import { useEffect, useMemo, useRef, useState } from "react";
import { ApiError, api, fileUrl, type AccountRepo, type MapRoutineInfo, type Repo, type RepoWorktree } from "../api.ts";
import { useStore } from "../store.tsx";
import { go } from "../router.ts";
import { Icon, relTime } from "../components/ui.tsx";
import { fmtDuration, heartbeat } from "../components/progress.ts";

/**
 * Repos (docs/V2-ARCHITECTURE.md, Changes (repos)): what agents work on. Each repo has one read-only
 * canonical clone and a git worktree per task; its map (architecture and features) comes from a read-only onboarding run.
 */

export function useRepos() {
  const { onEvent } = useStore();
  const [data, setData] = useState<{ repos: Repo[]; map_routines: MapRoutineInfo[]; map_routines_missing: string[]; error: string | null } | null>(null);
  const load = () => api.repos().then((d) => setData({ ...d, error: null }))
    .catch((e) => setData((x) => ({ repos: x?.repos ?? [], map_routines: x?.map_routines ?? [], map_routines_missing: x?.map_routines_missing ?? [], error: e.message })));
  const timer = useRef<number | null>(null);
  useEffect(() => { load(); }, []);
  useEffect(() => onEvent((e) => {
    if (e.type === "repo.updated" || e.type === "memory.updated" || e.type === "agent.retired" || e.type === "agent.created" || e.type === "crews.updated") {
      if (timer.current) clearTimeout(timer.current);
      timer.current = window.setTimeout(load, 250);
    }
    if (e.type === "repo.progress") {
      setData((d) => d && {
        ...d,
        repos: d.repos.map((r) => r.id !== e.repoId || !r.job ? r : {
          ...r, job: { ...r.job, last_output_at: new Date().toISOString(), lines: [...r.job.lines.filter((l) => l.line.replace(/:\s.*$/, "") !== e.line.replace(/:\s.*$/, "") || !/\d+%/.test(e.line)), { line: e.line, at: new Date().toISOString() }].slice(-40) },
        }),
      });
    }
  }), [onEvent]);
  return { data, reload: load };
}

export function Repos({ focus }: { focus?: string }) {
  const { data, reload } = useRepos();
  const [adding, setAdding] = useState(false);
  const live = (data?.repos ?? []).filter((r) => r.status !== "archived");
  const archived = (data?.repos ?? []).filter((r) => r.status === "archived");
  useEffect(() => {
    if (focus && data) document.getElementById(`repo-${focus}`)?.scrollIntoView({ block: "start" });
  }, [focus, !!data]);
  return (
    <div className="page">
      <div className="page-inner" style={{ maxWidth: 1000 }}>
        <div className="page-head-row">
          <h1>Repos</h1>
          <button className="btn primary" onClick={() => setAdding(!adding)} aria-expanded={adding}><Icon name="plus" size={14} />Add repo</button>
        </div>
        <p className="lede">
          The code your agents work on. agentbox keeps one read-only clone of each (fetched every 15 minutes) and gives every
          task its own git worktree and branch, so agents never get in each other's way. When a task closes, its worktree is
          removed, unless it holds work that isn't pushed.
        </p>
        {adding && <AddRepo onDone={() => { setAdding(false); reload(); }} onCancel={() => setAdding(false)} />}
        {data?.error && <div className="error-box" style={{ marginBottom: 16 }}>{data.error}</div>}
        {!data && <p className="hint">Loading…</p>}
        {data && live.length === 0 && !adding && (
          <div className="group-intro"><p>No repos yet. Add one from a connected GitHub, GitLab or Bitbucket account, or by its URL.</p></div>
        )}
        <div className="repo-list">
          {live.map((r) => <RepoCard key={r.id} repo={r} onChange={reload} open={focus === r.name} />)}
        </div>
        {data && live.some((r) => r.status === "ready") && <MapRoutine routines={data.map_routines} missing={data.map_routines_missing} onChange={reload} />}
        {archived.length > 0 && (
          <section>
            <h2>Archived</h2>
            <div className="repo-list">{archived.map((r) => <ArchivedRepo key={r.id} repo={r} onChange={reload} />)}</div>
          </section>
        )}
      </div>
    </div>
  );
}

