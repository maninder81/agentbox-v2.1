import { attachmentsForAgent } from "./uploads.ts";
import { all, get, newId, now, run } from "./db.ts";
import { publish } from "./bus.ts";
import { getAgent, listAgents, spawnInstance, type Agent } from "./agents.ts";
import { enqueueTask } from "./runner.ts";

/**
 * Group chats: the owner and several agents in one thread. A message from the owner goes to
 * every @mentioned member, or to the lead when nobody is mentioned. An agent's reply is posted
 * to the group, and its @mentions pass the next step to those members. Each agent keeps its
 * own session per group and is shown the messages it missed since its last reply.
 */

// Agent turns per owner message before the group pauses for the owner: none by default (agents stop on
// their own; nothing should wait on the owner). Set AGENTBOX_GROUP_TURN_LIMIT to bring a cap back.
export const TURN_LIMIT = Number(process.env.AGENTBOX_GROUP_TURN_LIMIT) > 0 ? Number(process.env.AGENTBOX_GROUP_TURN_LIMIT) : Infinity;
/** What an agent replies when it has nothing to add; agentbox posts nothing. */
export const NO_REPLY = "NO_REPLY";
export const isNoReply = (text: string) => text.trim().replace(/[`*.]/g, "") === NO_REPLY;

export type Group = {
  id: string; name: string; purpose: string; lead_agent_id: string | null; members: string[];
  paused: boolean; created_at: string;
};

export function getGroup(id: string): Group | undefined {
  const t = get(`SELECT * FROM threads WHERE id = ? AND kind = 'group'`, id);
  if (!t) return undefined;
  const members = all<{ agent_id: string }>(`SELECT agent_id FROM thread_members WHERE thread_id = ?`, id).map((r) => r.agent_id);
  return {
    id: t.id, name: t.name, purpose: t.purpose ?? "", lead_agent_id: t.lead_agent_id, members,
    paused: !!t.paused_mentions, created_at: t.created_at,
  };
}

export const listGroups = () =>
  all<{ id: string }>(`SELECT id FROM threads WHERE kind = 'group' ORDER BY created_at`).map((r) => getGroup(r.id)!);

export const groupsOf = (agentId: string) => listGroups().filter((g) => g.members.includes(agentId));

function validate(input: { name: string; members: string[]; lead: string | null }) {
  const name = input.name.trim().toLowerCase().replace(/^#/, "").replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  if (!name) throw new Error("Give the group a name");
  // Members are agents (roles); an instance picked by mistake counts as its agent.
  const members = [...new Set(input.members.map((id) => getAgent(id)?.base_agent_id ?? id))];
  if (members.length === 0) throw new Error("Pick at least one member");
  for (const id of members) if (!getAgent(id)) throw new Error("Unknown agent in members");
  const leadRole = input.lead ? getAgent(input.lead)?.base_agent_id ?? input.lead : null;
  const lead = leadRole && members.includes(leadRole) ? leadRole : members[0];
  return { name, members, lead };
}

export function createGroup(input: { name: string; purpose: string; members: string[]; lead: string | null }) {
  const v = validate(input);
  if (get(`SELECT 1 FROM threads WHERE kind = 'group' AND name = ?`, v.name)) throw new Error(`#${v.name} already exists`);
  const id = newId();
  run(
    `INSERT INTO threads (id, kind, name, purpose, lead_agent_id, created_at) VALUES (?, 'group', ?, ?, ?, ?)`,
    id, v.name, input.purpose.trim(), v.lead, now(),
  );
  for (const m of v.members) run(`INSERT INTO thread_members (thread_id, agent_id) VALUES (?, ?)`, id, m);
  const g = getGroup(id)!;
  publish({ type: "group.updated", group: g });
  return g;
}

export function updateGroup(id: string, input: { name: string; purpose: string; members: string[]; lead: string | null }) {
  if (!getGroup(id)) throw new Error("No such group");
  const v = validate(input);
  if (get(`SELECT 1 FROM threads WHERE kind = 'group' AND name = ? AND id != ?`, v.name, id)) throw new Error(`#${v.name} already exists`);
  run(`UPDATE threads SET name = ?, purpose = ?, lead_agent_id = ? WHERE id = ?`, v.name, input.purpose.trim(), v.lead, id);
  run(`DELETE FROM thread_members WHERE thread_id = ?`, id);
  for (const m of v.members) run(`INSERT INTO thread_members (thread_id, agent_id) VALUES (?, ?)`, id, m);
  const g = getGroup(id)!;
  publish({ type: "group.updated", group: g });
  return g;
}

export function deleteGroup(id: string) {
  if (!getGroup(id)) throw new Error("No such group");
  const busy = get(`SELECT 1 FROM tasks WHERE thread_id = ? AND status IN ('queued', 'running')`, id);
  if (busy) throw new Error("Agents are still replying in this group; wait or stop them first");
  run(`DELETE FROM threads WHERE id = ?`, id);
  publish({ type: "group.deleted", id });
}

/** Member ids @mentioned in `text` (by slug or name), in order, excluding `except`. */
/** Member agents (roles) @mentioned in `text`, in order, excluding the agent `except` (a role or instance). */
export function mentions(group: Group, text: string, except?: string): string[] {
  except = except ? getAgent(except)?.base_agent_id ?? except : except;
  const members = group.members.map((id) => getAgent(id)).filter(Boolean) as Agent[];
  const found: string[] = [];
  for (const m of text.matchAll(/@([A-Za-z0-9][A-Za-z0-9_-]*)/g)) {
    const k = m[1].toLowerCase();
    const a = members.find((x) => x.slug === k || x.name.toLowerCase() === k);
    if (a && a.id !== except && !found.includes(a.id)) found.push(a.id);
  }
  return found;
}

/** Agent turns taken in this group since the owner last spoke. */
function turnsSinceOwner(groupId: string) {
  const last = get<{ created_at: string }>(
    `SELECT created_at FROM messages WHERE thread_id = ? AND author = 'user' ORDER BY created_at DESC LIMIT 1`, groupId,
  )?.created_at ?? "";
  return (get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM tasks WHERE thread_id = ? AND source = 'group' AND created_at > ?`, groupId, last,
  )?.n ?? 0) as number;
}

function systemNote(groupId: string, content: string) {
  const message = { id: newId(), thread_id: groupId, author: "system", task_id: null, content, created_at: now() };
  run(
    `INSERT INTO messages (id, thread_id, author, task_id, content, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    message.id, message.thread_id, message.author, message.task_id, message.content, message.created_at,
  );
  publish({ type: "message.created", message });
}

/** The member agent's instance for this group's conversation (one per agent per group). */
export function groupInstance(group: Group, roleId: string) {
  const live = listAgents().find((a) => a.base_agent_id === roleId && a.created_by === `group:${group.id}`);
  return live ?? spawnInstance(roleId, { label: `#${group.name}`, createdBy: `group:${group.id}` });
}

/** Give each target agent a turn in the group, unless it already has one waiting. */
function trigger(group: Group, roleTargets: string[], why: string) {
  const targets = roleTargets.map((r) => groupInstance(group, r).id);
  const remaining = TURN_LIMIT - turnsSinceOwner(group.id);
  const queued = new Set(
    all<{ agent_id: string }>(`SELECT agent_id FROM tasks WHERE thread_id = ? AND status = 'queued'`, group.id).map((r) => r.agent_id),
  );
  const fresh = targets.filter((id) => !queued.has(id));
  const now_ = fresh.slice(0, Math.max(0, remaining));
  const later = fresh.slice(now_.length);
  for (const id of now_) {
    enqueueTask({
      agentId: id, threadId: group.id, source: "group",
      title: `#${group.name}: ${why}`.slice(0, 200),
      prompt: why, // replaced at run time by the group catch-up prompt
      input: null,
    });
  }
  if (later.length) {
    // Remember the waiting agents (roles), so Continue finds them as group members.
    const roles = later.map((id) => getAgent(id)?.base_agent_id ?? id);
    run(`UPDATE threads SET paused_mentions = ? WHERE id = ?`, JSON.stringify(roles), group.id);
    const names = roles.map((id) => getAgent(id)?.name).filter(Boolean).join(", ");
    systemNote(group.id, `Paused after ${TURN_LIMIT} agent replies since your last message. Waiting to hear from: ${names}.`);
    publish({ type: "group.updated", group: getGroup(group.id)! });
  }
}

/** The owner posts in a group. */
export function postAsOwner(groupId: string, text: string) {
  const group = getGroup(groupId);
  if (!group) throw new Error("No such group");
  run(`UPDATE threads SET paused_mentions = NULL WHERE id = ?`, groupId);
  const message = { id: newId(), thread_id: groupId, author: "user", task_id: null, content: text, created_at: now() };
  run(
    `INSERT INTO messages (id, thread_id, author, task_id, content, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    message.id, message.thread_id, message.author, message.task_id, message.content, message.created_at,
  );
  publish({ type: "message.created", message });
  const targets = mentions(group, text);
  const lead = group.lead_agent_id ?? group.members[0];
  const first = text.split("\n")[0].slice(0, 80);
  trigger({ ...group, paused: false }, targets.length ? targets : [lead], first);
  publish({ type: "group.updated", group: getGroup(groupId)! });
  return message;
}

/** Resume a paused group: the waiting members get their turn, with a fresh budget. */
export function continueGroup(groupId: string) {
  const t = get(`SELECT paused_mentions FROM threads WHERE id = ? AND kind = 'group'`, groupId);
  if (!t) throw new Error("No such group");
  const waiting: string[] = t.paused_mentions ? JSON.parse(t.paused_mentions) : [];
  postAsOwnerSilently(groupId);
  const group = getGroup(groupId)!;
  trigger(group, waiting.filter((id) => group.members.includes(id)), "continue");
}

function postAsOwnerSilently(groupId: string) {
  // A "Continue" counts as the owner speaking: it resets the turn budget.
  run(`UPDATE threads SET paused_mentions = NULL WHERE id = ?`, groupId);
  const message = { id: newId(), thread_id: groupId, author: "user", task_id: null, content: "Continue.", created_at: now() };
  run(
    `INSERT INTO messages (id, thread_id, author, task_id, content, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    message.id, message.thread_id, message.author, message.task_id, message.content, message.created_at,
  );
  publish({ type: "message.created", message });
  publish({ type: "group.updated", group: getGroup(groupId)! });
}

/** After an agent's group reply is posted: pass the turn to whoever it mentioned. */
export function afterAgentReply(task: any, content: string) {
  if (task.source !== "group" || task.status !== "done" || isNoReply(content)) return;
  const group = getGroup(task.thread_id);
  if (!group) return;
  const targets = mentions(group, content, task.agent_id);
  if (targets.length) {
    const who = getAgent(task.agent_id)?.name ?? "a teammate";
    trigger(group, targets, `mentioned by ${who}`);
  }
}

/** The prompt for an agent's turn in a group: who's here and what it missed. */
export function groupPrompt(task: any, agent: Agent) {
  const group = getGroup(task.thread_id)!;
  const me = agent.base_agent_id ?? agent.id;
  const people = group.members
    .map((id) => getAgent(id))
    .filter(Boolean)
    .map((a) => `@${a!.slug}${a!.id === group.lead_agent_id ? " (lead)" : ""}${a!.id === me ? " (you)" : ""} — ${a!.title}`)
    .join("\n");
  // Everything posted since this agent last read the group, including while it was busy.
  const seen = get<{ seen_at: string }>(
    `SELECT seen_at FROM group_reads WHERE thread_id = ? AND agent_id = ?`, group.id, agent.id,
  )?.seen_at ?? "";
  const readAt = now();
  const missed = all<{ author: string; content: string }>(
    `SELECT author, content FROM (
       SELECT author, content, created_at FROM messages WHERE thread_id = ? AND created_at > ? AND created_at <= ? AND author != ?
       ORDER BY created_at DESC LIMIT 40
     ) ORDER BY created_at`,
    group.id, seen, readAt, agent.id,
  );
  run(
    `INSERT INTO group_reads (thread_id, agent_id, seen_at) VALUES (?, ?, ?)
     ON CONFLICT (thread_id, agent_id) DO UPDATE SET seen_at = excluded.seen_at`,
    group.id, agent.id, readAt,
  );
  const nameOf = (author: string) =>
    author === "user" ? "Owner" : author === "system" ? "agentbox" : getAgent(author)?.name ?? "someone";
  const transcript = missed.map((m) => `**${nameOf(m.author)}:** ${attachmentsForAgent(m.content)}`).join("\n\n");
  return `[agentbox group #${group.name}]${group.purpose ? `\nPurpose: ${group.purpose}` : ""}
Members:
${people}

New in the group since your last reply:

${transcript || "(nothing new)"}

You were brought in because: ${task.prompt}.

How this group works:
- Your final reply is posted to the group for everyone to read.
- An @mention gives that member a turn right away. @mention someone only when you need them to act
  now (e.g. "@${listAgents().find((a) => group.members.includes(a.id) && a.id !== me)?.slug ?? "teammate"} please run the tests").
  To refer to someone without waking them, write their name without the @. Never @mention just
  to thank, acknowledge or keep someone informed.
- Hand off one step at a time: don't mention the next person until the current step is done.
- If you have nothing to add or do, reply with exactly ${NO_REPLY} and nothing will be posted.
- Keep replies short; put long detail in GitHub issues/PRs and link them.`;
}
