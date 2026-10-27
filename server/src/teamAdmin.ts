import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { get } from "./db.ts";
import {
  MAX_REPLICAS, DEFAULT_PER_CREATOR, MODELS, createAgent, deleteAgent, getAgent, listAgents, readInstructions, slugify, updateAgent, writeInstructions, type Agent,
} from "./agents.ts";
import { create, getApproval, lineDiff, mustSetup, registerKind, type Approval } from "./approvals.ts";
import { deleteSkill, getSkill, listSkills, render, saveSkill, setAgentSkills, setSkillAgents, skillExists, skillsOf } from "./skills.ts";
import { ID_RE, cachedIntegrations, mappedIntegrations, setRoleIntegrations } from "./integrations.ts";
import { getRepo, listRepos, updateRepo } from "./repos.ts";
import { crewIdOf, crewName, listCrews, setRoleCrew } from "./crews.ts";

/**
 * Team changes proposed by the helper agent (the built-in setup role): new agents, changes to an agent
 * (its job description, settings, skills, integrations, repos), new or changed skills and who has them,
 * and bundles of these. Every proposal is an approval card (approvals.ts); only the owner's click in the
 * portal applies it, optionally after editing its text. Applying records undo steps, so the card's Undo
 * puts everything back as long as nobody changed it since.
 */

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const fail = (message: string, statusCode = 409) => Object.assign(new Error(message), { statusCode });
const MAX_TEXT = 100_000;

// --- references --------------------------------------------------------------------------------------

/** Agents (roles) by id, slug or name. */
export function findRole(ref: string): Agent | undefined {
  const k = String(ref ?? "").trim().toLowerCase().replace(/^@/, "");
  if (!k) return undefined;
  return listAgents().find((a) => !a.base_agent_id && (a.id === ref || a.slug === k || a.name.toLowerCase() === k));
}

const roster = () => listAgents().filter((a) => !a.base_agent_id && !a.builtin).map((a) => a.name).join(", ") || "none";

/** What a bundle creates, so its other items can refer to it. */
type Ctx = { newAgents: Map<string, string>; newSkills: Set<string> };
const emptyCtx = (): Ctx => ({ newAgents: new Map(), newSkills: new Set() });

/**
 * A role reference stored in a payload: an existing role's id, or `new:<slug>` for an agent the same
 * bundle creates (resolved when it's applied).
 */
function roleRef(ref: string, ctx: Ctx): { ref: string; name: string } {
  const r = findRole(ref);
  if (r) {
    if (r.builtin) throw new Error(`${r.name} is built into agentbox; its team settings can't change here`);
    return { ref: r.id, name: r.name };
  }
  const slug = slugify(String(ref ?? "").replace(/^@/, ""));
  if (slug && ctx.newAgents.has(slug)) return { ref: `new:${slug}`, name: ctx.newAgents.get(slug)! };
  throw new Error(`No agent called "${ref}". Agents: ${roster()}.`);
}

function roleId(ref: string): string {
  if (!ref.startsWith("new:")) {
    if (!getAgent(ref)) throw fail("An agent in this proposal no longer exists; ask the helper to propose it again");
    return ref;
  }
  const r = get<{ id: string }>(`SELECT id FROM agents WHERE slug = ? AND base_agent_id IS NULL`, ref.slice(4));
  if (!r) throw fail(`The new agent ${ref.slice(4)} wasn't created`);
  return r.id;
}

const skillName = (raw: string) => String(raw ?? "").toLowerCase().trim().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);

function mustSkill(name: string, ctx: Ctx) {
  const n = skillName(name);
  if (!getSkill(n) && !ctx.newSkills.has(n)) {
    throw new Error(`No skill called "${name}". Skills: ${listSkills().map((s) => s.name).join(", ") || "none"} (propose a new one in the same bundle).`);
  }
  return n;
}

function mustIntegration(id: string) {
  const k = String(id ?? "").trim().toLowerCase();
  if (!ID_RE.test(k)) throw new Error(`Bad integration id "${id}"`);
  const known = cachedIntegrations();
  if (known && !known.some((x) => x.id === k)) throw new Error(`No integration "${id}". Integrations: ${known.map((x) => x.id).join(", ")}`);
  return k;
}

function mustRepo(name: string) {
  const r = getRepo(String(name ?? "").trim().toLowerCase());
  if (!r || r.status === "archived") throw new Error(`No repo called "${name}". Repos: ${listRepos({ archived: false }).map((x) => x.name).join(", ") || "none"}`);
  return r.name;
}

