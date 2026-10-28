import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { all, get, newId, now, run } from "./db.ts";
import { helperLimitError } from "./rules.ts";
import { publish } from "./bus.ts";
import { dmThreadOf, getAgent, instanceTree, listAgents, retireReplica, reviveInstance, rootOf, spawnInstance, type Agent } from "./agents.ts";
import { proposeSkill, skillsOf } from "./skills.ts";
import { agentStatus, enqueueTask, openTasksOf, stopTask, taskRow } from "./runner.ts";
import { cancelWakeup, LIMITS as WAKE_LIMITS, pendingFor as pendingWakeups, scheduleWakeup } from "./wakeups.ts";
import { leadFor as delegatorOf, raiseAttention } from "./attention.ts";
import { createRoutine, defaultTimezone, deleteRoutine, describeCron, listRoutines } from "./routines.ts";
import { bindRepo, ensureWorktree, fetchRepo, finishMap, getRepo, mapDir, roleAllowed, type Repo } from "./repos.ts";
import { requestSetup } from "./setupRequests.ts";
import { confirmNote, deleteNote, draftDir, ensureDrafts, finishPromotion, moveNote, repoMemoryDir, writeNote } from "./memory.ts";
import { isSetupAgent } from "./setup.ts";
import { isOrchestrator } from "./roleGuards.ts";
import { crewIdOf, crewName, crewmates, sameCrew } from "./crews.ts";
import { linksOf, readLinked } from "./linkedWork.ts";
import { askGroupLead, describeWorkspaces, finishWorkspace, launchWorkspace, ledGroup, messageWorkspace, postToGroup } from "./groupWork.ts";
import { roadmapsOf } from "./roadmaps.ts";
import { cachedIntegrations, isConnected, mappedIntegrations } from "./integrations.ts";
import { LIMITS as PLAN_LIMITS, decidePlan, getPlan, plansFor, submitPlan, type Decision } from "./plans.ts";
import { mayControl as mayControlHosted, roomServices as roomHosted, serviceByName as hostedByName, startService, stopService as stopHosted, tailLog as tailHosted } from "./hosting.ts";
import { LIMITS as RM_LIMITS, STATUSES as RM_STATUSES, createRoadmap, itemsOf as roadmapItems, updateRoadmap } from "./roadmaps.ts";

/**
 * The internal channel between agents. Agents call these tools; agentbox queues the work,
 * runs it, and routes the report back. Teams/GitHub are for people and records, not this.
 */

export const LIMITS = { depth: 3, handoffsPerTurn: 6 };
const GROUP_LEAD_TOOLS = new Set(["launch_workspace", "list_workspaces", "message_workspace", "finish_workspace", "post_to_group"]);

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
const refuse = (t: string) => ({ content: [{ type: "text" as const, text: t }], isError: true });

