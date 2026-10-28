export type AgentStatus = "idle" | "working" | "limited" | "error";

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
  status: AgentStatus;
  taskId?: string;
  dm_thread_id: string | null;
  skills: string[];
  home?: string;
  /** Instances only: */
  created_by?: string | null;
  parent_instance_id?: string | null;
  label?: string | null;
  kept?: number;
  /** Agents (roles) only: how many live tasks they have. */
  live_instances?: number;
  base_agent_id?: string | null;
  replica_no?: number | null;
  max_replicas?: number;
  can_scale?: number;
  retired_at?: string | null;
  /** Built-in roles (e.g. "setup"): not deletable or renamable; their CLAUDE.md belongs to agentbox. */
  builtin?: string | null;
  owner_notes?: string | null;
  /** Roles: ids of the integrations mapped to them. */
  integrations?: string[];
  /** Roles: the crew it's in (null: none). Tasks follow their role's crew. */
  crew_id?: string | null;
};
/** A crew (crews.ts): a separate team; its agents only work with each other. */
export type Crew = { id: string; slug: string; name: string; summary: string; lead_role_id: string | null; created_at: string };
export type StepState = "pending" | "running" | "human" | "done" | "failed" | "skipped";
export type IntegrationState = "available" | "connecting" | "connected" | "error" | "disconnected" | "unavailable";
export type SettingValue = string | number | boolean | string[];
export type IntegrationGate =
  | { kind: "setting"; key: string; title: string; command: string }
  | { kind: "step"; id: string; title: string; instructions: string | null; copy: string | null };
/** The last (or running) connect / verify / disconnect, for the steps card's live progress. */
export type IntegrationJob = {
  action: "connect" | "verify" | "disconnect"; running: boolean; started_at: string; ended_at: string | null;
  last_output_at: string; ok: boolean | null; code: number | null; timed_out: boolean;
};
/** server/src/integrations.ts › Integration (adapted from `agentbox integration status --json`). */
export type Integration = {
  id: string; title: string; description: string; category: string; state: IntegrationState;
  /** False: "coming soon" (state "unavailable"). */
  available: boolean; enabled: boolean; account: string | null; depends: string[];
  settings: {
    key: string; prompt: string; type: "string" | "boolean" | "list" | "enum" | "number"; required: boolean;
    default: SettingValue | null; options: string[] | null; pattern: string | null; example: string | null;
    value: SettingValue | null; missing: boolean; error: string | null;
  }[];
  settings_saved: boolean; missing: string[];
  steps: {
    id: string; title: string; human: boolean; instructions: string | null; copy: string | null; state: StepState;
    check: { ok: boolean; code: number | null; output: string | null; timed_out: boolean } | null; last_error: string | null;
  }[];
  gates: IntegrationGate[];
  revoke: string | null;
  default_roles: string[]; skills: string[];
  last: { action: string; ok: boolean | null; error: string | null; at: string | null } | null;
  /** Mapped role ids. */
  roles: string[];
  // GET /api/integrations/:id only:
  output?: { line: string; at: string }[];
  job?: IntegrationJob | null;
  /** The server's clock when it answered (elapsed times don't depend on the browser's). */
  now?: string;
};
/** server/src/setupPlan.ts › PlanView: a setup session's checklist. */
export type PlanStepStatus = "pending" | "done" | "skipped" | "failed";
export type PlanCheck = { ok: boolean; code: number | null; output: string; at: string; timed_out: boolean };
export type PlanStep = {
  id: string; title: string; why: string; instructions: string; commands: string[]; check: string | null; human: boolean;
  integration: { id: string; step: string | null } | null;
  status: PlanStepStatus; done_by: "check" | "owner" | "agent" | null; done_at: string | null; note: string | null;
  last_check: PlanCheck | null; nudged: boolean;
};
export type SetupPlan = {
  instance_id: string; title: string; steps: PlanStep[]; created_at: string; updated_at: string;
  current: string | null; checking: Record<string, string>; checked_at: Record<string, string>; interval_ms: number;
  done_count: number; total: number;
};
export type SetupSession = {
  id: string; label: string | null; name: string; retired_at: string | null; created_at: string;
  plan: { title: string; done: number; total: number; current: string | null } | null;
};
export type LineDiff = { op: " " | "-" | "+"; text: string };
export type ApprovalKind = "mapping" | "team_rule" | "repo_add" | "agent_create" | "agent_change" | "skill" | "skill_assign" | "bundle";
/** One change in a team proposal (a bundle holds several). */
export type TeamItem = { kind: "agent_create" | "agent_change" | "skill" | "skill_assign"; title: string; payload: any };
export type Approval = {
  id: string; kind: ApprovalKind; status: "pending" | "approved" | "rejected" | "failed" | "undone";
  proposed_by: string; proposed_by_name?: string | null; task_id: string | null; thread_id: string | null;
  title: string; error: string | null; created_at: string; decided_at: string | null; undo?: unknown[] | null;
  payload: {
    integration_id?: string; integration_title?: string; roles?: string[]; before?: string[]; added?: string[]; removed?: string[];
    file?: string; relative?: string; reason?: string; created?: boolean; diff?: LineDiff[];
    url?: string; name?: string; default_branch?: string; role_names?: string[]; description?: string;
    items?: TeamItem[];
    [k: string]: any;
  };
};
export type DocumentInfo = {
  path: string; name: string; folder: string; location: string; size: number; modified: string;
  source: "home" | "written"; task_id: string | null; task_title: string | null;
};
export const fileUrl = (path: string, download = false) =>
  `/api/file?path=${encodeURIComponent(path)}${download ? "&download=1" : ""}`;