const STATUS_LABEL: Record<Repo["status"], string> = { cloning: "Cloning", ready: "Ready", error: "Error", archived: "Archived" };
const MAP_LABEL: Record<Repo["map_status"], string> = { none: "No map", choosing: "Choosing who maps it…", running: "Mapping…", ready: "Mapped", error: "Map failed" };

/**
 * Who maps a repo: "the helper chooses" (it looks at the repo and picks a crew lead), or an agent allowed
 * to use it, grouped by crew with each crew's lead first.
 */
function MapperPicker({ value, allowed, onChange, disabled }: { value: string | null; allowed: string[]; onChange: (id: string | null) => void; disabled?: boolean }) {
  const { agents, crews } = useStore();
  const roles = agents.filter((a) => !a.base_agent_id && !a.builtin && (!allowed.length || allowed.includes(a.id)));
  const groups = [...crews.map((c) => ({ id: c.id, name: `${c.name} crew`, lead: c.lead_role_id })), { id: "", name: crews.length ? "No crew" : "Agents", lead: null }]
    .map((g) => {
      const members = roles.filter((r) => (crews.some((c) => c.id === r.crew_id) ? r.crew_id : "") === g.id);
      const lead = members.find((m) => m.id === g.lead) ?? members.find((m) => m.can_scale);
      return { ...g, members: lead ? [lead, ...members.filter((m) => m !== lead)] : members, leadId: lead?.id };
    })
    .filter((g) => g.members.length);
  const gone = value && !roles.some((r) => r.id === value);
  return (
    <select className="text mapper-picker" value={gone ? "" : value ?? ""} disabled={disabled} aria-label="Who maps this repo"
      onChange={(e) => onChange(e.target.value || null)}>
      <option value="">Let the helper choose (it looks at the repo)</option>
      {groups.map((g) => (
        <optgroup key={g.id || "none"} label={g.name}>
          {g.members.map((m) => <option key={m.id} value={m.id}>{m.name}{m.id === g.leadId ? " (lead)" : ""} — {m.title}</option>)}
        </optgroup>
      ))}
    </select>
  );
}

function useNow(on: boolean) {
  const [t, setT] = useState(() => Date.now());
  useEffect(() => { if (!on) return; const i = setInterval(() => setT(Date.now()), 1000); return () => clearInterval(i); }, [on]);
  return t;
}

