import { useEffect, useMemo, useState } from "react";
import { api, type Roadmap, type RoadmapItem, type RoadmapStatus } from "../api.ts";
import { useStore } from "../store.tsx";
import { Icon, relTime } from "./ui.tsx";
import { Drawing, FullScreen, layout, type GEdge, type GNode } from "./graph.tsx";
import { openMessage } from "./focusMessage.ts";

/**
 * Roadmaps (docs/V2.1-PLAN.md §3): progress on big work without reading the chat.
 * - The metro line: one dot per step in order, grouped by phase (done ●, in progress ◉ pulsing,
 *   blocked ● red, to do ○, skipped –), next to "Now / Next / Blocked" and a count.
 * - A live card in the conversation (updated in place, never re-posted), pills in the task header and
 *   a Roadmaps tab in the panel; any of them opens the full map (dependencies) or list in one click.
 */

const LABEL: Record<RoadmapStatus, string> = { todo: "to do", doing: "in progress", done: "done", blocked: "blocked", skipped: "skipped" };
const BADGE: Record<RoadmapStatus, string> = { todo: "○", doing: "◉", done: "✓", blocked: "!", skipped: "–" };

/** Steps in a doable order (dependencies first), keeping the agent's order where it's free. */
export function ordered(items: RoadmapItem[]): RoadmapItem[] {
  const pos = new Map(items.map((i, n) => [i.id, n]));
  const left = new Map(items.map((i) => [i.id, i.after.filter((a) => pos.has(a)).length]));
  const next = new Map<string, string[]>();
  for (const i of items) for (const a of i.after) next.set(a, [...(next.get(a) ?? []), i.id]);
  const ready = items.filter((i) => !left.get(i.id)).map((i) => i.id);
  const out: RoadmapItem[] = [];
  const byId = new Map(items.map((i) => [i.id, i]));
  while (ready.length) {
    ready.sort((a, b) => pos.get(a)! - pos.get(b)!);
    const id = ready.shift()!;
    out.push(byId.get(id)!);
    for (const n of next.get(id) ?? []) { left.set(n, left.get(n)! - 1); if (left.get(n) === 0) ready.push(n); }
  }
  return out.length === items.length ? out : items; // (the server refuses cycles; just in case)
}

/** What's happening: in progress, ready to start next (all its dependencies done), blocked. */
export function glance(items: RoadmapItem[]) {
  const done = new Set(items.filter((i) => i.status === "done" || i.status === "skipped").map((i) => i.id));
  const ids = new Set(items.map((i) => i.id));
  return {
    now: items.filter((i) => i.status === "doing"),
    next: ordered(items).filter((i) => i.status === "todo" && i.after.every((a) => done.has(a) || !ids.has(a))),
    blocked: items.filter((i) => i.status === "blocked"),
  };
}

/**
 * Where a step leads: the message behind it (the reply of the turn that last changed it: for a blocked
 * step, the question to the owner), else its PR/issue/doc link.
 */
export function messageHref(i: RoadmapItem): string | null {
  const s = i.source;
  if (!s) return null;
  if (!s.message_id) return `#/agents/${s.agent_id}`;
  return `#/agents/${s.agent_id}${s.thread_id ? `/threads/${s.thread_id}` : ""}/m/${s.message_id}`;
}
const linkHref = (l: string) => (l.startsWith("/") ? `/api/file?path=${encodeURIComponent(l)}` : l);
/** Open a step: blocked → the question; otherwise its link, else where it changed. A #/ link is a page here. */
export function openStep(i: RoadmapItem, before?: () => void) {
  const msg = messageHref(i);
  if (i.link?.startsWith("#/")) { before?.(); location.hash = i.link; return; }
  if (i.status !== "blocked" && i.link) { window.open(linkHref(i.link), "_blank", "noopener"); return; }
  if (msg) { before?.(); openMessage(msg, i.source?.message_id ?? null); return; }
  if (i.link) window.open(linkHref(i.link), "_blank", "noopener");
}

const pct = (r: Roadmap) => (r.counts.total ? Math.round(((r.counts.done + r.counts.skipped) / r.counts.total) * 100) : 0);

