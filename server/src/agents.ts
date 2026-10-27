import fs from "node:fs";
import path from "node:path";
import { all, get, newId, now, run } from "./db.ts";
import { publish } from "./bus.ts";
import { config, paths } from "./config.ts";

export const AGENTS_ROOT = paths.agents;
export const WORK_ROOT = paths.work;

// docs/UI-DESIGN.md › Agent colours: hues that also step in lightness.
const COLORS = ["#8AB4FF", "#F2B45A", "#C59BFF", "#5BD69A", "#FF8FB1", "#6FD3E0", "#E0D06F", "#B0B8C6"];
export const MODELS = ["opus", "sonnet", "haiku"] as const;

export type Agent = {
  id: string;
  slug: string;
  name: string;
  title: string;
  summary: string;
  model: string;
  color: string;
  max_turns: number;
  created_at: string;
  /** Set on replicas: the agent this is a copy of. */
  base_agent_id?: string | null;
  replica_no?: number | null;
  /** Replicas live in their base agent's home (shared CLAUDE.md, skills, memory). */
  home_slug?: string | null;
  retired_at?: string | null;
  /** On a base agent: how many replicas may run at once (0 = none). */
  max_replicas?: number;
  /** May this agent start instances of other roles (a manager role, e.g. tech-lead)? */
  can_scale?: number;
  /** Instances: who started it — "owner", "routine:<id>", "group:<id>", or the creating instance's id. */
  created_by?: string | null;
  /** Instances: the instance whose task this one is part of (task rooms are these trees). */
  parent_instance_id?: string | null;
  /** Instances: the task, as a short title. */
  label?: string | null;
  /** Instances: a finished task room the owner chose to keep visible. */
  kept?: number;
  /** Task rooms (root instance): the room's shared folder. */
  workspace?: string | null;
  /** Instances: conversation size after the last turn, in tokens. */
  context_tokens?: number | null;
  /** Built-in roles (e.g. "setup", setup.ts): can't be deleted or renamed; CLAUDE.md owned by agentbox. */
  builtin?: string | null;
  /** Built-in roles: the owner's notes, added to the agent's instructions. */
  owner_notes?: string | null;
  /** Agents (roles): the crew it's in (crews.ts); null for none. Instances follow their role. */
  crew_id?: string | null;
};

/** Per creator: how many live instances of one role an agent may run at once (config limits.per_role; role.max_replicas overrides). */
export const DEFAULT_PER_CREATOR = config.limits.per_role;
/** The highest role.max_replicas the owner may set. */
export const MAX_REPLICAS = Math.max(6, DEFAULT_PER_CREATOR);
/** Safety cap on live instances overall (VM memory and Claude usage). */
export const MAX_LIVE_INSTANCES = 40;

export function slugify(name: string) {
  return name.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32);
}

type Homed = Pick<Agent, "slug"> & { home_slug?: string | null };
export const homeOf = (a: Homed) => path.join(AGENTS_ROOT, a.home_slug ?? a.slug);
export const instructionsPath = (a: Homed) => path.join(homeOf(a), "CLAUDE.md");
export const memoryDir = (a: Homed) => path.join(homeOf(a), "memory");

/** Active agents (retired replicas excluded), base agents before their replicas. */
export const listAgents = () =>
  all<Agent>(
    `SELECT a.* FROM agents a LEFT JOIN agents b ON b.id = a.base_agent_id
     WHERE a.retired_at IS NULL
     ORDER BY COALESCE(b.created_at, a.created_at), a.replica_no IS NOT NULL, a.replica_no`,
  );
/** Retired replicas, so history can still name them. */
export const listRetired = () => all<Agent>(`SELECT * FROM agents WHERE retired_at IS NOT NULL ORDER BY created_at`);
export const getAgent = (id: string) => get<Agent>(`SELECT * FROM agents WHERE id = ?`, id);
export const replicasOf = (baseId: string) =>
  all<Agent>(`SELECT * FROM agents WHERE base_agent_id = ? AND retired_at IS NULL ORDER BY replica_no`, baseId);
/** The agent whose instructions/skills/memory this one uses (itself unless it's a replica). */
export const baseOf = (a: Agent) => (a.base_agent_id ? getAgent(a.base_agent_id) ?? a : a);

export function readInstructions(a: Agent) {
  try {
    return fs.readFileSync(instructionsPath(a), "utf8");
  } catch {
    return "";
  }
}

