import { EventEmitter } from "node:events";
import { now, run } from "./db.ts";

/** Everything the UI needs to stay live goes through here and out over WebSocket. */
export type BusEvent =
  | { type: "agent.created" | "agent.updated"; agent: any }
  | { type: "agent.deleted"; agentId: string }
  | { type: "agent.retired"; agentId: string }
  | { type: "agent.status"; agentId: string; status: AgentStatus; taskId?: string }
  | { type: "task.updated"; task: any }
  | { type: "message.created"; message: any }
  | { type: "turn.delta"; taskId: string; agentId: string; text: string }
  | { type: "step.updated"; step: any }
  | { type: "usage"; usage: any }
  | { type: "skill.updated"; skill: any }
  | { type: "skill.deleted"; name: string }
  | { type: "draft.updated"; draft: any }
  | { type: "agent.skills"; agentId: string; skills: string[] }
  | { type: "thread.created"; thread: any }
  | { type: "group.updated"; group: any }
  | { type: "group.deleted"; id: string }
  | { type: "routine.updated"; routine: any }
  | { type: "routine.deleted"; id: string }
  | { type: "display.updated"; display: any }
  | { type: "paused"; paused: boolean }
  | { type: "devices.changed" } // paired phones or their audit changed (portal Devices page / Activity)
  | { type: "progress.updated"; progress: any } // progress.ts: a running task's live status changed
  | { type: "progress.cleared"; agent_id: string; task_id: string } // its turn ended
  | { type: "attention.updated"; item: any } // attention.ts: a "needs you" item was created, refreshed or seen
  | { type: "routine-run.updated"; run: any } // routineRuns.ts: a routine run started, changed or finished
  | { type: "integration.output"; integrationId: string; taskId: string | null; line: string } // integrations.ts: CLI output
  | { type: "integration.updated"; integrationId: string } // its state may have changed: refetch
  | { type: "integration.job"; integrationId: string; job: any } // a connect / verify / disconnect started or ended
  | { type: "integration.mapping"; integrationId: string; roles: string[] } // role ↔ integration mapping changed
  | { type: "approval.updated"; approval: any } // approvals.ts: a proposal was made or decided
  | { type: "setup.plan"; instanceId: string; plan: any } // setupPlan.ts: a setup session's checklist changed
  | { type: "setup.check"; instanceId: string; stepId: string; running: boolean; at: string; ok?: boolean } // a step's check started / ended
  | { type: "repo.updated"; repoId: string | null } // repos.ts: a repo, its clone, map or worktrees changed: refetch
  | { type: "repo.progress"; repoId: string; line: string } // a clone's progress line
  | { type: "memory.updated"; repo?: string; draft?: any } // memory.ts: a repo's memory tree or a task's draft changed
  | { type: "setup_request.updated"; request: any } // setupRequests.ts: a request was raised, started, finished or declined
  | { type: "plan.updated"; plan: any } // plans.ts: a plan was submitted, decided or replaced
  | { type: "plan_gate.updated"; rootId: string; required: boolean } // plans.ts: a task's "approve a plan first" changed
  | { type: "review.updated"; rootId: string; review: any } // changes.ts: the owner reviewed a task's changes
  | { type: "roadmap.updated"; roadmap: any } // roadmaps.ts: a roadmap was created, changed or archived
  | { type: "wakeup.updated"; wakeup: any } // wakeups.ts: a one-time wake-up was set, fired or cancelled
  | { type: "hosting.updated"; service: any } // hosting.ts: a hosted service started, stopped or exited
  | { type: "notes.updated"; roomId: string } // notes.ts: a note in a piece of work's notebook was added, changed or deleted
  | { type: "crews.updated"; crews: any[] } // crews.ts: a crew was created, renamed, given a lead or deleted, or an agent moved
  | { type: "links.updated"; roomId: string } // linkedWork.ts: the owner linked or unlinked other work to a piece of work
  | { type: "group.workspaces"; groupId: string } // groupWork.ts: a group's workspaces changed (launched, asked, finished)
  | { type: "shares.updated"; roomId: string } // shares.ts: a link to a piece of work was made or revoked
  | { type: "sharing.updated" }; // shares.ts: the ngrok tunnel started, stopped or failed

export type AgentStatus = "idle" | "working" | "limited" | "error";

const emitter = new EventEmitter();
emitter.setMaxListeners(100);

// Streaming deltas and live progress are too chatty to keep; everything else is the activity log.
// Run updates are derived state (the run rows and routine.updated already record runs).
const EPHEMERAL = new Set(["turn.delta", "devices.changed", "progress.updated", "progress.cleared", "routine-run.updated",
  "integration.output", "integration.updated", "setup.plan", "setup.check", "repo.updated", "repo.progress", "hosting.updated",
  "notes.updated", "crews.updated", "links.updated", "group.workspaces", "sharing.updated"]);

export function publish(event: BusEvent) {
  if (!EPHEMERAL.has(event.type)) {
    const e = event as any;
    run(
      `INSERT INTO events (ts, type, agent_id, task_id, payload) VALUES (?, ?, ?, ?, ?)`,
      now(),
      event.type,
      e.agentId ?? e.agent?.id ?? e.task?.agent_id ?? e.step?.agent_id ?? e.item?.agent_id ?? null,
      e.taskId ?? e.task?.id ?? e.step?.task_id ?? e.message?.task_id ?? e.item?.task_id ?? null,
      JSON.stringify(event),
    );
  }
  emitter.emit("event", event);
}

export function subscribe(fn: (e: BusEvent) => void) {
  emitter.on("event", fn);
  return () => emitter.off("event", fn);
}