/** The metro line: phases as labelled segments of dots. */
export function MetroLine({ items, onOpen }: { items: RoadmapItem[]; onOpen?: () => void }) {
  const phases = useMemo(() => {
    const out: { phase: string; items: RoadmapItem[] }[] = [];
    for (const i of ordered(items)) {
      const last = out[out.length - 1];
      if (last && last.phase === i.phase) last.items.push(i);
      else out.push({ phase: i.phase, items: [i] });
    }
    return out;
  }, [items]);
  return (
    <div className={`metro${onOpen ? " clickable" : ""}`} onClick={onOpen} role={onOpen ? "button" : undefined} tabIndex={onOpen ? 0 : undefined}
      onKeyDown={onOpen ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(); } } : undefined}
      aria-label={`${items.length} steps: ${items.filter((i) => i.status === "done").length} done`}>
      {phases.map((p, n) => (
        <div key={n} className="metro-phase">
          {p.phase && <span className="metro-phase-label">{p.phase}</span>}
          <div className="metro-track">
            {p.items.map((i) => (
              <span key={i.id} className={`metro-dot ${i.status}`} title={`${i.title} — ${LABEL[i.status]}${i.owner ? ` · ${i.owner}` : ""}${i.note ? ` · ${i.note}` : ""}`} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function Ring({ r, size = 18 }: { r: Roadmap; size?: number }) {
  const p = pct(r) / 100, rad = size / 2 - 2.5, c = 2 * Math.PI * rad;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className={`rm-ring${r.counts.blocked ? " blocked" : ""}${r.status === "done" ? " done" : ""}`} aria-hidden="true">
      <circle cx={size / 2} cy={size / 2} r={rad} className="track" />
      <circle cx={size / 2} cy={size / 2} r={rad} className="fill" strokeDasharray={`${c * p} ${c}`} transform={`rotate(-90 ${size / 2} ${size / 2})`} />
    </svg>
  );
}

function Glance({ r }: { r: Roadmap }) {
  const g = glance(r.items);
  const ask = g.blocked.find((i) => messageHref(i));
  const line = (label: string, cls: string, list: RoadmapItem[], extra?: (i: RoadmapItem) => string) => list.length > 0 && (
    <div className={`rm-glance-line ${cls}`}>
      <span className="rm-glance-key">{label}</span>
      <span className="rm-glance-val">
        {list.slice(0, 2).map((i) => `${i.title}${extra?.(i) ?? ""}`).join(" · ")}{list.length > 2 ? ` · +${list.length - 2}` : ""}
      </span>
    </div>
  );
  return (
    <div className="rm-glance">
      {line("Now", "doing", g.now, (i) => (i.owner ? ` (${i.owner})` : ""))}
      {line("Blocked", "blocked", g.blocked, (i) => (i.note ? `: ${i.note}` : ""))}
      {ask && <a className="rm-ask" href={messageHref(ask)!} onClick={(e) => { e.preventDefault(); openMessage(messageHref(ask)!, ask.source?.message_id ?? null); }}
        title={`${ask.source?.agent_name}'s message about "${ask.title}"`}>Read what {ask.source?.agent_name} needs from you →</a>}
      {line("Next", "todo", g.next)}
      {r.status === "done" && <div className="rm-glance-line done"><span className="rm-glance-key">Done</span><span className="rm-glance-val">Every step is finished.</span></div>}
    </div>
  );
}

/** The compact view: title, count, metro line and the glance lines; click to open the full map. */
export function RoadmapSummary({ r, onOpen, compact = false }: { r: Roadmap; onOpen: () => void; compact?: boolean }) {
  return (
    <div className={`rm-summary${r.status === "done" ? " done" : ""}`}>
      <div className="rm-summary-head">
        <Ring r={r} />
        <button className="rm-title" onClick={onOpen} title="Open the map">{r.title}</button>
        <span className="rm-count">{r.counts.done}/{r.counts.total}{r.counts.blocked ? <span className="blocked"> · {r.counts.blocked} blocked</span> : null}</span>
        {!compact && <button className="btn sm ghost" onClick={onOpen}><Icon name="expand" size={14} />Open map</button>}
      </div>
      <MetroLine items={r.items} onOpen={onOpen} />
      <Glance r={r} />
    </div>
  );
}

/** Live roadmaps of a task's work (any task in it), kept current from the event stream. */
export function useRoadmaps(instanceId: string) {
  const { onEvent } = useStore();
  const [state, setState] = useState<{ root: string | null; list: Roadmap[] }>({ root: null, list: [] });
  useEffect(() => {
    let alive = true;
    api.taskRoadmaps(instanceId).then((r) => alive && setState({ root: r.root_id, list: r.roadmaps })).catch(() => {});
    return () => { alive = false; };
  }, [instanceId]);
  useEffect(() => onEvent((e) => {
    if (e.type !== "roadmap.updated") return;
    const r = e.roadmap as Roadmap;
    setState((s) => {
      if (!s.root || r.root_id !== s.root) return s; // not loaded yet, or another work's
      if (r.status === "archived") return { ...s, list: s.list.filter((x) => x.id !== r.id) };
      return { ...s, list: s.list.some((x) => x.id === r.id) ? s.list.map((x) => (x.id === r.id ? r : x)) : [...s.list, r] };
    });
  }), [onEvent]);
  return state.list;
}

/** The card in a conversation (author "roadmap"): always the latest state, never re-posted. */
export function RoadmapCard({ id }: { id: string }) {
  const { onEvent } = useStore();
  const [r, setR] = useState<Roadmap | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => { api.roadmap(id).then(setR).catch(() => {}); }, [id]);
  useEffect(() => onEvent((e) => { if (e.type === "roadmap.updated" && e.roadmap?.id === id) setR(e.roadmap); }), [id, onEvent]);
  if (!r) return null;
  const last = r.events[0];
  return (
    <div className={`approval-card roadmap-card rm-${r.status}`} aria-label={`Roadmap: ${r.title}`}>
      <div className="approval-head">
        <span className="approval-kicker">Roadmap{r.status === "done" ? " · complete" : r.status === "archived" ? " · archived" : ""}</span>
      </div>
      <RoadmapSummary r={r} onOpen={() => setOpen(true)} />
      {last && <span className="hint">Latest: {last.by} {relTime(last.at)}: {last.text}</span>}
      {open && <RoadmapFull list={[r]} initial={r.id} onClose={() => setOpen(false)} />}
    </div>
  );
}

/**
 * The progress strip under a task's (or task room's) header: one slim line per roadmap of the work
 * (ring, label, count, the metro line, and what's in progress or blocked). Always visible, never in
 * the way; a click opens the map. Hidden when the work has no roadmap.
 */
export function RoadmapStrip({ instanceId }: { instanceId: string }) {
  const list = useRoadmaps(instanceId);
  const [open, setOpen] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  if (!list.length) return null;
  const active = [...list].sort((a, b) => Number(a.status === "done") - Number(b.status === "done"));
  const shown = more ? active : active.slice(0, 2);
  return (
    <div className="rm-strip" aria-label="Roadmaps">
      {shown.map((r) => {
        const g = glance(r.items);
        const hint = g.blocked.length ? { cls: "blocked", text: `Blocked: ${g.blocked[0].title}${g.blocked[0].note ? ` (${g.blocked[0].note})` : ""}` }
          : g.now.length ? { cls: "doing", text: `Now: ${g.now.map((i) => i.title).slice(0, 2).join(" · ")}` }
          : g.next.length ? { cls: "todo", text: `Next: ${g.next[0].title}` } : r.status === "done" ? { cls: "done", text: "Complete" } : null;
        return (
          <div key={r.id} className="rm-strip-line">
            <button className="rm-strip-row" onClick={() => setOpen(r.id)} title="Open the map">
              <Ring r={r} size={16} />
              <span className="rm-strip-title">{r.title}</span>
              <span className="rm-strip-count">{r.counts.done}/{r.counts.total}</span>
              <span className="rm-strip-dots" aria-hidden="true">
                {ordered(r.items).map((i) => <span key={i.id} className={`metro-dot sm ${i.status}`} />)}
              </span>
              {hint && <span className={`rm-strip-hint ${hint.cls}`}>{hint.text}</span>}
            </button>
            {g.blocked[0] && messageHref(g.blocked[0]) && (
              <a className="rm-strip-ask" href={messageHref(g.blocked[0])!} title="The message that asks you"
                onClick={(e) => { e.preventDefault(); openMessage(messageHref(g.blocked[0])!, g.blocked[0].source?.message_id ?? null); }}>Read the question →</a>
            )}
          </div>
        );
      })}
      {list.length > 2 && <button className="rm-strip-more" onClick={() => setMore(!more)}>{more ? "Fewer" : `+${list.length - 2} more`}</button>}
      {open && <RoadmapFull list={list} initial={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

/** The panel tab: every roadmap of the work, compact. */
export function RoadmapsTab({ instanceId }: { instanceId: string }) {
  const list = useRoadmaps(instanceId);
  const [open, setOpen] = useState<string | null>(null);
  if (!list.length) {
    return <p className="hint">No roadmaps yet. For big work, the agents keep one here (steps, who's on what, what's blocked) as they go.</p>;
  }
  return (
    <div className="rm-tab">
      {list.map((r) => <RoadmapSummary key={r.id} r={r} compact onOpen={() => setOpen(r.id)} />)}
      {open && <RoadmapFull list={list} initial={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

/** Full screen: the map (steps and what they wait on) or the list, for one roadmap at a time. */
export function RoadmapFull({ list, initial, onClose }: { list: Roadmap[]; initial: string; onClose: () => void }) {
  const [id, setId] = useState(initial);
  const [mode, setMode] = useState<"map" | "list">("map");
  const r = list.find((x) => x.id === id) ?? list[0];
  const graph = useMemo(() => {
    const byId = new Map(r.items.map((i) => [i.id, i]));
    const nodes: GNode[] = r.items.map((i) => ({
      id: i.id, label: i.title, cls: i.status, badge: BADGE[i.status],
      sub: i.status === "blocked" ? `blocked${i.note ? `: ${i.note}` : ""}` : [i.phase, i.owner, i.status === "doing" ? "in progress" : ""].filter(Boolean).join(" · ") || undefined,
      title: `${i.title} — ${LABEL[i.status]}${i.owner ? ` · ${i.owner}` : ""}${i.note ? `\n${i.note}` : ""}${i.link ? `\n${i.link}` : ""}\nClick: ${i.status === "blocked" ? "read the question" : i.link ? "open the link" : "open the message"}`,
    }));
    const edges: GEdge[] = r.items.flatMap((i) => i.after.filter((a) => byId.has(a)).map((a) => ({
      from: a, to: i.id, cls: byId.get(a)!.status === "done" || byId.get(a)!.status === "skipped" ? "met" : "waiting",
    })));
    return { nodes, edges };
  }, [r]);
  const openItem = (itemId: string) => { const i = r.items.find((x) => x.id === itemId); if (i) openStep(i, onClose); };
  const bar = (
    <>
      {list.length > 1 && (
        <div className="segmented" aria-label="Roadmap">
          {list.map((x) => <button key={x.id} aria-pressed={x.id === r.id} onClick={() => setId(x.id)}>{x.title}</button>)}
        </div>
      )}
      {list.length === 1 && <strong>{r.title}</strong>}
      <div className="segmented" aria-label="View">
        <button aria-pressed={mode === "map"} onClick={() => setMode("map")}>Map</button>
        <button aria-pressed={mode === "list"} onClick={() => setMode("list")}>List</button>
      </div>
      <span className="rm-legend">
        <span className="done">{r.counts.done} done</span>
        {r.counts.doing > 0 && <span className="doing">{r.counts.doing} in progress</span>}
        {r.counts.blocked > 0 && <span className="blocked">{r.counts.blocked} blocked</span>}
        <span className="todo">{r.counts.todo} to do</span>
      </span>
    </>
  );
  return (
    <FullScreen label={`Roadmap: ${r.title}`} bar={bar} onClose={onClose}>
      {(budget) => {
        if (mode === "list") return { size: { width: 900, height: 600 }, render: () => <RoadmapList r={r} onLeave={onClose} /> };
        const laid = layout(graph.nodes, graph.edges, budget);
        return { size: laid, render: (zoom) => <Drawing kind="rm" nodes={graph.nodes} edges={graph.edges} laid={laid} scale={zoom} onNode={openItem} /> };
      }}
    </FullScreen>
  );
}

function RoadmapList({ r, onLeave }: { r: Roadmap; onLeave: () => void }) {
  const items = ordered(r.items);
  const phases = [...new Set(items.map((i) => i.phase))];
  return (
    <div className="rm-list">
      {phases.map((p) => (
        <section key={p || "-"}>
          {p && <h3>{p}</h3>}
          <ul>
            {items.filter((i) => i.phase === p).map((i) => (
              <li key={i.id} className={i.status}>
                <span className={`metro-dot ${i.status}`} aria-hidden="true" />
                <span className="rm-list-title">{i.title}</span>
                <span className="rm-list-meta">
                  {LABEL[i.status]}{i.owner ? ` · ${i.owner}` : ""}{i.updated_at ? ` · ${relTime(i.updated_at)}` : ""}
                  {i.note && <><br />{i.note}</>}
                </span>
                <span className="rm-list-links">
                  {messageHref(i) && (
                    <a href={messageHref(i)!} onClick={(e) => { e.preventDefault(); onLeave(); openMessage(messageHref(i)!, i.source?.message_id ?? null); }}
                      title={`${i.source?.agent_name}'s message from when this last changed`}>
                      {i.status === "blocked" ? "Read the question" : "Message"}
                    </a>
                  )}
                  {i.link && <a href={linkHref(i.link)} target="_blank" rel="noopener noreferrer">link</a>}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ))}
      {r.events.length > 0 && (
        <section>
          <h3>Recent changes</h3>
          <ul className="rm-events">{r.events.slice(0, 10).map((e, n) => <li key={n}><span className="hint">{relTime(e.at)} · {e.by}</span> {e.text}</li>)}</ul>
        </section>
      )}
    </div>
  );
}
