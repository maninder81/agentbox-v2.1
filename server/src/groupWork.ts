import type { FastifyInstance } from "fastify";
import { all, get, newId, now, run } from "./db.ts";
import { publish, subscribe } from "./bus.ts";
import { dmThreadOf, getAgent, listAgents, rootOf, spawnInstance, type Agent } from "./agents.ts";
import { enqueueTask, taskRow } from "./runner.ts";
import { getGroup, groupInstance, type Group } from "./groups.ts";
import { counts, createRoadmap, getRoadmap, itemsOf, roadmapsOf, updateRoadmap } from "./roadmaps.ts";
import { bindRepo, getRepo, roleAllowed } from "./repos.ts";
import { crewIdOf, crewName, sameCrew } from "./crews.ts";
import { addLink, linksOf, removeLink } from "./linkedWork.ts";
import { finishTree, instanceSummary } from "./work.ts";

/**
 * Group workspaces: the owner sets the high-level direction in a group, and the group's lead turns each
 * independent item into a workspace (a task room of its own, under Work), staffed from its crew. The lead
 * keeps one roadmap for the group, a step per workspace, that agentbox moves along (launched → doing,
 * a question waiting → blocked, finished → done); reads each workspace (linked work); sends them
 * instructions; and is asked first when a workspace needs a decision: questions from a workspace's
 * agents go to the group lead, whose answer comes back as their report. Only what the lead can't
 * decide reaches the owner (its own ask_owner). That keeps the owner on direction, not delegation.
 */

run(`CREATE TABLE IF NOT EXISTS group_workspaces (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL,
  root_id TEXT NOT NULL UNIQUE,        -- the workspace's lead task (a top-level instance)
  item_id TEXT NOT NULL,               -- its step on the group's roadmap
  title TEXT NOT NULL,
  question TEXT,                       -- a question from the workspace waiting on the group lead
  question_task TEXT,                  -- the group lead's task answering it
  created_at TEXT NOT NULL
)`);
run(`CREATE TABLE IF NOT EXISTS group_programs (
  group_id TEXT PRIMARY KEY,
  roadmap_id TEXT NOT NULL             -- the group's roadmap (one step per workspace)
)`);

export const LIMITS = { live: 8, brief: 20_000 };
export const CREATOR = "glead:";

type Row = { id: string; group_id: string; root_id: string; item_id: string; title: string; question: string | null; question_task: string | null; created_at: string };

const httpError = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode });
const changed = (groupId: string) => publish({ type: "group.workspaces", groupId });

/** The group an instance leads: its group conversation's instance of the group's lead agent. */
export function ledGroup(agent: Agent): Group | undefined {
  const by = agent.created_by ?? "";
  if (!agent.base_agent_id || !by.startsWith("group:")) return undefined;
  const g = getGroup(by.slice(6));
  return g && g.lead_agent_id === agent.base_agent_id ? g : undefined;
}

/** The workspace (row) an instance works in, if its work was launched from a group. */
export function workspaceOf(agent: Agent): Row | undefined {
  if (!agent.base_agent_id) return undefined;
  const root = rootOf(agent);
  if (!root.created_by?.startsWith(CREATOR)) return undefined;
  return get<Row>(`SELECT * FROM group_workspaces WHERE root_id = ?`, root.id);
}

const rowsOf = (groupId: string) => all<Row>(`SELECT * FROM group_workspaces WHERE group_id = ? ORDER BY created_at`, groupId);
const isLive = (r: Row) => { const a = getAgent(r.root_id); return !!a && !a.retired_at; };

/** The group's roadmap, if it has one still showing. */
function programOf(groupId: string) {
  const p = get<{ roadmap_id: string }>(`SELECT roadmap_id FROM group_programs WHERE group_id = ?`, groupId);
  const r = p ? getRoadmap(p.roadmap_id) : null;
  return r && r.status !== "archived" ? r : null;
}

/** Move a workspace's step on the group roadmap (as whoever made the roadmap). Never fails the caller. */
function setStep(row: Row, change: { status?: string; note?: string; owner?: string }) {
  const r = programOf(row.group_id);
  if (!r) return;
  const by = getAgent(r.created_by);
  if (!by || !itemsOf(r.id).some((i) => i.id === row.item_id)) return;
  try { updateRoadmap(by, { roadmap: r.id, items: [{ id: row.item_id, ...change }] }); } catch (e) { console.error("groupWork: roadmap step", e); }
}

const stepId = (title: string, taken: Set<string>) => {
  const base = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30) || "ws";
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  return id;
};

