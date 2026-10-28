import { ScrollToBottom } from "../components/ScrollToBottom.tsx";
import { PlanCard } from "../components/Plan.tsx";
import { ReviewCard } from "./Changes.tsx";
import { RoadmapCard, RoadmapStrip } from "../components/Roadmap.tsx";
import { HostedList, HostedStrip, useHosted } from "../components/Hosted.tsx";
import { NotesTab, SaveSelection, useNotes } from "../components/Notes.tsx";
import { LinkWorkButton, LinkedStrip } from "../components/LinkedWork.tsx";
import { ShareButton } from "../components/Share.tsx";
import { AttachButton, AttachmentStrip, useAttachments } from "../components/Attachments.tsx";
import { SetupRequestCard } from "../components/Requests.tsx";
import { MicButton, VoiceStatus, useVoice } from "../components/Voice.tsx";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { api, type DocumentInfo, type InstanceSummary, type Message, type RoomView, type Step, type Task } from "../api.ts";
import { useStore } from "../store.tsx";
import { Avatar, Icon, Markdown, Spinner, StatusGlyph, relTime, useEscToStop } from "../components/ui.tsx";
import { WorkLog } from "./AgentChat.tsx";
import { DocumentReader } from "./Documents.tsx";
import { LiveBar, useSeenRoom } from "../components/Live.tsx";

/**
 * A task room: a task and every task it started, as one timeline. Each entry says which task it
 * belongs to; chips filter by task. The composer talks to the room's lead task.
 */