export type InstanceSummary = {
  id: string; name: string; label: string | null; role_id: string; color: string; parent_instance_id: string | null;
  created_by: string | null; created_at: string; retired_at: string | null; kept: boolean;
  status: AgentStatus | "done"; current: string | null; queued: number;
};
/** A workspace a group's lead launched (groupWork.ts). */
export type GroupWorkspace = {
  id: string; title: string; root_id: string; item_id: string; created_at: string; question: string | null; step: string | null;
  lead: InstanceSummary | null; roadmaps: { title: string; total: number; done: number; blocked: number; doing: number; todo: number; skipped: number }[];
};
/** Linked work (linkedWork.ts): other work this one's agents may read. */
export type LinkedWorkInfo = { id: string; label: string; name: string; crew: string | null; crew_name: string; status: "live" | "done" | "deleted" };
export type WorkLink = { id: string; created_at: string; work: LinkedWorkInfo };
export type WorkRoom = { root: InstanceSummary; members: InstanceSummary[]; last_activity: string | null; hides_at?: string | null };
export type RoomView = {
  root: InstanceSummary; members: InstanceSummary[]; workspace: string | null; threads: { id: string; agent_id: string; kind: string }[];
  messages: Message[]; tasks: Task[]; steps: Step[];
};
export type RetiredAgent = { id: string; name: string; color: string; base_agent_id: string | null };

export type Skill = { name: string; description: string; body: string; files: string[]; agents: string[]; updated_at: string };
export type SkillDraft = {
  id: string; name: string; description: string; body: string; proposed_by: string; task_id: string | null;
  status: "pending" | "approved" | "rejected"; created_at: string;
};

export type Message = { id: string; thread_id: string; author: string; task_id: string | null; content: string; created_at: string };
export type Task = {
  id: string; agent_id: string; thread_id: string; source: "user" | "agent" | "message" | "result" | "cron"; prompt?: string;
  title: string | null; from_agent_id: string | null; parent_task_id: string | null; depth: number; children?: number;
  status: "queued" | "running" | "done" | "failed" | "stopped";
  result?: string | null; error: string | null; cost_usd?: number | null;
  created_at: string; started_at: string | null; finished_at: string | null;
};
export type Step = {
  id: string; task_id: string; seq: number; kind: string; name: string; summary: string;
  input: string | null; output: string | null; status: "running" | "done" | "error" | "stopped";
  started_at: string; finished_at: string | null;
};
export type Group = {
  id: string; name: string; purpose: string; lead_agent_id: string | null; members: string[]; paused: boolean; created_at: string;
};
export type Thread = { id: string; kind: "dm" | "handoff" | "group" | "routine"; agent_id: string; peer_agent_id: string | null; name: string | null; last_at: string | null };
/** A row of a routine's own run log (GET /api/routines/:id). */
export type RoutineRunRow = {
  id: string; at: string; trigger: "schedule" | "manual"; outcome: "started" | "skipped"; reason: string | null; task_id: string | null;
  task_status: string | null; task_error?: string | null;
  status?: RunStatus | null; finished_at?: string | null; summary?: string | null;
};
export type RunStatus = "running" | "done" | "failed" | "stopped" | "skipped";
/** A routine run, active or finished (server routineRuns.ts, CONTRACTS-v2 § G). */
export type RoutineRun = {
  id: string; routine_id: string; routine_name: string; role_id: string; instance_id: string | null;
  trigger: "schedule" | "manual"; started_at: string; finished_at: string | null;
  status: RunStatus; reason: string | null;
  summary: string | null; duration_s: number | null; tasks: number;
  members: { id: string; name: string; label: string | null; status: string }[];
};
export type RunDetail = {
  run: RoutineRun; members: InstanceSummary[]; threads: { id: string; agent_id: string; kind: string }[];
  messages: Message[]; tasks: Task[]; steps: Step[];
};
/** server/src/wakeups.ts: a one-time wake-up an agent set for itself. */
export type Wakeup = {
  id: string; agent_id: string; agent_name: string | null; task_id: string | null; note: string; due_at: string;
  status: "pending" | "fired" | "cancelled"; created_at: string; done_at: string | null;
};
export type Routine = {
  id: string; agent_id: string; thread_id: string; name: string; cron: string; timezone: string; prompt: string;
  enabled: boolean; created_by: string; created_at: string; next_runs: string[]; describe: string; last_run: RoutineRunRow | null;
  instance_id: string | null; context_mode: "continue" | "fresh"; workspace: string | null;
  group: { id: string; name: string; label: string | null; role_id: string; context_tokens: number | null }[];
  compaction: { runs_since: number; last_at: string | null; context_tokens: number; due: string[] };
  rules: RoutineRules; rules_summary: string[];
};
export type RoutineRules = {
  everyone: string;
  roles: Record<string, string>;
  perms: {
    merge_main: "never" | "safe" | "allowed" | null;
    deploy: "none" | "staging" | "production" | null;
    issues: boolean | null;
    teams: boolean | null;
    max_helpers: number | null;
  };
};
export type DisplayHolder = { holder: string; reason: string; since: string; last_used: string; task_id: string | null } | null;
export type ActivityItem = {
  id: string; ts: string; kind: string; actor: string; agent_id: string | null; title: string; detail?: string; task_id?: string | null; link?: string;
};
export type GraphEdge = { from: string; to: string; kind: string; n: number; last: string };
export type RoutineInput = { agent_id: string; name: string; cron: string; timezone: string; prompt: string; enabled: boolean; context_mode?: "continue" | "fresh"; rules?: RoutineRules };
export type ThreadData = { messages: Message[]; tasks: Task[]; steps: Step[] };
/** Live progress of a running task (server progress.ts, CONTRACTS-v2 § A). */
export type Progress = {
  agent_id: string; task_id: string; root_id: string | null; group_id: string | null;
  activity: string;
  step: { name: string; summary: string; started_at: string } | null;
  started_at: string; last_step_at: string;
  state: "working" | "stalled"; stalled_for_s: number | null;
  summary: string | null;
  /** Routine work only: the run this task belongs to. */
  run_id?: string | null;
};
/** A "needs you" item (server attention.ts, CONTRACTS-v2 § B). room_id: task-room root or group id. */
export type Attention = {
  id: string; kind: "reply" | "failed" | "stalled" | "question";
  agent_id: string; task_id: string | null; room_id: string | null;
  title: string; created_at: string; seen_at: string | null;
};

