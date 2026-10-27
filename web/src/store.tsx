import { setPathRoots } from "./components/ui.tsx";
import { createContext, useCallback, useContext, useEffect, useReducer, useRef, type ReactNode } from "react";
import { api, roleLimits, type Agent, type Crew, type DisplayHolder, type RetiredAgent, type WorkRoom, type Group, type Routine, type Message, type Skill, type SkillDraft, type Step, type Task, type ThreadData, type Usage, type Progress, type Attention, type RoutineRun } from "./api.ts";

type State = {
  connected: boolean;
  loaded: boolean;
  agents: Agent[];
  crews: Crew[];
  usage: Usage | null;
  skills: Skill[];
  drafts: SkillDraft[];
  groups: Group[];
  routines: Routine[];
  paused: boolean;
  display: DisplayHolder;
  retired: RetiredAgent[];
  work: { live: WorkRoom[]; done: WorkRoom[] };
  /** Bumped on any event that could change the activity feed. */
  activityVersion: number;
  threads: Record<string, ThreadData>;
  /** Every task we've seen, for the board. */
  board: Record<string, Task>;
  /** Bumped when a thread is created, so views listing threads refetch. */
  threadsVersion: number;
  /** Bumped when paired phones change (pairing claimed, approved, revoked, or a phone did something). */
  devicesVersion: number;
  /** Text streamed so far for running turns, by task id. */
  live: Record<string, string>;
  /** What each running task is doing now, by task id (cleared when its turn ends). */
  progress: Record<string, Progress>;
  /** "Needs you" items, unseen first. */
  attention: Attention[];
  /** Routine runs in progress, newest first (CONTRACTS-v2 § G). */
  activeRuns: RoutineRun[];
};

type Action =
  | { type: "loaded"; agents: Agent[]; crews: Crew[]; usage: Usage | null; skills: Skill[]; drafts: SkillDraft[]; groups: Group[]; paused: boolean; display: DisplayHolder; retired: RetiredAgent[] }
  | { type: "connected"; value: boolean }
  | { type: "thread"; id: string; data: ThreadData }
  | { type: "board"; tasks: Task[] }
  | { type: "routines"; routines: Routine[] }
  | { type: "work"; work: { live: WorkRoom[]; done: WorkRoom[] } }
  | { type: "live"; progress: Progress[]; attention: Attention[] }
  | { type: "runs"; runs: RoutineRun[] }
  | { type: "event"; e: any };

/** Unseen first, newest first; the server sends at most 100. */
const sortAttention = (items: Attention[]) =>
  [...items].sort((a, b) => Number(!!a.seen_at) - Number(!!b.seen_at) || (b.seen_at ?? b.created_at).localeCompare(a.seen_at ?? a.created_at));

const upsert = <T extends { id: string }>(list: T[], item: T, sort?: (a: T, b: T) => number) => {
  const i = list.findIndex((x) => x.id === item.id);
  const next = i === -1 ? [...list, item] : list.map((x, j) => (j === i ? { ...x, ...item } : x));
  return sort ? next.sort(sort) : next;
};

