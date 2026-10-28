import { all, get, newId, now, run } from "./db.ts";
import { publish } from "./bus.ts";
import { dmThreadOf, getAgent, instanceTree, rootOf, type Agent } from "./agents.ts";
import { isSetupAgent } from "./setup.ts";

/**
 * Roadmaps (docs/V2.1-PLAN.md §3): for big work, agents keep one or more labelled roadmaps of steps
 * (status, dependencies, phase, owner, link) that every agent on the work updates as it goes. The
 * owner sees them live (a card in the conversation, pills in the task header, a full map) without
 * reading the chat. Each roadmap belongs to a piece of work (the task tree's root); any instance in
 * that tree may read and update it. The work's instruction layer lists them, so agents keep them current.
 */

run(`CREATE TABLE IF NOT EXISTS roadmaps (
  id TEXT PRIMARY KEY,
  root_id TEXT NOT NULL,               -- the work (root instance) it belongs to
  created_by TEXT NOT NULL,            -- the instance that made it
  thread_id TEXT,                      -- where its card was posted
  title TEXT NOT NULL,
  status TEXT NOT NULL,                -- active | done | archived
  events TEXT NOT NULL DEFAULT '[]',   -- the last changes: [{ at, by, text }]
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`);
run(`CREATE INDEX IF NOT EXISTS roadmaps_root ON roadmaps(root_id, created_at)`);
run(`CREATE TABLE IF NOT EXISTS roadmap_items (
  roadmap_id TEXT NOT NULL REFERENCES roadmaps(id) ON DELETE CASCADE,
  id TEXT NOT NULL,                    -- the agent's short id, e.g. "schema"
  position INTEGER NOT NULL,
  title TEXT NOT NULL,
  phase TEXT NOT NULL DEFAULT '',
  after TEXT NOT NULL DEFAULT '[]',    -- ids of steps that come first
  status TEXT NOT NULL,                -- todo | doing | done | blocked | skipped
  owner TEXT NOT NULL DEFAULT '',      -- who's on it (e.g. coder#3)
  note TEXT NOT NULL DEFAULT '',       -- why it's blocked, what's left…
  link TEXT NOT NULL DEFAULT '',       -- a PR, issue or doc
  updated_at TEXT NOT NULL,
  updated_by TEXT,
  source_agent TEXT,                   -- the instance whose turn last changed it,
  source_task TEXT,                    -- and that turn: its reply is "the message" behind the step
  PRIMARY KEY (roadmap_id, id)
)`);
for (const col of ["source_agent", "source_task"]) {
  if (!all<{ name: string }>(`PRAGMA table_info(roadmap_items)`).some((c) => c.name === col)) run(`ALTER TABLE roadmap_items ADD COLUMN ${col} TEXT`);
}

export const LIMITS = { title: 60, item: 60, phase: 24, owner: 40, note: 200, link: 500, items: 40, active: 6, events: 20 };
export const STATUSES = ["todo", "doing", "done", "blocked", "skipped"] as const;
export type ItemStatus = (typeof STATUSES)[number];
export type Item = {
  id: string; title: string; phase: string; after: string[]; status: ItemStatus; owner: string; note: string; link: string;
  updated_at: string; updated_by: string | null; source_agent?: string | null; source_task?: string | null;
};
/** Where a step last changed: the agent's conversation, and the reply of the turn that changed it (once posted). */
export type ItemSource = { agent_id: string; agent_name: string; thread_id: string | null; message_id: string | null; at: string };
export type Roadmap = {
  id: string; root_id: string; created_by: string; thread_id: string | null; title: string; status: "active" | "done" | "archived";
  events: { at: string; by: string; text: string }[]; created_at: string; updated_at: string;
};

const httpError = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode });
const oneLine = (s: unknown) => String(s ?? "").replace(/[\x00-\x1f\x7f]/g, " ").replace(/\s+/g, " ").trim();
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$/;