export function Room({ id }: { id: string }) {
  const { threads, live, loadThread, work, everyone, progress } = useStore();
  useSeenRoom(id);
  const [view, setView] = useState<RoomView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<string | null>(null);
  const [showFilter, setShowFilter] = useState(() => { try { return localStorage.getItem("room.filters") !== "closed"; } catch { return true; } });
  const toggleFilter = () => {
    const next = !showFilter;
    setShowFilter(next);
    try { localStorage.setItem("room.filters", next ? "open" : "closed"); } catch { /* fine without it */ }
  };
  const [panel, setPanel] = useState(true);

  // Membership comes from the server; refetch when the work list changes (tasks started/finished).
  const signature = JSON.stringify([...work.live, ...work.done].find((w) => w.root.id === id)?.members.map((m) => [m.id, m.status]) ?? []);
  useEffect(() => {
    api.room(id).then((v) => { setView(v); setError(null); v.threads.forEach((t) => loadThread(t.id).catch(() => {})); })
      .catch((e) => setError(e.message));
  }, [id, signature]);

  const members = view?.members ?? [];
  const byThread = useMemo(() => new Map((view?.threads ?? []).map((t) => [t.id, t.agent_id])), [view]);
  const member = (instanceId: string | undefined) => members.find((m) => m.id === instanceId);

  // Live data for every thread in the room, merged by time.
  const merged = useMemo(() => {
    const msgs: Message[] = []; const tasks: Task[] = []; const steps: Step[] = [];
    for (const t of view?.threads ?? []) {
      const d = threads[t.id];
      if (!d) continue;
      msgs.push(...d.messages); tasks.push(...d.tasks); steps.push(...d.steps);
    }
    msgs.sort((a, b) => a.created_at.localeCompare(b.created_at));
    return { msgs, tasks, steps };
  }, [view, threads]);
  const taskById = useMemo(() => new Map(merged.tasks.map((t) => [t.id, t])), [merged]);
  const running = merged.tasks.filter((t) => t.status === "running");
  useEscToStop(running.length > 0, () => running.forEach((t) => api.stop(t.id)));

  if (error) return <div className="page"><div className="page-inner"><div className="error-box">{error}</div></div></div>;
  if (!view) return <div className="page" />;
  const root = view.root;
  const done = !!root.retired_at;
  const rootThread = view.threads.find((t) => t.agent_id === root.id && t.kind === "dm")?.id;
  const replied = new Set(merged.msgs.map((m) => m.task_id).filter(Boolean));
  const pending = merged.tasks.filter((t) => (t.status === "running" || t.status === "queued") && !replied.has(t.id));
  // An entry belongs to the task whose conversation it's in, and also to the task that wrote it.
  const visible = (...ids: (string | undefined)[]) => !filter || ids.includes(filter);

  return (
    <>
      <section className="chat room" aria-label={`Task room: ${root.label}`}>
        <header className="chat-head">
          <span className="room-mark" aria-hidden="true"><Icon name="room" size={18} /></span>
          <div className="who" style={{ minWidth: 0 }}>
            <strong>{root.label ?? root.name}</strong>
            <span>Task room · {members.length} task{members.length === 1 ? "" : "s"} · led by {root.name}</span>
          </div>
          <div className="actions">
            {running.length > 0 && (
              <button className="btn sm danger" onClick={() => running.forEach((t) => api.stop(t.id))} title="Stop everything running here (Esc)">
                <Icon name="stop" size={14} />Stop
              </button>
            )}
            {!done && <LinkWorkButton instanceId={root.id} />}
            {!done && <ShareButton roomId={root.id} />}
            <RoomLifecycle root={root} />
            <button className="icon-btn" aria-pressed={panel} aria-label="Room details" onClick={() => setPanel(!panel)}><Icon name="panel" /></button>
          </div>
        </header>
        <RoadmapStrip instanceId={root.id} />
        <HostedStrip roomId={root.id} />
        <LinkedStrip instanceId={root.id} />

        <nav className={`room-filter${showFilter ? "" : " collapsed"}`} aria-label="Show">
          <button className="room-filter-toggle" aria-expanded={showFilter} onClick={toggleFilter}
            title={showFilter ? "Hide the task filter" : "Show the task filter"}>
            <span className={`chev${showFilter ? " open" : ""}`}><Icon name="chevron" size={10} /></span>
            Show{!showFilter && <>: <strong>{filter ? (members.find((m) => m.id === filter)?.label ?? "one task") : "all tasks"}</strong></>}
          </button>
          {!showFilter && filter && (
            <button className="link-button" onClick={() => setFilter(null)}>Show all</button>
          )}
          {showFilter && <button className="pill" aria-pressed={!filter} onClick={() => setFilter(null)}>All</button>}
          {showFilter && members.map((m) => (
            <button key={m.id} className="pill" aria-pressed={filter === m.id} onClick={() => setFilter(filter === m.id ? null : m.id)} title={m.name}>
              <span className={`glyph ${m.status === "done" ? "" : m.status}`} />{m.label ?? m.name}
            </button>
          ))}
        </nav>

        <RoomTimeline>
          <TimelineEntries msgs={merged.msgs} pending={pending} steps={merged.steps} members={members} byThread={byThread}
            taskById={taskById} visible={visible} />
        </RoomTimeline>

        <LiveBar
          items={Object.values(progress).filter((p) => p.root_id === id && visible(p.agent_id))}
          taskOf={(tid) => taskById.get(tid)}
          stepsOf={(tid) => merged.steps.filter((s) => s.task_id === tid)}
          labelOf={members.length > 1 ? (aid) => member(aid)?.label : undefined}
        />

        {!done && rootThread && <RoomComposer threadId={rootThread} lead={root} />}
        {done && <p className="composer-hint" style={{ padding: "12px 24px 20px", margin: 0, maxWidth: "none", textAlign: "center" }}>This task room is done; its history stays readable.</p>}
      </section>
      {panel && <RoomPanel id={id} members={members} workspace={view.workspace} onClose={() => setPanel(false)} />}
      <SaveSelection instanceId={id} />
    </>
  );
}

/**
 * The entries of a room-style timeline (task rooms, routine runs): messages from several
 * instances' conversations merged by time, then what's still pending (queued, or running without
 * live progress).
 */