function RepoCard({ repo: r, onChange, open }: { repo: Repo; onChange: () => void; open: boolean }) {
  const { everyone } = useStore();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [settings, setSettings] = useState(open);
  const [conflict, setConflict] = useState<any>(null);
  const cloning = r.status === "cloning";
  const now = useNow(cloning);
  const act = async (name: string, fn: () => Promise<unknown>) => {
    setBusy(name); setError(null);
    try { await fn(); onChange(); } catch (e: any) { setError(e.message); }
    setBusy(null);
  };
  const archive = (confirm = false) => act("archive", async () => {
    try { await api.archiveRepo(r.name, confirm); setConflict(null); } catch (e) {
      if (e instanceof ApiError && e.status === 409 && e.data?.detail) { setConflict(e.data.detail); return; }
      throw e;
    }
  });
  const open_ = r.worktrees.filter((w) => w.status !== "kept");
  const kept = r.worktrees.filter((w) => w.status === "kept");
  const roleNames = r.allowed_roles.map((id) => everyone.find((a) => a.id === id)?.name ?? "deleted agent");
  const started = r.job ? Date.parse(r.job.started_at) : now;
  const quiet = r.job ? heartbeat(Date.parse(r.job.last_output_at), now) : null;
  return (
    <article id={`repo-${r.name}`} className={`card repo-card st-${r.status}`} aria-label={r.name}>
      <div className="repo-top">
        <div className="repo-title">
          <strong>{r.name}</strong>
          <span className={`repo-state st-${r.status}`}>{STATUS_LABEL[r.status]}</span>
          <span className="tag">{r.provider}</span>
        </div>
        <div className="repo-actions">
          {r.status === "ready" && <button className="btn sm" disabled={!!busy} onClick={() => act("fetch", () => api.fetchRepo(r.name))}><Icon name="refresh" size={14} />{busy === "fetch" ? "Fetching…" : "Fetch"}</button>}
          {r.status === "ready" && r.map_status !== "running" && r.map_status !== "choosing" && (
            <button className="btn sm" disabled={!!busy} onClick={() => act("remap", async () => { const x = await api.remapRepo(r.name); go({ name: "agent", id: x.instance_id }); })}
              title={r.mapper_role_id ? undefined : "No mapper chosen: the helper looks at the repo and picks a crew lead first"}>
              {r.map_status === "none" ? "Map it" : "Re-map"}
            </button>
          )}
          {r.status === "error" && <button className="btn sm primary" disabled={!!busy} onClick={() => act("retry", () => api.retryRepo(r.name))}>Retry clone</button>}
          <button className="btn sm ghost" aria-expanded={settings} aria-controls={`repo-settings-${r.id}`} onClick={() => setSettings(!settings)}>
            {settings ? "Close settings" : "Settings"}
          </button>
        </div>
      </div>
      {/* Right under the buttons: below the worktree list it opened out of sight on a busy repo. */}
      {settings && <RepoSettings repo={r} onSaved={onChange} onArchive={() => archive(false)} busy={busy === "archive"} />}
      <div className="sub repo-url">{r.url}</div>
      {r.description && <div className="sub">{r.description}</div>}
      <dl className="repo-meta">
        <dt>Default branch</dt><dd><code>{r.default_branch ?? "?"}</code></dd>
        <dt>Last fetch</dt><dd>{r.last_fetch_at ? relTime(r.last_fetch_at) : "never"}</dd>
        <dt>Map</dt>
        <dd>
          <span className={`map-state m-${r.map_status}`}>{MAP_LABEL[r.map_status]}</span>
          {r.map_status === "ready" && r.map_updated_at && <span className="hint"> · {relTime(r.map_updated_at)}</span>}
          {(r.map_status === "running" || r.map_status === "choosing") && r.map_task_id && <> · <a href={`#/agents/${r.map_task_id}`}>open the task</a></>}
        </dd>
        {r.status !== "archived" && (
          <>
            <dt>Mapped by</dt>
            <dd className="mapper-row">
              <MapperPicker value={r.mapper_role_id} allowed={r.allowed_roles} disabled={!!busy || r.map_status === "running"}
                onChange={(id) => act("mapper", () => api.updateRepo(r.name, { mapper_role_id: id }))} />
              {r.mapper_role_id && !everyone.some((a) => a.id === r.mapper_role_id && !a.retired_at) && <span className="hint" style={{ color: "var(--warn)" }}>Its mapper was removed: pick another.</span>}
              {r.mapper_note && r.mapper_role_id && <span className="hint">{r.mapper_note}</span>}
            </dd>
          </>
        )}
        {r.memory && (
          <>
            <dt>Memory</dt>
            <dd>
              {r.memory.notes
                ? <a href={fileUrl(r.memory.index ?? r.memory.dir)} data-file-path={r.memory.index ?? undefined}>{r.memory.notes} note{r.memory.notes === 1 ? "" : "s"}</a>
                : <span className="hint">none yet</span>}
              {r.memory.stale > 0 && <span className="hint"> · {r.memory.stale} may be stale (re-checked when an agent needs them)</span>}
              {r.memory.drafts.length > 0 && (
                <span className="hint"> · {r.memory.drafts.map((d, i) => (
                  <span key={d.id}>{i ? ", " : ""}<a href={`#/agents/${d.instance_id}`}>{d.agent_name ?? "a task"}</a>{d.status === "promoting" ? " folding in its notes" : ` has ${d.notes} draft note${d.notes === 1 ? "" : "s"}${d.note ? ` (${d.note})` : " waiting for its PR to merge"}`}</span>
                ))}</span>
              )}
            </dd>
          </>
        )}
        <dt>Used by</dt><dd>{roleNames.length ? roleNames.join(", ") : "every agent"}</dd>
        {r.test_command && <><dt>Tests</dt><dd><code>{r.test_command}</code></dd></>}
        <dt>Rules</dt>
        <dd>{r.agents_may_merge ? "agents may merge" : `no pushes to ${r.protected_branches.join(", ") || "—"}${r.lead_may_merge ? " · lead merges routine PRs" : " · you merge"}`} · {r.agents_may_deploy ? "agents may deploy" : "no deploys"}</dd>
      </dl>
      {r.error && <div className="error-box">{r.error}</div>}
      {r.map_error && r.map_status === "error" && <div className="hint">Map: {r.map_error}</div>}
      {cloning && r.job && (
        <div className="repo-progress" role="status" aria-live="polite">
          <div className="hint">Cloning… {fmtDuration(now - started)}</div>
          <pre className="repo-log">{r.job.lines.slice(-6).map((l) => l.line).join("\n")}</pre>
          {quiet && <div className="hint">{quiet}</div>}
        </div>
      )}
      {r.map_status === "ready" && r.map_files.some((f) => f.exists) && (
        <div className="repo-map">
          {r.map_files.filter((f) => f.exists).map((f) => <a key={f.file} className="pill" href={fileUrl(f.path)} data-file-path={f.path}>{f.file}</a>)}
        </div>
      )}
      {(open_.length > 0 || kept.length > 0) && (
        <div className="repo-worktrees">
          <span className="hint">Worktrees</span>
          <ul>
            {open_.map((w) => <WorktreeRow key={w.id} w={w} onChange={onChange} />)}
            {kept.map((w) => <WorktreeRow key={w.id} w={w} onChange={onChange} />)}
          </ul>
        </div>
      )}
      {error && <div className="error-box">{error}</div>}
      {conflict?.kind === "busy" && (
        <div className="error-box">
          Open tasks use {r.name}: {conflict.tasks.map((t: any, i: number) => <span key={t.id}>{i ? ", " : ""}<a href={`#/agents/${t.id}`}>{t.name} ({t.label ?? "task"})</a></span>)}.
          Wait for them to finish, or mark them done, then archive.
        </div>
      )}
      {conflict?.kind === "unpushed" && (
        <div className="error-box">
          {conflict.worktrees.length} worktree(s) hold unpushed work. They stay on disk (you can still discard them) if you archive.
          <div style={{ marginTop: 8 }}><button className="btn sm danger" disabled={!!busy} onClick={() => archive(true)}>Archive anyway</button></div>
        </div>
      )}
    </article>
  );
}