/** Find one of this group's workspaces by its title, step id, lead's name or id. */
function mustWorkspace(group: Group, ref: string): Row {
  const k = String(ref ?? "").trim().toLowerCase();
  const rows = rowsOf(group.id);
  const hit = rows.find((r) => r.root_id === ref || r.item_id === k || r.title.toLowerCase() === k || getAgent(r.root_id)?.name.toLowerCase() === k)
    ?? rows.find((r) => r.title.toLowerCase().includes(k));
  if (!hit) throw new Error(`No workspace "${ref}" in #${group.name}. Workspaces: ${rows.map((r) => `"${r.title}" (${getAgent(r.root_id)?.name})`).join(", ") || "none yet"}`);
  return hit;
}

export function launchWorkspace(agent: Agent, taskId: string, input: { title?: unknown; brief?: unknown; lead?: unknown; repos?: unknown; after?: unknown }) {
  const group = ledGroup(agent);
  if (!group) throw new Error("Only a group's lead, in its group, launches workspaces.");
  const title = String(input.title ?? "").replace(/\s+/g, " ").trim().slice(0, 60);
  const brief = String(input.brief ?? "").trim();
  if (!title) throw new Error("Give the workspace a short title (it's the roadmap step too)");
  if (!brief) throw new Error("Write the brief: the goal, scope, constraints, what done looks like");
  if (brief.length > LIMITS.brief) throw new Error(`The brief is ${brief.length} characters; keep it to ${LIMITS.brief}`);
  const live = rowsOf(group.id).filter(isLive);
  if (live.length >= LIMITS.live) throw new Error(`#${group.name} has ${live.length} live workspaces, the limit. Finish some first (finish_workspace).`);
  // Who leads it: an agent of your crew (default: your own agent, e.g. a fresh tech-lead).
  const ref = String(input.lead ?? "").trim().toLowerCase().replace(/^@/, "");
  const role = ref
    ? listAgents().find((a) => !a.base_agent_id && !a.builtin && (a.slug === ref || a.name.toLowerCase() === ref))
    : getAgent(agent.base_agent_id!);
  if (!role || role.base_agent_id || role.builtin) throw new Error(`No agent called "${input.lead}"`);
  if (!sameCrew(agent, role)) throw new Error(`${role.name} is in ${crewName(crewIdOf(role))}, not your crew: staff workspaces from your own crew`);
  const repos = [...new Set((Array.isArray(input.repos) ? input.repos : []).map((x) => String(x).trim()).filter(Boolean))];
  for (const n of repos) {
    const repo = getRepo(n);
    if (!repo || repo.status === "archived") throw new Error(`No repo called "${n}"`);
    if (repo.status !== "ready") throw new Error(`${repo.name} isn't ready (${repo.status})`);
    if (!roleAllowed(repo, role)) throw new Error(`${role.name} isn't allowed to use ${repo.name}`);
  }

  // The step first (it can fail on a bad "after"), then the workspace.
  const program = programOf(group.id);
  const taken = new Set(program ? itemsOf(program.id).map((i) => i.id) : []);
  const item = stepId(title, taken);
  const after = (Array.isArray(input.after) ? input.after : []).map((x) => String(x).trim()).filter((x) => taken.has(x));
  const inst = spawnInstance(role.id, { label: title, createdBy: `${CREATOR}${group.id}`, asLead: true });
  const step = { id: item, title, owner: inst.name, status: "doing", link: `#/work/${inst.id}`, after };
  try {
    if (program) updateRoadmap(getAgent(program.created_by) ?? agent, { roadmap: program.id, add: [step] });
    else {
      const r = createRoadmap(agent, taskId, { title: `Workspaces · #${group.name}`.slice(0, 60), items: [step] });
      run(`INSERT INTO group_programs (group_id, roadmap_id) VALUES (?, ?) ON CONFLICT (group_id) DO UPDATE SET roadmap_id = excluded.roadmap_id`, group.id, r.id);
    }
  } catch (e) {
    run(`UPDATE agents SET retired_at = ? WHERE id = ?`, now(), inst.id);
    throw e;
  }
  run(`INSERT INTO group_workspaces (id, group_id, root_id, item_id, title, created_at) VALUES (?, ?, ?, ?, ?, ?)`, newId(), group.id, inst.id, item, title, now());
  for (const n of repos) bindRepo(inst, n);
  // The group lead reads it like linked work (progress, conversation, documents).
  try { addLink(agent.id, inst.id); } catch (e) { console.error("groupWork: link", e); }
  enqueueTask({
    agentId: inst.id, threadId: dmThreadOf(inst.id)!, source: "agent", title,
    prompt: `[agentbox] Workspace from ${agent.name}, the lead of #${group.name} (${agent.title})

Title: ${title}

${brief}

You lead this workspace: plan it, delegate and see it through, as you would for the owner. ${agent.name}
oversees it from the group: your reply to this message goes back to them as your first report.${repos.length ? `\n\nRepos for this work: ${repos.join(", ")}.` : ""}`,
    fromAgentId: agent.id, parentTaskId: null, depth: 1,
    input: { author: agent.id, content: `**${title}**\n\n${brief}` },
  });
  changed(group.id);
  return inst;
}