export type Usage = {
  status: "allowed" | "allowed_warning" | "rejected";
  resetsAt?: number;
  rateLimitType?: string;
  utilization?: number;
  unifiedWindows?: Record<string, { utilization: number; resetsAt: number }>;
};

export type CoreQuestion = { id: string; question: string; hint: string; kind: "short" | "long" | "multi"; options?: string[] };
export type Template = { id: string; label: string; name: string; job: string; done: string };
export type FollowUp = { id: string; question: string; options: string[] };
export type Draft = { title: string; summary: string; model: string; model_reason: string; instructions: string };

export type Device = {
  id: string; name: string; fingerprint: string; app_version: string | null; tailnet_login: string | null;
  status: "pending" | "active"; created_at: string; approved_at: string | null; last_seen_at: string | null; expires_at: string | null;
  /** Notifications on (the phone registered a push token). The token itself never reaches the portal. */
  push: boolean;
};
export type Pairing = { id: string; code: string; expires_at: string; url: string; qr_payload: string };
export type GatewayStatus = {
  tailscale: {
    installed: boolean; backend_state: string | null; dns_name: string | null; url: string | null;
    serve_target: string | null; funnel: boolean | null; funnel_capable: boolean | null; error?: string;
  };
  guard: { present: boolean | null; detail: string };
  manual_url: string | null;
  url: string | null;
  port: number;
};

/** server/src/repos.ts › repoView. */
export type RepoWorktree = {
  id: string; repo_id: string; instance_id: string; purpose: "task" | "onboard"; path: string | null; branch: string | null;
  status: "pending" | "active" | "kept" | "removed" | "discarded" | "error"; note: string | null; created_at: string; closed_at: string | null;
  instance: { id: string; name: string; label: string | null; retired: boolean } | null;
};
/** A weekly map refresh: one per agent that maps repos. */
export type MapRoutineInfo = { id: string; enabled: boolean; agent_id: string; agent: string };
export type Repo = {
  id: string; name: string; url: string; provider: "github" | "gitlab" | "bitbucket" | "other"; default_branch: string | null;
  description: string; test_command: string; protected_branches: string[]; allowed_roles: string[];
  agents_may_merge: boolean; agents_may_deploy: boolean; propose_map_pr: boolean; lead_may_merge: boolean;
  status: "cloning" | "ready" | "error" | "archived"; last_fetch_at: string | null; error: string | null;
  /** choosing: the helper is picking who maps it (map_task_id is the helper's task). */
  map_status: "none" | "choosing" | "running" | "ready" | "error"; map_updated_at: string | null; map_task_id: string | null; map_error: string | null;
  archive_path: string | null; archived_at: string | null; created_at: string;
  /** Who maps it (an agent); null: the helper picks a crew lead when it's mapped. mapper_note: who chose and why. */
  mapper_role_id: string | null; mapper_note: string | null;
  path: string | null; map_dir: string; map_files: { file: string; path: string; exists: boolean; size: number; modified: string | null }[];
  /** Repo memory (agent-owned notes): count, stale ones, task drafts waiting for their PR to merge. */
  memory?: { dir: string; index: string | null; notes: number; stale: number; scanned_at: string | null; drafts: { id: string; agent_name: string | null; instance_id: string; status: "open" | "promoting"; notes: number; note: string | null; pr_number: number | null }[] } | null;
  job: { running: boolean; started_at: string; ended_at: string | null; last_output_at: string; ok: boolean | null; lines: { line: string; at: string }[] } | null;
  worktrees: RepoWorktree[]; users: { id: string; name: string; label: string | null }[];
};
export type AccountRepo = {
  provider: Repo["provider"]; full_name: string; url: string; ssh_url: string | null; description: string;
  default_branch: string | null; private: boolean; archived: boolean; updated_at: string | null; added: string | null;
};
export type RepoBinding = { id: string; repo: string; branch: string | null; path: string | null; status: RepoWorktree["status"]; note: string | null };
/** server/src/setupRequests.ts › requestView. */
export type SetupRequest = {
  id: string; requester_id: string | null; requester_name: string | null; task_id: string | null; thread_id: string | null;
  title: string; why: string; for_setup_agent: string; integration: string | null; repo: string | null; repo_url: string | null; check_cmd: string | null;
  status: "pending" | "in_progress" | "done" | "rejected" | "cancelled" | "failed";
  setup_instance_id: string | null; setup_instance_name: string | null; result_note: string | null;
  created_at: string; updated_at: string; decided_at: string | null; completed_at: string | null;
  waiters: { instance_id: string; name: string | null; called_back_at: string | null }[];
};

