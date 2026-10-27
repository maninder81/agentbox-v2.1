import { useEffect, useState } from "react";
import { api, roleLimits, type Agent } from "../api.ts";
import { useStore } from "../store.tsx";
import { Avatar, Icon, Markdown, StatusGlyph, relTime } from "../components/ui.tsx";
import { STATE_LABEL, STATE_STEP, STEP_ICON } from "../components/Setup.tsx";
import { useIntegrations } from "./Integrations.tsx";
import { AgentSkills, DeleteAgent, Instructions, Memory, ScaleSwitch } from "./AgentPanel.tsx";
import { AgentDocuments } from "./Documents.tsx";

type Tab = "tasks" | "instructions" | "integrations" | "skills" | "memory" | "documents" | "settings";
const TABS: { key: Tab; label: string }[] = [
  { key: "tasks", label: "Tasks" },
  { key: "instructions", label: "Instructions" },
  { key: "integrations", label: "Integrations" },
  { key: "skills", label: "Skills" },
  { key: "memory", label: "Memory" },
  { key: "documents", label: "Documents" },
  { key: "settings", label: "Settings" },
];

/** An agent (role): what it is, its live tasks, and everything its tasks share. */
export function RolePage({ role }: { role: Agent }) {
  const [tab, setTab] = useState<Tab>("tasks");
  const [data, setData] = useState<{ instructions: string; memory: { file: string; content: string }[] } | null>(null);
  const reload = () => api.agent(role.id).then((r) => setData({ instructions: r.instructions, memory: r.memory })).catch(() => {});
  useEffect(() => { reload(); }, [role.id, tab]);

  return (
    <div className="page">
      <div className="page-inner" style={{ maxWidth: 920 }}>
        <div className="role-head">
          <Avatar name={role.name} color={role.color} size={44} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <h1 style={{ margin: 0 }}>{role.name}{role.builtin && <span className="builtin-badge" title="Built into agentbox">built-in</span>}</h1>
            <p className="hint" style={{ marginTop: 2 }}>{role.title} · {role.model}</p>
          </div>
          {role.builtin === "setup"
            ? <a className="btn primary" href="#/helper"><Icon name="terminal" />Open the helper</a>
            : <a className="btn primary" href={`#/new/${role.id}`}><Icon name="plus" />New task</a>}
        </div>
        <p className="lede" style={{ marginTop: 12 }}>{role.summary}</p>

        <nav className="tabs page-tabs" role="tablist">
          {TABS.filter((t) => !(role.builtin && t.key === "integrations")).map((t) => (
            <button key={t.key} role="tab" aria-selected={tab === t.key} onClick={() => setTab(t.key)}>{t.label}</button>
          ))}
        </nav>
        <div className="role-body" role="tabpanel">
          {tab === "tasks" && <RoleTasks role={role} />}
          {tab === "instructions" && data && (role.builtin
            ? <BuiltinInstructions role={role} text={data.instructions} />
            : <Instructions agent={role} text={data.instructions} onSaved={reload} />)}
          {tab === "integrations" && !role.builtin && <RoleIntegrations role={role} />}
          {tab === "skills" && <AgentSkills agent={role} />}
          {tab === "memory" && data && <Memory files={data.memory} agent={role} />}
          {tab === "documents" && <AgentDocuments agent={role} />}
          {tab === "settings" && <RoleSettings role={role} />}
        </div>
      </div>
    </div>
  );
}

function RoleTasks({ role }: { role: Agent }) {
  const { agents, everyone, board, work } = useStore();
  const live = agents.filter((a) => a.base_agent_id === role.id);
  const current = (id: string) => Object.values(board).find((t) => t.agent_id === id && t.status === "running")?.title;
  const starter = (a: Agent) => {
    const by = a.created_by ?? "";
    if (by === "owner") return "you";
    if (by.startsWith("routine:")) return "a routine";
    if (by.startsWith("group:")) return "a group";
    return everyone.find((x) => x.id === by)?.name ?? "—";
  };
  const done = work.done.flatMap((w) => w.members).filter((m) => m.role_id === role.id);
  return (
    <>
      {live.length === 0 ? (
        <div className="group-intro">
          <p>No live tasks.</p>
          <p className="hint">Start one with <strong>New task</strong>, or let tech-lead hand {role.name} work. Each task gets its own conversation.</p>
        </div>
      ) : (
        <div className="rows">
          {live.map((a) => (
            <a key={a.id} className="row task-line" href={`#/agents/${a.id}`}>
              <StatusGlyph status={a.status} />
              <span className="task-line-main">
                <span>{a.label ?? a.name}</span>
                <span className="hint">{current(a.id) ?? (a.status === "idle" ? "idle" : a.status)}</span>
              </span>
              <span className="hint task-line-meta">{a.name} · by {starter(a)} · {relTime(a.created_at)}</span>
            </a>
          ))}
        </div>
      )}
      {done.length > 0 && (
        <>
          <h2>Done recently</h2>
          <div className="rows">
            {done.map((m) => (
              <a key={m.id} className="row task-line" href={`#/agents/${m.id}`}>
                <span className="status"><span className="glyph" style={{ borderColor: "var(--ok)", background: "var(--ok)" }} /></span>
                <span className="task-line-main"><span>{m.label ?? m.name}</span></span>
                <span className="hint task-line-meta">{m.name} · done {m.retired_at ? relTime(m.retired_at) : ""}</span>
              </a>
            ))}
          </div>
        </>
      )}
    </>
  );
}