export function TimelineEntries({ msgs, pending, steps, members, byThread, taskById, visible = () => true, empty = "Nothing here yet." }: {
  msgs: Message[]; pending: Task[]; steps: Step[]; members: InstanceSummary[];
  byThread: Map<string, string>; taskById: Map<string, Task>;
  visible?: (...ids: (string | undefined)[]) => boolean; empty?: string;
}) {
  const { live, everyone, progress } = useStore();
  const member = (instanceId: string | undefined) => members.find((m) => m.id === instanceId);
  return (
    <>
          {msgs.length === 0 && pending.length === 0 && <p className="hint" style={{ textAlign: "center" }}>{empty}</p>}
          {msgs.map((m) => {
            const inst = member(byThread.get(m.thread_id));
            const from = m.author !== inst?.id ? member(m.author) : undefined;
            if (!visible(inst?.id, from?.id)) return null;
            if (m.author === "system") return <p key={m.id} className="system-note">{inst ? `${inst.label ?? inst.name}: ` : ""}{m.content}</p>;
            if (m.author === "setup_request") return <div key={m.id} className="msg"><span aria-hidden="true" /><SetupRequestCard id={m.content} /></div>;
            if (m.author === "plan") return <div key={m.id} className="msg"><span aria-hidden="true" /><PlanCard id={m.content} /></div>;
            if (m.author === "review") return <div key={m.id} className="msg"><span aria-hidden="true" /><ReviewCard id={m.content} /></div>;
            if (m.author === "roadmap") return <div key={m.id} className="msg"><span aria-hidden="true" /><RoadmapCard id={m.content} /></div>;
            const task = m.task_id ? taskById.get(m.task_id) : undefined;
            const isReply = !!task && task.agent_id === m.author;
            const author = m.author === "user" ? null : everyone.find((a) => a.id === m.author);
            // A guest the owner shared this work with (shares.ts): "guest:<name>".
            const guest = m.author.startsWith("guest:") ? m.author.slice(6) : null;
            return (
              <div key={m.id} className="msg" data-msg-id={m.id} data-author={m.author}>
                {m.author === "user"
                  ? <span className="avatar you-avatar" style={{ width: 28, height: 28, fontSize: 12 }} aria-hidden="true">You</span>
                  : guest ? <span className="avatar you-avatar guest-avatar" style={{ width: 28, height: 28, fontSize: 12 }} aria-hidden="true">{guest.slice(0, 1).toUpperCase()}</span>
                  : <Avatar name={author?.name ?? "?"} color={author?.color ?? "var(--muted)"} size={28} />}
                <div style={{ minWidth: 0 }}>
                  <div className="msg-meta">
                    <strong>{m.author === "user" ? "You" : guest ? guest : author?.name ?? (m.author === "routine" ? "Routine" : "agent")}</strong>
                    {guest && <span className="tag">guest</span>}
                    {from && <><a className="room-tag" href={`#/agents/${from.id}`} title={`Open ${from.label}`}>{from.label ?? from.name}</a><span className="hint">→</span></>}
                    {inst && <a className="room-tag" href={`#/agents/${inst.id}`} title={`Open ${inst.label}`}>{inst.label ?? inst.name}</a>}
                    {!isReply && task?.source === "agent" && <span className="hint">handed off</span>}
                    {!isReply && task?.source === "result" && <span className="hint">reported back</span>}
                    <time dateTime={m.created_at}>{relTime(m.created_at)}</time>
                  </div>
                  {isReply && task && <WorkLog task={task} steps={steps.filter((s) => s.task_id === task.id)} />}
                  <div className={!isReply && task && task.source !== "user" ? "handoff" : undefined}>
                    <Markdown text={m.content} home={author?.home} />
                  </div>
                </div>
              </div>
            );
          })}
          {pending.map((t) => {
            const inst = member(t.agent_id);
            if (!inst || !visible(inst.id)) return null;
            const a = everyone.find((x) => x.id === t.agent_id);
            // A working task's status lives in the bar below; here only its reply as it's written.
            if (t.status === "running" && progress[t.id] && !live[t.id]) return null;
            const tracked = t.status === "running" && !!progress[t.id];
            return (
              <div key={t.id} className="msg">
                <Avatar name={a?.name ?? "?"} color={a?.color ?? "var(--muted)"} size={28} />
                <div style={{ minWidth: 0 }}>
                  <div className="msg-meta">
                    <strong>{a?.name}</strong>
                    <span className="room-tag">{inst.label ?? inst.name}</span>
                    <span className="hint">{t.status === "queued" ? "up next" : tracked ? "writing…" : "working…"}</span>
                  </div>
                  {t.status === "running" && !tracked && <WorkLog task={t} steps={steps.filter((s) => s.task_id === t.id)} />}
                  {t.status === "running" && (live[t.id] ? <Markdown text={live[t.id]} streaming home={a?.home} /> : <p className="msg-note"><Spinner />Thinking…</p>)}
                </div>
              </div>
            );
          })}
    </>
  );
}