function WorktreeRow({ w, onChange }: { w: RepoWorktree; onChange: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sure, setSure] = useState(false);
  const discard = async () => {
    setBusy(true); setError(null);
    try { await api.discardWorktree(w.id); onChange(); } catch (e: any) { setError(e.message); setBusy(false); }
  };
  return (
    <li className={`wt-row wt-${w.status}`}>
      <span className="wt-task">
        {w.instance ? <a href={`#/agents/${w.instance.id}`}>{w.instance.label ?? w.instance.name}</a> : "deleted task"}
        <span className="hint"> · {w.instance?.name}{w.purpose === "onboard" ? " · map" : ""}</span>
      </span>
      <code className="wt-branch">{w.branch ?? "(not created yet)"}</code>
      {w.status === "kept" ? (
        <span className="wt-kept">
          <span className="chip warn">{w.note ?? "kept: unpushed work"}</span>
          {sure
            ? <><button className="btn sm danger" disabled={busy} onClick={discard}>Discard it</button><button className="btn sm ghost" onClick={() => setSure(false)}>Keep</button></>
            : <button className="btn sm ghost danger" onClick={() => setSure(true)} title={w.path ?? ""}>Discard…</button>}
        </span>
      ) : w.status === "error" ? <span className="chip bad" title={w.note ?? ""}>error</span> : w.status === "pending" ? <span className="hint">created at its next turn</span> : null}
      {error && <div className="error-box">{error}</div>}
    </li>
  );
}