const list = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : []);
const text = (v: unknown, what: string, max = MAX_TEXT) => {
  const t = String(v ?? "");
  if (t.length > max) throw new Error(`${what} is too long (${Math.round(max / 1000)} kB max)`);
  return t;
};

// --- preparing proposals -----------------------------------------------------------------------------

export type Item = { kind: "agent_create" | "agent_change" | "skill" | "skill_assign"; title: string; payload: any };

export type NewAgentInput = {
  name: string; title: string; summary?: string; model?: string; instructions: string;
  skills?: string[]; integrations?: string[]; repos?: string[]; max_replicas?: number; can_scale?: boolean; crew?: string; reason?: string;
};

/** A crew by id, slug or name (crews.ts). */
function mustCrew(ref: string) {
  const k = String(ref).trim().toLowerCase();
  const c = listCrews().find((c) => c.id === ref || c.slug === k || c.name.toLowerCase() === k);
  if (!c) throw new Error(`No crew called "${ref}". Crews: ${listCrews().map((c) => c.name).join(", ") || "none yet (the owner makes them on the Crews page)"}.`);
  return c;
}

function prepareNewAgent(input: NewAgentInput, ctx: Ctx): Item {
  const name = String(input.name ?? "").trim();
  const slug = slugify(name);
  if (!slug) throw new Error("The agent needs a name (letters or digits)");
  if (get(`SELECT 1 FROM agents WHERE slug = ?`, slug)) throw new Error(`An agent called "${slug}" already exists; change it with an agent change instead`);
  const title = String(input.title ?? "").trim();
  if (!title) throw new Error("Give the agent a role title, e.g. Sales assistant");
  const model = String(input.model ?? "sonnet").trim();
  if (!MODELS.includes(model as any)) throw new Error(`model is one of ${MODELS.join(", ")}`);
  const instructions = text(input.instructions, "The job description").trim();
  if (!instructions) throw new Error("Write the agent's job description (its CLAUDE.md)");
  if (input.max_replicas !== undefined && !(Number.isInteger(input.max_replicas) && input.max_replicas >= 0 && input.max_replicas <= MAX_REPLICAS)) {
    throw new Error(`max_replicas is 0–${MAX_REPLICAS}`);
  }
  const crew = input.crew ? mustCrew(input.crew) : null;
  return {
    kind: "agent_create",
    title: `New agent: ${name}${crew ? ` (${crew.name} crew)` : ""}`,
    payload: {
      name, slug, title, summary: String(input.summary ?? "").trim() || title, model, instructions,
      skills: [...new Set(list(input.skills).map((s) => mustSkill(s, ctx)))],
      integrations: [...new Set(list(input.integrations).map(mustIntegration))],
      repos: [...new Set(list(input.repos).map(mustRepo))],
      max_replicas: input.max_replicas ?? null, can_scale: input.can_scale ?? null,
      crew_id: crew?.id ?? null, crew_name: crew?.name ?? null,
      reason: text(input.reason, "The reason", 2000),
    },
  };
}

export type AgentChangeInput = {
  agent: string; instructions?: string; reason?: string;
  title?: string; summary?: string; model?: string; max_turns?: number; max_replicas?: number; can_scale?: boolean;
  add_skills?: string[]; remove_skills?: string[]; add_integrations?: string[]; remove_integrations?: string[];
  add_repos?: string[]; remove_repos?: string[];
};