function reducer(s: State, a: Action): State {
  switch (a.type) {
    case "loaded":
      return { ...s, loaded: true, agents: a.agents, crews: a.crews, usage: a.usage, skills: a.skills, drafts: a.drafts, groups: a.groups, paused: a.paused, display: a.display, retired: a.retired };
    case "connected":
      return { ...s, connected: a.value };
    case "thread":
      return { ...s, threads: { ...s.threads, [a.id]: a.data } };
    case "routines":
      return { ...s, routines: a.routines };
    case "live":
      return { ...s, progress: Object.fromEntries(a.progress.map((p) => [p.task_id, p])), attention: sortAttention(a.attention) };
    case "work":
      return { ...s, work: a.work };
    case "runs":
      return { ...s, activeRuns: a.runs };
    case "board":
      return { ...s, board: Object.fromEntries(a.tasks.map((t) => [t.id, t])) };
    case "event": {
      const e = a.e;
      if (["task.updated", "draft.updated", "routine.updated", "devices.changed"].includes(e.type)) s = { ...s, activityVersion: s.activityVersion + 1 };
      if (e.type === "devices.changed") return { ...s, devicesVersion: s.devicesVersion + 1 };
      if (e.type === "task.updated" && e.task.status !== "running" && s.progress[e.task.id]) {
        const progress = { ...s.progress };
        delete progress[e.task.id];
        s = { ...s, progress };
      }
      switch (e.type) {
        case "agent.created":
        case "agent.updated": {
          if (e.agent.retired_at) return s;
          const prev = s.agents.find((x) => x.id === e.agent.id);
          const agent = { status: "idle", skills: [], ...prev, ...e.agent } as Agent;
          // Keep each replica right after its base agent.
          const order = (a: Agent) => {
            const base = a.base_agent_id ? s.agents.find((x) => x.id === a.base_agent_id) ?? a : a;
            return `${base.created_at}|${a.base_agent_id ? String(a.replica_no ?? 0).padStart(3, "0") : "000"}`;
          };
          return { ...s, retired: s.retired.filter((r) => r.id !== agent.id), agents: upsert(s.agents, agent).sort((x, y) => order(x).localeCompare(order(y))) };
        }
        case "agent.skills":
          return { ...s, agents: s.agents.map((x) => (x.id === e.agentId ? { ...x, skills: e.skills } : x)) };
        case "skill.updated":
          return {
            ...s,
            skills: [...s.skills.filter((k) => k.name !== e.skill.name), e.skill as Skill]
              .sort((x, y) => x.name.localeCompare(y.name)),
          };
        case "skill.deleted":
          return { ...s, skills: s.skills.filter((k) => k.name !== e.name) };
        case "draft.updated":
          return {
            ...s,
            drafts: e.draft.status === "pending"
              ? upsert(s.drafts, e.draft)
              : s.drafts.filter((d) => d.id !== e.draft.id),
          };
        case "paused":
          return { ...s, paused: e.paused };
        case "display.updated":
          return { ...s, display: e.display };
        case "routine.updated":
          return { ...s, routines: upsert(s.routines, e.routine) };
        case "crews.updated":
          return { ...s, crews: e.crews };
        case "routine.deleted":
          return { ...s, routines: s.routines.filter((r) => r.id !== e.id) };
        case "group.updated":
          return { ...s, groups: upsert(s.groups, e.group) };
        case "group.deleted":
          return { ...s, groups: s.groups.filter((g) => g.id !== e.id) };
        case "agent.retired": {
          const gone = s.agents.find((x) => x.id === e.agentId);
          return {
            ...s,
            agents: s.agents.filter((x) => x.id !== e.agentId),
            retired: gone ? [...s.retired, { id: gone.id, name: gone.name, color: gone.color, base_agent_id: gone.base_agent_id ?? null }] : s.retired,
          };
        }
        case "agent.deleted":
          return {
            ...s,
            agents: s.agents.filter((x) => x.id !== e.agentId),
            groups: s.groups.map((g) => ({ ...g, members: g.members.filter((m) => m !== e.agentId) })),
          };
        case "thread.created":
          return { ...s, threadsVersion: s.threadsVersion + 1 };
        case "agent.status":
          return { ...s, agents: s.agents.map((x) => (x.id === e.agentId ? { ...x, status: e.status, taskId: e.taskId } : x)) };
        case "usage":
          return { ...s, usage: e.usage };
        case "progress.updated":
          return { ...s, progress: { ...s.progress, [e.progress.task_id]: e.progress } };
        case "progress.cleared": {
          if (!s.progress[e.task_id]) return s;
          const progress = { ...s.progress };
          delete progress[e.task_id];
          return { ...s, progress };
        }
        case "routine-run.updated": {
          const others = s.activeRuns.filter((r) => r.id !== e.run.id);
          // Keep the routines list's "last run" in step (routine.updated only comes when a run is logged).
          const routines = s.routines.map((r): Routine => (r.last_run && r.last_run.id === e.run.id
            ? { ...r, last_run: { ...r.last_run, status: e.run.status, finished_at: e.run.finished_at, summary: e.run.summary } }
            : r));
          return {
            ...s,
            routines,
            activeRuns: e.run.status === "running"
              ? [...others, e.run].sort((x, y) => y.started_at.localeCompare(x.started_at))
              : others,
          };
        }
        case "integration.mapping": {
          // Keep each role's list of mapped integrations current.
          const roles: string[] = e.roles ?? [];
          return {
            ...s,
            agents: s.agents.map((x) => {
              if (x.base_agent_id) return x;
              const had = (x.integrations ?? []).filter((i) => i !== e.integrationId);
              return { ...x, integrations: roles.includes(x.id) ? [...had, e.integrationId].sort() : had };
            }),
          };
        }
        case "attention.updated":
          return { ...s, attention: sortAttention([e.item, ...s.attention.filter((x) => x.id !== e.item.id)]).slice(0, 100) };
        case "turn.delta":
          return { ...s, live: { ...s.live, [e.taskId]: (s.live[e.taskId] ?? "") + e.text } };
        case "message.created":
        case "task.updated":
        case "step.updated": {
          const item = e.message ?? e.task ?? e.step;
          if (e.type === "task.updated") s = { ...s, board: { ...s.board, [e.task.id]: { ...s.board[e.task.id], ...e.task } } };
          const threadId: string | undefined =
            e.message?.thread_id ?? e.task?.thread_id ??
            Object.keys(s.threads).find((id) => s.threads[id].tasks.some((t) => t.id === e.step?.task_id));
          if (!threadId || !s.threads[threadId]) return s;
          const t = s.threads[threadId];
          const next: ThreadData =
            e.type === "message.created" ? { ...t, messages: upsert<Message>(t.messages, item) }
            : e.type === "task.updated" ? { ...t, tasks: upsert<Task>(t.tasks, item) }
            : { ...t, steps: upsert<Step>(t.steps, item, (x, y) => x.seq - y.seq) };
          let live = s.live;
          // Once the agent's message lands, the streamed copy is no longer needed.
          if (e.type === "message.created" && e.message.author !== "user" && e.message.task_id && live[e.message.task_id]) {
            live = { ...live };
            delete live[e.message.task_id];
          }
          return { ...s, live, threads: { ...s.threads, [threadId]: next } };
        }
      }
      return s;
    }
  }
}