function RepoSettings({ repo: r, onSaved, onArchive, busy }: { repo: Repo; onSaved: () => void; onArchive: () => void; busy: boolean }) {
  const { agents } = useStore();
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => { box.current?.scrollIntoView({ block: "nearest", behavior: "smooth" }); }, []);
  const roles = agents.filter((a) => !a.base_agent_id && !a.builtin);
  const [v, setV] = useState({
    description: r.description, test_command: r.test_command, default_branch: r.default_branch ?? "", protected_branches: r.protected_branches.join(", "),
    allowed_roles: r.allowed_roles, agents_may_merge: r.agents_may_merge, agents_may_deploy: r.agents_may_deploy, propose_map_pr: r.propose_map_pr, lead_may_merge: r.lead_may_merge,
  });
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const save = async () => {
    setSaving(true); setMsg(null);
    try {
      await api.updateRepo(r.name, { ...v, protected_branches: v.protected_branches.split(",").map((s) => s.trim()).filter(Boolean) });
      setMsg({ ok: true, text: "Saved" }); onSaved();
    } catch (e: any) { setMsg({ ok: false, text: e.message }); }
    setSaving(false);
  };
  const toggleRole = (id: string) => setV({ ...v, allowed_roles: v.allowed_roles.includes(id) ? v.allowed_roles.filter((x) => x !== id) : [...v.allowed_roles, id] });
  const id = (k: string) => `rs-${r.id}-${k}`;
  return (
    <div className="repo-settings" id={`repo-settings-${r.id}`} ref={box}>
      <div className="field"><label htmlFor={id("d")}>Description</label><input id={id("d")} className="text" value={v.description} maxLength={300} onChange={(e) => setV({ ...v, description: e.target.value })} placeholder="One line; the map run fills it in" /></div>
      <div className="repo-settings-row">
        <div className="field"><label htmlFor={id("b")}>Default branch</label><input id={id("b")} className="text" value={v.default_branch} onChange={(e) => setV({ ...v, default_branch: e.target.value })} /></div>
        <div className="field"><label htmlFor={id("p")}>Protected branches</label><input id={id("p")} className="text" value={v.protected_branches} onChange={(e) => setV({ ...v, protected_branches: e.target.value })} placeholder="main, release" /></div>
      </div>
      <div className="field"><label htmlFor={id("t")}>Test command</label><input id={id("t")} className="text mono" value={v.test_command} maxLength={300} onChange={(e) => setV({ ...v, test_command: e.target.value })} placeholder="npm test" /></div>
      <div className="field">
        <span style={{ fontWeight: 500 }}>Agents that may use it</span>
        <div className="choices">
          {roles.map((a) => <button key={a.id} className="pill" aria-pressed={v.allowed_roles.includes(a.id)} onClick={() => toggleRole(a.id)}>{a.name}</button>)}
        </div>
        <span className="hint">{v.allowed_roles.length ? "Only these agents see it and get worktrees." : "None picked: every agent may use it."}</span>
      </div>
      <Toggle label="Agents may push and merge to protected branches" hint="Off: pushes to them and merges of PRs into them are refused; agents open PRs for you." value={v.agents_may_merge} onChange={(x) => setV({ ...v, agents_may_merge: x })} />
      {!v.agents_may_merge && <Toggle label="The work's lead merges routine PRs" hint="On: the lead (e.g. tech-lead) merges minor/medium, non-breaking PRs into protected branches once CI is green. Epics, failing or running checks and drafts are refused; those stay yours." value={v.lead_may_merge} onChange={(x) => setV({ ...v, lead_may_merge: x })} />}
      <Toggle label="Agents may deploy" hint="Off: deploy workflows (gh workflow run deploy…, release, rollout) are refused." value={v.agents_may_deploy} onChange={(x) => setV({ ...v, agents_may_deploy: x })} />
      <Toggle label="Propose the map to the repo as a PR" hint="Off: the map stays in agentbox's store; nothing is added to the repo." value={v.propose_map_pr} onChange={(x) => setV({ ...v, propose_map_pr: x })} />
      <div className="repo-settings-actions">
        <button className="btn sm primary" disabled={saving} onClick={save}>{saving ? "Saving…" : "Save"}</button>
        {msg && <span className={msg.ok ? "hint" : "error-text"} role="status">{msg.text}</span>}
        <span className="grow" />
        <button className="btn sm ghost danger" disabled={busy} onClick={onArchive} title="Moves the clone to the archive; the map stays">{busy ? "Archiving…" : "Archive repo"}</button>
      </div>
    </div>
  );
}