/** server/src/plans.ts › planView (docs/V2.1-PLAN.md §1). */
export type PlanGraph = { nodes: { id: string; label: string; change?: string }[]; edges: { from: string; to: string; label?: string }[] };
export type Plan = {
  id: string; root_id: string; instance_id: string; instance_name: string | null; task_id: string | null; thread_id: string | null;
  version: number; status: "shared" | "pending" | "approved" | "changes" | "rejected" | "superseded"; title: string;
  body: { title: string; summary: string; diagram: { before: PlanGraph; after: PlanGraph }; changes: string[]; checks: string[]; risks: string[]; details: string };
  feedback: string | null; created_at: string; decided_at: string | null;
  /** Who decides: null = the owner; otherwise the lead that delegated to this agent. */
  reviewer_id: string | null; reviewer_name: string | null;
};
export type PlanGate = { required: boolean; approved: { id: string; version: number; title: string } | null };
/** server/src/roadmaps.ts › roadmapView (docs/V2.1-PLAN.md §3). */
export type RoadmapStatus = "todo" | "doing" | "done" | "blocked" | "skipped";
export type RoadmapItem = {
  id: string; title: string; phase: string; after: string[]; status: RoadmapStatus; owner: string; note: string; link: string;
  updated_at: string; updated_by: string | null;
  /** Where it last changed: the agent's reply in that turn (null until posted). */
  source?: { agent_id: string; agent_name: string; thread_id: string | null; message_id: string | null; at: string } | null;
};
export type Roadmap = {
  id: string; root_id: string; created_by: string; created_by_name: string | null; thread_id: string | null; title: string;
  status: "active" | "done" | "archived"; events: { at: string; by: string; text: string }[]; created_at: string; updated_at: string;
  items: RoadmapItem[]; counts: Record<RoadmapStatus | "total", number>;
};
/** server/src/changes.ts (docs/V2.1-PLAN.md §2). */
export type DiffLine = { t: "hunk" | "ctx" | "add" | "del"; s: string; o?: number; n?: number };
export type FileChange = { path: string; status: "added" | "modified" | "deleted" | "untracked"; additions: number; deletions: number; binary: boolean; truncated: boolean; lines: DiffLine[] };
export type RepoChanges = {
  worktree_id: string; repo: string; branch: string | null; base: string; path: string;
  instance: { id: string; name: string; label: string | null } | null; head: string | null;
  commits: { sha: string; subject: string }[]; files: FileChange[]; additions: number; deletions: number; truncated: boolean; error: string | null;
};
export type ReviewComment = { worktree_id: string; repo: string; path: string; line: number; side: "old" | "new"; text: string };
export type Review = { id: string; root_id: string; instance_id: string; verdict: "approve" | "changes" | "reject"; note: string; comments: ReviewComment[]; heads: Record<string, string>; created_at: string };

/** The device bridge (server/src/bench.ts): the owner's computer sharing USB devices with agents. */
export type BenchStatus = {
  enabled: boolean; token: boolean; settings: { serial: boolean; loopback: boolean }; connected: boolean;
  bridge: { host: string; os: string; version: number; since: string; capabilities: Record<string, boolean> } | null;
  devices: { id: string; kind: string; description: string; manufacturer: string; vid: string; pid: string; port: number; url: string; dev: string | null; in_use: boolean }[];
};

/** An API error with what the server attached (409s from repos carry `detail`). */
export class ApiError extends Error {
  constructor(message: string, public status: number, public data: any) { super(message); }
}

async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError((data as any).error ?? `${res.status} ${res.statusText}`, res.status, data);
  return data as T;
}

/** A service an agent hosts (server/src/hosting.ts). */
/** A note in a piece of work's notebook (notes.ts): plain text, written fresh or saved from the chat. */
export type Note = {
  id: string; room_id: string; quote: string | null; body: string; message_id: string | null; author: string | null;
  created_at: string; updated_at: string;
};
/** A link sharing one piece of work with a guest (shares.ts). The link itself is shown once, when made. */
export type WorkShare = {
  id: string; room_id: string; perm: "read" | "edit"; label: string; created_at: string; expires_at: string;
  revoked_at: string | null; last_seen_at: string | null; live: boolean;
};
export type ShareExpiry = "6h" | "1d" | "7d";
export type HostedService = {
  id: string; name: string; kind: "static" | "command"; dir: string; command: string | null; port: number | null;
  status: "running" | "stopped" | "exited"; url: string; local_url: string; started_by: string; started_by_id: string;
  room_id: string; created_at: string; stopped_at: string | null; stop_reason: string | null;
};

/** The parallel-tasks choice on a role's page; the server's values arrive with GET /api/state. */
export const roleLimits = { per_role: 5, max_replicas: 6 };