function prepareAgentChange(input: AgentChangeInput, ctx: Ctx): Item {
  const role = findRole(input.agent);
  if (!role) throw new Error(`No agent called "${input.agent}". Agents: ${roster()}.`);
  if (role.builtin) throw new Error(`${role.name} is built into agentbox: its instructions come with agentbox. The owner can add notes on its page.`);
  const p: any = { role_id: role.id, role_name: role.name, reason: text(input.reason, "The reason", 2000) };
  let changes = 0;

  if (input.instructions !== undefined) {
    const next = text(input.instructions, "The job description").trim() + "\n";
    const current = readInstructions(role);
    if (!next.trim()) throw new Error("The job description can't be empty");
    if (next !== current) {
      p.instructions = { content: next, base_hash: sha(current), diff: lineDiff(current, next) };
      changes++;
    }
  }

  const settings: { key: string; before: unknown; after: unknown }[] = [];
  const set = (key: keyof Agent, after: unknown) => { if (after !== undefined && after !== (role as any)[key]) settings.push({ key, before: (role as any)[key], after }); };
  if (input.title !== undefined) set("title", String(input.title).trim());
  if (input.summary !== undefined) set("summary", String(input.summary).trim());
  if (input.model !== undefined) {
    if (!MODELS.includes(input.model as any)) throw new Error(`model is one of ${MODELS.join(", ")}`);
    set("model", input.model);
  }
  if (input.max_turns !== undefined) {
    if (!(Number.isInteger(input.max_turns) && input.max_turns >= 5 && input.max_turns <= 500)) throw new Error("max_turns is 5–500");
    set("max_turns", input.max_turns);
  }
  if (input.max_replicas !== undefined) {
    if (!(Number.isInteger(input.max_replicas) && input.max_replicas >= 0 && input.max_replicas <= MAX_REPLICAS)) throw new Error(`max_replicas is 0–${MAX_REPLICAS}`);
    set("max_replicas", input.max_replicas);
  }
  if (input.can_scale !== undefined) {
    const after = input.can_scale ? 1 : 0;
    if (after !== (role.can_scale ? 1 : 0)) settings.push({ key: "can_scale", before: role.can_scale ? 1 : 0, after });
  }
  if (settings.length) { p.settings = settings; changes += settings.length; }

  const delta = (add: string[], remove: string[], have: string[]) => ({
    add: add.filter((x) => !have.includes(x)), remove: remove.filter((x) => have.includes(x)),
  });
  const skills = delta(
    [...new Set(list(input.add_skills).map((s) => mustSkill(s, ctx)))],
    [...new Set(list(input.remove_skills).map(skillName))], skillsOf(role.id),
  );
  if (skills.add.length || skills.remove.length) { p.skills = skills; changes++; }
  const integrations = delta(
    [...new Set(list(input.add_integrations).map(mustIntegration))],
    [...new Set(list(input.remove_integrations).map((s) => s.toLowerCase()))], mappedIntegrations(role.id),
  );
  if (integrations.add.length || integrations.remove.length) { p.integrations = integrations; changes++; }

  const addRepos: string[] = [];
  const removeRepos: string[] = [];
  for (const n of new Set(list(input.add_repos).map(mustRepo))) {
    const r = getRepo(n)!;
    if (r.allowed_roles.length && !r.allowed_roles.includes(role.id)) addRepos.push(n);
  }
  for (const n of new Set(list(input.remove_repos).map(mustRepo))) {
    const r = getRepo(n)!;
    if (!r.allowed_roles.length) throw new Error(`${n} is open to every agent; to keep ${role.name} out, list who may use it on the Repos page`);
    if (r.allowed_roles.includes(role.id)) removeRepos.push(n);
  }
  if (addRepos.length || removeRepos.length) { p.repos = { add: addRepos, remove: removeRepos }; changes++; }

  if (!changes) throw new Error(`That's ${role.name} as it is now; nothing to change`);
  return { kind: "agent_change", title: `Change ${role.name}`, payload: p };
}

export type SkillInput = { name: string; description: string; body: string; agents?: string[]; source?: string; reason?: string };

function prepareSkill(input: SkillInput, ctx: Ctx): Item {
  const name = skillName(input.name);
  if (!/^[a-z0-9][a-z0-9-]{1,39}$/.test(name)) throw new Error("Skill names are 2–40 characters: lowercase letters, digits and dashes");
  const description = String(input.description ?? "").replace(/\s+/g, " ").trim();
  if (!description) throw new Error("Describe when the skill should be used (one sentence)");
  const body = text(input.body, "The skill").trim();
  if (!body) throw new Error("The skill needs instructions");
  const existing = getSkill(name);
  const before = existing ? render(name, existing.description, existing.body) : "";
  const after = render(name, description, body);
  if (existing && before === after && !list(input.agents).length) throw new Error(`That's the skill "${name}" as it is now; nothing to change`);
  const agents = list(input.agents).map((r) => roleRef(r, ctx));
  const source = String(input.source ?? "").trim();
  if (source && !/^https:\/\/\S+$/.test(source)) throw new Error("source is the https:// page the skill came from");
  return {
    kind: "skill",
    title: `${existing ? "Change skill" : "New skill"}: ${name}`,
    payload: {
      name, description, body, created: !existing, base_hash: existing ? sha(before) : null, diff: lineDiff(before, after),
      agents: agents.map((a) => a.ref), agent_names: agents.map((a) => a.name),
      files: existing?.files ?? [], source: source || null, reason: text(input.reason, "The reason", 2000),
    },
  };
}