function Toggle({ label, hint, value, onChange }: { label: string; hint: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="toggle-row">
      <span className="switch"><input type="checkbox" checked={value} onChange={(e) => onChange(e.target.checked)} /><span /></span>
      <span><span>{label}</span><span className="hint" style={{ display: "block" }}>{hint}</span></span>
    </label>
  );
}

function ArchivedRepo({ repo: r, onChange }: { repo: Repo; onChange: () => void }) {
  const [sure, setSure] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const kept = r.worktrees.filter((w) => w.status === "kept");
  return (
    <article className="card repo-card st-archived">
      <div className="repo-top">
        <div className="repo-title"><strong>{r.name}</strong><span className="repo-state st-archived">Archived {r.archived_at ? relTime(r.archived_at) : ""}</span></div>
        <div className="repo-actions">
          {sure ? (
            <>
              <button className="btn sm danger" onClick={() => api.purgeRepo(r.name).then(onChange).catch((e) => setError(e.message))}>Delete for good</button>
              <button className="btn sm ghost" onClick={() => setSure(false)}>Cancel</button>
            </>
          ) : <button className="btn sm ghost danger" onClick={() => setSure(true)}>Purge…</button>}
        </div>
      </div>
      <div className="sub">{r.archive_path ?? "no clone"} · map kept{kept.length ? ` · ${kept.length} worktree(s) with unpushed work` : ""}</div>
      {kept.length > 0 && <ul className="repo-worktrees">{kept.map((w) => <WorktreeRow key={w.id} w={w} onChange={onChange} />)}</ul>}
      {sure && <p className="hint">Purging deletes the archived clone, its worktrees (unpushed work included) and its map.</p>}
      {error && <div className="error-box">{error}</div>}
    </article>
  );
}

function MapRoutine({ routines, missing, onChange }: { routines: MapRoutineInfo[]; missing: string[]; onChange: () => void }) {
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="map-routine">
      <div>
        <strong>Keep maps fresh</strong>
        <p className="hint">A weekly routine per mapper re-checks the maps of the repos it maps against new commits and updates what drifted.</p>
      </div>
      <div className="map-routines">
        {routines.map((r) => (
          <a key={r.id} className="btn sm" href={`#/routines/${r.id}`}>{r.agent}: {r.enabled ? "on" : "paused · open to enable"}</a>
        ))}
        {missing.length > 0 && (
          <button className="btn sm" onClick={() => api.mapRoutine().then(onChange).catch((e) => setError(e.message))}>
            Add weekly refresh for {missing.join(", ")} (paused)
          </button>
        )}
      </div>
      {error && <div className="error-box">{error}</div>}
    </div>
  );
}

// --- adding ------------------------------------------------------------------------------------------