export const api = {
  state: () => call<{ agents: Agent[]; crews?: Crew[]; usage: Usage | null; groups: Group[]; paused: boolean; display: DisplayHolder; retired: RetiredAgent[]; roots?: { agents: string; work: string }; limits?: { per_role: number; max_replicas: number } }>("GET", "/api/state"),
  fileInfo: (path: string) => call<Pick<DocumentInfo, "path" | "name" | "folder" | "size" | "modified">>("GET", `/api/file/info?path=${encodeURIComponent(path)}`),
  work: () => call<{ live: WorkRoom[]; done: WorkRoom[] }>("GET", "/api/work"),
  newTask: (roleId: string, text: string, title?: string, images?: string[], repos?: string[], requirePlan?: boolean, links?: string[]) =>
    call<Agent>("POST", "/api/work", { role_id: roleId, text, title, images, repos, require_plan: requirePlan || undefined, links: links?.length ? links : undefined }),
  publicConfig: () => call<{ host: string; access: string; modules: Record<string, boolean> }>("GET", "/api/config/public"),
  shares: (roomId: string) => call<{ shares: WorkShare[]; ready: boolean; missing: string | null }>("GET", `/api/work/${roomId}/shares`),
  createShare: (roomId: string, b: { perm: "read" | "edit"; expiry: ShareExpiry; label?: string }) =>
    call<{ share: WorkShare; url: string }>("POST", `/api/work/${roomId}/shares`, b),
  revokeShare: (id: string) => call<WorkShare>("DELETE", `/api/shares/${id}`),
  links: (instanceId: string) => call<{ room_id: string; links: WorkLink[]; linked_from: WorkLink[] }>("GET", `/api/work/${instanceId}/links`),
  addLink: (instanceId: string, workId: string) => call<{ room_id: string; links: WorkLink[] }>("POST", `/api/work/${instanceId}/links`, { work_id: workId }),
  removeLink: (id: string) => call<{ ok: true }>("DELETE", `/api/links/${id}`),
  room: (rootId: string) => call<RoomView>("GET", `/api/work/${rootId}`),
  hosted: (rootId: string) => call<{ services: HostedService[] }>("GET", `/api/hosting?room=${encodeURIComponent(rootId)}`),
  hostedAll: () => call<{ services: HostedService[] }>("GET", "/api/hosting"),
  stopHosted: (id: string) => call<HostedService>("POST", `/api/hosting/${id}/stop`),
  notes: (instanceId: string) => call<{ room_id: string; notes: Note[] }>("GET", `/api/work/${instanceId}/notes`),
  addNote: (instanceId: string, note: { quote?: string; body?: string; message_id?: string; author?: string }) => call<Note>("POST", `/api/work/${instanceId}/notes`, note),
  updateNote: (id: string, body: string) => call<Note>("PATCH", `/api/notes/${id}`, { body }),
  deleteNote: (id: string) => call<{ ok: true }>("DELETE", `/api/notes/${id}`),
  roomDocuments: (rootId: string) => call<(DocumentInfo & { author: string | null })[]>("GET", `/api/work/${rootId}/documents`),
  groupWorkspaces: (groupId: string) => call<{ lead_instance_id: string | null; workspaces: GroupWorkspace[] }>("GET", `/api/groups/${groupId}/workspaces`),
  groupDocuments: (groupId: string) => call<(DocumentInfo & { author: string | null })[]>("GET", `/api/groups/${groupId}/documents`),
  allDocuments: () => call<(DocumentInfo & { role: string })[]>("GET", "/api/documents"),
  finishTask: (instanceId: string) => call<{ finished: number }>("POST", `/api/agents/${instanceId}/done`),
  setTaskMeta: (instanceId: string, meta: { label?: string; kept?: boolean }) => call<Agent>("PATCH", `/api/agents/${instanceId}/meta`, meta),
  documents: (agentId: string) => call<DocumentInfo[]>("GET", `/api/agents/${agentId}/documents`),
  spawnReplica: (baseId: string) => call<Agent>("POST", `/api/agents/${baseId}/replicas`),
  retireReplica: (id: string) => call("POST", `/api/agents/${id}/retire`),
  pauseAll: (stopRunning: boolean) => call("POST", "/api/pause", { stopRunning }),
  resumeAll: () => call("POST", "/api/resume"),
  control: () => call<{ paused: boolean; display: DisplayHolder; running: number }>("GET", "/api/control"),
  takeDisplay: () => call("POST", "/api/display/take"),
  releaseDisplay: () => call("POST", "/api/display/release"),
  activity: (agent?: string) => call<ActivityItem[]>("GET", `/api/activity${agent ? `?agent=${agent}` : ""}`),
  graph: (since: string) => call<{ edges: GraphEdge[] }>("GET", `/api/graph?since=${encodeURIComponent(since)}`),
  health: () => call<any>("GET", "/api/health"),
  screenCredential: () => call<{ password: string | null }>("GET", "/api/screen/credential"),
  authMe: () => call<{ mode: string; host: string | null; identity: unknown }>("GET", "/api/auth/me"),
  logout: () => call<{ ok: true; logout_url: string | null }>("POST", "/api/auth/logout"),
  interview: () => call<{ questions: CoreQuestion[]; templates: Template[] }>("GET", "/api/interview"),
  followUps: (answers: Record<string, unknown>) =>
    call<{ questions: FollowUp[] }>("POST", "/api/interview/follow-ups", { answers }),
  draft: (answers: Record<string, unknown>, extra: FollowUp[]) =>
    call<Draft>("POST", "/api/interview/draft", { answers, extra }),
  crews: () => call<{ crews: Crew[] }>("GET", "/api/crews"),
  createCrew: (body: { name: string; summary?: string; members?: string[] }) => call<Crew>("POST", "/api/crews", body),
  updateCrew: (id: string, patch: { name?: string; summary?: string; lead_role_id?: string | null }) => call<Crew>("PATCH", `/api/crews/${id}`, patch),
  deleteCrew: (id: string) => call<{ ok: true }>("DELETE", `/api/crews/${id}`),
  setAgentCrew: (roleId: string, crewId: string | null) => call<Agent>("PUT", `/api/agents/${roleId}/crew`, { crew_id: crewId }),
  createAgent: (body: { name: string; title: string; summary: string; model: string; instructions: string; interview: unknown; skills: string[]; crew_id?: string | null }) =>
    call<Agent>("POST", "/api/agents", body),
  agent: (id: string) =>
    call<{ agent: Agent; instructions: string; memory: { file: string; content: string }[] }>("GET", `/api/agents/${id}`),
  updateAgent: (id: string, patch: Partial<Pick<Agent, "title" | "summary" | "model" | "max_turns" | "max_replicas">> & { can_scale?: boolean }) =>
    call<Agent>("PATCH", `/api/agents/${id}`, patch),
  saveInstructions: (id: string, text: string) => call("PUT", `/api/agents/${id}/instructions`, { text }),
  deleteAgent: (id: string) => call("DELETE", `/api/agents/${id}`),
  resetSession: (id: string) => call("POST", `/api/agents/${id}/reset-session`),
  setAgentSkills: (id: string, skills: string[]) => call<Agent>("PUT", `/api/agents/${id}/skills`, { skills }),
  skills: () => call<{ skills: Skill[]; drafts: SkillDraft[] }>("GET", "/api/skills"),
  skill: (name: string) => call<Skill>("GET", `/api/skills/${name}`),
  createSkill: (b: { name: string; description: string; body: string; agents: string[] }) => call<Skill>("POST", "/api/skills", b),
  updateSkill: (name: string, b: { description: string; body: string; agents: string[] }) => call<Skill>("PUT", `/api/skills/${name}`, b),
  deleteSkill: (name: string) => call("DELETE", `/api/skills/${name}`),
  skillDraft: (id: string) => call<{ draft: SkillDraft; existing: Skill | null }>("GET", `/api/skill-drafts/${id}`),
  approveDraft: (id: string, b: { name: string; description: string; body: string; agents: string[] }) =>
    call("POST", `/api/skill-drafts/${id}/approve`, b),
  rejectDraft: (id: string) => call("POST", `/api/skill-drafts/${id}/reject`),
  tasks: () => call<Task[]>("GET", "/api/tasks"),
  task: (id: string) => call<{ task: Task; tree: Task[]; steps: Step[] }>("GET", `/api/tasks/${id}`),
  agentThreads: (id: string) => call<Thread[]>("GET", `/api/agents/${id}/threads`),
  createGroup: (b: { name: string; purpose: string; members: string[]; lead: string | null }) => call<Group>("POST", "/api/groups", b),
  updateGroup: (id: string, b: { name: string; purpose: string; members: string[]; lead: string | null }) => call<Group>("PUT", `/api/groups/${id}`, b),
  deleteGroup: (id: string) => call("DELETE", `/api/groups/${id}`),
  continueGroup: (id: string) => call("POST", `/api/groups/${id}/continue`),
  routines: () => call<Routine[]>("GET", "/api/routines"),
  wakeups: () => call<{ wakeups: Wakeup[] }>("GET", "/api/wakeups"),
  cancelWakeup: (id: string) => call<Wakeup>("POST", `/api/wakeups/${id}/cancel`),
  routine: (id: string) => call<{ routine: Routine; runs: RoutineRunRow[] }>("GET", `/api/routines/${id}`),
  routineRuns: (q: { state?: "active" | "archive"; routine_id?: string; before?: string; limit?: number }) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== "") p.set(k, String(v));
    return call<{ runs: RoutineRun[] }>("GET", `/api/routine-runs?${p}`);
  },
  routineRun: (id: string) => call<RunDetail>("GET", `/api/routine-runs/${id}`),
  createRoutine: (b: RoutineInput) => call<Routine>("POST", "/api/routines", b),
  updateRoutine: (id: string, b: RoutineInput) => call<Routine>("PUT", `/api/routines/${id}`, b),
  deleteRoutine: (id: string) => call("DELETE", `/api/routines/${id}`),
  compactRoutine: (id: string) => call("POST", `/api/routines/${id}/compact`),
  freshRoutine: (id: string) => call("POST", `/api/routines/${id}/fresh`),
  runRoutine: (id: string) => call<{ started: boolean; routine: Routine }>("POST", `/api/routines/${id}/run`),
  previewCron: (cron: string, timezone: string) => call<{ next_runs: string[]; describe: string }>("POST", "/api/routines/preview", { cron, timezone }),
  thread: (id: string) => call<ThreadData>("GET", `/api/threads/${id}`),
  send: (threadId: string, text: string, images?: string[]) => call("POST", `/api/threads/${threadId}/messages`, { text, images }),
  /** Voice input (CONTRACTS-v2 C). Errors carry the HTTP status (`status`) so the UI can explain them. */
  transcribe: async (body: { audio: string; mime: string; purpose: "task" | "message"; agent_id?: string }, signal?: AbortSignal) => {
    const res = await fetch("/api/voice/transcribe", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error((data as any).error ?? `${res.status} ${res.statusText}`), { status: res.status });
    return data as { text: string; raw: string; duration_s: number; cleaned: boolean };
  },
  /** Voice v2 (CONTRACTS-v2 C): tidy up text the browser recognised. Errors carry `status`. */
  cleanVoice: async (body: { text: string; purpose: "task" | "message"; agent_id?: string; lang?: string }, signal?: AbortSignal) => {
    const res = await fetch("/api/voice/clean", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error((data as any).error ?? `${res.status} ${res.statusText}`), { status: res.status });
    return data as { text: string; raw: string; cleaned: boolean };
  },
  upload: (name: string, type: string, data: string) => call<{ path: string; name: string; size: number }>("POST", "/api/uploads", { name, type, data }),
  stop: (taskId: string) => call("POST", `/api/tasks/${taskId}/stop`),
  progress: () => call<Progress[]>("GET", "/api/progress"),
  attention: () => call<{ items: Attention[] }>("GET", "/api/attention"),
  attentionSeen: (id: string) => call<Attention>("POST", `/api/attention/${id}/seen`),
  attentionSeenAll: () => call<{ seen: number }>("POST", "/api/attention/seen-all"),
  attentionSeenRoom: (roomId: string) => call<{ seen: number }>("POST", `/api/attention/seen-room/${roomId}`),
  // Device admin always sends a JSON body: the server requires it (it forces a CORS preflight).
  devices: () => call<{ pending: Device[]; active: Device[] }>("GET", "/api/devices"),
  newPairing: () => call<Pairing>("POST", "/api/devices/pairings", {}),
  cancelPairing: () => call("DELETE", "/api/devices/pairings", {}),
  approveDevice: (id: string) => call("POST", `/api/devices/${id}/approve`, {}),
  denyDevice: (id: string) => call("POST", `/api/devices/${id}/deny`, {}),
  revokeDevice: (id: string) => call("POST", `/api/devices/${id}/revoke`, {}),
  revokeAllDevices: () => call<{ revoked: number }>("POST", "/api/devices/revoke-all", {}),
  pushSettings: () => call<{ details: boolean }>("GET", "/api/devices/push"),
  setPushDetails: (details: boolean) => call<{ details: boolean }>("PUT", "/api/devices/push", { details }),
  testPush: (id: string) => call<{ ok: true }>("POST", `/api/devices/${id}/test-push`, {}),
  gateway: (fresh = false) => call<GatewayStatus>("GET", `/api/devices/gateway${fresh ? "?fresh=1" : ""}`),
  setGatewayUrl: (url: string) => call<GatewayStatus>("PUT", "/api/devices/gateway", { url }),
  // Integrations and the setup agent (docs/V2-ARCHITECTURE.md §10).
  integrations: () => call<{ integrations: Integration[]; setup_role_id: string | null; error: string | null }>("GET", "/api/integrations"),
  integration: (id: string) => call<Integration>("GET", `/api/integrations/${id}`),
  setIntegrationRoles: (id: string, roles: string[]) => call<{ roles: string[] }>("PUT", `/api/integrations/${id}/roles`, { roles }),
  benchStatus: () => call<BenchStatus>("GET", "/api/bench/status"),
  benchTest: () => call<{ ok: boolean; steps: { name: string; ok: boolean; detail: string }[]; status: BenchStatus }>("POST", "/api/bench/test", {}),
  integrationTask: (id: string, action: "connect" | "reconnect" | "disconnect") =>
    call<{ instance_id: string; created: boolean }>("POST", `/api/integrations/${id}/task`, { action }),
  roleIntegrations: (roleId: string) => call<{ integrations: string[] }>("GET", `/api/agents/${roleId}/integrations`),
  setRoleIntegrations: (roleId: string, integrations: string[]) =>
    call<{ integrations: string[] }>("PUT", `/api/agents/${roleId}/integrations`, { integrations }),
  saveNotes: (roleId: string, text: string) => call<{ owner_notes: string }>("PUT", `/api/agents/${roleId}/notes`, { text }),
  approval: (id: string) => call<Approval>("GET", `/api/approvals/${id}`),
  setupSessions: () => call<{ setup_role_id: string | null; sessions: SetupSession[] }>("GET", "/api/setup/sessions"),
  setupPlan: (instanceId: string) => call<{ plan: SetupPlan | null }>("GET", `/api/setup/plans/${instanceId}`),
  setupStep: (instanceId: string, stepId: string, action: "check" | "skip" | "done" | "reopen") =>
    call<{ plan: SetupPlan | null; result: PlanCheck | null }>("POST", `/api/setup/plans/${instanceId}/steps/${encodeURIComponent(stepId)}`, { action }),
  terminalInfo: () => call<{ available: boolean; error: string | null }>("GET", "/api/setup/terminal/info"),
  approve: (id: string, edits?: Record<string, Record<string, string>>) => call<Approval>("POST", `/api/approvals/${id}/approve`, { edits: edits ?? {} }),
  undoApproval: (id: string) => call<Approval>("POST", `/api/approvals/${id}/undo`),
  // Repos (docs/V2-ARCHITECTURE.md, Changes (repos)).
  repos: () => call<{ repos: Repo[]; map_routines: MapRoutineInfo[]; map_routines_missing: string[] }>("GET", "/api/repos"),
  repo: (name: string) => call<Repo>("GET", `/api/repos/${encodeURIComponent(name)}`),
  availableRepos: (refresh = false) => call<{ accounts: { provider: string; ok: boolean; error: string | null; count: number }[]; repos: AccountRepo[] }>("GET", `/api/repos/available${refresh ? "?refresh=1" : ""}`),
  checkRepo: (url: string) => call<{ ok: boolean; default_branch: string | null; error: string | null; provider: string; name: string; taken: boolean }>("POST", "/api/repos/check", { url }),
  addRepo: (b: { url: string; name?: string; default_branch?: string; allowed_roles?: string[]; description?: string; mapper_role_id?: string | null }) => call<Repo>("POST", "/api/repos", b),
  updateRepo: (name: string, patch: Partial<Pick<Repo, "description" | "test_command" | "default_branch" | "protected_branches" | "allowed_roles" | "agents_may_merge" | "agents_may_deploy" | "propose_map_pr" | "lead_may_merge" | "mapper_role_id">>) =>
    call<Repo>("PATCH", `/api/repos/${encodeURIComponent(name)}`, patch),
  fetchRepo: (name: string) => call<Repo>("POST", `/api/repos/${encodeURIComponent(name)}/fetch`, {}),
  retryRepo: (name: string) => call<Repo>("POST", `/api/repos/${encodeURIComponent(name)}/retry`, {}),
  remapRepo: (name: string) => call<{ instance_id: string }>("POST", `/api/repos/${encodeURIComponent(name)}/remap`, {}),
  archiveRepo: (name: string, confirmUnpushed = false) => call<Repo>("POST", `/api/repos/${encodeURIComponent(name)}/archive`, { confirm_unpushed: confirmUnpushed }),
  purgeRepo: (name: string) => call<{ purged: string }>("POST", `/api/repos/${encodeURIComponent(name)}/purge`, {}),
  discardWorktree: (id: string) => call<RepoWorktree>("POST", `/api/repos/worktrees/${id}/discard`, {}),
  mapRoutine: () => call<{ created: string[] }>("POST", "/api/repos/map-routine", {}),
  taskRepos: (instanceId: string) => call<{ repos: RepoBinding[] }>("GET", `/api/agents/${instanceId}/repos`),
  // Setup requests: agents ask, the owner starts or declines.
  setupRequest: (id: string) => call<SetupRequest>("GET", `/api/setup-requests/${id}`),
  setupRequests: (status?: string) => call<{ requests: SetupRequest[] }>("GET", `/api/setup-requests${status ? `?status=${status}` : ""}`),
  raiseSetupRequest: (b: { title: string; why?: string; for_setup_agent: string; integration?: string; repo?: string; repo_url?: string; check?: string }) =>
    call<SetupRequest>("POST", "/api/setup-requests", b),
  startSetupRequest: (id: string) => call<{ instance_id: string; created: boolean; request: SetupRequest }>("POST", `/api/setup-requests/${id}/start`, {}),
  rejectSetupRequest: (id: string, reason: string) => call<SetupRequest>("POST", `/api/setup-requests/${id}/reject`, { reason }),
  markSetupRequest: (id: string, status: "done" | "failed", note: string) => call<SetupRequest>("POST", `/api/setup-requests/${id}/mark`, { status, note }),
  reject: (id: string) => call<Approval>("POST", `/api/approvals/${id}/reject`),
  // Plans (an agent asks before changing things) and diff review (v2.1).
  plan: (id: string) => call<Plan>("GET", `/api/plans/${id}`),
  taskPlans: (instanceId: string) => call<{ gate: PlanGate; plans: Plan[] }>("GET", `/api/agents/${instanceId}/plans`),
  setPlanGate: (instanceId: string, required: boolean) => call<PlanGate>("POST", `/api/agents/${instanceId}/plan-gate`, { required }),
  decidePlan: (id: string, verdict: "approve" | "changes" | "reject", note: string) => call<Plan>("POST", `/api/plans/${id}/decide`, { verdict, note }),
  taskChanges: (instanceId: string) => call<{ root_id: string; repos: RepoChanges[]; review: Review | null }>("GET", `/api/agents/${instanceId}/changes`),
  roadmap: (id: string) => call<Roadmap>("GET", `/api/roadmaps/${id}`),
  taskRoadmaps: (instanceId: string, archived = false) => call<{ root_id: string; roadmaps: Roadmap[] }>("GET", `/api/agents/${instanceId}/roadmaps${archived ? "?archived=1" : ""}`),
  archiveRoadmap: (id: string, archived: boolean) => call<Roadmap>("POST", `/api/roadmaps/${id}/archive`, { archived }),
  changesSummary: (instanceId: string) => call<{ root_id: string; worktrees: number }>("GET", `/api/agents/${instanceId}/changes/summary`),
  review: (id: string) => call<Review>("GET", `/api/reviews/${id}`),
  submitReview: (instanceId: string, b: { verdict: Review["verdict"]; note: string; comments: Omit<ReviewComment, "repo">[] }) =>
    call<Review>("POST", `/api/agents/${instanceId}/review`, b),
};
