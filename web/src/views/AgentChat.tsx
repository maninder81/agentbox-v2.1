import { AttachButton, AttachmentStrip, useAttachments } from "../components/Attachments.tsx";
import { MicButton, VoiceStatus, useVoice } from "../components/Voice.tsx";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { api, type Agent, type Message, type Step, type Task, type Thread } from "../api.ts";
import { useStore } from "../store.tsx";
import { Avatar, Icon, Markdown, Spinner, StatusGlyph, duration, relTime, useEscToStop } from "../components/ui.tsx";
import { TaskPanel } from "./AgentPanel.tsx";
import { RolePage } from "./RolePage.tsx";
import { LiveBar, useSeenRoom } from "../components/Live.tsx";
import { ApprovalCard, IntegrationStepsCard, TerminalCtx, TerminalPanel } from "../components/Setup.tsx";
import { RepoChips, SetupRequestCard } from "../components/Requests.tsx";
import { PlanCard, PlanChip } from "../components/Plan.tsx";
import { ChangesButton, ReviewCard } from "./Changes.tsx";
import { RoadmapCard, RoadmapStrip } from "../components/Roadmap.tsx";
import { ScrollToBottom } from "../components/ScrollToBottom.tsx";
import { onFocusRequest } from "../components/focusMessage.ts";
import { SaveSelection } from "../components/Notes.tsx";
import { LinkWorkButton, LinkedStrip } from "../components/LinkedWork.tsx";

const STARTERS = [
  "Introduce yourself: what's your job, and what do you need from me to start?",
  "Check your access: GitHub (gh), AWS, and the shared browser. Report what works.",
  "Read your instructions and tell me what's unclear or missing.",
];

export function AgentChat({ agentId, threadParam, msgParam }: { agentId: string; threadParam?: string; msgParam?: string }) {
  const { agents, everyone } = useStore();
  const live = agents.find((a) => a.id === agentId);
  // Finished tasks aren't in the live list; load them so their history stays readable.
  const [loaded, setLoaded] = useState<Agent | null>(null);
  useEffect(() => {
    if (!live) api.agent(agentId).then((r) => setLoaded(r.agent)).catch(() => setLoaded(null));
  }, [agentId, !!live]);
  const agent = live ?? loaded ?? (everyone.find((a) => a.id === agentId) as Agent | undefined);
  if (!agent) return <div className="page"><div className="page-inner"><p className="lede">Loading…</p></div></div>;
  if (!agent.base_agent_id) return <RolePage role={agent} />;
  // The setup agent's sessions open in the Setup workspace (chat, terminal and checklist on one screen).
  if (everyone.find((a) => a.id === agent.base_agent_id)?.builtin === "setup" && !threadParam) return <SetupRedirect id={agent.id} />;
  return <TaskChat key={agent.id} agent={agent} threadParam={threadParam} msgParam={msgParam} />;
}

function SetupRedirect({ id }: { id: string }) {
  useEffect(() => { location.replace(`#/helper/${id}`); }, [id]);
  return <div className="page" />;
}