export function RoomTimeline({ children }: { children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  });
  return (
    <div className="timeline" ref={ref} aria-live="polite" aria-relevant="additions"
      onScroll={() => { const el = ref.current!; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; }}>
      <div className="timeline-inner">{children}</div>
      <ScrollToBottom scroller={ref} onJump={() => { stick.current = true; }} />
    </div>
  );
}

function RoomComposer({ threadId, lead }: { threadId: string; lead: InstanceSummary }) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  }, [text]);
  const att = useAttachments();
  const voice = useVoice({ input: ref, text, setText, purpose: "message", agentId: lead.id });
  const send = async () => {
    const v = text.trim();
    const images = att.paths;
    if ((!v && !images.length) || att.uploading) return;
    setText(""); setError(null);
    try { await api.send(threadId, v, images); att.clear(); } catch (e: any) { setError(e.message); setText(v); }
  };
  return (
    <div className="composer-wrap">
      <AttachmentStrip a={att} />
      <VoiceStatus v={voice} />
      <div className={`composer${att.dragging ? " dropping" : ""}`} {...att.dropProps}>
        <textarea ref={ref} rows={1} value={text} placeholder={`Message the room's lead (${lead.name})…`} aria-label="Message the room's lead"
          onChange={(e) => setText(e.target.value)} onPaste={att.onPaste}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); } }} />
        <AttachButton a={att} />
        <MicButton v={voice} />
        <button className="btn primary sm" style={{ minHeight: 34 }} disabled={(!text.trim() && !att.paths.length) || att.uploading} onClick={send} aria-label="Send"><Icon name="send" size={14} /></button>
      </div>
      <p className="composer-hint">{error ? <span style={{ color: "var(--bad)" }}>{error}</span> : att.uploading ? "Uploading…" : <>Goes to {lead.name} ({lead.label}), who coordinates the room · ⏎ send · Esc stops</>}</p>
    </div>
  );
}