function RoleSettings({ role }: { role: Agent }) {
  const [error, setError] = useState<string | null>(null);
  const patch = (p: Parameters<typeof api.updateAgent>[1]) => api.updateAgent(role.id, p).catch((e) => setError(e.message));
  return (
    <div style={{ display: "grid", gap: 20, maxWidth: 560 }}>
      {error && <div className="error-box">{error}</div>}
      <div className="field">
        <label htmlFor="rs-model">Model</label>
        <select id="rs-model" className="text" style={{ maxWidth: 240 }} value={role.model} onChange={(e) => patch({ model: e.target.value })}>
          <option value="opus">Opus — best judgement</option>
          <option value="sonnet">Sonnet — strong all-rounder</option>
          <option value="haiku">Haiku — fast, light</option>
        </select>
        <span className="hint">Used by every {role.name} task from its next turn.</span>
      </div>
      <div className="field">
        <label htmlFor="rs-cap">Tasks another agent may run at once</label>
        <select id="rs-cap" className="text" style={{ maxWidth: 120 }} value={role.max_replicas || roleLimits.per_role}
          onChange={(e) => patch({ max_replicas: Number(e.target.value) })}>
          {Array.from({ length: roleLimits.max_replicas }, (_, i) => i + 1).map((n) => <option key={n} value={n}>{n}</option>)}
        </select>
        <span className="hint">For example, how many {role.name} tasks one tech-lead task can have going in parallel. Your own tasks aren't limited.</span>
      </div>
      {!role.builtin && <ScaleSwitch agent={role} />}
      {role.builtin
        ? <p className="hint">{role.name} is built into agentbox: it can't be renamed or deleted.</p>
        : <DeleteAgent agent={role} />}
    </div>
  );
}

/** Built-in roles: CLAUDE.md belongs to agentbox (read-only); the owner adds notes instead. */
function BuiltinInstructions({ role, text }: { role: Agent; text: string }) {
  const [notes, setNotes] = useState(role.owner_notes ?? "");
  const [saved, setSaved] = useState(role.owner_notes ?? "");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setNotes(role.owner_notes ?? ""); setSaved(role.owner_notes ?? ""); }, [role.owner_notes]);
  return (
    <div style={{ display: "grid", gap: 16 }}>
      <div className="field">
        <label htmlFor="owner-notes">Your notes for {role.name}</label>
        <textarea id="owner-notes" className="text" style={{ minHeight: 110 }} value={notes} maxLength={8000}
          placeholder="Preferences and context, e.g. which AWS region or GitHub org to use."
          onChange={(e) => setNotes(e.target.value)} />
        <span className="hint">Added to {role.name}'s instructions on its next turn.</span>
        {error && <div className="error-box">{error}</div>}
        <div><button className="btn sm primary" disabled={notes === saved} onClick={async () => {
          setError(null);
          try { const r = await api.saveNotes(role.id, notes); setSaved(r.owner_notes); } catch (e: any) { setError(e.message); }
        }}>Save notes</button></div>
      </div>
      <div>
        <span className="hint">Maintained by agentbox and updated with it; read-only here.</span>
        <Markdown text={text} home={role.home} />
      </div>
    </div>
  );
}

/** Which integrations this agent uses (§10.3). Unmapped ones are invisible to it. */
function RoleIntegrations({ role }: { role: Agent }) {
  const { data, reload } = useIntegrations();
  const [error, setError] = useState<string | null>(null);
  if (!data) return <p className="hint">Loading…</p>;
  const items = data.integrations.filter((i) => i.available);
  const mine = items.filter((i) => i.roles.includes(role.id)).map((i) => i.id);
  const toggle = async (id: string, on: boolean) => {
    setError(null);
    // Keep mappings to integrations the catalog doesn't list right now.
    const current = (role.integrations ?? []).filter((x) => !items.some((i) => i.id === x));
    const next = on ? [...new Set([...current, ...mine, id])] : [...current, ...mine.filter((x) => x !== id)];
    try { await api.setRoleIntegrations(role.id, next); reload(); } catch (e: any) { setError(e.message); }
  };
  return (
    <>
      <span className="hint">
        {role.name} gets the instructions and skills of the integrations switched on here, while they're connected. <a href="#/integrations">All integrations</a>
      </span>
      {data.error && <div className="error-box">Couldn't read the integration catalog: {data.error}</div>}
      {error && <div className="error-box">{error}</div>}
      <div className="rows" style={{ marginTop: 10 }}>
        {items.map((i) => {
          const st = STATE_STEP[i.state];
          return (
            <label key={i.id} className="row" style={{ cursor: "pointer" }}>
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ fontWeight: 500 }}>{i.title}</span>
                <span className={`int-state st-${st}`} style={{ marginLeft: 10 }}><span className="sc-icon" aria-hidden="true">{STEP_ICON[st]}</span>{STATE_LABEL[i.state]}</span>
              </span>
              <span className="switch">
                <input type="checkbox" checked={mine.includes(i.id)} aria-label={`${role.name} uses ${i.title}`} onChange={(e) => toggle(i.id, e.target.checked)} />
                <span />
              </span>
            </label>
          );
        })}
        {items.length === 0 && <div className="row"><span className="hint">No integrations in the catalog.</span></div>}
      </div>
    </>
  );
}