/** The owner editing a role's CLAUDE.md (the API). Built-in roles' instructions belong to agentbox. */
export function editInstructions(a: Agent, text: string) {
  if (a.base_agent_id) throw new Error("Replicas use their base agent's instructions; edit those instead");
  if (a.builtin) throw new Error(`${a.name}'s instructions are maintained by agentbox; add your notes instead`);
  writeInstructions(a, text);
}

export function writeInstructions(a: Agent, text: string) {
  fs.writeFileSync(instructionsPath(a), text.endsWith("\n") ? text : text + "\n");
}

export function createAgent(input: {
  name: string;
  title: string;
  summary: string;
  model: string;
  instructions: string;
  interview: unknown;
}): Agent {
  const slug = slugify(input.name);
  if (!slug) throw new Error("Name needs at least one letter or digit");
  if (get(`SELECT 1 FROM agents WHERE slug = ?`, slug)) throw new Error(`An agent called "${slug}" already exists`);
  if (!MODELS.includes(input.model as any)) throw new Error(`Unknown model ${input.model}`);

  const count = (get<{ n: number }>(`SELECT COUNT(*) AS n FROM agents`)?.n ?? 0) as number;
  const agent: Agent = {
    id: newId(),
    slug,
    name: input.name.trim(),
    title: input.title.trim(),
    summary: input.summary.trim(),
    model: input.model,
    color: COLORS[count % COLORS.length],
    max_turns: 60,
    created_at: now(),
  };

  const home = homeOf(agent);
  fs.mkdirSync(path.join(home, "memory"), { recursive: true });
  fs.mkdirSync(path.join(home, "scratch"), { recursive: true });
  fs.mkdirSync(path.join(home, ".claude", "skills"), { recursive: true });
  writeInstructions(agent, input.instructions);
  const memIndex = path.join(memoryDir(agent), "MEMORY.md");
  if (!fs.existsSync(memIndex)) {
    fs.writeFileSync(memIndex, `# ${agent.name}'s memory\n\nOne line per memory file: - [Title](file.md) — what it covers\n`);
  }

  run(
    `INSERT INTO agents (id, slug, name, title, summary, model, color, max_turns, interview, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    agent.id, agent.slug, agent.name, agent.title, agent.summary, agent.model, agent.color,
    agent.max_turns, JSON.stringify(input.interview ?? {}), agent.created_at,
  );
  // An agent is a role: no conversation of its own. Work happens on its instances (tasks).
  publish({ type: "agent.created", agent: { ...agent, status: "idle", dm_thread_id: null } });
  return agent;
}

export function updateAgent(
  id: string,
  patch: Partial<Pick<Agent, "title" | "summary" | "model" | "max_turns" | "max_replicas" | "can_scale">>,
) {
  const a = getAgent(id);
  if (!a) throw new Error("No such agent");
  if (a.base_agent_id) throw new Error("Replicas follow their base agent; change the base agent instead");
  if (a.builtin && ((patch.title !== undefined && patch.title !== a.title) || (patch.summary !== undefined && patch.summary !== a.summary))) {
    throw new Error(`${a.name} is built in: its name and description can't change`);
  }
  if (patch.model && !MODELS.includes(patch.model as any)) throw new Error(`Unknown model ${patch.model}`);
  if (patch.max_replicas !== undefined && !(Number.isInteger(patch.max_replicas) && patch.max_replicas >= 0 && patch.max_replicas <= MAX_REPLICAS)) {
    throw new Error(`Max replicas must be 0–${MAX_REPLICAS}`);
  }
  const next = { ...a, ...patch, can_scale: patch.can_scale === undefined ? a.can_scale : patch.can_scale ? 1 : 0 };
  run(
    `UPDATE agents SET title = ?, summary = ?, model = ?, max_turns = ?, max_replicas = ?, can_scale = ? WHERE id = ?`,
    next.title, next.summary, next.model, next.max_turns, next.max_replicas ?? 0, next.can_scale ?? 0, id,
  );
  publish({ type: "agent.updated", agent: next });
  // Replicas run with their base's role and model.
  for (const r of replicasOf(id)) {
    run(`UPDATE agents SET title = ?, summary = ?, model = ?, max_turns = ? WHERE id = ?`, next.title, next.summary, next.model, next.max_turns, r.id);
    publish({ type: "agent.updated", agent: getAgent(r.id) });
  }
  return next;
}

export type Spawn = {
  label: string; createdBy: string; parentInstanceId?: string | null;
  /** A task bringing in its one lead (e.g. tech-lead): allowed although only the owner starts such roles. */
  asLead?: boolean;
};