export type SkillAssignInput = { skill: string; add?: string[]; remove?: string[]; reason?: string };

function prepareSkillAssign(input: SkillAssignInput, ctx: Ctx): Item {
  const name = mustSkill(input.skill, ctx);
  const add = list(input.add).map((r) => roleRef(r, ctx));
  const remove = list(input.remove).map((r) => roleRef(r, ctx));
  if (!add.length && !remove.length) throw new Error("Say which agents get the skill (add) or lose it (remove)");
  const parts = [add.length ? `give ${name} to ${add.map((a) => a.name).join(", ")}` : "", remove.length ? `take it from ${remove.map((a) => a.name).join(", ")}` : ""].filter(Boolean);
  return {
    kind: "skill_assign",
    title: parts.join("; ").replace(/^./, (c) => c.toUpperCase()),
    payload: {
      skill: name, add: add.map((a) => a.ref), add_names: add.map((a) => a.name), remove: remove.map((a) => a.ref), remove_names: remove.map((a) => a.name),
      reason: text(input.reason, "The reason", 2000),
    },
  };
}

export type BundleItemInput = ({ type: "new_agent" } & NewAgentInput) | ({ type: "agent_change" } & AgentChangeInput)
  | ({ type: "skill" } & SkillInput) | ({ type: "skill_assignment" } & SkillAssignInput);

function prepareItem(x: any, ctx: Ctx): Item {
  switch (x?.type) {
    case "new_agent": return prepareNewAgent(x, ctx);
    case "agent_change": return prepareAgentChange(x, ctx);
    case "skill": return prepareSkill(x, ctx);
    case "skill_assignment": return prepareSkillAssign(x, ctx);
    default: throw new Error(`Unknown change type "${x?.type}" (new_agent, agent_change, skill, skill_assignment)`);
  }
}

/** Everything a bundle creates, known before its items are checked (any order works). */
function bundleCtx(items: any[]): Ctx {
  const ctx = emptyCtx();
  for (const x of items) {
    if (x?.type === "new_agent") { const s = slugify(String(x.name ?? "")); if (s) ctx.newAgents.set(s, String(x.name).trim()); }
    if (x?.type === "skill") { const n = skillName(x.name); if (n && !getSkill(n)) ctx.newSkills.add(n); }
  }
  return ctx;
}

// --- proposing (the helper's tools) --------------------------------------------------------------------

const propose = (agent: Agent, taskId: string | null, item: Item) => {
  mustSetup(agent);
  return create(agent, taskId, item.kind, item.title, item.payload);
};

export const proposeNewAgent = (agent: Agent, taskId: string | null, input: NewAgentInput) => {
  mustSetup(agent);
  const ctx = emptyCtx();
  // Its own new skills can't be in a single proposal: those need a bundle.
  return propose(agent, taskId, prepareNewAgent(input, ctx));
};
export const proposeAgentChange = (agent: Agent, taskId: string | null, input: AgentChangeInput) => {
  mustSetup(agent);
  return propose(agent, taskId, prepareAgentChange(input, emptyCtx()));
};
export const proposeSkillChange = (agent: Agent, taskId: string | null, input: SkillInput) => {
  mustSetup(agent);
  return propose(agent, taskId, prepareSkill(input, emptyCtx()));
};
export const proposeSkillAssign = (agent: Agent, taskId: string | null, input: SkillAssignInput) => {
  mustSetup(agent);
  return propose(agent, taskId, prepareSkillAssign(input, emptyCtx()));
};