/** Done (finish the whole room) while live; "hidden in 24 h — Keep" once done. */
function RoomLifecycle({ root }: { root: InstanceSummary }) {
  const { work } = useStore();
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (root.retired_at) {
    const hides = work.done.find((w) => w.root.id === root.id)?.hides_at;
    return (
      <span className="hint" style={{ display: "inline-flex", gap: 8, alignItems: "center" }}>
        {root.kept ? "Kept" : hides ? `Hidden from Work ${relTime(hides)}` : "Done"}
        <button className="btn sm" onClick={() => api.setTaskMeta(root.id, { kept: !root.kept })}>{root.kept ? "Stop keeping" : "Keep"}</button>
      </span>
    );
  }
  return (
    <div className="popover-anchor">
      <button className="btn sm" onClick={() => { setError(null); setConfirm(!confirm); }}><Icon name="check" size={14} />Done</button>
      {confirm && (
        <div className="popover" role="dialog" aria-label="Finish task room">
          <strong>Mark the whole room done?</strong>
          <p className="hint">Finishes {root.label} and every task in it. They leave Work after 24 hours unless you keep them; history stays.</p>
          {error && <div className="error-box">{error}</div>}
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn sm primary" onClick={async () => { try { await api.finishTask(root.id); setConfirm(false); } catch (e: any) { setError(e.message); } }}>Mark done</button>
            <button className="btn sm ghost" onClick={() => setConfirm(false)}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}

function RoomPanel({ id, members, workspace, onClose }: { id: string; members: InstanceSummary[]; workspace: string | null; onClose: () => void }) {
  const [tab, setTab] = useState<"tasks" | "documents" | "notes" | "services">("tasks");
  const hosted = useHosted(id);
  const notes = useNotes(id);
  return (
    <aside className="panel" aria-label="Room details">
      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={tab === "tasks"} onClick={() => setTab("tasks")}>Tasks</button>
        <button role="tab" aria-selected={tab === "documents"} onClick={() => setTab("documents")}>Documents</button>
        <button role="tab" aria-selected={tab === "notes"} onClick={() => setTab("notes")}>
          Notes{notes?.length ? <span className="tab-count">{notes.length}</span> : null}
        </button>
        <button role="tab" aria-selected={tab === "services"} onClick={() => setTab("services")}>
          Services{hosted?.length ? <span className="tab-count">{hosted.length}</span> : null}
        </button>
        <button className="icon-btn" style={{ marginLeft: "auto", alignSelf: "center" }} aria-label="Close details" onClick={onClose}><Icon name="close" /></button>
      </div>
      <div className="panel-body" role="tabpanel">
        {tab === "tasks" && workspace && (
          <p className="hint" style={{ margin: 0 }}>Shared folder: <span className="mono">{workspace}</span><br />State, scripts and notes for this work (also in Documents).</p>
        )}
        {tab === "tasks" && (
          <div className="rows">
            {members.map((m) => (
              <a key={m.id} className="row task-line" href={`#/agents/${m.id}`} style={{ paddingLeft: m.parent_instance_id ? 24 : 14 }}>
                {m.status === "done" ? <span className="status"><span className="glyph" style={{ borderColor: "var(--ok)", background: "var(--ok)" }} /></span> : <StatusGlyph status={m.status} />}
                <span className="task-line-main">
                  <span>{m.label ?? m.name}</span>
                  <span className="hint">{m.name}{m.current ? ` · ${m.current}` : m.status === "done" ? " · done" : ""}</span>
                </span>
              </a>
            ))}
          </div>
        )}
        {tab === "documents" && <WorkDocuments load={() => api.roomDocuments(id)} empty="No documents from this room yet." />}
        {tab === "notes" && <NotesTab instanceId={id} />}
        {tab === "services" && <HostedList roomId={id} empty="Nothing hosted in this room. Agents host pages, dashboards and servers here with a link for you." />}
      </div>
    </aside>
  );
}

/** Documents produced by a piece of work (room or group), newest first, with who wrote each. */
export function WorkDocuments({ load, empty }: { load: () => Promise<(DocumentInfo & { author: string | null })[]>; empty: string }) {
  const { everyone } = useStore();
  const [docs, setDocs] = useState<(DocumentInfo & { author: string | null })[] | null>(null);
  const [open, setOpen] = useState<DocumentInfo | null>(null);
  useEffect(() => {
    const go = () => load().then(setDocs).catch(() => setDocs([]));
    go();
    const t = setInterval(go, 15000);
    return () => clearInterval(t);
  }, []);
  if (!docs) return <p className="hint">Loading…</p>;
  if (!docs.length) return <p className="hint">{empty}</p>;
  return (
    <>
      <ul className="doc-list">
        {docs.map((d) => {
          const who = everyone.find((a) => a.id === d.author);
          return (
            <li key={d.path}>
              <button className="doc-row" onClick={() => setOpen(d)} title={d.path}>
                <span className="doc-badge">{d.name.split(".").pop()?.slice(0, 4)}</span>
                <span className="doc-text">
                  <span className="doc-name">{d.name}</span>
                  <span className="hint">{who ? `${who.name} · ` : ""}{relTime(d.modified)}</span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {open && <DocumentReader doc={open} onClose={() => setOpen(null)} />}
    </>
  );
}