function TaskChat({ agent, threadParam, msgParam }: { agent: Agent; threadParam?: string; msgParam?: string }) {
  const { everyone, threads, live, loadThread, threadsVersion, progress } = useStore();
  // A task you started is its own room for "needs you": opening it marks those items seen.
  useSeenRoom(!agent.parent_instance_id && agent.created_by === "owner" ? agent.id : null);
  const [threadList, setThreadList] = useState<Thread[]>([]);
  useEffect(() => {
    api.agentThreads(agent.id).then(setThreadList).catch(() => {});
  }, [agent.id, threadsVersion]);
  const threadId = threadParam ?? agent.dm_thread_id ?? undefined;
  const isMain = !threadParam || threadParam === agent.dm_thread_id;
  const thread = threadId ? threads[threadId] : undefined;
  const [panel, setPanel] = useState(() => {
    try { return localStorage.getItem("agentbox.panel") !== "closed"; } catch { return true; }
  });
  useEffect(() => {
    try { localStorage.setItem("agentbox.panel", panel ? "open" : "closed"); } catch { /* storage unavailable */ }
  }, [panel]);
  useEffect(() => {
    if (threadId) loadThread(threadId).catch(() => {});
  }, [threadId, loadThread]);

  const running = thread?.tasks.find((t) => t.status === "running");
  useEscToStop(!!running, () => { if (running) api.stop(running.id); });
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      const p = document.querySelector(".panel");
      if (e.key === "Escape" && p && getComputedStyle(p).position === "fixed" && !document.querySelector(".reader-backdrop, .popover")) setPanel(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const role = everyone.find((a) => a.id === agent.base_agent_id);
  const done = !!agent.retired_at;
  // The setup agent's tasks get an embedded terminal for logins (§10.4).
  const isSetup = role?.builtin === "setup";
  const [term, setTerm] = useState(false);

  return (
    <TerminalCtx.Provider value={isSetup && !done ? () => setTerm(true) : null}>
      <section className="chat" aria-label={`Task: ${agent.label ?? agent.name}`}>
        <header className="chat-head">
          <Avatar name={role?.name ?? agent.name} color={agent.color} size={32} />
          <div className="who" style={{ minWidth: 0 }}>
            <TaskTitle agent={agent} />
            <span><TaskOrigin agent={agent} /></span>
            <RepoChips instanceId={agent.id} />
          </div>
          <div className="actions">
            {!isSetup && <PlanChip instanceId={agent.id} />}
            {done ? <span className="chip">Done</span> : <StatusGlyph status={agent.status} withLabel />}
            {!isSetup && <ChangesButton instanceId={agent.id} />}
            {!isSetup && !done && agent.base_agent_id && <LinkWorkButton instanceId={agent.id} />}
            {running && (
              <button className="btn sm danger" onClick={() => api.stop(running.id)} title="Stop (Esc)">
                <Icon name="stop" size={14} />Stop
              </button>
            )}
            {!done && <FinishButton agent={agent} />}
            {isSetup && !done && (
              <button className="btn sm" aria-pressed={term} title="A terminal next to the chat, for logins" onClick={() => setTerm(!term)}>
                <Icon name="terminal" size={14} />Terminal
              </button>
            )}
            <button className="icon-btn" aria-pressed={panel && !term} aria-label="Task details" title="Task details" onClick={() => { setTerm(false); setPanel(!panel || term); }}>
              <Icon name="panel" />
            </button>
          </div>
        </header>

        {!isSetup && <RoadmapStrip instanceId={agent.id} />}
        {!isSetup && agent.base_agent_id && <LinkedStrip instanceId={agent.id} />}
        {threadList.length > 1 && <ThreadTabs agent={agent} threads={threadList} current={threadId} />}
        {thread ? <Timeline agent={agent} thread={thread} live={live} focus={msgParam} /> : <div className="timeline" />}
        {/* The work log is already in the timeline here: the bar only says what's happening, and flags a stall. */}
        <LiveBar items={Object.values(progress).filter((p) => p.agent_id === agent.id)} log={false} />
        {threadId && isMain && !done && <Composer agent={agent} threadId={threadId} empty={!thread || thread.messages.length === 0} />}
        {done && (
          <p className="composer-hint" style={{ padding: "12px 24px 20px", margin: 0, maxWidth: "none", textAlign: "center" }}>
            This task is done; its history stays here. <a href={`#/new/${agent.base_agent_id}`}>Start a new task for {role?.name ?? "this agent"}</a>
          </p>
        )}
        {threadId && !isMain && !done && (
          <p className="composer-hint" style={{ padding: "10px 24px 18px", margin: 0, maxWidth: "none", textAlign: "center" }}>
            This thread is read-only. <a href={`#/agents/${agent.id}`}>Back to the task</a>
          </p>
        )}
      </section>
      {term ? <TerminalPanel onClose={() => setTerm(false)} /> : panel && <TaskPanel agent={agent} onClose={() => setPanel(false)} />}
      {!isSetup && <SaveSelection instanceId={agent.id} />}
    </TerminalCtx.Provider>
  );
}

/** The task's title; click to rename. */
export function TaskTitle({ agent }: { agent: Agent }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(agent.label ?? "");
  useEffect(() => setValue(agent.label ?? ""), [agent.label]);
  const save = async () => {
    setEditing(false);
    if (value.trim() && value.trim() !== agent.label) await api.setTaskMeta(agent.id, { label: value.trim() }).catch(() => {});
  };
  if (editing) {
    return (
      <input className="text title-input" autoFocus value={value} aria-label="Task title" maxLength={120}
        onChange={(e) => setValue(e.target.value)} onBlur={save}
        onKeyDown={(e) => { if (e.key === "Enter") save(); if (e.key === "Escape") { e.stopPropagation(); setValue(agent.label ?? ""); setEditing(false); } }} />
    );
  }
  return (
    <button className="title-button" onClick={() => setEditing(true)} title="Rename this task">
      <strong>{agent.label ?? agent.name}</strong>
    </button>
  );
}

/** "coder#2 · Coder · started by tech-lead#1 · in Partner API keys" */
export function TaskOrigin({ agent }: { agent: Agent }) {
  const { everyone, groups } = useStore();
  const by = agent.created_by;
  const creator = by && !["owner"].includes(by) && !by.includes(":") ? everyone.find((a) => a.id === by) : undefined;
  const root = agent.parent_instance_id ? rootOfLocal(agent, everyone) : undefined;
  return (
    <>
      {agent.name} · {agent.title}
      {by === "owner" && " · started by you"}
      {by?.startsWith("routine:") && " · routine"}
      {by?.startsWith("group:") && " · group"}
      {by?.startsWith("glead:") && <> · launched from <a href={`#/groups/${by.slice(6)}`}>#{groups.find((g) => g.id === by.slice(6))?.name ?? "a group"}</a></>}
      {creator && <> · started by <a href={`#/agents/${creator.id}`}>{creator.name}</a></>}
      {root && root.id !== agent.id && <> · in <a href={`#/work/${root.id}`}>{root.label ?? root.name}</a></>}
    </>
  );
}

function rootOfLocal(a: Agent, all: Agent[]) {
  let cur = a;
  for (let i = 0; i < 20 && cur.parent_instance_id; i++) {
    const next = all.find((x) => x.id === cur.parent_instance_id);
    if (!next) break;
    cur = next;
  }
  return cur;
}

/** Done: finish this task (and anything it started). */
export function FinishButton({ agent }: { agent: Agent }) {
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!confirm) return;
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setConfirm(false); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [confirm]);
  return (
    <div className="popover-anchor" ref={ref}>
      <button className="btn sm" onClick={() => { setError(null); setConfirm(!confirm); }} title="Mark this task done">
        <Icon name="check" size={14} />Done
      </button>
      {confirm && (
        <div className="popover" role="dialog" aria-label="Finish task">
          <strong>Mark this task done?</strong>
          <p className="hint">
            It leaves the live list and the agent stops taking messages here. Any tasks it started are finished too.
            The history stays readable.
          </p>
          {error && <div className="error-box">{error}</div>}
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn sm primary" onClick={async () => {
              try { await api.finishTask(agent.id); setConfirm(false); } catch (e: any) { setError(e.message); }
            }}>Mark done</button>
            <button className="btn sm ghost" onClick={() => setConfirm(false)}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}

function ThreadTabs({ agent, threads, current }: { agent: Agent; threads: Thread[]; current?: string }) {
  const { agents, everyone } = useStore();
  return (
    <nav className="tabs thread-tabs" aria-label="Conversations">
      {threads.map((t) => {
        const peer = everyone.find((a) => a.id === t.peer_agent_id);
        const label = t.kind === "dm" ? "You" : t.kind === "routine" ? (t.name ?? "Routine") : `From ${peer?.name ?? "deleted agent"}`;
        return (
          <a key={t.id} role="tab" aria-selected={t.id === current}
            href={t.kind === "dm" ? `#/agents/${agent.id}` : `#/agents/${agent.id}/threads/${t.id}`}>
            {peer && <Avatar name={peer.name} color={peer.color} size={16} />}
            {t.kind === "routine" && <Icon name="routine" size={14} />}
            {label}
          </a>
        );
      })}
    </nav>
  );
}

export function Timeline({ agent, thread, live, focus }: {
  agent: Agent;
  thread: { messages: Message[]; tasks: Task[]; steps: Step[] };
  live: Record<string, string>;
  /** A message to show (a link to it, e.g. from a roadmap step): scrolled to and highlighted once. */
  focus?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const tasks = useMemo(() => new Map(thread.tasks.map((t) => [t.id, t])), [thread.tasks]);
  const replies = useMemo(
    // A turn's reply is the message its own agent wrote (not a system note or handoff queued with it).
    () => new Map(thread.messages.filter((m) => m.task_id && tasks.get(m.task_id)?.agent_id === m.author).map((m) => [m.task_id!, m])),
    [thread.messages, tasks],
  );
  const stepsByTask = useMemo(() => {
    const m = new Map<string, Step[]>();
    for (const s of thread.steps) m.set(s.task_id, [...(m.get(s.task_id) ?? []), s]);
    return m;
  }, [thread.steps]);

  // Follow new output while the reader is at the bottom; leave them alone if they scrolled up.
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  });
  // A linked message: bring it into view and flash it once it's rendered (then stop following the
  // bottom). Asked again (the same link clicked after scrolling away), it does it again.
  const want = useRef<string | null>(focus ?? null);
  const [, again] = useState(0);
  useEffect(() => { want.current = focus ?? null; again((n) => n + 1); }, [focus]);
  useEffect(() => onFocusRequest((id) => { want.current = id; again((n) => n + 1); }), []);
  useLayoutEffect(() => {
    const id = want.current;
    if (!id) return;
    const el = document.getElementById(`msg-${id}`);
    if (!el) return; // not rendered yet: tried again after the next render
    want.current = null;
    stick.current = false;
    // Instant: a smooth scroll starts at the bottom, where "follow new output" would pull it back.
    el.scrollIntoView({ block: "center" });
    el.classList.remove("msg-flash");
    void el.offsetWidth; // restart the flash animation
    el.classList.add("msg-flash");
    setTimeout(() => el.classList.remove("msg-flash"), 2600);
  });
  const onScroll = () => {
    const el = ref.current!;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  // An input is what a turn responds to: your message, a teammate's handoff, or a report coming back.
  const inputs = thread.messages.filter((m) => !(m.task_id && tasks.get(m.task_id)?.agent_id === m.author));
  const active = thread.tasks.some((t) => t.status === "running" || t.status === "queued");

  return (
    <div className="timeline" ref={ref} onScroll={onScroll} aria-live="polite" aria-relevant="additions">
      <div className="timeline-inner">
        {inputs.length === 0 && (
          <div className="msg">
            <Avatar name={agent.name} color={agent.color} size={28} />
            <div>
              <div className="msg-meta"><strong>{agent.name}</strong></div>
              <p style={{ color: "var(--muted)" }}>{agent.summary || "Ready when you are."}</p>
            </div>
          </div>
        )}
        {inputs.map((m) => {
          const task = m.task_id ? tasks.get(m.task_id) : undefined;
          return (
            <div key={m.id} style={{ display: "contents" }}>
              <Input message={m} task={task} active={active} />
              {task && (
                <Turn agent={agent} task={task} steps={stepsByTask.get(task.id) ?? []} reply={replies.get(task.id)} live={live[task.id]} />
              )}
            </div>
          );
        })}
      </div>
      <ScrollToBottom scroller={ref} onJump={() => { stick.current = true; }} />
    </div>
  );
}

const SOURCE_LABEL: Record<string, string> = { agent: "handed off a task", message: "sent a message", result: "reported back" };

function Input({ message, task, active }: { message: Message; task?: Task; active: boolean }) {
  const { everyone } = useStore();
  const [open, setOpen] = useState(task?.source !== "result");
  // Setup agent cards: an integration's steps, or a proposal waiting for the owner.
  if (["integration", "approval", "setup_request", "plan", "review", "roadmap"].includes(message.author)) {
    return (
      <div className="msg">
        <span aria-hidden="true" />
        {message.author === "integration" ? <IntegrationStepsCard id={message.content} active={active} />
          : message.author === "setup_request" ? <SetupRequestCard id={message.content} />
          : message.author === "plan" ? <PlanCard id={message.content} />
          : message.author === "review" ? <ReviewCard id={message.content} />
          : message.author === "roadmap" ? <RoadmapCard id={message.content} /> : <ApprovalCard id={message.content} />}
      </div>
    );
  }
  if (message.author === "user") {
    return (
      <div className="msg" data-msg-id={message.id} data-author="user">
        <span className="avatar you-avatar" style={{ width: 28, height: 28, fontSize: 12 }} aria-hidden="true">You</span>
        <div>
          <div className="msg-meta"><strong>You</strong><time dateTime={message.created_at}>{relTime(message.created_at)}</time></div>
          <div className="prose" style={{ whiteSpace: "pre-wrap" }}>{message.content}</div>
        </div>
      </div>
    );
  }
  if (message.author.startsWith("guest:")) {
    // A guest the owner shared this work with (shares.ts).
    const name = message.author.slice(6);
    return (
      <div className="msg" data-msg-id={message.id} data-author={message.author}>
        <span className="avatar you-avatar guest-avatar" style={{ width: 28, height: 28, fontSize: 12 }} aria-hidden="true">{name.slice(0, 1).toUpperCase()}</span>
        <div style={{ minWidth: 0 }}>
          <div className="msg-meta"><strong>{name}</strong><span className="tag">guest</span><time dateTime={message.created_at}>{relTime(message.created_at)}</time></div>
          <Markdown text={message.content} />
        </div>
      </div>
    );
  }
  if (message.author === "system") return <p className="system-note">{message.content}</p>;
  if (message.author === "routine") {
    return (
      <div className="msg">
        <span className="avatar you-avatar" style={{ width: 28, height: 28 }} aria-hidden="true"><Icon name="routine" size={14} /></span>
        <div>
          <div className="msg-meta">
            <strong>Routine</strong>
            <time dateTime={message.created_at}>{relTime(message.created_at)}</time>
            {task && <a className="hint" href={`#/tasks/${task.id}`}>task</a>}
          </div>
          <Markdown text={message.content} />
        </div>
      </div>
    );
  }
  const from = everyone.find((a) => a.id === message.author);
  return (
    <div className="msg" data-msg-id={message.id} data-author={message.author}>
      {from ? <Avatar name={from.name} color={from.color} size={28} /> : <span className="avatar you-avatar" style={{ width: 28, height: 28 }} />}
      <div style={{ minWidth: 0 }}>
        <div className="msg-meta">
          <strong>{from?.name ?? "Deleted agent"}</strong>
          <span className="hint">{SOURCE_LABEL[task?.source ?? ""] ?? ""}</span>
          <time dateTime={message.created_at}>{relTime(message.created_at)}</time>
          {task && <a className="hint" href={`#/tasks/${task.id}`}>task</a>}
        </div>
        <div className={`handoff ${task?.source ?? ""}`}>
          {task?.source === "result" && (
            <button className="worklog-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
              <span className="chev"><Icon name="chevron" size={14} /></span>
              {open ? "Hide report" : "Show report"}
            </button>
          )}
          {open && <Markdown text={message.content} home={from?.home} />}
          {!open && <p className="hint">{message.content.split("\n")[0].replace(/\*\*/g, "")}</p>}
        </div>
      </div>
    </div>
  );
}

function Turn({ agent, task, steps, reply, live }: { agent: Agent; task: Task; steps: Step[]; reply?: Message; live?: string }) {
  const running = task.status === "running";
  const content = reply?.content ?? live ?? "";
  return (
    <div className="msg" id={reply ? `msg-${reply.id}` : undefined} data-msg-id={reply?.id} data-author={agent.id}>
      <Avatar name={agent.name} color={agent.color} size={28} />
      <div style={{ minWidth: 0 }}>
        <div className="msg-meta">
          <strong>{agent.name}</strong>
          <time dateTime={task.started_at ?? task.created_at}>{relTime(task.started_at ?? task.created_at)}</time>
        </div>

        {task.status === "queued" && (
          <p className="msg-note">
            Queued — starts when {agent.name} finishes the current task.
            <button className="btn ghost sm" onClick={() => api.stop(task.id)}>Cancel</button>
          </p>
        )}

        {(steps.length > 0 || running) && <WorkLog task={task} steps={steps} />}

        {content ? (
          <Markdown text={content} streaming={running} home={agent.home} />
        ) : running ? (
          <p className="msg-note"><Spinner />{steps.length ? "Working…" : "Thinking…"}</p>
        ) : null}

        {task.status === "failed" && (
          <p className="msg-note bad" style={{ marginTop: 8 }}>
            <Icon name="x" size={14} />This turn failed: {task.error ?? "unknown error"}
          </p>
        )}
        {task.status === "stopped" && <p className="msg-note" style={{ marginTop: 8 }}><Icon name="stop" size={14} />Stopped.</p>}
      </div>
    </div>
  );
}

export function WorkLog({ task, steps }: { task: Task; steps: Step[] }) {
  const running = task.status === "running";
  const visible = steps.filter((s) => s.kind !== "meta");
  const [manual, setManual] = useState<boolean | null>(null);
  const open = manual ?? running;
  const [, tick] = useState(0);
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [running]);

  const counts = visible.reduce<Record<string, number>>((m, s) => ((m[s.name] = (m[s.name] ?? 0) + 1), m), {});
  const breakdown = Object.entries(counts).map(([k, n]) => `${k} ×${n}`).join(" · ");
  const started = task.started_at ?? task.created_at;
  const label = running
    ? `Working for ${duration(started)} · ${visible.length} step${visible.length === 1 ? "" : "s"}`
    : `Worked for ${duration(started, task.finished_at)} · ${visible.length} step${visible.length === 1 ? "" : "s"}`;

  if (!running && visible.length === 0) return null;
  return (
    <div className="worklog">
      <button className="worklog-toggle" aria-expanded={open} onClick={() => setManual(!open)}>
        <span className="chev"><Icon name="chevron" size={14} /></span>
        {running && <Spinner />}
        {label}
        {breakdown && <span style={{ opacity: 0.8 }}>({breakdown})</span>}
      </button>
      {open && visible.length > 0 && (
        <ol className="steps">
          {visible.map((s) => <StepRow key={s.id} step={s} />)}
        </ol>
      )}
    </div>
  );
}