export function proposeBundle(agent: Agent, taskId: string | null, input: { title: string; reason?: string; items: BundleItemInput[] }) {
  mustSetup(agent);
  const raw = Array.isArray(input.items) ? input.items : [];
  if (raw.length < 2) throw new Error("A bundle has two or more changes; propose a single change on its own");
  if (raw.length > 20) throw new Error("At most 20 changes in one bundle");
  const ctx = bundleCtx(raw);
  const seen = new Set<string>();
  const items = raw.map((x, i) => {
    try {
      const it = prepareItem(x, ctx);
      const key = it.kind === "agent_create" ? `a:${it.payload.slug}` : it.kind === "skill" ? `s:${it.payload.name}` : "";
      if (key && seen.has(key)) throw new Error("it's in this bundle twice");
      if (key) seen.add(key);
      return it;
    } catch (e: any) {
      throw new Error(`Change ${i + 1} (${x?.type ?? "?"}): ${e.message}`);
    }
  });
  const title = String(input.title ?? "").trim().slice(0, 120) || `${items.length} team changes`;
  return create(agent, taskId, "bundle", title, { items, reason: text(input.reason, "The reason", 2000) });
}

// --- applying --------------------------------------------------------------------------------------------

type Step =
  | { op: "delete_agent"; role_id: string }
  | { op: "instructions"; role_id: string; before: string; after_hash: string }
  | { op: "settings"; role_id: string; before: Record<string, unknown> }
  | { op: "skills"; role_id: string; before: string[] }
  | { op: "integrations"; role_id: string; before: string[] }
  | { op: "repo_roles"; repo: string; before: string[] }
  | { op: "delete_skill"; name: string; after_hash: string }
  | { op: "skill_content"; name: string; description: string; body: string; after_hash: string }
  | { op: "skill_agents"; name: string; before: string[] };

const skillHash = (name: string) => { const s = getSkill(name); return s ? sha(render(name, s.description, s.body)) : null; };

/** The owner's edits to an item's text (the card's Edit). */
function edited(item: Item, e: any): Item {
  if (!e || typeof e !== "object") return item;
  const p = { ...item.payload };
  if (item.kind === "agent_create" && typeof e.instructions === "string") {
    if (!e.instructions.trim()) throw fail("The job description can't be empty", 400);
    p.instructions = text(e.instructions, "The job description").trim();
  }
  if (item.kind === "agent_change" && typeof e.instructions === "string" && p.instructions) {
    if (!e.instructions.trim()) throw fail("The job description can't be empty", 400);
    p.instructions = { ...p.instructions, content: text(e.instructions, "The job description").trim() + "\n" };
  }
  if (item.kind === "skill") {
    if (typeof e.body === "string") { if (!e.body.trim()) throw fail("The skill needs instructions", 400); p.body = text(e.body, "The skill").trim(); }
    if (typeof e.description === "string" && e.description.trim()) p.description = e.description.replace(/\s+/g, " ").trim();
  }
  return { ...item, payload: p };
}

/** Is the item still applicable as proposed? Checked for every item before any is applied. */
function check(item: Item) {
  const p = item.payload;
  if (item.kind === "agent_create") {
    if (get(`SELECT 1 FROM agents WHERE slug = ?`, p.slug)) throw fail(`An agent called "${p.slug}" exists now; ask the helper to propose it again`);
  }
  if (item.kind === "agent_change") {
    const role = getAgent(p.role_id);
    if (!role || role.retired_at) throw fail(`${p.role_name} no longer exists`);
    if (p.instructions && sha(readInstructions(role)) !== p.instructions.base_hash) {
      throw fail(`${p.role_name}'s job description changed since this was proposed; ask the helper to propose it again`);
    }
  }
  if (item.kind === "skill") {
    if (p.created ? !!getSkill(p.name) : skillHash(p.name) !== p.base_hash) {
      throw fail(`The skill "${p.name}" changed since this was proposed; ask the helper to propose it again`);
    }
  }
}