export function findAgent(nameOrSlug: string): Agent | undefined {
  const k = nameOrSlug.trim().toLowerCase().replace(/^@/, "");
  // "coder#2", "coder-2" and "coder 2" all name the same instance.
  const alt = k.replace(/[#\s]+/g, "-");
  return listAgents().find((a) => a.slug === k || a.name.toLowerCase() === k || a.slug === alt);
}

/** The thread where `to` works on what `from` hands it; one per pair, kept for context. */
export function handoffThread(to: Agent, from: Agent) {
  const existing = get<{ id: string }>(
    `SELECT id FROM threads WHERE kind = 'handoff' AND agent_id = ? AND peer_agent_id = ?`, to.id, from.id,
  );
  if (existing) return existing.id;
  const id = newId();
  run(`INSERT INTO threads (id, kind, agent_id, peer_agent_id, created_at) VALUES (?, 'handoff', ?, ?, ?)`, id, to.id, from.id, now());
  publish({ type: "thread.created", thread: { id, kind: "handoff", agent_id: to.id, peer_agent_id: from.id } });
  return id;
}

type Handoff = { kind: "task" | "message"; from: Agent; fromTask: any; to: string; title: string; body: string; routedTo?: Agent; repos?: string[] };

const refs = (s: string) => new Set([...s.matchAll(/#(\d{2,})/g)].map((m) => m[1]));

/**
 * The instance of this role you started earlier that worked on the same issue or PR (matched by
 * #numbers in the title), reopened if it was retired. Saves a fresh instance re-learning it all.
 */
function authorOf(role: Agent, h: Handoff): Agent | undefined {
  const wanted = refs(h.title);
  if (!wanted.size) return undefined;
  const mine = all<Agent>(
    `SELECT * FROM agents WHERE base_agent_id = ? AND created_by = ? ORDER BY replica_no DESC`, role.id, h.from.id,
  );
  for (const a of mine) {
    const seen = new Set<string>();
    for (const t of [a.label ?? "", ...all<{ title: string }>(`SELECT title FROM tasks WHERE agent_id = ?`, a.id).map((t) => t.title ?? "")]) {
      for (const n of refs(t)) seen.add(n);
    }
    if ([...wanted].some((n) => seen.has(n))) {
      if (!a.retired_at) return a;
      const over = helperLimitError(h.from);
      if (over) throw new Error(over);
      return reviveInstance(a.id, h.from.id);
    }
  }
  return undefined;
}

/** Checks shared by delegations and messages. Returns an error for the agent, or the target. */
function check(h: Handoff): string | Agent {
  let target = findAgent(h.to);
  const names = crewmates(h.from).map((a) => a.name).join(", ") || "none";
  // The setup agent takes work from the owner only; agents reach it through setup requests.
  const role = target ? (target.base_agent_id ? getAgent(target.base_agent_id) : target) : undefined;
  if (target && role?.builtin && !isSetupAgent(h.from)) {
    return "The setup agent isn't a teammate you hand work to. If you need an account, login, tool or access, call mcp__team__request_setup: the owner gets a card for it and you're called back when it's done.";
  }
  if (!target) return `No teammate called "${h.to}". Agents: ${names}. (Delegate to an agent to start a fresh task, or to a live instance such as coder#2 for a follow-up.)`;
  // Crews are separate teams: work never crosses from one to another.
  if (!role?.builtin && !isSetupAgent(h.from) && !sameCrew(h.from, target)) {
    return `${target.name} is in ${crewName(crewIdOf(target))}, not your crew (${crewName(crewIdOf(h.from))}), so you can't hand it work or message it. Your crew: ${names}. If this needs another crew's skills, say so in your reply to the owner.`;
  }
  // A message to an agent goes to its live instance in your work, if there's exactly one.
  if (h.kind === "message" && !target.base_agent_id) {
    const live = listAgents().filter((a) => a.base_agent_id === target!.id && a.created_by === h.from.id);
    if (live.length !== 1) {
      return live.length
        ? `${target.name} has several live tasks from you (${live.map((a) => a.name).join(", ")}); message one of them by name.`
        : `${target.name} has no live task from you to message. Use delegate_task to give it work.`;
    }
    target = live[0];
  }
  if (target.id === h.from.id) return "That's you. Do the work yourself or pick a teammate.";
  // Orchestrators lay out the work before handing it out, so the owner can follow it from the start.
  if (h.kind === "task" && h.from.base_agent_id && isOrchestrator(h.from) && !roadmapsOf(rootOf(h.from).id).length) {
    return "Create this work's roadmap first (mcp__team__roadmap_create: the steps, who does each, what depends on what), then delegate, putting each delegate's name as the owner of its step. The owner follows the work there from the start. For a single small task, a 1–3 step roadmap is fine.";
  }
  if (h.fromTask.source === "agent" && h.fromTask.from_agent_id === target.id) {
    return `${target.name} handed this task to you. Don't hand it back: finish what you can and put questions or blockers in your final reply, which goes to ${target.name} automatically.`;
  }
  const depth = (h.fromTask.depth ?? 0) + 1;
  if (depth > LIMITS.depth) {
    return `Delegation chain limit (${LIMITS.depth}) reached. Do this yourself, or report back and let the owner decide.`;
  }
  const sent = (get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM tasks WHERE parent_task_id = ? AND source IN ('agent', 'message')`, h.fromTask.id,
  )?.n ?? 0) as number;
  if (sent >= LIMITS.handoffsPerTurn) return `You've handed off ${sent} items in this turn, the limit. Wait for reports before handing off more.`;
  return target;
}

export function handOff(h: Handoff) {
  const checked = check(h);
  if (typeof checked === "string") throw new Error(checked);
  // Repos to bind: checked before any instance is started.
  for (const name of h.repos ?? []) {
    const repo = getRepo(String(name).trim());
    const role = checked.base_agent_id ? getAgent(checked.base_agent_id) ?? checked : checked;
    if (!repo || repo.status === "archived") throw new Error(`No repo called "${name}"`);
    if (repo.status !== "ready") throw new Error(`${repo.name} isn't ready (${repo.status})`);
    if (!roleAllowed(repo, role)) throw new Error(`${role.name} isn't allowed to use ${repo.name}`);
  }
  // Delegating to an agent (role) starts a fresh instance for this one task; delegating to an
  // instance sends it a follow-up in its own conversation. A planning agent (tech-lead) is
  // different: each piece of work gets at most one, as its lead, reused for later handoffs.
  // Follow-up work (rework, review fixes) on an issue or PR goes back to the instance that did it.
  const target = checked.base_agent_id ? checked
    : checked.can_scale && h.from.base_agent_id ? leadFor(checked, h)
    : (h.kind === "task" && authorOf(checked, h)) || spawnHelper(checked, h);
  if (target.id === h.from.id) throw new Error("That's you. Do the work yourself or pick a teammate.");
  h.routedTo = target;
  // Repos for the helper: each gets its own worktree, created before its first turn.
  const repoNames = [...new Set((h.repos ?? []).map((r) => String(r).trim()).filter(Boolean))];
  if (repoNames.length) {
    for (const r of repoNames) bindRepo(target, r);
    h.body += `\n\nRepos for this task: ${repoNames.join(", ")}. Your worktree for each is ready when you start (see Repos in your instructions).`;
  }
  const threadId = dmThreadOf(target.id)!;
  const prompt = h.kind === "task"
    ? `[agentbox] Task from ${h.from.name} (${h.from.title})

Title: ${h.title}

${h.body}

Your final reply is sent back to ${h.from.name} automatically as your report. Make it complete
and self-contained: the outcome, links (issues, PRs, commits), what you verified, and anything
left open. If the task is unclear or you're blocked, say so in that reply instead of guessing.`
    : `[agentbox] Message from ${h.from.name} (${h.from.title}). FYI, no reply is expected.

${h.body}

Take it into account if it affects your work. Your reply here is not sent anywhere; only message
${h.from.name} back (send_message) if they genuinely need to know something.`;
  return enqueueTask({
    agentId: target.id,
    threadId,
    source: h.kind === "task" ? "agent" : "message",
    title: h.title,
    prompt,
    fromAgentId: h.from.id,
    parentTaskId: h.fromTask.id,
    depth: (h.fromTask.depth ?? 0) + 1,
    input: { author: h.from.id, content: h.kind === "task" ? `**${h.title}**\n\n${h.body}` : h.body },
  });
}

/** A new instance for a delegation, within the routine's helper limit if there is one. */
function spawnHelper(role: Agent, h: Handoff) {
  const over = helperLimitError(h.from);
  if (over) throw new Error(over);
  return spawnInstance(role.id, { label: h.title, createdBy: h.from.id, parentInstanceId: h.from.base_agent_id ? h.from.id : null });
}

/** The work item's lead of this role: the existing one, or a new one joining its room. */
function leadFor(role: Agent, h: Handoff): Agent {
  const root = rootOf(h.from);
  const existing = instanceTree(root.id).find((a) => a.base_agent_id === role.id && !a.retired_at);
  if (existing) {
    if (existing.id === h.from.id) throw new Error("That's you. Do the work yourself or pick a teammate.");
    if (h.fromTask.from_agent_id === existing.id) {
      throw new Error(`${existing.name} handed this task to you. Don't hand it back: put questions or blockers in your final reply, which goes to ${existing.name} automatically.`);
    }
    return existing;
  }
  return spawnInstance(role.id, {
    label: `Lead · ${root.label ?? root.name}`, createdBy: `lead:${root.id}`, parentInstanceId: root.id, asLead: true,
  });
}

/** Called when a delegated task ends: the assignee's report becomes the delegator's next turn. */
export function returnResult(task: any) {
  if (task.source !== "agent" || !task.from_agent_id) return;
  const delegator = listAgents().find((a) => a.id === task.from_agent_id);
  const assignee = listAgents().find((a) => a.id === task.agent_id);
  if (!delegator || !assignee) return;
  const parent = task.parent_task_id ? taskRow(task.parent_task_id) : undefined;
  const threadId = parent?.thread_id ?? get<{ id: string }>(`SELECT id FROM threads WHERE kind = 'dm' AND agent_id = ?`, delegator.id)!.id;
  const outcome = task.status === "done" ? "finished" : task.status === "stopped" ? "was stopped on" : "failed on";
  const report = (task.result ?? "").trim() || (task.error ? `Error: ${task.error}` : "(no report)");
  enqueueTask({
    agentId: delegator.id,
    threadId,
    source: "result",
    title: `Report: ${task.title ?? "task"}`,
    prompt: `[agentbox] ${assignee.name} ${outcome} the task you delegated: "${task.title}" (task ${task.id}).

Their report:

${report}

Continue from here: check the result against what you asked for, follow up or hand off the next
step if needed, and report to the owner as your instructions say.`,
    fromAgentId: null,
    parentTaskId: task.id,
    depth: parent?.depth ?? 0,
    input: { author: assignee.id, content: `${outcome === "finished" ? "Finished" : outcome === "was stopped on" ? "Stopped" : "Failed"} **${task.title}**\n\n${report}` },
  });
}

export function teamServer(agent: Agent, taskId: string) {
  return createSdkMcpServer({
    name: "team",
    version: "1.0.0",
    instructions: "agentbox team tools: how agents on this team hand work to each other.",
    // The helper proposes skills with its own tool (straight to an approval card), not as a draft.
    tools: teamTools(agent, taskId).filter((t) => !(isSetupAgent(agent) && t.name === "propose_skill"))
      // A group's lead runs its workspaces; nobody else sees those tools.
      .filter((t) => !GROUP_LEAD_TOOLS.has(t.name) || !!ledGroup(agent)),
  });
}

/** The tool definitions (handlers callable directly in tests). */
export function teamTools(agent: Agent, taskId: string) {
  const me = () => taskRow(taskId);
  return [
      tool(
        "list_agents",
        "List the agents you can delegate to, with each one's live tasks (instances such as coder#2): what they're doing, status and who started them. Pass pool to see just one agent.",
        { pool: z.string().optional().describe("An agent's name, e.g. coder") },
        async ({ pool }) => {
          const base = pool ? findAgent(pool) : undefined;
          if (pool && (!base || !sameCrew(agent, base))) return refuse(`No agent called "${pool}" in your crew.`);
          const roleId = base ? base.base_agent_id ?? base.id : undefined;
          const roles = listAgents().filter((a) => !a.base_agent_id && !a.builtin && sameCrew(agent, a) && (!roleId || a.id === roleId));
          const rows = roles.map((r) => {
            const live = listAgents().filter((a) => a.base_agent_id === r.id && a.id !== agent.id);
            const lines = live.map((i) => {
              const open = openTasksOf(i.id);
              const running = open.find((t) => t.status === "running");
              const by = i.created_by === "owner" ? "the owner" : i.created_by?.startsWith("routine:") ? "a routine"
                : i.created_by?.startsWith("group:") ? "a group" : getAgent(i.created_by ?? "")?.name ?? "?";
              return `    - ${i.name} "${i.label ?? ""}" — ${agentStatus(i.id).status}${running ? `, working on "${running.title}"` : ""}` +
                `${open.length > (running ? 1 : 0) ? `, ${open.length - (running ? 1 : 0)} queued` : ""} (started by ${by}${i.created_by === agent.id ? ": you" : ""})`;
            });
            return `- ${r.name} — ${r.title}: ${r.summary} Skills: ${skillsOf(r.id).join(", ") || "none"}.` +
              (r.can_scale ? " (Hand it work to bring it in as your work's lead: one per piece of work, reused for later handoffs.)" : "") +
              (lines.length ? `\n  Live tasks:\n${lines.join("\n")}` : "\n  No live tasks.");
          });
          return text(rows.length ? rows.join("\n") : "No matching agents.");
        },
      ),

      tool(
        "read_linked_work",
        "Read other work the owner linked to yours (often another crew's): its progress and roadmap, conversation, documents or hosted links. Read-only. Call with no work to list what's linked.",
        {
          work: z.string().optional().describe("The linked work's title or id (from the list)"),
          part: z.enum(["progress", "conversation", "documents", "services"]).optional().describe("progress (default): tasks, roadmap, latest message; conversation: messages, newest last; documents; services: hosted links"),
          limit: z.number().int().min(1).max(40).optional().describe("conversation: how many messages (default 20)"),
          before: z.number().int().min(0).optional().describe("conversation: skip this many of the newest, to read further back"),
        },
        async ({ work, part, limit, before }) => {
          try {
            if (!work) {
              const { links } = linksOf(agent.id);
              return text(links.length
                ? links.map((l) => `- "${l.work.label}" (${l.work.crew_name} crew, led by ${l.work.name}; ${l.work.status}) — id ${l.work.id}`).join("\n")
                : "No work is linked to yours. Only the owner links work.");
            }
            return text(readLinked(agent, work, part ?? "progress", { limit, before }));
          } catch (e: any) {
            return refuse(e.message);
          }
        },
      ),

      // --- a group's lead: workspaces launched from the group (groupWork.ts) ---
      tool(
        "launch_workspace",
        "Group lead only: turn one independent item the owner asked for into its own workspace (a task room under Work), led by an agent of your crew. It becomes a step on the group's roadmap. Its lead's first reply comes back to you.",
        {
          title: z.string().describe("Short title (the roadmap step), e.g. 'Payments: remove dead code'"),
          brief: z.string().describe("Everything its lead needs: goal, scope, constraints, repos, what done looks like, how to report"),
          lead: z.string().optional().describe("Which agent of your crew leads it (default: your own agent, as a fresh task)"),
          repos: z.array(z.string()).optional().describe("Registered repos it works on"),
          after: z.array(z.string()).optional().describe("Roadmap step ids this one waits for"),
        },
        async (args) => {
          try {
            const inst = launchWorkspace(agent, taskId, args);
            return text(`Launched "${args.title}" as ${inst.name} (workspace ${inst.id}); it's on the group's roadmap. Its first report comes back to you.`);
          } catch (e: any) { return refuse(e.message); }
        },
      ),
      tool("list_workspaces", "Group lead only: the group's workspaces and where each stands (lead, status, roadmap, questions waiting on you).", {}, async () => {
        const g = ledGroup(agent);
        return g ? text(describeWorkspaces(g.id)) : refuse("Only a group's lead has workspaces.");
      }),
      tool(
        "message_workspace",
        "Group lead only: instructions, a correction or an answer to a workspace's lead. Their reply comes back to you.",
        { workspace: z.string().describe("Its title, step id or lead's name"), text: z.string() },
        async ({ workspace, text: body }) => {
          try { const to = messageWorkspace(agent, taskId, workspace, body); return text(`Sent to ${to.name}; their reply comes back to you.`); }
          catch (e: any) { return refuse(e.message); }
        },
      ),
      tool(
        "finish_workspace",
        "Group lead only: mark a workspace done once its work is really finished (its PRs merged, nothing running). Its step on the roadmap is done; its history stays.",
        { workspace: z.string() },
        async ({ workspace }) => {
          try { const r = finishWorkspace(agent, workspace); return text(`"${r.title}" is done.`); } catch (e: any) { return refuse(e.message); }
        },
      ),
      tool(
        "post_to_group",
        "Group lead only: post a short note to the group (a status, a finished item, a decision you need), from outside it, e.g. after a workspace's report. Nobody is woken.",
        { text: z.string() },
        async ({ text: body }) => {
          try { postToGroup(agent, body); return text("Posted."); } catch (e: any) { return refuse(e.message); }
        },
      ),

      tool(
        "find_work",
        "Find who is working (or worked) on something: search tasks by issue number (e.g. 124 or #124), branch name or keyword. Cheaper than listing everyone.",
        {
          query: z.string().describe("Issue number, branch name or words from the task, e.g. '#124' or 'epic/2958'"),
          open_only: z.boolean().optional().describe("Only running or queued tasks (default false)"),
        },
        async ({ query, open_only }) => {
          // "issue #902", "#902", "fix/902-cron" → match the number 902; otherwise the text itself.
          const q = query.match(/#?(\d{2,})/)?.[1] ?? query.trim();
          if (!q) return refuse("Give an issue number, branch or keyword.");
          // Match "#124" / "124" as a whole number, anything else as a substring.
          const like = `%${q}%`;
          const rows = all(
            `SELECT id, agent_id, title, prompt, status, created_at, finished_at FROM tasks
             WHERE source IN ('user', 'agent', 'cron', 'group') AND (title LIKE ? OR prompt LIKE ?) AND id != ?
             ${open_only ? "AND status IN ('running', 'queued')" : ""}
             ORDER BY created_at DESC LIMIT 40`,
            like, like, taskId,
          ).filter((t: any) => !/^\d+$/.test(q) || new RegExp(`(^|[^\\d])#?${q}([^\\d]|$)`).test(`${t.title} ${t.prompt}`))
            // Only your crew's work: other crews are separate teams.
            .filter((t: any) => { const who = getAgent(t.agent_id); return !who || sameCrew(agent, who); })
            .slice(0, 10);
          if (!rows.length) return text(`No tasks mention "${query}".`);
          return text(rows.map((t: any) => {
            const who = getAgent(t.agent_id);
            return `- ${who?.name ?? "deleted"}${who?.retired_at ? " (retired)" : ""}: "${t.title}" — ${t.status}, ${t.finished_at ? `finished ${t.finished_at}` : `since ${t.created_at}`} (task ${t.id})`;
          }).join("\n"));
        },
      ),

      tool(
        "retire_instance",
        "Finish a task you started: retire the instance (e.g. coder#3) once its work is really finished (its PR merged or closed) and nothing is queued for it. Not while its PR is in review: rework goes back to it. You can only retire instances you started. Not for a lead that joined your work (e.g. tech-lead): it stays for later handoffs. Its history stays.",
        { name: z.string().describe("e.g. coder#3") },
        async ({ name }) => {
          const r = findAgent(name);
          if (!r) return refuse(`No live instance called "${name}".`);
          if (!r.base_agent_id) return refuse(`${r.name} is an agent, not an instance.`);
          if (r.created_by !== agent.id) return refuse(`You didn't start ${r.name}, so you can't retire it. The owner (or whoever started it) can.`);
          const open = openTasksOf(r.id);
          if (open.length) return refuse(`${r.name} still has ${open.length} task(s) running or queued ("${open[0].title}"). Wait for its report first.`);
          retireReplica(r.id);
          return text(`Retired ${r.name}.`);
        },
      ),

      tool(
        "delegate_task",
        "Hand a task to a teammate. It joins their queue; when they finish, their report comes back to you automatically as a new message. Don't wait or poll: end your turn after delegating.",
        {
          to: z.string().describe("Teammate's name, e.g. coder"),
          title: z.string().describe("Short imperative title, e.g. 'Fix token refresh on tab blur (#88)'"),
          instructions: z.string().describe("Everything they need: context, links, acceptance criteria, constraints, what to report back"),
          repos: z.array(z.string()).optional().describe("Registered repos (names) this task works on: the helper gets its own worktree of each"),
        },
        async (args) => {
          try {
            const h: Handoff = { kind: "task", from: agent, fromTask: me(), to: args.to, title: args.title, body: args.instructions, repos: args.repos };
            const t = handOff(h);
            const to = h.routedTo!;
            const back = to.name !== findAgent(args.to)?.name && !findAgent(args.to)?.base_agent_id;
            return text(`Delegated to ${to.name} as task ${t.id}${back ? ` (${to.name} already worked on this, so it continues with its context instead of a new ${args.to} starting from scratch)` : ""}. Their report will arrive as a new message.`);
          } catch (e: any) {
            return refuse(e.message);
          }
        },
      ),

      tool(
        "send_message",
        "Send a teammate an FYI (no task, no reply expected). Use delegate_task when you need something done.",
        { to: z.string(), text: z.string() },
        async (args) => {
          try {
            handOff({ kind: "message", from: agent, fromTask: me(), to: args.to, title: `Message from ${agent.name}`, body: args.text });
            return text(`Sent to ${findAgent(args.to)!.name}.`);
          } catch (e: any) {
            return refuse(e.message);
          }
        },
      ),

      tool(
        "schedule_wakeup",
        `Wake yourself up later, once: a new turn in ${WAKE_LIMITS.minMinutes}–${WAKE_LIMITS.maxMinutes} minutes with your note. Use it instead of sleeping or polling in a shell loop: to check CI or a deploy, retry after a rate limit resets, or follow up on something slow. Then end your turn (or carry on with other work). If you're on a delegated task, the woken turn's reply goes back to whoever delegated it.`,
        {
          in_minutes: z.number().describe("Minutes from now"),
          note: z.string().describe("What to do when you wake, self-contained, e.g. 'Check CI on PR #5363; merge if green, else ask coder#2 to fix'"),
        },
        async (args) => {
          try {
            const w = scheduleWakeup(agent, taskId, args);
            return text(`Wake-up set for ${w.due_at} (id ${w.id}). End your turn when you're done for now; you'll be woken with your note.`);
          } catch (e: any) {
            return refuse(e.message);
          }
        },
      ),

      tool("cancel_wakeup", "Cancel a wake-up you set (no longer needed).", { wakeup_id: z.string().optional().describe("Leave out when you have just one") }, async ({ wakeup_id }) => {
        const mine = pendingWakeups(agent.id);
        const id = wakeup_id ?? (mine.length === 1 ? mine[0].id : null);
        if (!id) return refuse(mine.length ? `Pass wakeup_id: ${mine.map((w) => `${w.id} (${w.due_at}: ${w.note.slice(0, 60)})`).join(", ")}` : "You have no wake-ups waiting.");
        try { cancelWakeup(id, agent); return text("Cancelled."); } catch (e: any) { return refuse(e.message); }
      }),

      tool(
        "ask_owner",
        "Ask the owner for something only they can give: a decision that's theirs (spend, a breaking or critical change, product direction), access or a credential, or a merge or deploy you aren't allowed to do. This is what reaches them ('needs you'); a plain reply is only read when they look. Don't ask about routine work: decide it yourself, or ask your lead.",
        { question: z.string().describe("One short question, with the options and your recommendation") },
        async ({ question }) => {
          const q = String(question ?? "").trim();
          if (!q) return refuse("Say what you need.");
          // In a workspace a group launched, the group's lead answers first.
          const groupLead = askGroupLead(agent, taskId, q);
          if (groupLead) {
            return text(`It went to ${groupLead}, the lead of the group that launched this work: they decide it, or take it to the owner if it's theirs. Their answer comes back to you as a message. Carry on with anything that doesn't depend on it, or end your turn.`);
          }
          const root = rootOf(agent);
          raiseAttention("question", agent.id, taskId, root.created_by === "owner" ? root.id : null, `${agent.name} asks: ${q}`);
          return text("The owner has it in 'needs you'. Put the same question, with context, in your reply, then carry on with anything that doesn't depend on the answer, or end your turn.");
        },
      ),

      tool(
        "stop_task",
        "Stop a task you handed out (a helper that's stuck, going in circles, or no longer needed). Its report comes back to you as 'stopped'; then re-delegate with clearer instructions, or close it.",
        { task_id: z.string().describe("The task's id (from delegate_task, get_task or a 'may be stuck' notice)") },
        async ({ task_id }) => {
          const t = taskRow(task_id);
          if (!t) return refuse("No task with that id.");
          if (delegatorOf(t)?.id !== agent.id) return refuse("You can only stop tasks you handed out.");
          if (t.status !== "running" && t.status !== "queued") return refuse(`That task is already ${t.status}.`);
          stopTask(task_id);
          return text(`Stopping "${t.title}". Its report reaches you shortly.`);
        },
      ),

      tool("get_task", "Check a task's status and report, including any tasks it delegated further.", { task_id: z.string() }, async ({ task_id }) => {
        const t = taskRow(task_id);
        if (!t) return refuse("No task with that id.");
        const who = listAgents().find((a) => a.id === t.agent_id)?.name ?? "deleted agent";
        const kids = all(`SELECT id, title, status, agent_id FROM tasks WHERE parent_task_id = ? AND source = 'agent'`, t.id)
          .map((k: any) => `  - ${k.title} → ${listAgents().find((a) => a.id === k.agent_id)?.name}: ${k.status} (${k.id})`);
        const report = t.result ? `\nReport:\n${String(t.result).slice(0, 4000)}` : t.error ? `\nError: ${t.error}` : "";
        return text(`"${t.title ?? t.prompt.slice(0, 80)}" → ${who}: ${t.status}${kids.length ? `\nDelegated further:\n${kids.join("\n")}` : ""}${report}`);
      }),

      tool(
        "schedule_routine",
        "Create a recurring routine: a prompt an agent (you by default) runs on a cron schedule, e.g. checking open PRs every 2 hours. The owner can see, pause and edit it in agentbox. Runs must be at least 15 minutes apart.",
        {
          name: z.string().describe("Short name, e.g. 'PR review'"),
          cron: z.string().describe("5-field cron in the owner's timezone, e.g. '0 */2 * * *' (every 2 hours) or '30 9 * * 1-5' (weekdays 09:30)"),
          prompt: z.string().describe("What to do each run, self-contained"),
          agent: z.string().optional().describe("Teammate who runs it; defaults to you"),
        },
        async (args) => {
          const target = args.agent ? findAgent(args.agent) : agent;
          if (!target) return refuse(`No teammate called "${args.agent}".`);
          try {
            const r = createRoutine({ agent_id: target.id, name: args.name, cron: args.cron, timezone: defaultTimezone(), prompt: args.prompt, enabled: true }, agent.id);
            return text(`Scheduled "${r.name}" for ${target.name}: ${r.describe} (${r.timezone}). Next run ${r.next_runs[0] ?? "—"}. Routine id ${r.id}.`);
          } catch (e: any) {
            return refuse(e.message);
          }
        },
      ),

      tool("list_routines", "List the routines you run, or that you created for teammates.", {}, async () => {
        const mine = listRoutines().filter((r) => r.agent_id === agent.id || r.created_by === agent.id);
        if (!mine.length) return text("No routines.");
        return text(mine.map((r) => `- ${r.id}: "${r.name}" for ${listAgents().find((a) => a.id === r.agent_id)?.name}, ${describeCron(r.cron)} (${r.timezone})${r.enabled ? "" : " [paused]"}`).join("\n"));
      }),

      tool("cancel_routine", "Delete a routine you created.", { routine_id: z.string() }, async ({ routine_id }) => {
        const r = listRoutines().find((x) => x.id === routine_id);
        if (!r) return refuse("No routine with that id.");
        if (r.created_by !== agent.id) return refuse("Only the owner can remove routines you didn't create; ask them.");
        deleteRoutine(r.id);
        return text(`Deleted "${r.name}".`);
      }),

      tool(
        "use_repo",
        "Work on a registered repo: binds this task to it and gives you your own git worktree (a branch off origin/<default branch>; the same one again for rework). Returns its path. The canonical clone is read-only.",
        { name: z.string().describe("The repo's name, from the Repos section of your instructions") },
        async ({ name }) => {
          if (!agent.base_agent_id) return refuse("Repos are used by tasks (instances).");
          let repo: Repo | undefined = getRepo(name);
          if (repo && repo.status === "ready" && roleAllowed(repo, agent) && (!repo.last_fetch_at || Date.now() - Date.parse(repo.last_fetch_at) > 5 * 60_000)) {
            // Can agentbox still fetch it? If not, ask for access (the worktree still works from the last fetch).
            try { repo = await fetchRepo(name); } catch (e: any) {
              let note = "";
              try {
                const r = requestSetup(agent, taskId, {
                  title: `Access to repo ${name}`, repo: name,
                  why: `agentbox can't fetch ${name}: ${e.message}`,
                  for_setup_agent: `agentbox can't fetch the registered repo "${name}" (${repo.url}): ${e.message}\nRestore read access for the agent user (the provider account's login, or a deploy key), then check that \`agentbox repo fetch ${name}\` works.`,
                });
                note = ` I raised setup request ${r.request.id} for access; you'll be called back when it's fixed.`;
              } catch (err: any) { note = ` (Couldn't raise a setup request: ${err.message})`; }
              try {
                const wt = await ensureWorktree(agent, name);
                return text(`Fetching ${name} failed, so your worktree is from the last fetch (${repo.last_fetch_at ?? "unknown"}): ${wt.path} (branch ${wt.branch}).${note}`);
              } catch (err: any) { return refuse(`${err.message}.${note}`); }
            }
          }
          try {
            const wt = await ensureWorktree(agent, name);
            const r = wt.repo;
            try { ensureDrafts(agent); } catch { /* the next turn tracks it */ }
            return text([
              `Your worktree for ${r.name}: ${wt.path}`,
              `Branch: ${wt.branch} (off origin/${r.default_branch}; push it with \`git push -u origin HEAD\`, then open a PR).`,
              r.test_command ? `Tests: ${r.test_command}` : "",
              r.map_status === "ready" ? `Map: ${mapDir(r.name)}/ (read AGENTS.md first)` : "",
              `Repo memory: ${repoMemoryDir(r.name)}/ (read INDEX.md first). Write what you learn to your draft folder ${draftDir(r.name, agent.id)}/; it's folded in when your work merges.`,
              `Never edit the canonical clone; ${r.agents_may_merge ? "" : `pushes and merges to ${r.protected_branches.join(", ")} are refused; `}${r.agents_may_deploy ? "" : "deploys are refused."}`,
            ].filter(Boolean).join("\n"));
          } catch (e: any) {
            return refuse(e.message);
          }
        },
      ),

      tool(
        "repo_map_done",
        "Record a repo's map as complete (after the onboard-repo skill wrote ARCHITECTURE.md and FEATURE-MAP.md to its map folder). Fills in the repo's description (and test command, if you know one) when they're empty.",
        {
          name: z.string().describe("The repo's name"),
          description: z.string().describe("One line: what the repo is"),
          test_command: z.string().optional().describe("Only if the repo states one (README, CI); onboarding doesn't run tests"),
        },
        async ({ name, description, test_command }) => {
          try {
            const r = finishMap(agent, name, { description, test_command });
            return text(`${r.name}'s map is ready (${mapDir(r.name)}/). Description: ${r.description || "—"}.`);
          } catch (e: any) {
            return refuse(e.message);
          }
        },
      ),

      tool(
        "memory_write",
        "Write a note in a repo's memory tree (the Repo memory section of your instructions). Updating a note: read it first and pass the rev from its header (refused if someone changed it since; read again and merge). New notes are added only while you fold in merged work; before that, write them to your task's draft folder. Frontmatter `anchors:` lists the code the note describes (path or path#symbol on the default branch); agentbox hashes them and clears `stale:`.",
        {
          repo: z.string().describe("The repo's name"),
          path: z.string().describe("Path inside the repo's memory, e.g. portal-b/auth.md or portal-b/INDEX.md (you choose the layout)"),
          content: z.string().describe("The whole note: optional frontmatter (anchors: [...]) and markdown"),
          rev: z.number().optional().describe("The note's current rev (from its header) when it exists"),
        },
        async (args) => {
          try { return text(await writeNote(agent, args)); } catch (e: any) { return refuse(e.message); }
        },
      ),

      tool(
        "memory_confirm",
        "You checked a repo-memory note against the code and it's still right: re-stamp it as verified on the default branch (clears a stale mark). Pass the rev from its header.",
        { repo: z.string(), path: z.string(), rev: z.number() },
        async (args) => {
          try { return text(await confirmNote(agent, args)); } catch (e: any) { return refuse(e.message); }
        },
      ),

      tool(
        "memory_move",
        "Move or rename a note or a folder in a repo's memory tree (to reorganise it). Update the INDEX.md files that list it.",
        { repo: z.string(), from: z.string(), to: z.string() },
        async (args) => {
          try { return text(await moveNote(agent, args)); } catch (e: any) { return refuse(e.message); }
        },
      ),

      tool(
        "memory_delete",
        "Delete a note or a folder from a repo's memory tree (wrong, obsolete, or merged into another note). Update the INDEX.md that listed it.",
        { repo: z.string(), path: z.string() },
        async (args) => {
          try { return text(await deleteNote(agent, args)); } catch (e: any) { return refuse(e.message); }
        },
      ),

      tool(
        "memory_promoted",
        "After your PR merged: say you've folded this task's draft notes into the repo's memory (or that nothing was worth keeping). Removes the drafts.",
        { repo: z.string() },
        async ({ repo }) => {
          try { return text(finishPromotion(agent, repo)); } catch (e: any) { return refuse(e.message); }
        },
      ),

      tool(
        "request_setup",
        "Ask for something this computer lacks (an account, a login, a CLI, cloud or repo access). The owner gets a card to have the setup agent do it; you're called back with a new message when it's done or declined. Don't wait or poll: end your turn, or carry on with other work.",
        {
          title: z.string().describe("Short, e.g. \"Connect GCP (project acme-prod)\""),
          why: z.string().describe("For the owner: what you need it for, in a sentence or two"),
          for_setup_agent: z.string().describe("For the setup agent: exactly what to set up (account, project, region, scopes, which repo…). The owner can read it."),
          integration: z.string().optional().describe("An integration id from the catalog (e.g. gcp), if it's one of them"),
          repo: z.string().optional().describe("A registered repo's name, for repo access"),
          check: z.string().optional().describe("A read-only shell command that exits 0 once it's done (e.g. gcloud auth list --filter=status:ACTIVE --format=value(account) | grep -q .)"),
        },
        async (args) => {
          try {
            const { request, joined } = requestSetup(agent, taskId, args);
            return text(`${joined ? `Joined the open setup request "${request.title}" (${request.id}): someone already asked for it.` : `Setup request ${request.id} raised: the owner sees a card with "Set up now" and "Reject".`} You'll get a new message when it's done or declined. End your turn now, or continue with work that doesn't need it; don't wait in a loop.`);
          } catch (e: any) {
            return refuse(e.message);
          }
        },
      ),

      tool(
        "submit_plan",
        `Share a plan. Use it when this work says "Plan first" or the owner asks for a plan (then it needs the owner's approval: set wait_for_owner if they asked in words, submit, end your turn and wait for the decision), or, optionally, for a high-impact design change (a new service, a changed data flow or schema), which is just for the record: submit and carry on immediately, never wait for a reply (the owner may redirect you later). Never for low- or medium-risk work: do that yourself. The owner reads the DIAGRAM first, so make it carry the plan: two small graphs of components (services, queues, tables, pages, jobs; never file names) as they are now ("before") and as they'll be ("after"). Use the same id for the same component in both. Show ONLY what changes plus its direct neighbours: at most ${PLAN_LIMITS.afterNodes} boxes, labels of 2–4 words. A box that stays but behaves differently gets a short "change" note. For something entirely new, leave "before" empty. Text stays short: a 1–2 sentence summary, up to ${PLAN_LIMITS.changes} "changes" bullets, up to ${PLAN_LIMITS.checks} checks (how we'll know it works), up to ${PLAN_LIMITS.risks} risks; anything longer goes in "details" (collapsed). Plans that are too big, or that draw boxes unrelated to the change, are refused with what to simplify. Example: before {service1 → service2}, after {service1 → logger (new), service1 → service2}.`,
        {
          title: z.string().describe(`What this plan does, ≤ ${PLAN_LIMITS.title} chars`),
          summary: z.string().describe(`1–2 sentences, ≤ ${PLAN_LIMITS.summary} chars: the goal and the approach`),
          diagram: z.object({
            before: z.object({
              nodes: z.array(z.object({ id: z.string(), label: z.string() })).describe("Components as they are now (only the ones that matter to this change). Empty for something new."),
              edges: z.array(z.object({ from: z.string(), to: z.string(), label: z.string().optional() })),
            }).optional(),
            after: z.object({
              nodes: z.array(z.object({ id: z.string(), label: z.string(), change: z.string().optional().describe(`For a box that stays but behaves differently, ≤ ${PLAN_LIMITS.change} chars`) })),
              edges: z.array(z.object({ from: z.string(), to: z.string(), label: z.string().optional().describe("A few words: what flows (e.g. \"events\")") })),
            }),
          }),
          changes: z.array(z.string()).describe(`What changes, one short bullet each (≤ ${PLAN_LIMITS.changes})`),
          checks: z.array(z.string()).optional().describe("How we'll know it works: tests, commands, what to observe"),
          risks: z.array(z.string()).optional().describe("What could go wrong, and the fallback"),
          details: z.string().optional().describe("Optional longer markdown (files, steps); shown collapsed"),
          wait_for_owner: z.boolean().optional().describe("true only when the owner asked you for a plan before you start (the work says \"Plan first\" counts automatically); then end your turn and wait"),
        },
        async (args) => {
          try {
            const p = submitPlan(agent, taskId, args);
            const lead = p.reviewer_id ? getAgent(p.reviewer_id) : null;
            if (lead) {
              return text(p.status === "pending"
                ? `Plan "${p.title}" (v${p.version}) is with ${lead.name} (who delegated this to you) to decide, not the owner. End your turn now with a short summary of the plan; you'll get a message with ${lead.name}'s decision.`
                : `Plan "${p.title}" (v${p.version}) is shared with ${lead.name}. Carry on with the work now; don't wait for a reply.`);
            }
            return text(p.status === "pending"
              ? `Plan "${p.title}" (v${p.version}) is with the owner for approval (this work is "plan first"). End your turn now; you'll get a message with their decision.`
              : `Plan "${p.title}" (v${p.version}) is shared with the owner. Carry on with the work now; don't wait for a reply. If the owner wants a different direction, you'll get a message.`);
          } catch (e: any) {
            return refuse(`Plan not submitted: ${e.message}`);
          }
        },
      ),
      tool(
        "decide_plan",
        "Decide a plan that an agent you delegated to sent you (they wait for you, not the owner). approve: they go ahead. changes: they revise it (say what to change). reject: they stop that approach. Judge it against the work's goal and prefer the simplest solution. Leave plan_id out when only one waits for you.",
        {
          plan_id: z.string().optional().describe("The plan's id (from the notice or your instructions)"),
          verdict: z.enum(["approve", "changes", "reject"]),
          note: z.string().optional().describe("For changes: what to change. Otherwise optional guidance."),
        },
        async ({ plan_id, verdict, note }) => {
          const waiting = plansFor(agent.id);
          const p = plan_id ? getPlan(plan_id) : waiting.length === 1 ? waiting[0] : null;
          if (!p) {
            return refuse(waiting.length
              ? `Several plans wait for you; pass plan_id: ${waiting.map((w) => `${w.id} ("${w.title}" from ${getAgent(w.instance_id)?.name ?? "?"})`).join(", ")}`
              : "No plan waits for your decision.");
          }
          try {
            const d = decidePlan(p.id, verdict as Decision, note ?? "", { by: agent, byTaskId: taskId });
            const who = getAgent(d.instance_id)?.name ?? "The agent";
            return text(`${verdict === "approve" ? "Approved" : verdict === "changes" ? "Sent back for changes" : "Rejected"}: "${d.title}". ${who} gets your decision now${verdict === "approve" ? " and goes ahead" : ""}; their reply comes back to you as a report.`);
          } catch (e: any) {
            return refuse(e.message);
          }
        },
      ),

      tool(
        "roadmap_create",
        `Start a roadmap for big work (several steps, phases or agents), so the owner can see at a glance what's done, in progress, blocked and next, without reading the chat. Give it a clear label (e.g. "Partner API keys", "CSPM rollout"); separate streams of work can each have their own. Steps are short outcomes (≤ ${RM_LIMITS.item} chars, e.g. "Schema + migration", not "work on DB"), ${RM_LIMITS.items} at most; "after" lists the steps that must come first (only real dependencies), "phase" groups them (e.g. "Build", "Rollout"). Every agent on this work can update it, and it appears in your instructions each turn. Don't make one for small tasks.`,
        {
          title: z.string().describe(`The label, ≤ ${RM_LIMITS.title} chars`),
          items: z.array(z.object({
            id: z.string().describe("Short id, e.g. \"schema\""),
            title: z.string(),
            phase: z.string().optional(),
            after: z.array(z.string()).optional().describe("Ids of steps that must be done first"),
            status: z.enum(RM_STATUSES).optional().describe("Default todo"),
            owner: z.string().optional().describe("Who does it, e.g. coder#3 (when known)"),
            note: z.string().optional(),
            link: z.string().optional().describe("PR, issue or doc"),
          })),
        },
        async (args) => {
          try {
            const r = createRoadmap(agent, taskId, args);
            return text(`Roadmap "${r.title}" (${r.id}) is live for the owner. Update it with roadmap_update as steps start, finish or get blocked.`);
          } catch (e: any) {
            return refuse(`Roadmap not created: ${e.message}`);
          }
        },
      ),

      tool(
        "roadmap_update",
        "Update a roadmap of this work as things happen: a step started (doing), finished (done, with its PR/issue as link), blocked (with the reason in note; blocked on the owner: the question itself, asked in full in your reply this turn, which the step links to), skipped, or the plan changed (add, remove, retitle, re-order dependencies). Send only what changed. Do it right when it happens: the owner follows progress here.",
        {
          roadmap: z.string().describe("Its id (or exact title), as listed under \"Roadmaps of this work\" in your instructions"),
          items: z.array(z.object({
            id: z.string(),
            status: z.enum(RM_STATUSES).optional(),
            title: z.string().optional(),
            phase: z.string().optional(),
            after: z.array(z.string()).optional(),
            owner: z.string().optional(),
            note: z.string().optional(),
            link: z.string().optional(),
          })).optional().describe("Changes to existing steps (only the fields that changed)"),
          add: z.array(z.object({
            id: z.string(), title: z.string(), phase: z.string().optional(), after: z.array(z.string()).optional(),
            status: z.enum(RM_STATUSES).optional(), owner: z.string().optional(), note: z.string().optional(), link: z.string().optional(),
          })).optional(),
          remove: z.array(z.string()).optional().describe("Ids of steps that no longer apply (prefer status skipped to keep history)"),
          title: z.string().optional().describe("A new label"),
        },
        async (args) => {
          try {
            const r = updateRoadmap(agent, args as any, taskId);
            const items = roadmapItems(r.id);
            const done = items.filter((i) => i.status === "done").length;
            return text(`Updated "${r.title}": ${done}/${items.length} done${r.status === "done" ? " (complete)" : ""}.`);
          } catch (e: any) {
            return refuse(`Roadmap not updated: ${e.message}`);
          }
        },
      ),

      tool(
        "propose_skill",
        "Propose a reusable skill (a procedure you or teammates will need again) for the owner to review and add to the skill library.",
        {
          name: z.string().describe("kebab-case, e.g. deploy-staging"),
          description: z.string().describe("One sentence: what it does and when to use it"),
          body: z.string().describe("Markdown instructions: steps, commands, checks. General, not tied to this one task."),
        },
        async (args) => {
          const d = proposeSkill(agent.id, taskId, args);
          return text(`Proposed skill "${d.name}". The owner will review it in agentbox.`);
        },
      ),

      // --- hosting (hosting.ts): serve what you build at a link the owner can open --------------------
      tool(
        "host_start",
        "Host something for the owner to open in their browser: a static folder (HTML/JS/CSS) or a command that serves HTTP on $PORT. Returns the link. Starting the same name again restarts it. Use the host-service skill.",
        {
          name: z.string().describe("Short lowercase name; it becomes the link's path, e.g. arm-dashboard → …/arm-dashboard/"),
          dir: z.string().describe("Absolute folder: what to serve (static), or where to run the command"),
          command: z.string().optional().describe("Leave out for a static folder. Otherwise a shell command that listens on 127.0.0.1:$PORT, e.g. 'python3 -m http.server $PORT --bind 127.0.0.1' or 'npm run dev -- --port $PORT --host 127.0.0.1'"),
          keep_prefix: z.boolean().optional().describe("true: the app gets the full path (/name/…), for apps built with that base path. Default false: it gets / (the prefix is removed)"),
        },
        async (args) => {
          try {
            const v = await startService(agent, { name: args.name, dir: args.dir, command: args.command, stripPrefix: args.keep_prefix !== true });
            return text(`Hosted "${v.name}" (${v.kind}${v.port ? `, port ${v.port}` : ""}).
Owner's link: ${v.url}
Your own checks from this machine: ${v.local_url}${v.port ? ` (or http://127.0.0.1:${v.port}/ directly)` : ""}
It runs until you or your lead stop it (host_stop) or the work is marked done. Give the owner the link, not a command to run.`);
          } catch (e: any) {
            return refuse(e.message);
          }
        },
      ),
      tool("host_stop", "Stop a hosted service you started (a lead can stop any in its work).", { name: z.string() }, async ({ name }) => {
        const s = hostedByName(name.trim().toLowerCase());
        if (!s) return refuse(`Nothing called "${name}" is running.`);
        if (!mayControlHosted(agent, s)) return refuse(`"${s.name}" was started by ${getAgent(s.started_by)?.name ?? "another task"}; ask them or your lead.`);
        await stopHosted(s, `stopped by ${agent.name}`);
        return text(`Stopped "${s.name}".`);
      }),
      tool("host_list", "List the services hosted in this work (running, and the last ones that ended), with their links.", {}, async () => {
        const list = roomHosted(rootOf(agent).id);
        if (!list.length) return text("Nothing hosted in this work.");
        return text(list.map((v) => `- ${v.name}: ${v.status}${v.status === "running" ? ` — ${v.url}` : ` (${v.stop_reason ?? ""})`} · ${v.kind === "command" ? `\`${v.command}\` on port ${v.port}` : v.dir} · started by ${v.started_by}`).join("\n"));
      }),
      tool("host_logs", "The last lines a hosted command printed (for a crash or a failed start).", { name: z.string(), lines: z.number().int().min(1).max(400).optional() }, async ({ name, lines }) => {
        const s = get<any>(`SELECT * FROM hosted_services WHERE name = ? AND room_id = ? ORDER BY created_at DESC LIMIT 1`, name.trim().toLowerCase(), rootOf(agent).id);
        if (!s) return refuse(`No service called "${name}" in this work.`);
        return text(tailHosted(s, lines ?? 60) || "(no output)");
      }),
  ];
}

export function rosterFor(agent: Agent) {
  // Your crew's agents only (crews.ts); built-in roles (the setup agent) take work from the owner only.
  const roles = crewmates(agent);
  const tools = (id: string) => {
    const list = mappedIntegrations(id).filter(isConnected).map((i) => cachedIntegrations()?.find((x) => x.id === i)?.title ?? i);
    return list.length ? ` Tools: ${list.join(", ")}.` : "";
  };
  const crew = crewIdOf(agent);
  const header = crew ? `You're in the **${crewName(crew)}** crew. You work only with these agents; other crews' agents are out of reach.\n` : "";
  return header + (roles.length
    ? roles.map((a) => `- **${a.name}** (${a.title}): ${a.summary}${tools(a.id)}${a.can_scale ? " (hand it work to bring it in as this work's lead)" : ""}`).join("\n")
    : "- (no other agents in your crew)");
}