function StepRow({ step }: { step: Step }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="step">
      <button className="step-row" aria-expanded={open} onClick={() => setOpen(!open)} title={step.summary}>
        <span className="step-kind"><Icon name={step.kind} size={14} /></span>
        <span className="step-label">{step.name}</span>
        <span className="step-summary">{step.summary || "—"}</span>
        <span className={`step-state ${step.status}`}>
          {step.status === "running" ? <Spinner /> : step.status === "done" ? <Icon name="check" size={14} /> : <Icon name="x" size={14} />}
        </span>
      </button>
      {open && (
        <div className="step-detail">
          {step.input && step.input !== "{}" && (<><span className="lbl">Input</span><pre>{step.input}</pre></>)}
          <span className="lbl">Output</span>
          <pre>{step.output ?? (step.status === "running" ? "Running…" : "(none)")}</pre>
        </div>
      )}
    </li>
  );
}

export function Composer({ agent, threadId, empty, starters = STARTERS, placeholder }: {
  agent: Agent; threadId: string; empty: boolean; starters?: string[]; placeholder?: string;
}) {
  const [text, setText] = useState("");
  const att = useAttachments();
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);
  const voice = useVoice({ input: ref, text, setText, purpose: "message", agentId: agent.id });

  useEffect(() => ref.current?.focus(), [agent.id]);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  }, [text]);

  async function send(value = text) {
    const v = value.trim();
    const images = att.paths;
    if ((!v && !images.length) || att.uploading) return;
    setError(null);
    setText("");
    try {
      await api.send(threadId, v, images);
      att.clear();
    } catch (e: any) {
      setError(e.message);
      setText(v);
    }
  }
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
    }
  };

  return (
    <div className="composer-wrap">
      {empty && (
        <div className="choices" style={{ maxWidth: 820, margin: "0 auto 10px" }}>
          {starters.map((s) => <button key={s} className="pill" onClick={() => send(s)}>{s}</button>)}
        </div>
      )}
      <AttachmentStrip a={att} />
      <VoiceStatus v={voice} />
      <div className={`composer${att.dragging ? " dropping" : ""}`} {...att.dropProps}>
        <textarea ref={ref} rows={1} value={text} placeholder={placeholder ?? `Message ${agent.name}…`} aria-label={`Message ${agent.name}`}
          onChange={(e) => setText(e.target.value)} onKeyDown={onKey} onPaste={att.onPaste} />
        <AttachButton a={att} />
        <MicButton v={voice} />
        <button className="btn primary sm" style={{ minHeight: 34 }} disabled={(!text.trim() && !att.paths.length) || att.uploading} onClick={() => send()} aria-label="Send">
          <Icon name="send" size={14} />
        </button>
      </div>
      <p className="composer-hint">
        {error ? <span style={{ color: "var(--bad)" }}>{error}</span>
          : att.uploading ? "Uploading…"
          : agent.status === "working" ? `${agent.name} is working · Esc to stop · new messages queue up and run next`
          : "⏎ send · ⇧⏎ new line · paste or drop images"}
      </p>
    </div>
  );
}