/** First everything the items create (agents, skill text), then what links them (skills, access). */
function applyItems(items: Item[], steps: Step[]) {
  for (const it of items) check(it);
  for (const it of items) {
    const p = it.payload;
    if (it.kind === "agent_create") {
      const a = createAgent({ name: p.name, title: p.title, summary: p.summary, model: p.model, instructions: p.instructions + "\n", interview: { source: "helper" } });
      steps.push({ op: "delete_agent", role_id: a.id });
      if (p.crew_id && listCrews().some((c) => c.id === p.crew_id)) setRoleCrew(a.id, p.crew_id);
      if (p.max_replicas !== null || p.can_scale !== null) {
        updateAgent(a.id, { ...(p.max_replicas !== null ? { max_replicas: p.max_replicas } : {}), ...(p.can_scale !== null ? { can_scale: p.can_scale ? 1 : 0 } : {}) });
      }
    }
    if (it.kind === "skill") {
      const before = getSkill(p.name);
      saveSkill({ name: p.name, description: p.description, body: p.body }, { create: p.created });
      const after_hash = skillHash(p.name)!;
      steps.push(before
        ? { op: "skill_content", name: p.name, description: before.description, body: before.body, after_hash }
        : { op: "delete_skill", name: p.name, after_hash });
    }
  }
  for (const it of items) {
    const p = it.payload;
    if (it.kind === "agent_create") {
      const id = roleId(`new:${p.slug}`);
      if (p.skills.length) { steps.push({ op: "skills", role_id: id, before: [] }); setAgentSkills(id, p.skills); }
      if (p.integrations.length) { steps.push({ op: "integrations", role_id: id, before: [] }); setRoleIntegrations(id, p.integrations); }
      for (const n of p.repos) {
        const r = getRepo(n);
        if (r && r.allowed_roles.length && !r.allowed_roles.includes(id)) {
          steps.push({ op: "repo_roles", repo: n, before: r.allowed_roles });
          updateRepo(n, { allowed_roles: [...r.allowed_roles, id] });
        }
      }
    }
    if (it.kind === "agent_change") {
      const role = getAgent(p.role_id)!;
      if (p.instructions) {
        const before = readInstructions(role);
        writeInstructions(role, p.instructions.content);
        steps.push({ op: "instructions", role_id: role.id, before, after_hash: sha(readInstructions(role)) });
      }
      if (p.settings?.length) {
        const before: Record<string, unknown> = {};
        const patch: Record<string, unknown> = {};
        for (const s of p.settings) { before[s.key] = (role as any)[s.key]; patch[s.key] = s.after; }
        updateAgent(role.id, patch as any);
        steps.push({ op: "settings", role_id: role.id, before });
      }
      if (p.skills) {
        const have = skillsOf(role.id);
        steps.push({ op: "skills", role_id: role.id, before: have });
        setAgentSkills(role.id, [...new Set([...have.filter((s) => !p.skills.remove.includes(s)), ...p.skills.add])].filter(skillExists));
      }
      if (p.integrations) {
        const have = mappedIntegrations(role.id);
        steps.push({ op: "integrations", role_id: role.id, before: have });
        setRoleIntegrations(role.id, [...new Set([...have.filter((s) => !p.integrations.remove.includes(s)), ...p.integrations.add])]);
      }
      if (p.repos) {
        for (const n of [...p.repos.add, ...p.repos.remove]) {
          const r = getRepo(n);
          if (!r || r.status === "archived") continue;
          const next = p.repos.add.includes(n) ? [...new Set([...r.allowed_roles, role.id])] : r.allowed_roles.filter((x) => x !== role.id);
          if (!next.length) continue; // never turn a closed repo into an open one
          steps.push({ op: "repo_roles", repo: n, before: r.allowed_roles });
          updateRepo(n, { allowed_roles: next });
        }
      }
    }
    if (it.kind === "skill" && p.agents.length) {
      const have = getSkill(p.name)!.agents;
      steps.push({ op: "skill_agents", name: p.name, before: have });
      setSkillAgents(p.name, [...new Set([...have, ...p.agents.map(roleId)])]);
    }
    if (it.kind === "skill_assign") {
      const s = getSkill(p.skill);
      if (!s) throw fail(`The skill "${p.skill}" no longer exists`);
      const remove = new Set(p.remove.map((r: string) => { try { return roleId(r); } catch { return ""; } }));
      steps.push({ op: "skill_agents", name: p.skill, before: s.agents });
      setSkillAgents(p.skill, [...new Set([...s.agents.filter((x) => !remove.has(x)), ...p.add.map(roleId)])]);
    }
  }
}

const itemsOf = (a: Approval): Item[] => (a.kind === "bundle" ? a.payload.items : [{ kind: a.kind as Item["kind"], title: a.title, payload: a.payload }]);

function apply(a: Approval, edits: Record<string, any>): Step[] {
  const items = itemsOf(a).map((it, i) => edited(it, edits[String(i)]));
  const steps: Step[] = [];
  try {
    applyItems(items, steps);
    return steps;
  } catch (e) {
    // Half a bundle is worse than none: put back what was already applied.
    try { undoSteps(steps, false); } catch (u) { console.error("teamAdmin: rollback failed", u); }
    throw e;
  }
}

/** Undo, last step first; refused as a whole when something it would put back was changed since. */
function undo(_a: Approval, raw: unknown[]) {
  undoSteps(raw as Step[], true);
}