function AddRepo({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const [tab, setTab] = useState<"account" | "url">("account");
  return (
    <section className="card add-repo" aria-label="Add a repo">
      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={tab === "account"} onClick={() => setTab("account")}>From your accounts</button>
        <button role="tab" aria-selected={tab === "url"} onClick={() => setTab("url")}>By URL</button>
        <span className="grow" />
        <button className="icon-btn" aria-label="Close" onClick={onCancel}><Icon name="close" /></button>
      </div>
      {tab === "account" ? <FromAccount onDone={onDone} /> : <ByUrl onDone={onDone} />}
    </section>
  );
}

/** The add forms' "Who maps it?" (a mapper outside the chosen agents is dropped). */
function MapperField({ value, allowed, onChange }: { value: string | null; allowed: string[]; onChange: (id: string | null) => void }) {
  useEffect(() => { if (value && allowed.length && !allowed.includes(value)) onChange(null); }, [allowed.join(",")]);
  return (
    <label className="field">
      <span style={{ fontWeight: 500 }}>Who maps it?</span>
      <MapperPicker value={value} allowed={allowed} onChange={onChange} />
      <span className="hint">The map (architecture and features) is written by this agent and kept fresh by it. Different repos suit different crews.</span>
    </label>
  );
}

function RolesPicker({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const { agents } = useStore();
  const roles = agents.filter((a) => !a.base_agent_id && !a.builtin);
  if (!roles.length) return null;
  return (
    <div className="field">
      <span style={{ fontWeight: 500 }}>Agents that may use it <span className="hint">(none picked: every agent)</span></span>
      <div className="choices">
        {roles.map((a) => <button key={a.id} className="pill" aria-pressed={value.includes(a.id)} onClick={() => onChange(value.includes(a.id) ? value.filter((x) => x !== a.id) : [...value, a.id])}>{a.name}</button>)}
      </div>
    </div>
  );
}

function FromAccount({ onDone }: { onDone: () => void }) {
  const [data, setData] = useState<Awaited<ReturnType<typeof api.availableRepos>> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState<AccountRepo | null>(null);
  const [roles, setRoles] = useState<string[]>([]);
  const [mapper, setMapper] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = (refresh = false) => { setError(null); api.availableRepos(refresh).then(setData).catch((e) => setError(e.message)); };
  useEffect(() => load(), []);
  const shown = useMemo(() => {
    const k = q.trim().toLowerCase();
    return (data?.repos ?? []).filter((r) => !k || r.full_name.toLowerCase().includes(k) || r.description.toLowerCase().includes(k)).slice(0, 100);
  }, [data, q]);
  const add = async () => {
    if (!picked) return;
    setBusy(true); setError(null);
    try { await api.addRepo({ url: picked.url, default_branch: picked.default_branch ?? undefined, allowed_roles: roles, description: picked.description, mapper_role_id: mapper }); onDone(); } catch (e: any) { setError(e.message); setBusy(false); }
  };
  if (data && data.accounts.length === 0) {
    return <div className="add-repo-body"><p className="hint">No code-hosting account is connected. Connect GitHub, GitLab or Bitbucket on the <a href="#/integrations">Integrations</a> page, or add a repo by its URL.</p></div>;
  }
  return (
    <div className="add-repo-body">
      <div className="add-repo-search">
        <input className="text" type="search" placeholder="Search your repos" aria-label="Search your repos" value={q} onChange={(e) => setQ(e.target.value)} />
        <button className="btn sm ghost" onClick={() => load(true)} title="Ask the providers again"><Icon name="refresh" size={14} />Refresh</button>
      </div>
      {data?.accounts.filter((a) => !a.ok).map((a) => <div key={a.provider} className="hint">{a.provider}: {a.error}</div>)}
      {error && <div className="error-box">{error}</div>}
      {!data && !error && <p className="hint">Asking your connected accounts…</p>}
      <ul className="account-repos" role="listbox" aria-label="Repos">
        {shown.map((r) => (
          <li key={`${r.provider}:${r.full_name}`}>
            <button role="option" aria-selected={picked?.url === r.url} disabled={!!r.added} onClick={() => setPicked(r)} className="account-repo">
              <span className="ar-name">{r.full_name}{r.private && <span className="tag">private</span>}{r.archived && <span className="tag">archived</span>}</span>
              <span className="hint ar-desc">{r.added ? `added as ${r.added}` : r.description || r.provider}</span>
            </button>
          </li>
        ))}
        {data && shown.length === 0 && <li className="hint">No matches.</li>}
      </ul>
      {picked && (
        <div className="add-repo-confirm">
          <p><strong>{picked.full_name}</strong> <span className="hint">· {picked.default_branch ?? "default branch from the remote"}</span></p>
          <RolesPicker value={roles} onChange={setRoles} />
          <MapperField value={mapper} allowed={roles} onChange={setMapper} />
          <button className="btn primary" disabled={busy} onClick={add}>{busy ? "Adding…" : `Add and clone ${picked.full_name}`}</button>
          <p className="hint">It's cloned, then {mapper ? "that agent maps it" : "the helper picks who maps it and they map it"} for the team.</p>
        </div>
      )}
    </div>
  );
}

function ByUrl({ onDone }: { onDone: () => void }) {
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const [roles, setRoles] = useState<string[]>([]);
  const [mapper, setMapper] = useState<string | null>(null);
  const [check, setCheck] = useState<Awaited<ReturnType<typeof api.checkRepo>> | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const doCheck = async () => {
    setBusy("check"); setError(null); setCheck(null);
    try { const c = await api.checkRepo(url.trim()); setCheck(c); if (!name) setName(c.name); } catch (e: any) { setError(e.message); }
    setBusy(null);
  };
  const add = async () => {
    setBusy("add"); setError(null);
    try { await api.addRepo({ url: url.trim(), name: name.trim() || undefined, default_branch: check?.default_branch ?? undefined, allowed_roles: roles, mapper_role_id: mapper }); onDone(); } catch (e: any) { setError(e.message); setBusy(null); }
  };
  // No access: a setup request (the same path agents use), started at once since the owner asked.
  const getAccess = async () => {
    setBusy("setup"); setError(null);
    try {
      const r = await api.raiseSetupRequest({
        title: `Access to ${url.trim()}`.slice(0, 120),
        why: `I want to add this repo to agentbox, but it can't read it (${check?.error ?? "access denied"}).`,
        for_setup_agent: `agentbox can't read the repository ${url.trim()} (git ls-remote failed: ${check?.error ?? "access denied"}).\nGive the agent user read access: prefer the provider account that's already connected; otherwise a read-only deploy key the owner adds on the repo's settings page. When \`git ls-remote ${url.trim()}\` works, I'll add the repo.`,
        repo_url: url.trim(),
      });
      const s = await api.startSetupRequest(r.id);
      go({ name: "setup", id: s.instance_id });
    } catch (e: any) { setError(e.message); setBusy(null); }
  };
  return (
    <div className="add-repo-body">
      <div className="field">
        <label htmlFor="ar-url">Repository URL</label>
        <div className="add-repo-search">
          <input id="ar-url" className="text mono" value={url} placeholder="https://github.com/acme/web-app.git or git@github.com:acme/web-app.git"
            onChange={(e) => { setUrl(e.target.value); setCheck(null); }} onKeyDown={(e) => { if (e.key === "Enter" && url.trim()) doCheck(); }} />
          <button className="btn sm" disabled={!url.trim() || !!busy} onClick={doCheck}>{busy === "check" ? "Checking…" : "Check access"}</button>
        </div>
        <span className="hint">https, ssh or git@ only, without a user or token in it: agentbox uses the connected account or your ssh key.</span>
      </div>
      {error && <div className="error-box">{error}</div>}
      {check && !check.ok && (
        <div className="error-box">
          agentbox can't read it: {check.error}
          <div style={{ marginTop: 8, display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button className="btn sm primary" disabled={!!busy} onClick={getAccess}>{busy === "setup" ? "Opening…" : "Open setup to get access"}</button>
            <span className="hint">The helper plans it with you (an account login or a deploy key).</span>
          </div>
        </div>
      )}
      {check?.ok && (
        <div className="add-repo-confirm">
          <p className="ok-text"><Icon name="check" size={14} /> Readable · default branch <code>{check.default_branch ?? "?"}</code> · {check.provider}</p>
          <div className="field">
            <label htmlFor="ar-name">Name</label>
            <input id="ar-name" className="text" value={name} maxLength={40} onChange={(e) => setName(e.target.value.toLowerCase())} />
            {check.taken && name === check.name && <span className="hint">That name is taken; pick another.</span>}
          </div>
          <RolesPicker value={roles} onChange={setRoles} />
          <MapperField value={mapper} allowed={roles} onChange={setMapper} />
          <button className="btn primary" disabled={!!busy} onClick={add}>{busy === "add" ? "Adding…" : "Add and clone"}</button>
        </div>
      )}
    </div>
  );
}