/**
 * Start an instance of a role for one task. Numbers only go up (coder#1, coder#2, …) so a retired
 * instance's history never mixes with a new task's.
 */
export function spawnInstance(roleId: string, s: Spawn) {
  const role = getAgent(roleId);
  if (!role || role.retired_at) throw new Error("No such agent");
  if (role.base_agent_id) throw new Error(`${role.name} is an instance; start work on its agent, ${getAgent(role.base_agent_id)?.name}`);
  // The setup agent gets temporary sudo while it works: only the owner starts its tasks.
  if (role.builtin === "setup" && s.createdBy !== "owner") throw new Error(`Only the owner starts ${role.name} tasks; ask the owner.`);
  const live = (get<{ n: number }>(`SELECT COUNT(*) AS n FROM agents WHERE base_agent_id IS NOT NULL AND retired_at IS NULL`)?.n ?? 0) as number;
  if (live >= MAX_LIVE_INSTANCES) throw new Error(`There are already ${live} live tasks, the limit. Finish some first.`);
  const byAgent = s.createdBy !== "owner" && !s.createdBy.startsWith("routine:") && !s.createdBy.startsWith("group:")
    && !s.createdBy.startsWith("lead:");
  if (byAgent && !s.asLead) {
    if (role.can_scale) throw new Error(`Only the owner starts ${role.name} tasks.`);
    const limit = role.max_replicas || DEFAULT_PER_CREATOR;
    const mine = (get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM agents WHERE base_agent_id = ? AND created_by = ? AND retired_at IS NULL`, role.id, s.createdBy,
    )?.n ?? 0) as number;
    if (mine >= limit) throw new Error(`You already have ${mine} live ${role.name} task(s), your limit. Retire finished ones first.`);
  }
  const n = ((get<{ n: number }>(`SELECT MAX(replica_no) AS n FROM agents WHERE base_agent_id = ?`, role.id)?.n ?? 0) as number) + 1;
  let slug = `${role.slug}-${n}`;
  while (get(`SELECT 1 FROM agents WHERE slug = ?`, slug)) slug += "x";
  const agent: Agent = {
    id: newId(), slug, name: `${role.name}#${n}`, title: role.title, summary: role.summary, model: role.model, color: role.color,
    max_turns: role.max_turns, created_at: now(), base_agent_id: role.id, replica_no: n, home_slug: role.home_slug ?? role.slug,
    retired_at: null, max_replicas: 0, can_scale: role.can_scale ?? 0,
    created_by: s.createdBy, parent_instance_id: s.parentInstanceId ?? null, label: s.label.trim().slice(0, 120) || "Task", kept: 0,
  };
  run(
    `INSERT INTO agents (id, slug, name, title, summary, model, color, max_turns, interview, created_at, base_agent_id, replica_no,
                         home_slug, can_scale, created_by, parent_instance_id, label)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, '{}', ?, ?, ?, ?, ?, ?, ?, ?)`,
    agent.id, agent.slug, agent.name, agent.title, agent.summary, agent.model, agent.color, agent.max_turns, agent.created_at,
    agent.base_agent_id, agent.replica_no, agent.home_slug, agent.can_scale, agent.created_by, agent.parent_instance_id, agent.label,
  );
  const threadId = newId();
  run(`INSERT INTO threads (id, kind, agent_id, created_at) VALUES (?, 'dm', ?, ?)`, threadId, agent.id, now());
  publish({ type: "agent.created", agent: { ...agent, status: "idle", dm_thread_id: threadId } });
  return agent;
}

/** Reopen a retired instance for a follow-up (e.g. rework on its PR): its conversation resumes. */
export function reviveInstance(id: string, createdBy: string) {
  const a = getAgent(id);
  if (!a || !a.retired_at) return a;
  const role = getAgent(a.base_agent_id!)!;
  const limit = role.max_replicas || DEFAULT_PER_CREATOR;
  const mine = (get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM agents WHERE base_agent_id = ? AND created_by = ? AND retired_at IS NULL`, role.id, createdBy,
  )?.n ?? 0) as number;
  if (mine >= limit) {
    throw new Error(`${a.name} did this work but is closed, and you already have ${mine} live ${role.name} task(s), your limit. Retire one whose PR is merged, then delegate again.`);
  }
  run(`UPDATE agents SET retired_at = NULL WHERE id = ?`, id);
  const revived = getAgent(id)!;
  publish({ type: "agent.created", agent: { ...revived, status: "idle", dm_thread_id: dmThreadOf(id) } });
  return revived;
}

/** A task room's shared folder (/work/rooms/<title>-<id>), created on first use. */
export function ensureWorkspace(root: Agent): string {
  if (root.workspace) {
    fs.mkdirSync(path.join(root.workspace, "scripts"), { recursive: true });
    return root.workspace;
  }
  const base = slugify(root.label ?? root.name).slice(0, 40) || "task";
  const dir = path.join(WORK_ROOT, "rooms", `${base}-${root.id.slice(0, 6)}`);
  fs.mkdirSync(path.join(dir, "scripts"), { recursive: true });
  fs.mkdirSync(path.join(dir, "notes"), { recursive: true });
  const state = path.join(dir, "state.md");
  if (!fs.existsSync(state)) {
    fs.writeFileSync(state, `# ${root.label ?? root.name}: state

Where this work stands. Every agent in this work reads this first and updates it
at the end of a turn when something changed.

## Open

## Done

## Decisions

## Waiting on the owner
`);
  }
  run(`UPDATE agents SET workspace = ? WHERE id = ?`, dir, root.id);
  return dir;
}

/** The owner's "Add replica" on the agent panel: a blank task. */
export const spawnReplica = (roleId: string) => spawnInstance(roleId, { label: "New task", createdBy: "owner" });

/** Retire (finish) an instance: it leaves the live views; its history stays. */
export function retireReplica(id: string) {
  const a = getAgent(id);
  if (!a || a.retired_at) throw new Error("No such task");
  if (!a.base_agent_id) throw new Error(`${a.name} isn't an instance; only instances are retired`);
  run(`UPDATE agents SET retired_at = ? WHERE id = ?`, now(), id);
  run(`DELETE FROM thread_members WHERE agent_id = ?`, id);
  publish({ type: "agent.retired", agentId: id });
}

/** An instance and every instance started under it (retired ones included). */
export function instanceTree(rootId: string): Agent[] {
  return all<Agent>(
    `WITH RECURSIVE t(id) AS (SELECT ? UNION ALL SELECT a.id FROM agents a JOIN t ON a.parent_instance_id = t.id)
     SELECT agents.* FROM agents JOIN t USING (id) ORDER BY agents.created_at`,
    rootId,
  );
}

/** The top of the task room an instance belongs to. */
export function rootOf(a: Agent): Agent {
  let cur = a;
  for (let i = 0; i < 20 && cur.parent_instance_id; i++) cur = getAgent(cur.parent_instance_id) ?? cur;
  return cur;
}

export function setInstanceMeta(id: string, patch: { label?: string; kept?: boolean }) {
  const a = getAgent(id);
  if (!a || !a.base_agent_id) throw new Error("No such task");
  if (patch.label !== undefined) {
    const label = patch.label.trim().slice(0, 120);
    if (!label) throw new Error("Give the task a title");
    run(`UPDATE agents SET label = ? WHERE id = ?`, label, id);
  }
  if (patch.kept !== undefined) run(`UPDATE agents SET kept = ? WHERE id = ?`, patch.kept ? 1 : 0, id);
  const next = getAgent(id)!;
  publish({ type: "agent.updated", agent: next });
  return next;
}

export function deleteAgent(id: string) {
  const a = getAgent(id);
  if (!a) throw new Error("No such agent");
  if (a.base_agent_id) return retireReplica(id);
  if (a.builtin) throw new Error(`${a.name} is built into agentbox and can't be deleted`);
  // A base agent takes its replicas with it (they live in its home).
  const replicas = all<Agent>(`SELECT * FROM agents WHERE base_agent_id = ?`, id);
  run(`DELETE FROM agents WHERE id = ?`, id);
  fs.rmSync(homeOf(a), { recursive: true, force: true });
  for (const r of replicas) publish({ type: "agent.deleted", agentId: r.id });
  publish({ type: "agent.deleted", agentId: id });
}

/** An instance's conversation (roles have none). */
export function dmThreadOf(agentId: string): string | null {
  return get<{ id: string }>(`SELECT id FROM threads WHERE kind IN ('dm', 'routine') AND agent_id = ? ORDER BY kind = 'dm' DESC`, agentId)?.id ?? null;
}

export function listMemory(a: Agent) {
  const dir = memoryDir(a);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .sort((x, y) => (x === "MEMORY.md" ? -1 : y === "MEMORY.md" ? 1 : x.localeCompare(y)))
    .map((file) => ({ file, content: fs.readFileSync(path.join(dir, file), "utf8") }));
}