function undoSteps(raw: Step[], checkFirst: boolean) {
  const steps = [...raw].reverse();
  if (checkFirst) for (const s of steps) {
    if (s.op === "instructions") {
      const role = getAgent(s.role_id);
      if (role && sha(readInstructions(role)) !== s.after_hash) throw fail(`${role.name}'s job description changed since; undo it by hand on its page`);
    }
    if (s.op === "skill_content" || s.op === "delete_skill") {
      const h = skillHash(s.name);
      if (h && h !== s.after_hash) throw fail(`The skill "${s.name}" changed since; undo it by hand on the Skills page`);
    }
    if (s.op === "delete_agent") {
      const n = (get<{ n: number }>(`SELECT COUNT(*) AS n FROM agents WHERE base_agent_id = ?`, s.role_id)?.n ?? 0) as number;
      if (n > 0) throw fail(`${getAgent(s.role_id)?.name ?? "The new agent"} has done work since; delete it from its page if you want it gone`);
    }
  }
  for (const s of steps) {
    switch (s.op) {
      case "delete_agent": if (getAgent(s.role_id)) deleteAgent(s.role_id); break;
      case "instructions": { const r = getAgent(s.role_id); if (r) writeInstructions(r, s.before); break; }
      case "settings": if (getAgent(s.role_id)) updateAgent(s.role_id, s.before as any); break;
      case "skills": if (getAgent(s.role_id)) setAgentSkills(s.role_id, s.before.filter(skillExists)); break;
      case "integrations": if (getAgent(s.role_id)) setRoleIntegrations(s.role_id, s.before); break;
      case "repo_roles": { const r = getRepo(s.repo); if (r && r.status !== "archived") updateRepo(s.repo, { allowed_roles: s.before.filter((id) => getAgent(id)) }); break; }
      case "delete_skill": if (getSkill(s.name)) deleteSkill(s.name); break;
      case "skill_content": if (getSkill(s.name)) saveSkill({ name: s.name, description: s.description, body: s.body }, { create: false }); break;
      case "skill_agents": if (getSkill(s.name)) setSkillAgents(s.name, s.before.filter((id) => getAgent(id))); break;
    }
  }
}

for (const kind of ["agent_create", "agent_change", "skill", "skill_assign", "bundle"] as const) registerKind(kind, { apply, undo });

// --- reading the team (the helper's tools) ----------------------------------------------------------------

const liveTasks = (roleId: string) =>
  (get<{ n: number }>(`SELECT COUNT(*) AS n FROM agents WHERE base_agent_id = ? AND retired_at IS NULL`, roleId)?.n ?? 0) as number;

const reposOf = (role: Agent) => listRepos({ archived: false }).filter((r) => !r.allowed_roles.length || r.allowed_roles.includes(role.id)).map((r) => r.name);

export function teamOverview(): string {
  const roles = listAgents().filter((a) => !a.base_agent_id);
  const lines = roles.map((a) => {
    if (a.builtin) return `- **${a.name}** (${a.title}): you. Built in.`;
    const skills = skillsOf(a.id);
    const ints = mappedIntegrations(a.id);
    return `- **${a.name}** (${a.title}) · ${crewIdOf(a) ? `${crewName(crewIdOf(a))} crew` : "no crew"} · model ${a.model} · ${a.can_scale ? "lead (can start other agents' tasks)" : `up to ${a.max_replicas || DEFAULT_PER_CREATOR} parallel tasks per starter`} · max ${a.max_turns} steps/turn · ${liveTasks(a.id)} live task(s)
    ${a.summary}
    skills: ${skills.join(", ") || "none"} · integrations: ${ints.join(", ") || "none"} · repos: ${reposOf(a).join(", ") || "none"}`;
  });
  const skills = listSkills();
  const crews = listCrews();
  return [
    `# Crews (${crews.length})`, ...(crews.length ? crews.map((c) => `- ${c.name}${c.summary ? `: ${c.summary}` : ""}`) : ["- none: every agent works with every other"]),
    "Agents only work with their own crew's agents. A new agent joins a crew with propose_new_agent's crew.", "",
    `# Agents (${roles.length})`, ...lines, "",
    `# Skill library (${skills.length})`,
    ...skills.map((s) => `- ${s.name}: ${s.description} · used by ${s.agents.map((id) => getAgent(id)?.name ?? id).join(", ") || "nobody"}`),
    "", "get_agent(name) shows an agent's full job description; get_skill(name) a skill's text.",
  ].join("\n");
}