/** What the group lead (and the owner's group page) see: each workspace and where it stands. */
export function workspacesView(groupId: string) {
  const program = programOf(groupId);
  const items = program ? itemsOf(program.id) : [];
  return rowsOf(groupId).map((r) => {
    const root = getAgent(r.root_id);
    const maps = root ? roadmapsOf(root.id).map((m: any) => ({ title: m.title, ...counts(itemsOf(m.id)) })) : [];
    return {
      id: r.id, title: r.title, root_id: r.root_id, item_id: r.item_id, created_at: r.created_at,
      question: r.question, step: items.find((i) => i.id === r.item_id)?.status ?? null,
      lead: root ? instanceSummary(root) : null, roadmaps: maps,
    };
  });
}

function describe(groupId: string) {
  const ws = workspacesView(groupId);
  if (!ws.length) return "No workspaces yet.";
  return ws.map((w) => {
    const l = w.lead;
    const state = !l ? "deleted" : l.status === "done" ? "finished" : `${l.status}${l.current ? `, on "${l.current}"` : ""}${l.queued ? `, ${l.queued} queued` : ""}`;
    const maps = w.roadmaps.map((m) => `${m.title} ${m.done}/${m.total}${m.blocked ? ` (${m.blocked} blocked)` : ""}`).join("; ");
    return `- "${w.title}" — ${l?.name ?? "?"}: ${state}${maps ? ` · roadmap ${maps}` : ""}${w.question ? ` · ASKS YOU: ${w.question}` : ""} (id ${w.root_id})`;
  }).join("\n");
}

/** Instructions or an answer to a workspace's lead, as a task: its reply comes back to the group lead. */
export function messageWorkspace(agent: Agent, taskId: string, ref: string, text: string) {
  const group = ledGroup(agent);
  if (!group) throw new Error("Only a group's lead, in its group, does this.");
  const row = mustWorkspace(group, ref);
  const root = getAgent(row.root_id);
  if (!root || root.retired_at) throw new Error(`"${row.title}" is finished`);
  const body = String(text ?? "").trim();
  if (!body) throw new Error("Say what they should do");
  enqueueTask({
    agentId: root.id, threadId: dmThreadOf(root.id)!, source: "agent", title: `From #${group.name}: ${body.split("\n")[0].slice(0, 80)}`,
    prompt: `[agentbox] From ${agent.name}, the lead of #${group.name}, who oversees this workspace:\n\n${body}\n\nYour reply goes back to ${agent.name}.`,
    fromAgentId: agent.id, parentTaskId: null, depth: 1,
    input: { author: agent.id, content: body },
  });
  if (row.question) { run(`UPDATE group_workspaces SET question = NULL WHERE id = ?`, row.id); setStep(row, { status: "doing", note: "" }); }
  changed(group.id);
  return root;
}

export function finishWorkspace(agent: Agent, ref: string) {
  const group = ledGroup(agent);
  if (!group) throw new Error("Only a group's lead, in its group, does this.");
  const row = mustWorkspace(group, ref);
  finishTree(row.root_id);
  setStep(row, { status: "done", note: "" });
  changed(group.id);
  return row;
}