function short(what: string, v: unknown, max: number, required = false): string {
  const s = oneLine(v);
  if (!s && required) throw new Error(`${what} is empty`);
  if (s.length > max) throw new Error(`${what} is ${s.length} characters; keep it to ${max}`);
  return s;
}
function status(v: unknown, what: string): ItemStatus {
  const s = String(v ?? "todo").trim().toLowerCase();
  if (!(STATUSES as readonly string[]).includes(s)) throw new Error(`${what}: status must be one of ${STATUSES.join(", ")}`);
  return s as ItemStatus;
}
function link(v: unknown, what: string): string {
  const s = short(`${what} link`, v, LIMITS.link);
  // #/… is a page in agentbox (e.g. a workspace a group launched).
  if (s && !/^https?:\/\/\S+$/.test(s) && !s.startsWith("/") && !/^#\/[\w\-/]+$/.test(s)) throw new Error(`${what} link: an http(s) URL or an absolute file path`);
  return s;
}

type ItemIn = { id?: unknown; title?: unknown; phase?: unknown; after?: unknown; status?: unknown; owner?: unknown; note?: unknown; link?: unknown };
function item(i: ItemIn, n: number): Omit<Item, "updated_at" | "updated_by"> {
  const id = String(i?.id ?? "").trim();
  if (!ID_RE.test(id)) throw new Error(`items[${n}].id "${id}": a short id (letters, digits, - _ .), e.g. "schema"`);
  return {
    id, title: short(`step "${id}" title`, i.title, LIMITS.item, true), phase: short(`step "${id}" phase`, i.phase, LIMITS.phase),
    after: Array.isArray(i.after) ? [...new Set(i.after.map((x) => String(x).trim()).filter(Boolean))] : i.after ? [String(i.after).trim()] : [],
    status: status(i.status, `step "${id}"`), owner: short(`step "${id}" owner`, i.owner, LIMITS.owner),
    note: short(`step "${id}" note`, i.note, LIMITS.note), link: link(i.link, `step "${id}"`),
  };
}

/** Every "after" names a step of this roadmap, and the steps can be done in some order (no cycles). */
function checkGraph(items: { id: string; after: string[] }[]) {
  const ids = new Set(items.map((i) => i.id));
  for (const i of items) for (const a of i.after) {
    if (!ids.has(a)) throw new Error(`step "${i.id}" comes after "${a}", which isn't a step of this roadmap`);
    if (a === i.id) throw new Error(`step "${i.id}" can't come after itself`);
  }
  const indeg = new Map(items.map((i) => [i.id, i.after.length]));
  const next = new Map<string, string[]>();
  for (const i of items) for (const a of i.after) next.set(a, [...(next.get(a) ?? []), i.id]);
  const queue = items.filter((i) => !i.after.length).map((i) => i.id);
  let seen = 0;
  while (queue.length) {
    const id = queue.shift()!;
    seen++;
    for (const n of next.get(id) ?? []) { indeg.set(n, indeg.get(n)! - 1); if (indeg.get(n) === 0) queue.push(n); }
  }
  if (seen !== items.length) throw new Error("The steps' \"after\" links go in a circle; a step can't (indirectly) come after itself");
}

// --- reading ---------------------------------------------------------------------------------------

const toRoadmap = (r: any): Roadmap => ({ ...r, events: JSON.parse(r.events || "[]") });
const toItem = (r: any): Item => ({ ...r, after: JSON.parse(r.after || "[]") });
export const getRoadmap = (id: string) => { const r = get<any>(`SELECT * FROM roadmaps WHERE id = ?`, id); return r ? toRoadmap(r) : null; };
export const itemsOf = (id: string) => all<any>(`SELECT * FROM roadmap_items WHERE roadmap_id = ? ORDER BY position`, id).map(toItem);
export const roadmapsOf = (rootId: string, opts: { archived?: boolean } = {}) =>
  all<any>(`SELECT * FROM roadmaps WHERE root_id = ? ${opts.archived ? "" : "AND status != 'archived'"} ORDER BY created_at`, rootId).map(toRoadmap);

export function counts(items: Item[]) {
  const c = { total: items.length, todo: 0, doing: 0, done: 0, blocked: 0, skipped: 0 };
  for (const i of items) c[i.status]++;
  return c;
}

/**
 * The message behind a step: the reply of the turn that last changed it (recorded since v2.1; for
 * older rows, the turn its updater was in at that time). Null until that agent's turn has a reply.
 */
export function itemSource(r: Roadmap, i: Item): ItemSource | null {
  let agentId = i.source_agent ?? null, taskId = i.source_task ?? null;
  if (!agentId && i.updated_by) {
    // Older rows only know the updater's name: find that instance in this work's task tree.
    agentId = instanceTree(r.root_id).find((a) => a.name === i.updated_by)?.id ?? null;
  }
  if (!agentId) return null;
  if (!taskId) {
    taskId = get<{ id: string }>(`SELECT id FROM tasks WHERE agent_id = ? AND created_at <= ? ORDER BY created_at DESC LIMIT 1`, agentId, i.updated_at)?.id ?? null;
  }
  const a = getAgent(agentId);
  if (!a) return null;
  const m = taskId ? get<{ id: string; thread_id: string }>(`SELECT id, thread_id FROM messages WHERE task_id = ? AND author = ? ORDER BY created_at DESC LIMIT 1`, taskId, agentId) : undefined;
  const thread = m?.thread_id ?? (taskId ? get<{ thread_id: string }>(`SELECT thread_id FROM tasks WHERE id = ?`, taskId)?.thread_id : null) ?? null;
  return { agent_id: a.id, agent_name: a.name, thread_id: thread, message_id: m?.id ?? null, at: i.updated_at };
}

export function roadmapView(r: Roadmap) {
  const items = itemsOf(r.id).map((i) => ({ ...i, source: itemSource(r, i) }));
  return { ...r, items, counts: counts(items), created_by_name: getAgent(r.created_by)?.name ?? null };
}
function announce(id: string) {
  const r = getRoadmap(id)!;
  publish({ type: "roadmap.updated", roadmap: roadmapView(r) });
  return r;
}

/** The roadmap an agent may change: one of its own work's (the same task tree). */
function mine(agent: Agent, ref: string): Roadmap {
  const root = rootOf(agent);
  const r = getRoadmap(ref) ?? roadmapsOf(root.id).find((x) => x.title.toLowerCase() === ref.trim().toLowerCase()) ?? null;
  if (!r || r.root_id !== root.id) throw new Error(`No roadmap "${ref}" in this work${roadmapsOf(root.id).length ? `. Roadmaps: ${roadmapsOf(root.id).map((x) => `${x.title} (${x.id})`).join(", ")}` : ""}`);
  if (r.status === "archived") throw new Error(`"${r.title}" was archived by the owner`);
  return r;
}

// --- writing ----------------------------------------------------------------------------------------

function postCard(threadId: string, id: string) {
  const message = { id: newId(), thread_id: threadId, author: "roadmap", task_id: null, content: id, created_at: now() };
  run(`INSERT INTO messages (id, thread_id, author, task_id, content, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    message.id, message.thread_id, message.author, message.task_id, message.content, message.created_at);
  publish({ type: "message.created", message });
}

function event(r: Roadmap, by: string, texts: string[]) {
  if (!texts.length) return;
  const events = [...texts.map((text) => ({ at: now(), by, text })).reverse(), ...r.events].slice(0, LIMITS.events);
  run(`UPDATE roadmaps SET events = ? WHERE id = ?`, JSON.stringify(events), r.id);
}

/** Done when every step is done or skipped; active again as soon as one isn't. */
function settle(id: string) {
  const r = getRoadmap(id)!;
  if (r.status === "archived") return;
  const items = itemsOf(id);
  const finished = items.length > 0 && items.every((i) => i.status === "done" || i.status === "skipped");
  const next = finished ? "done" : "active";
  if (next !== r.status) run(`UPDATE roadmaps SET status = ? WHERE id = ?`, next, id);
}

export function createRoadmap(agent: Agent, taskId: string | null, input: { title?: unknown; items?: unknown }) {
  if (!agent.base_agent_id || isSetupAgent(agent)) throw new Error("Roadmaps belong to tasks (the setup agent uses its checklist)");
  const root = rootOf(agent);
  const title = short("title", input?.title, LIMITS.title, true);
  if (roadmapsOf(root.id).some((r) => r.title.toLowerCase() === title.toLowerCase())) throw new Error(`This work already has a roadmap "${title}"; update it, or give the new one its own label`);
  if (roadmapsOf(root.id).filter((r) => r.status === "active").length >= LIMITS.active) throw new Error(`This work has ${LIMITS.active} active roadmaps; finish or merge some first`);
  const raw = Array.isArray(input?.items) ? input.items : [];
  if (!raw.length) throw new Error("items: give the steps (at least one)");
  if (raw.length > LIMITS.items) throw new Error(`${raw.length} steps; keep it to ${LIMITS.items} (merge small ones, or split into labelled roadmaps)`);
  const items = raw.map((i: ItemIn, n: number) => item(i, n + 1));
  const dup = items.find((i: { id: string }, n: number) => items.findIndex((j: { id: string }) => j.id === i.id) !== n);
  if (dup) throw new Error(`The step id "${dup.id}" is used twice`);
  checkGraph(items);
  const id = newId();
  const at = now();
  const threadId = (taskId ? get<{ thread_id: string }>(`SELECT thread_id FROM tasks WHERE id = ?`, taskId)?.thread_id : null) ?? dmThreadOf(agent.id);
  run(`INSERT INTO roadmaps (id, root_id, created_by, thread_id, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`,
    id, root.id, agent.id, threadId, title, at, at);
  items.forEach((i: Omit<Item, "updated_at" | "updated_by">, n: number) => run(
    `INSERT INTO roadmap_items (roadmap_id, id, position, title, phase, after, status, owner, note, link, updated_at, updated_by, source_agent, source_task) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id, i.id, n, i.title, i.phase, JSON.stringify(i.after), i.status, i.owner, i.note, i.link, at, agent.name, agent.id, taskId,
  ));
  event(getRoadmap(id)!, agent.name, [`created with ${items.length} steps`]);
  settle(id);
  if (threadId) postCard(threadId, id);
  return announce(id);
}

export type UpdateInput = {
  roadmap: string;
  title?: unknown;
  items?: (ItemIn & { id: unknown })[]; // changes to existing steps (only the fields given)
  add?: ItemIn[];
  remove?: unknown[];
};

export function updateRoadmap(agent: Agent, input: UpdateInput, taskId: string | null = null) {
  const r = mine(agent, String(input?.roadmap ?? ""));
  const current = itemsOf(r.id);
  const byId = new Map(current.map((i) => [i.id, { ...i }]));
  const texts: string[] = [];
  const at = now();

  for (const id of (Array.isArray(input.remove) ? input.remove : []).map((x) => String(x).trim())) {
    if (!byId.delete(id)) throw new Error(`No step "${id}" to remove`);
    texts.push(`removed "${id}"`);
  }
  for (const [n, raw] of (Array.isArray(input.add) ? input.add : []).entries()) {
    const i = item(raw, n + 1);
    if (byId.has(i.id)) throw new Error(`There's already a step "${i.id}"; change it with items instead`);
    byId.set(i.id, { ...i, updated_at: at, updated_by: agent.name, source_agent: agent.id, source_task: taskId });
    texts.push(`added "${i.title}"`);
  }
  const changed = new Set<string>();
  for (const raw of Array.isArray(input.items) ? input.items : []) {
    const id = String(raw?.id ?? "").trim();
    const cur = byId.get(id);
    if (!cur) throw new Error(`No step "${id}"${byId.size ? ` (steps: ${[...byId.keys()].join(", ")})` : ""}`);
    const next = { ...cur };
    if (raw.title !== undefined) next.title = short(`step "${id}" title`, raw.title, LIMITS.item, true);
    if (raw.phase !== undefined) next.phase = short(`step "${id}" phase`, raw.phase, LIMITS.phase);
    if (raw.after !== undefined) next.after = Array.isArray(raw.after) ? [...new Set(raw.after.map((x) => String(x).trim()).filter(Boolean))] : [];
    if (raw.owner !== undefined) next.owner = short(`step "${id}" owner`, raw.owner, LIMITS.owner);
    if (raw.note !== undefined) next.note = short(`step "${id}" note`, raw.note, LIMITS.note);
    if (raw.link !== undefined) next.link = link(raw.link, `step "${id}"`);
    if (raw.status !== undefined) {
      next.status = status(raw.status, `step "${id}"`);
      if (next.status !== cur.status) texts.push(`${next.title}: ${cur.status} → ${next.status}${next.status === "blocked" && next.note ? ` (${next.note})` : ""}`);
    }
    next.updated_at = at;
    next.updated_by = agent.name;
    next.source_agent = agent.id;
    next.source_task = taskId;
    byId.set(id, next);
    changed.add(id);
  }
  const items = [...byId.values()];
  if (items.length > LIMITS.items) throw new Error(`${items.length} steps; keep it to ${LIMITS.items}`);
  if (!items.length) throw new Error("A roadmap needs at least one step");
  checkGraph(items);
  let title = r.title;
  if (input.title !== undefined) {
    title = short("title", input.title, LIMITS.title, true);
    if (title.toLowerCase() !== r.title.toLowerCase() && roadmapsOf(r.root_id).some((x) => x.id !== r.id && x.title.toLowerCase() === title.toLowerCase())) {
      throw new Error(`This work already has a roadmap "${title}"`);
    }
    if (title !== r.title) texts.push(`renamed to "${title}"`);
  }

  // Keep existing order; new steps go after the steps they follow (or at the end).
  const order = current.filter((i) => byId.has(i.id)).map((i) => i.id);
  for (const i of items) if (!order.includes(i.id)) order.push(i.id);
  run(`DELETE FROM roadmap_items WHERE roadmap_id = ?`, r.id);
  order.forEach((id, n) => {
    const i = byId.get(id)!;
    run(`INSERT INTO roadmap_items (roadmap_id, id, position, title, phase, after, status, owner, note, link, updated_at, updated_by, source_agent, source_task) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      r.id, i.id, n, i.title, i.phase, JSON.stringify(i.after), i.status, i.owner, i.note, i.link, i.updated_at, i.updated_by, i.source_agent ?? null, i.source_task ?? null);
  });
  run(`UPDATE roadmaps SET title = ?, updated_at = ? WHERE id = ?`, title, at, r.id);
  event(getRoadmap(r.id)!, agent.name, texts);
  settle(r.id);
  return announce(r.id);
}

/** The owner hides a roadmap (agents stop seeing it) or brings it back. */
export function archiveRoadmap(id: string, archived: boolean) {
  const r = getRoadmap(id);
  if (!r) throw httpError(404, "No such roadmap");
  run(`UPDATE roadmaps SET status = ?, updated_at = ? WHERE id = ?`, archived ? "archived" : "active", now(), id);
  if (!archived) settle(id);
  return announce(id);
}

// --- what agents see ---------------------------------------------------------------------------------

const MARK: Record<ItemStatus, string> = { todo: " ", doing: ">", done: "x", blocked: "!", skipped: "-" };

/** The work layer's section: every roadmap of this work, compactly, so agents keep them current. */
export function roadmapNote(agent: Agent): string {
  if (!agent.base_agent_id || isSetupAgent(agent)) return "";
  const list = roadmapsOf(rootOf(agent).id);
  if (!list.length) return "";
  const body = list.map((r) => {
    const items = itemsOf(r.id);
    const c = counts(items);
    const lines = items.map((i) => `  [${MARK[i.status]}] ${i.id}: ${i.title}${i.owner ? ` (${i.owner})` : ""}${i.status === "blocked" && i.note ? ` — blocked: ${i.note}` : ""}`);
    return `- **${r.title}** (id ${r.id}${r.status === "done" ? ", done" : ""}): ${c.done}/${c.total} done${c.doing ? `, ${c.doing} in progress` : ""}${c.blocked ? `, ${c.blocked} blocked` : ""}\n${lines.join("\n")}`;
  }).join("\n");
  return `## Roadmaps of this work
The owner follows progress here instead of reading the chat. When you start a step, finish one (add its PR/issue as the
link), get blocked (say why in the note) or the plan changes, update it right away with \`mcp__team__roadmap_update\`.
Blocked on the owner? Put the decision itself in the note ("Delete, archive or keep the 7 undeployed projects?") and
ask it, with the facts they need, in your reply in the same turn: clicking the step takes the owner to that reply.
[x] done, [>] in progress, [!] blocked, [-] skipped, [ ] to do.
${body}`;
}

/** Live roadmaps of a task's whole tree, for the portal. */
export function workRoadmaps(instanceId: string, opts: { archived?: boolean } = {}) {
  const a = getAgent(instanceId);
  if (!a || !a.base_agent_id) throw httpError(404, "No such task");
  const root = rootOf(a);
  return { root_id: root.id, roadmaps: roadmapsOf(root.id, opts).map(roadmapView) };
}