export function agentDetail(ref: string): string {
  const a = findRole(ref);
  if (!a) throw new Error(`No agent called "${ref}". Agents: ${roster()}.`);
  return [
    `# ${a.name} (${a.title})${a.builtin ? " · built in" : ""}`,
    `model ${a.model} · max ${a.max_turns} steps/turn · max_replicas ${a.max_replicas ?? 0} · can_scale ${a.can_scale ? "yes (a lead)" : "no"} · ${liveTasks(a.id)} live task(s)`,
    `summary: ${a.summary}`,
    `skills: ${skillsOf(a.id).join(", ") || "none"}`,
    `integrations: ${mappedIntegrations(a.id).join(", ") || "none"}`,
    `repos: ${reposOf(a).join(", ") || "none"}`,
    a.builtin && a.owner_notes ? `owner's notes:\n${a.owner_notes}` : "",
    "", "## Job description (CLAUDE.md, exactly as saved)", "", readInstructions(a),
  ].filter((x) => x !== "").join("\n");
}

export function skillDetail(name: string): string {
  const s = getSkill(skillName(name));
  if (!s) throw new Error(`No skill called "${name}". Skills: ${listSkills().map((x) => x.name).join(", ") || "none"}`);
  return [
    `# ${s.name}`, `description: ${s.description}`,
    `used by: ${s.agents.map((id) => getAgent(id)?.name ?? id).join(", ") || "nobody"}`,
    s.files.length ? `other files (kept as they are on a change): ${s.files.join(", ")}` : "",
    "", "## SKILL.md body", "", s.body,
  ].filter((x) => x !== "").join("\n");
}

// --- test drive ------------------------------------------------------------------------------------------

/** The job description an agent would have once a pending proposal is approved (for a test drive). */
function proposedInstructions(approvalId: string, role: string): string | null {
  const a = getApproval(approvalId);
  if (!a) throw new Error("No such proposal");
  const k = slugify(role);
  for (const it of itemsOf(a)) {
    if (it.kind === "agent_create" && it.payload.slug === k) return it.payload.instructions;
    if (it.kind === "agent_change" && it.payload.instructions && findRole(role)?.id === it.payload.role_id) return it.payload.instructions.content;
  }
  return null;
}

export type DriveImpl = (prompt: string) => Promise<string>;
let driveImpl: DriveImpl = async (prompt) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "agentbox-drive-"));
  try {
    const q = query({ prompt, options: { cwd, model: "sonnet", tools: [], settingSources: [], strictMcpConfig: true, persistSession: false, maxTurns: 2 } });
    for await (const m of q as AsyncIterable<any>) {
      if (m.type === "result") {
        if (m.subtype !== "success") throw new Error(`Claude could not answer (${m.subtype})`);
        return String(m.result ?? "");
      }
    }
    throw new Error("No answer");
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
};
export const setDriveImpl = (fn: DriveImpl) => { driveImpl = fn; };

/**
 * Ask an agent, as its job description stands (or as a pending proposal would make it), what it would
 * do with a task. Nothing runs: no tools, no files. The helper uses it to show a change takes.
 */
export async function testDrive(agentRef: string, scenario: string, approvalId?: string): Promise<string> {
  const role = findRole(agentRef);
  const proposed = approvalId ? proposedInstructions(approvalId, agentRef) : null;
  if (approvalId && proposed === null) throw new Error(`That proposal doesn't set ${agentRef}'s job description`);
  if (!role && proposed === null) throw new Error(`No agent called "${agentRef}". Agents: ${roster()}.`);
  const instructions = proposed ?? readInstructions(role!);
  const team = listAgents().filter((a) => !a.base_agent_id && !a.builtin).map((a) => `- ${a.name} (${a.title}): ${a.summary}`).join("\n");
  const prompt = `This is a dry run. You are an agent on a software team; below is your job description, then a task.
You have no tools now. Don't do the task: say, in 4–8 short bullets, exactly what you would do first and in
what order, what you'd hand to which teammate, and what you would not do yourself and why.

<job_description>
${instructions}
</job_description>

<team>
${team}
</team>

<task>
${String(scenario).slice(0, 4000)}
</task>`;
  return (await driveImpl(prompt)).trim();
}