type Store = State & {
  everyone: Agent[];
  /** Every live event, for views that keep their own data (e.g. a routine run's page). Returns an unsubscribe. */
  onEvent: (fn: (e: any) => void) => () => void;
  loadThread: (id: string) => Promise<void>;
  refresh: () => Promise<void>;
};

const Ctx = createContext<Store | null>(null);

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, {
    connected: false, loaded: false, agents: [], crews: [], usage: null, skills: [], drafts: [], groups: [], routines: [], paused: false, display: null, retired: [], work: { live: [], done: [] }, activityVersion: 0, threads: {}, live: {}, board: {}, threadsVersion: 0, devicesVersion: 0, progress: {}, attention: [], activeRuns: [],
  });
  const listeners = useRef(new Set<(e: any) => void>());
  const onEvent = useCallback((fn: (e: any) => void) => {
    listeners.current.add(fn);
    return () => { listeners.current.delete(fn); };
  }, []);
  const openThreads = useRef(new Set<string>());
  // The Work list is derived on the server; refetch it (debounced) when tasks or agents change.
  const workTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const refreshWork = useCallback(() => {
    clearTimeout(workTimer.current);
    workTimer.current = setTimeout(() => { api.work().then((w) => dispatch({ type: "work", work: w })).catch(() => {}); }, 400);
  }, []);

  const refresh = useCallback(async () => {
    const [s, k, t, r] = await Promise.all([api.state(), api.skills(), api.tasks(), api.routines()]);
    if (s.roots) setPathRoots([s.roots.agents, s.roots.work]);
    if (s.limits) Object.assign(roleLimits, s.limits);
    dispatch({ type: "routines", routines: r });
    dispatch({ type: "loaded", agents: s.agents, crews: s.crews ?? [], usage: s.usage, skills: k.skills, drafts: k.drafts, groups: s.groups, paused: s.paused, display: s.display, retired: s.retired });
    dispatch({ type: "board", tasks: t });
    Promise.all([api.progress(), api.attention()])
      .then(([p, a]) => dispatch({ type: "live", progress: p, attention: a.items }))
      .catch(() => {});
    api.routineRuns({ state: "active" }).then((r) => dispatch({ type: "runs", runs: r.runs })).catch(() => {});
    refreshWork();
  }, []);

  const loadThread = useCallback(async (id: string) => {
    openThreads.current.add(id);
    dispatch({ type: "thread", id, data: await api.thread(id) });
  }, []);

  useEffect(() => {
    let ws: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout>;
    let closed = false;
    const connect = () => {
      const proto = location.protocol === "https:" ? "wss" : "ws";
      ws = new WebSocket(`${proto}://${location.host}/api/events`);
      ws.onopen = () => {
        dispatch({ type: "connected", value: true });
        // Catch up on anything missed while disconnected.
        refresh().catch(() => {});
        openThreads.current.forEach((id) => loadThread(id).catch(() => {}));
      };
      ws.onmessage = (m) => {
        const e = JSON.parse(m.data);
        dispatch({ type: "event", e });
        listeners.current.forEach((fn) => { try { fn(e); } catch { /* a view's handler failing mustn't stop the stream */ } });
        if (["agent.created", "agent.retired", "agent.updated", "agent.status", "task.updated", "agent.deleted"].includes(e.type)) refreshWork();
      };
      ws.onclose = () => {
        dispatch({ type: "connected", value: false });
        if (!closed) retry = setTimeout(connect, 2000);
      };
    };
    connect();
    return () => {
      closed = true;
      clearTimeout(retry);
      ws?.close();
    };
  }, [refresh, loadThread, refreshWork]);

  // Active and retired agents, for naming things in history.
  const everyone = [...state.agents, ...(state.retired as unknown as Agent[])];
  return <Ctx.Provider value={{ ...state, everyone, loadThread, refresh, onEvent }}>{children}</Ctx.Provider>;
}

export function useStore() {
  const s = useContext(Ctx);
  if (!s) throw new Error("useStore outside StoreProvider");
  return s;
}