/** The group lead's note in the group: posted as itself, nobody woken. */
export function postToGroup(agent: Agent, text: string) {
  const group = ledGroup(agent);
  if (!group) throw new Error("Only a group's lead does this.");
  const content = String(text ?? "").trim();
  if (!content) throw new Error("Nothing to post");
  const message = { id: newId(), thread_id: group.id, author: agent.id, task_id: null, content, created_at: now() };
  run(`INSERT INTO messages (id, thread_id, author, task_id, content, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    message.id, message.thread_id, message.author, message.task_id, message.content, message.created_at);
  publish({ type: "message.created", message });
  return message;
}

/**
 * ask_owner from inside a workspace a group launched: it goes to the group's lead first, as a task whose
 * reply is the answer (it comes back to the asker as a report). Returns the lead's name, or null when
 * this isn't group work (then it goes to the owner as usual).
 */
export function askGroupLead(agent: Agent, taskId: string, question: string): string | null {
  const row = workspaceOf(agent);
  if (!row) return null;
  const group = getGroup(row.group_id);
  if (!group?.lead_agent_id) return null;
  let lead: Agent;
  try { lead = groupInstance(group, group.lead_agent_id); } catch { return null; }
  if (lead.id === agent.id) return null;
  const from = taskRow(taskId);
  const t = enqueueTask({
    agentId: lead.id, threadId: dmThreadOf(lead.id)!, source: "agent", title: `Question from "${row.title}"`,
    prompt: `[agentbox] ${agent.name} (${agent.title}) in the workspace "${row.title}" (one #${group.name} launched) needs a decision:

${question}

Answer it yourself if you can: you set this work's direction, so routine and technical calls are yours. Your reply goes
straight back to ${agent.name} as the answer. Only if it's truly the owner's call (spend, a breaking or risky change,
product direction, access) call mcp__team__ask_owner with the context and your recommendation, then reply to
${agent.name} with what to do meanwhile.`,
    fromAgentId: agent.id, parentTaskId: taskId, depth: Math.min((from?.depth ?? 0) + 1, 3),
    input: { author: agent.id, content: `**Question from "${row.title}"**\n\n${question}` },
  });
  run(`UPDATE group_workspaces SET question = ?, question_task = ? WHERE id = ?`, question.slice(0, 500), t.id, row.id);
  setStep(row, { status: "blocked", note: `asks: ${question}`.slice(0, 200) });
  changed(row.group_id);
  return lead.name;
}

// --- what the agents are told ----------------------------------------------------------------------

/** For the lead of a group: how to run workspaces from it. In its instructions every turn. */
export function groupLeadNote(agent: Agent): string {
  const group = ledGroup(agent);
  if (!group) return "";
  const ws = rowsOf(group.id).filter(isLive).length;
  return `## You lead #${group.name}
The owner sets the direction in #${group.name}; you turn it into work and run it. When the owner asks for items or
areas to be worked on, give each independent one its own **workspace**: \`mcp__team__launch_workspace\` (a short
title, a complete brief, who leads it from your crew, repos). Each is a step on the group's roadmap, which agentbox
keeps current. Only launch what the owner asked for; at most ${LIMITS.live} live at once (now ${ws}).
- Follow them: \`mcp__team__list_workspaces\`, and \`mcp__team__read_linked_work\` for one's progress or conversation.
- Steer them: \`mcp__team__message_workspace\` (their reply comes back to you). Close one that's done with
  \`mcp__team__finish_workspace\`.
- Their questions come to you first. Decide what you can; only the owner's own calls go to \`mcp__team__ask_owner\`.
- Reports and questions reach you outside the group. Tell the group what the owner should know with
  \`mcp__team__post_to_group\` (a short status, a finished item, a decision you need): not every step.
`;
}

/** For everyone working in a workspace a group launched. */
export function workspaceNote(agent: Agent): string {
  const row = workspaceOf(agent);
  if (!row) return "";
  const group = getGroup(row.group_id);
  const lead = group?.lead_agent_id ? getAgent(group.lead_agent_id) : undefined;
  return `## This workspace comes from #${group?.name ?? "a group"}
"${row.title}" was launched by ${lead?.name ?? "the group's lead"}, who leads #${group?.name ?? "the group"} for the owner and oversees this work.
mcp__team__ask_owner reaches ${lead?.name ?? "that lead"} first; they answer, or take it to the owner if it's truly theirs.
`;
}

// --- keeping the roadmap current -------------------------------------------------------------------

subscribe((e) => {
  // A workspace finished (marked done by the owner, or by the group lead): its step is done.
  if (e.type === "agent.retired") {
    const row = get<Row>(`SELECT * FROM group_workspaces WHERE root_id = ?`, e.agentId);
    if (row) {
      setStep(row, { status: "done", note: "" });
      // The group lead's reading link frees up for the next workspace (links are capped).
      const g = getGroup(row.group_id);
      const lead = g?.lead_agent_id ? listAgents().find((a) => a.base_agent_id === g.lead_agent_id && a.created_by === `group:${g.id}`) : undefined;
      if (lead) for (const l of linksOf(lead.id).links.filter((l) => l.work.id === row.root_id)) { try { removeLink(l.id); } catch { /* already gone */ } }
      changed(row.group_id);
    }
  }
  // The group lead answered a workspace's question: unblock its step.
  if (e.type === "task.updated" && ["done", "failed", "stopped"].includes(e.task?.status)) {
    const row = get<Row>(`SELECT * FROM group_workspaces WHERE question_task = ?`, e.task.id);
    if (row) {
      run(`UPDATE group_workspaces SET question = NULL, question_task = NULL WHERE id = ?`, row.id);
      setStep(row, { status: "doing", note: "" });
      changed(row.group_id);
    }
  }
});

export function registerGroupWorkRoutes(app: FastifyInstance) {
  app.get("/api/groups/:id/workspaces", async (req) => {
    const group = getGroup((req.params as any).id);
    if (!group) throw httpError(404, "No such group");
    const lead = group.lead_agent_id
      ? listAgents().find((a) => a.base_agent_id === group.lead_agent_id && a.created_by === `group:${group.id}`) : undefined;
    const program = programOf(group.id);
    return { lead_instance_id: program ? getRoadmap(program.id)!.root_id : lead?.id ?? null, workspaces: workspacesView(group.id) };
  });
}

export { describe as describeWorkspaces };
