import { useState } from "react";
import { roleLimits, type RoutineRules } from "../api.ts";
import { useStore } from "../store.tsx";
import { Icon } from "../components/ui.tsx";

export const EMPTY_RULES: RoutineRules = {
  everyone: "", roles: {}, perms: { merge_main: null, deploy: null, issues: null, teams: null, max_helpers: null },
};

type Perms = RoutineRules["perms"];

/** One line of what the switches allow, e.g. "merge to main: safe PRs only · deploy: staging". */
export function rulesSummary(r: RoutineRules) {
  const p = r.perms;
  const out: string[] = [];
  if (p.merge_main) out.push(`merge to main: ${p.merge_main === "safe" ? "safe PRs only" : p.merge_main}`);
  if (p.deploy) out.push(`deploy: ${p.deploy}`);
  if (p.issues !== null) out.push(`GitHub issues: ${p.issues ? "yes" : "no"}`);
  if (p.teams !== null) out.push(`Teams posts: ${p.teams ? "yes" : "no"}`);
  if (p.max_helpers !== null) out.push(`helpers: ${p.max_helpers}`);
  const texts = (r.everyone ? 1 : 0) + Object.keys(r.roles).length;
  if (texts) out.push(`${texts} instruction${texts === 1 ? "" : "s"}`);
  return out;
}

const JOB = "As in job description";

/**
 * The owner's standing orders for a routine's whole group: switches for what matters most
 * (enforced before a command runs) and instructions for everyone or per role.
 */
export function RoutineRulesEditor({ rules, routineRoleId, onChange }: {
  rules: RoutineRules; routineRoleId: string; onChange: (r: RoutineRules) => void;
}) {
  const { agents } = useStore();
  const summary = rulesSummary(rules);
  const [open, setOpen] = useState(summary.length > 0);
  const roles = agents.filter((a) => !a.base_agent_id && !a.builtin && a.id !== routineRoleId);
  const routineRole = agents.find((a) => a.id === routineRoleId);
  const setPerm = <K extends keyof Perms>(k: K, v: Perms[K]) => onChange({ ...rules, perms: { ...rules.perms, [k]: v } });
  const setRole = (id: string, text: string | null) => {
    const next = { ...rules.roles };
    if (text === null) delete next[id];
    else next[id] = text;
    onChange({ ...rules, roles: next });
  };
  const yesNo = (v: boolean | null) => (v === null ? "" : v ? "yes" : "no");
  const fromYesNo = (v: string) => (v === "" ? null : v === "yes");

  return (
    <div className="field rules">
      <button className="rules-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className={`chev${open ? " open" : ""}`}><Icon name="chevron" size={10} /></span>
        <span style={{ fontWeight: 500 }}>Rules for this routine</span>
        <span className="hint">{summary.length ? summary.join(" · ") : "none: everyone follows their job description"}</span>
      </button>
      {open && (
        <div className="rules-body">
          <p className="hint" style={{ margin: 0 }}>
            These apply to everyone who works in this routine: {routineRole?.name ?? "its agent"}, the tech-lead it brings in, and
            anyone they start. They override job descriptions here (in both directions), never the team-wide rules. Merges into
            main, deploys and new issues are also checked before a command runs.
          </p>

          <div className="rules-grid">
            <label htmlFor="rp-merge">Merge PRs into main</label>
            <select id="rp-merge" className="text" value={rules.perms.merge_main ?? ""}
              onChange={(e) => setPerm("merge_main", (e.target.value || null) as Perms["merge_main"])}>
              <option value="">{JOB}</option>
              <option value="never">Never: leave PRs for me</option>
              <option value="safe">Safe PRs only (small, green, no breaking changes)</option>
              <option value="allowed">Allowed after review</option>
            </select>

            <label htmlFor="rp-deploy">Deploy</label>
            <select id="rp-deploy" className="text" value={rules.perms.deploy ?? ""}
              onChange={(e) => setPerm("deploy", (e.target.value || null) as Perms["deploy"])}>
              <option value="">{JOB}</option>
              <option value="none">Never</option>
              <option value="staging">Staging, without asking</option>
              <option value="production">Staging and production, without asking</option>
            </select>

            <label htmlFor="rp-issues">File GitHub issues</label>
            <select id="rp-issues" className="text" value={yesNo(rules.perms.issues)} onChange={(e) => setPerm("issues", fromYesNo(e.target.value))}>
              <option value="">{JOB}</option>
              <option value="yes">Yes</option>
              <option value="no">No</option>
            </select>

            <label htmlFor="rp-teams">Post in Teams</label>
            <select id="rp-teams" className="text" value={yesNo(rules.perms.teams)} onChange={(e) => setPerm("teams", fromYesNo(e.target.value))}>
              <option value="">{JOB}</option>
              <option value="yes">Yes</option>
              <option value="no">No</option>
            </select>

            <label htmlFor="rp-helpers">Helpers at once</label>
            <select id="rp-helpers" className="text" value={rules.perms.max_helpers ?? ""}
              onChange={(e) => setPerm("max_helpers", e.target.value === "" ? null : Number(e.target.value))}>
              <option value="">{JOB} (up to {roleLimits.per_role} each)</option>
              {[0, 1, 2, 3, 5, 8].map((n) => <option key={n} value={n}>{n === 0 ? "None: do it yourselves" : n}</option>)}
            </select>
          </div>
          {rules.perms.deploy === "production" && (
            <p className="warn-note" role="note">Production deploys will happen unattended, often at night. Make sure that's what you want.</p>
          )}

          <div className="field">
            <label htmlFor="rr-everyone">For everyone</label>
            <textarea id="rr-everyone" className="text" rows={3} value={rules.everyone}
              placeholder="e.g. Only handle Critical and High alerts in acme/web-app. One PR per package."
              onChange={(e) => onChange({ ...rules, everyone: e.target.value })} />
          </div>

          {Object.entries(rules.roles).map(([id, text]) => {
            const role = agents.find((a) => a.id === id);
            return (
              <div className="field" key={id}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <label htmlFor={`rr-${id}`}>For {role?.name ?? "a deleted agent"}{role ? <span className="hint"> (when it joins)</span> : null}</label>
                  <button className="btn ghost sm" onClick={() => setRole(id, null)}>Remove</button>
                </div>
                <textarea id={`rr-${id}`} className="text" rows={3} value={text}
                  placeholder={role?.can_scale ? "e.g. Merge only patch and minor bumps; anything else, leave the PR for me with a summary." : "e.g. Deploy merged fixes to staging, check health, post in Infra."}
                  onChange={(e) => setRole(id, e.target.value)} />
              </div>
            );
          })}
          {roles.some((r) => !(r.id in rules.roles)) && (
            <select className="text" value="" aria-label="Add instructions for an agent" style={{ alignSelf: "flex-start", width: "auto" }}
              onChange={(e) => e.target.value && setRole(e.target.value, "")}>
              <option value="">+ Instructions for…</option>
              {roles.filter((r) => !(r.id in rules.roles)).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
          )}
          <span className="hint">{routineRole?.name ?? "The routine's agent"}'s own job each run is in the box above.</span>
        </div>
      )}
    </div>
  );
}
