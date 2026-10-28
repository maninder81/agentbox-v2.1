import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { all, get, newId, now, run } from "./db.ts";
import { publish, subscribe } from "./bus.ts";
import { paths } from "./config.ts";
import { dmThreadOf, getAgent, listAgents, slugify, spawnInstance, type Agent } from "./agents.ts";
import { redactSecrets } from "./redact.ts";
import { crewIdOf, crewName, getCrew } from "./crews.ts";
import { setupRole } from "./setup.ts";

/**
 * Repos (docs/V2-ARCHITECTURE.md, Changes (repos); docs/TRUSTED-AUTONOMY.md §6–7): the owner adds
 * repos, agentbox keeps one canonical partial clone of each at <paths.work>/repos/<name> (never
 * edited; a periodic `git fetch --prune` keeps it current), and every task bound to a repo works in
 * its own git worktree at <paths.work>/worktrees/<repo>/<task-short-id> on a branch
 * `agentbox/<task-short-id>-<slug>`. Worktrees are created by the runner before a turn (or by
 * `use_repo`), reused by rework and revived instances, and cleaned up when the task closes: removed
 * when nothing is uncommitted or unpushed, otherwise kept and flagged for the owner.
 *
 * Every name is a sanitized slug and every path is resolved and confined under its root. Git runs with
 * GIT_TERMINAL_PROMPT=0, a timeout and its own process group; URLs never carry credentials (those come
 * from gh / glab credential helpers or ssh keys) and output is redacted before anyone sees it.
 */

// --- schema -------------------------------------------------------------------------------------

run(`CREATE TABLE IF NOT EXISTS repos (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  url TEXT NOT NULL,
  provider TEXT NOT NULL,              -- github | gitlab | bitbucket | other
  default_branch TEXT,
  description TEXT NOT NULL DEFAULT '',
  test_command TEXT NOT NULL DEFAULT '',
  protected_branches TEXT NOT NULL DEFAULT '[]',
  allowed_roles TEXT NOT NULL DEFAULT '[]', -- role ids; empty = every role
  agents_may_merge INTEGER NOT NULL DEFAULT 0,
  agents_may_deploy INTEGER NOT NULL DEFAULT 0,
  propose_map_pr INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,                -- cloning | ready | error | archived
  last_fetch_at TEXT,
  error TEXT,
  map_status TEXT NOT NULL DEFAULT 'none', -- none | running | ready | error
  map_updated_at TEXT,
  map_task_id TEXT,                    -- the onboarding instance
  map_error TEXT,
  archive_path TEXT,
  archived_at TEXT,
  created_at TEXT NOT NULL
)`);
run(`CREATE TABLE IF NOT EXISTS repo_worktrees (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  instance_id TEXT NOT NULL,           -- the task (instance); no FK: the row outlives a deleted role
  purpose TEXT NOT NULL DEFAULT 'task', -- task | onboard
  path TEXT,
  branch TEXT,
  status TEXT NOT NULL,                -- pending | active | kept | removed | discarded | error
  note TEXT,
  created_at TEXT NOT NULL,
  closed_at TEXT,
  UNIQUE (repo_id, instance_id)
)`);
run(`CREATE INDEX IF NOT EXISTS repo_worktrees_instance ON repo_worktrees(instance_id)`);
// The work's lead (an orchestrator role) may merge PRs into protected branches when CI is green (not epics):
// on by default, so routine, non-breaking fixes don't wait for the owner.
if (!all<{ name: string }>(`PRAGMA table_info(repos)`).some((c) => c.name === "lead_may_merge")) run(`ALTER TABLE repos ADD COLUMN lead_may_merge INTEGER NOT NULL DEFAULT 1`);
// Who maps the repo (an agent, usually a crew's lead; the owner picks, or the helper does when asked) and why.
for (const [col, type] of [["mapper_role_id", "TEXT"], ["mapper_note", "TEXT"]] as const) {
  if (!all<{ name: string }>(`PRAGMA table_info(repos)`).some((c) => c.name === col)) run(`ALTER TABLE repos ADD COLUMN ${col} ${type}`);
}
// Repos mapped before the setting existed: whoever mapped them last keeps doing it.
run(`UPDATE repos SET mapper_role_id = (SELECT base_agent_id FROM agents WHERE agents.id = repos.map_task_id), mapper_note = 'Mapped it before'
     WHERE mapper_role_id IS NULL AND map_task_id IS NOT NULL
       AND (SELECT base_agent_id FROM agents WHERE agents.id = repos.map_task_id) IN (SELECT id FROM agents WHERE base_agent_id IS NULL AND builtin IS NULL)`);

export type Provider = "github" | "gitlab" | "bitbucket" | "other";
export type RepoStatus = "cloning" | "ready" | "error" | "archived";
export type Repo = {
  id: string; name: string; url: string; provider: Provider; default_branch: string | null;
  description: string; test_command: string; protected_branches: string[]; allowed_roles: string[];
  agents_may_merge: boolean; agents_may_deploy: boolean; propose_map_pr: boolean; lead_may_merge: boolean;
  status: RepoStatus; last_fetch_at: string | null; error: string | null;
  /** choosing: the helper is picking who maps it (map_task_id is the helper's task). */
  map_status: "none" | "choosing" | "running" | "ready" | "error"; map_updated_at: string | null; map_task_id: string | null; map_error: string | null;
  archive_path: string | null; archived_at: string | null; created_at: string;
  /** The agent (role) that maps it; null: the helper picks one when it's first mapped. */
  mapper_role_id: string | null; mapper_note: string | null;
};
export type WorktreeStatus = "pending" | "active" | "kept" | "removed" | "discarded" | "error";
export type Worktree = {
  id: string; repo_id: string; instance_id: string; purpose: "task" | "onboard"; path: string | null; branch: string | null;
  status: WorktreeStatus; note: string | null; created_at: string; closed_at: string | null;
};

const parseList = (s: unknown): string[] => { try { const v = JSON.parse(String(s ?? "[]")); return Array.isArray(v) ? v.map(String) : []; } catch { return []; } };
const toRepo = (r: any): Repo => ({
  ...r, protected_branches: parseList(r.protected_branches), allowed_roles: parseList(r.allowed_roles),
  agents_may_merge: !!r.agents_may_merge, agents_may_deploy: !!r.agents_may_deploy, propose_map_pr: !!r.propose_map_pr,
  lead_may_merge: r.lead_may_merge === undefined ? true : !!r.lead_may_merge,
});

export const listRepos = (opts: { archived?: boolean } = {}) =>
  all(`SELECT * FROM repos ${opts.archived === false ? "WHERE status != 'archived'" : ""} ORDER BY name`).map(toRepo);
export const getRepo = (name: string) => { const r = get(`SELECT * FROM repos WHERE name = ?`, name); return r ? toRepo(r) : undefined; };
export const getRepoById = (id: string) => { const r = get(`SELECT * FROM repos WHERE id = ?`, id); return r ? toRepo(r) : undefined; };
export const worktreesOf = (repoId: string) => all<Worktree>(`SELECT * FROM repo_worktrees WHERE repo_id = ? ORDER BY created_at`, repoId);
export const worktreesFor = (instanceId: string) => all<Worktree>(`SELECT * FROM repo_worktrees WHERE instance_id = ? ORDER BY created_at`, instanceId);
export const getWorktree = (id: string) => get<Worktree>(`SELECT * FROM repo_worktrees WHERE id = ?`, id);

/** Bumped on every change: the Repos layer is cached per role against it. */
let version = 0;
function changed(repoId: string | null) {
  version++;
  publish({ type: "repo.updated", repoId });
}

// --- names and paths ----------------------------------------------------------------------------

export const NAME_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const BRANCH_RE = /^(?!-)(?!.*\.\.)(?!.*\/\/)(?!.*@\{)[A-Za-z0-9._\/-]{1,200}(?<![./])$/;

/** Route words under /api/repos/… that can't be repo names. */
const RESERVED = new Set(["available", "check", "fetch-all", "sweep", "map-routine", "worktrees"]);

export function checkName(name: string): string {
  if (typeof name !== "string" || !NAME_RE.test(name)) throw new Error("A repo name is 1–40 characters: lowercase letters, digits and dashes");
  if (RESERVED.has(name)) throw new Error(`"${name}" is reserved; pick another name`);
  return name;
}
export function checkBranch(b: string): string {
  if (typeof b !== "string" || !BRANCH_RE.test(b) || b.endsWith(".lock")) throw new Error(`"${b}" isn't a valid branch name`);
  return b;
}

export const reposRoot = () => path.resolve(paths.work, "repos");
export const worktreesRoot = () => path.resolve(paths.work, "worktrees");
export const mapsRoot = () => path.resolve(paths.data, "repos");

/** `root/<parts…>`, resolved, refused if it leaves `root` (no traversal). */
export function inside(root: string, ...parts: string[]): string {
  const base = path.resolve(root);
  const p = path.resolve(base, ...parts);
  if (p === base || !p.startsWith(base + path.sep)) throw new Error("That path leaves agentbox's repo folders");
  return p;
}
export const clonePath = (name: string) => inside(reposRoot(), checkName(name));
export const mapDir = (name: string) => inside(mapsRoot(), checkName(name), "map");
/**
 * The onboarding map is deliberately high level: how the system is built and what it does. Lower-level
 * knowledge (commands, gotchas, how a feature really works) comes from the agents' repo memory, written
 * as they work (memory.ts), so onboarding reads the repo but never installs, builds or runs tests.
 */
export const MAP_FILES = ["ARCHITECTURE.md", "FEATURE-MAP.md"];

// --- URLs ---------------------------------------------------------------------------------------

export type ParsedUrl = { url: string; provider: Provider; host: string; repoPath: string; name: string };
const HOST_RE = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;
const SEG_RE = /^[A-Za-z0-9._~-]+$/;

export function providerOf(host: string): Provider {
  const h = host.toLowerCase();
  if (h === "github.com" || h === "ssh.github.com") return "github";
  if (h === "gitlab.com" || h.startsWith("gitlab.")) return "gitlab";
  if (h === "bitbucket.org") return "bitbucket";
  return "other";
}

/**
 * A repo URL: https://host/owner/repo(.git), ssh://[git@]host[:port]/owner/repo(.git) or
 * git@host:owner/repo(.git). Refused: credentials (user:token@ or any userinfo in https), file://,
 * ext:: and every other transport, options (a leading "-"), spaces and control characters, ".." paths.
 */
export function parseRepoUrl(input: string): ParsedUrl {
  const u = String(input ?? "").trim().replace(/\/+$/, "");
  if (!u) throw new Error("Give the repository's URL");
  if (u.length > 300) throw new Error("That URL is too long");
  if (/[\s\x00-\x1f\x7f\\]/.test(u)) throw new Error("A repo URL has no spaces, backslashes or control characters");
  if (u.startsWith("-")) throw new Error("That isn't a URL");
  if (/^(file|ext|fd|http|git|ftp|ftps|rsync):/i.test(u) || /::/.test(u)) {
    throw new Error("Only https://, ssh:// and git@host:owner/repo URLs are accepted (no file://, ext:: or other transports)");
  }
  let host: string, repoPath: string, m: RegExpMatchArray | null;
  if ((m = u.match(/^https:\/\/([^/?#]+)\/([^?#]+)$/i))) {
    if (m[1].includes("@")) throw new Error("Leave credentials out of the URL (no user:token@). agentbox uses the provider's login (gh, glab) or your ssh key.");
    host = m[1].toLowerCase();
    if (/:\d+$/.test(host)) host = host.replace(/:(\d+)$/, (_x, p) => { if (Number(p) < 1 || Number(p) > 65535) throw new Error("Bad port"); return `:${p}`; });
    repoPath = m[2];
  } else if ((m = u.match(/^ssh:\/\/(?:([^@/]*)@)?([^/:?#]+)(?::(\d{1,5}))?\/([^?#]+)$/i))) {
    if (m[1] !== undefined && m[1] !== "git") throw new Error("ssh:// URLs may only name the git user (ssh://git@host/…); no other user or password");
    host = m[2].toLowerCase();
    repoPath = m[4];
  } else if ((m = u.match(/^([^@:/]+)@([^:/]+):([^?#]+)$/))) {
    if (m[1] !== "git") throw new Error("Use the git@host:owner/repo form (the git user only)");
    host = m[2].toLowerCase();
    repoPath = m[3];
  } else {
    throw new Error("Use an https://host/owner/repo, ssh://git@host/owner/repo or git@host:owner/repo URL");
  }
  if (!HOST_RE.test(host.replace(/:\d+$/, ""))) throw new Error(`"${host}" isn't a host name`);
  const segs = repoPath.replace(/^\/+/, "").split("/");
  if (!segs.length || segs.some((s) => !SEG_RE.test(s) || s === "." || s === "..")) throw new Error("The repo path may only have letters, digits and . _ ~ - between slashes");
  const last = segs[segs.length - 1].replace(/\.git$/i, "");
  const name = slugify(last).slice(0, 40) || "repo";
  return { url: u, provider: providerOf(host.replace(/:\d+$/, "")), host: host.replace(/:\d+$/, ""), repoPath: segs.join("/").replace(/\.git$/i, ""), name };
}

/** "host/owner/repo" for comparing a remote URL to a registered repo (lowercase, no .git). */
export function urlKey(url: string): string | null {
  try { const p = parseRepoUrl(url); return `${p.host}/${p.repoPath}`.toLowerCase(); } catch { return null; }
}

// --- git ------------------------------------------------------------------------------------------

export type GitResult = { code: number | null; stdout: string; stderr: string; timedOut: boolean };
export const TIMEOUTS = { lsRemote: 45_000, clone: 30 * 60_000, fetch: 10 * 60_000, worktree: 5 * 60_000, quick: 30_000 };

/** No credentials in anything we show or store: userinfo stripped, known secrets redacted. */
export function clean(text: string): string {
  return redactSecrets(String(text ?? "")).replace(/\b(https?:\/\/)[^\s/@]+@/gi, "$1");
}

function gitEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never", GIT_ASKPASS: process.env.GIT_ASKPASS ?? "",
    SSH_ASKPASS: "", GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? "ssh -o BatchMode=yes -o ConnectTimeout=20",
    LC_ALL: "C",
  };
}

/** Run git with a timeout (the whole process group is killed), never prompting. */
export function git(args: string[], opts: { cwd?: string; timeoutMs?: number; onLine?: (line: string) => void } = {}): Promise<GitResult> {
  return new Promise((resolve) => {
    let stdout = "", stderr = "", timedOut = false, buf = "";
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn("git", args, { cwd: opts.cwd, env: gitEnv(), stdio: ["ignore", "pipe", "pipe"], detached: true });
    } catch (e: any) {
      return resolve({ code: null, stdout: "", stderr: String(e?.message ?? e), timedOut: false });
    }
    const kill = () => { try { process.kill(-child.pid!, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch { /* gone */ } } };
    const timer = setTimeout(() => { timedOut = true; kill(); }, opts.timeoutMs ?? TIMEOUTS.quick);
    child.stdout!.on("data", (b: Buffer) => { stdout += b; if (stdout.length > 4_000_000) stdout = stdout.slice(-2_000_000); });
    child.stderr!.on("data", (b: Buffer) => {
      const t = b.toString("utf8");
      stderr += t;
      if (stderr.length > 200_000) stderr = stderr.slice(-100_000);
      if (!opts.onLine) return;
      buf += t;
      const parts = buf.split(/\r\n|\r|\n/);
      buf = parts.pop() ?? "";
      for (const l of parts) if (l.trim()) opts.onLine(clean(l));
    });
    const done = (code: number | null, err?: string) => {
      clearTimeout(timer);
      if (err) stderr += err;
      if (opts.onLine && buf.trim()) opts.onLine(clean(buf));
      resolve({ code, stdout, stderr, timedOut });
    };
    child.on("error", (e) => done(null, String(e.message)));
    child.on("close", (code) => done(code));
  });
}

const gitError = (r: GitResult, what: string) =>
  new Error(r.timedOut ? `${what} timed out` : `${what} failed: ${clean(r.stderr.trim() || r.stdout.trim()).split("\n").filter(Boolean).slice(-3).join(" ") || `exit ${r.code}`}`);

/** One git operation at a time per canonical clone (fetches, worktree add/remove share its refs). */
const locks = new Map<string, Promise<unknown>>();
function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  locks.set(key, next.catch(() => {}));
  return next;
}

/** Can we read it? `git ls-remote --symref <url> HEAD`, and the default branch it names. */
export async function checkAccess(url: string): Promise<{ ok: boolean; default_branch: string | null; error: string | null; provider: Provider; name: string }> {
  const p = parseRepoUrl(url);
  const r = await git(["ls-remote", "--symref", "--", p.url, "HEAD"], { timeoutMs: TIMEOUTS.lsRemote });
  if (r.code !== 0) {
    const msg = clean(r.stderr.trim()).split("\n").filter(Boolean).slice(-2).join(" ");
    return { ok: false, default_branch: null, error: r.timedOut ? "Timed out reaching the repo" : msg || `git ls-remote exited ${r.code}`, provider: p.provider, name: p.name };
  }
  const head = r.stdout.match(/^ref:\s+refs\/heads\/(\S+)\s+HEAD/m)?.[1] ?? null;
  return { ok: true, default_branch: head, error: null, provider: p.provider, name: p.name };
}

// --- roles ------------------------------------------------------------------------------------------

/** Roles by id, slug or name (base roles only, never built-in ones). Unknown names throw. */
export function resolveRoles(names: unknown): string[] {
  if (names === undefined || names === null) return [];
  if (!Array.isArray(names)) throw new Error("roles must be a list");
  const roles = listAgents().filter((a) => !a.base_agent_id && !a.builtin);
  const out: string[] = [];
  for (const n of names) {
    const k = String(n).trim().toLowerCase().replace(/^@/, "");
    if (!k) continue;
    const r = roles.find((a) => a.id === n || a.slug === k || a.name.toLowerCase() === k);
    if (!r) throw new Error(`No agent called "${n}". Agents: ${roles.map((x) => x.name).join(", ") || "none"}`);
    if (!out.includes(r.id)) out.push(r.id);
  }
  return out;
}

const roleOf = (a: Agent) => a.base_agent_id ?? a.id;
/** allowed_roles empty = every role. Built-in roles (the setup agent) never work in repos. */
export function roleAllowed(repo: Repo, agent: Agent): boolean {
  const role = getAgent(roleOf(agent));
  if (!role || role.builtin) return false;
  return repo.allowed_roles.length === 0 || repo.allowed_roles.includes(role.id);
}

// --- adding, cloning, fetching ------------------------------------------------------------------------

export type CloneJob = { repo_id: string; running: boolean; started_at: string; ended_at: string | null; last_output_at: string; ok: boolean | null; lines: { line: string; at: string }[] };
const jobs = new Map<string, CloneJob>();
export const jobOf = (repoId: string) => jobs.get(repoId) ?? null;

export type AddRepoInput = {
  url: string; name?: string; default_branch?: string; description?: string; test_command?: string;
  allowed_roles?: unknown; protected_branches?: unknown; agents_may_merge?: boolean; agents_may_deploy?: boolean;
  /** Start the onboarding (map) run once cloned (default true). */
  onboard?: boolean;
  /** Who maps it (an agent); left out, the helper picks a crew lead when it's mapped. */
  mapper_role_id?: string | null;
};

/** Register a repo and start cloning it (in the background; `repo.updated` / `repo.progress` events). */
export function addRepo(input: AddRepoInput, hooks: { onboard?: (name: string) => unknown } = {}): Repo {
  const p = parseRepoUrl(input.url);
  const name = checkName(input.name ? slugify(String(input.name)).slice(0, 40) : p.name);
  const existing = getRepo(name);
  if (existing) {
    throw new Error(existing.status === "archived"
      ? `A repo called "${name}" is archived. Purge it on the Repos page first, or pick another name.`
      : `A repo called "${name}" already exists. Pick another name.`);
  }
  const key = urlKey(p.url);
  const dup = listRepos({ archived: false }).find((r) => urlKey(r.url) === key);
  if (dup) throw new Error(`That repository is already added, as "${dup.name}"`);
  const branch = input.default_branch ? checkBranch(String(input.default_branch).trim()) : null;
  const protectedBranches = Array.isArray(input.protected_branches) ? input.protected_branches.map((b) => checkBranch(String(b).trim())) : null;
  const roles = resolveRoles(input.allowed_roles);
  const mapper = input.mapper_role_id ? checkMapper(String(input.mapper_role_id), roles) : null;
  const repo = {
    id: newId(), name, url: p.url, provider: p.provider, default_branch: branch,
    description: String(input.description ?? "").trim().slice(0, 300), test_command: String(input.test_command ?? "").trim().slice(0, 300),
    protected_branches: JSON.stringify(protectedBranches ?? (branch ? [branch] : [])), allowed_roles: JSON.stringify(roles),
    agents_may_merge: input.agents_may_merge ? 1 : 0, agents_may_deploy: input.agents_may_deploy ? 1 : 0,
    status: "cloning", created_at: now(),
  };
  run(
    `INSERT INTO repos (id, name, url, provider, default_branch, description, test_command, protected_branches, allowed_roles,
                        agents_may_merge, agents_may_deploy, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    repo.id, repo.name, repo.url, repo.provider, repo.default_branch, repo.description, repo.test_command, repo.protected_branches,
    repo.allowed_roles, repo.agents_may_merge, repo.agents_may_deploy, repo.status, repo.created_at,
  );
  if (mapper) run(`UPDATE repos SET mapper_role_id = ?, mapper_note = 'Chosen by the owner' WHERE id = ?`, mapper.id, repo.id);
  changed(repo.id);
  const onboard = input.onboard !== false;
  void cloneRepo(repo.id).then((ok) => {
    if (ok && onboard) {
      try { (hooks.onboard ?? startOnboarding)(name); } catch (e: any) { setMap(repo.id, "error", e.message); }
    }
  });
  return getRepoById(repo.id)!;
}

/** Clone (or re-clone after an error): `git clone --filter=blob:none`. True when ready. */
export async function cloneRepo(repoId: string): Promise<boolean> {
  const repo = getRepoById(repoId);
  if (!repo) return false;
  if (jobs.get(repoId)?.running) throw new Error(`${repo.name} is already cloning`);
  const dest = clonePath(repo.name);
  const at = now();
  const job: CloneJob = { repo_id: repoId, running: true, started_at: at, ended_at: null, last_output_at: at, ok: null, lines: [] };
  jobs.set(repoId, job);
  run(`UPDATE repos SET status = 'cloning', error = NULL WHERE id = ?`, repoId);
  changed(repoId);
  const say = (line: string) => {
    job.last_output_at = now();
    const entry = { line: line.length > 300 ? `${line.slice(0, 300)}…` : line, at: job.last_output_at };
    // Progress lines repeat with new percentages: replace the last one of the same phase.
    const phase = entry.line.replace(/:\s.*$/, "");
    const last = job.lines[job.lines.length - 1];
    if (last && /\d+%/.test(entry.line) && last.line.replace(/:\s.*$/, "") === phase) job.lines[job.lines.length - 1] = entry;
    else job.lines.push(entry);
    if (job.lines.length > 200) job.lines.splice(0, job.lines.length - 200);
    publish({ type: "repo.progress", repoId, line: entry.line });
  };
  try {
    fs.mkdirSync(reposRoot(), { recursive: true });
    if (fs.existsSync(dest)) fs.rmSync(dest, { recursive: true, force: true }); // a half-done earlier clone
    say(`Cloning ${repo.url} (partial clone: files are fetched when a worktree needs them)`);
    const r = await git(["clone", "--progress", "--filter=blob:none", "--no-checkout", "--", repo.url, dest], { timeoutMs: TIMEOUTS.clone, onLine: say });
    if (r.code !== 0) throw gitError(r, "git clone");
    let branch = repo.default_branch;
    if (!branch) {
      const h = await git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], { cwd: dest });
      branch = h.code === 0 ? h.stdout.trim().replace(/^origin\//, "") : null;
    }
    if (!branch) throw new Error("couldn't tell the default branch; set it in the repo's settings and retry");
    const has = await git(["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}`], { cwd: dest });
    if (has.code !== 0) throw new Error(`the remote has no branch "${branch}"`);
    const protectedBranches = repo.protected_branches.length ? repo.protected_branches : [branch];
    run(`UPDATE repos SET status = 'ready', default_branch = ?, protected_branches = ?, last_fetch_at = ?, error = NULL WHERE id = ?`,
      branch, JSON.stringify(protectedBranches), now(), repoId);
    say(`Ready: default branch ${branch}`);
    job.ok = true;
    return true;
  } catch (e: any) {
    const msg = clean(e?.message ?? String(e));
    run(`UPDATE repos SET status = 'error', error = ? WHERE id = ?`, msg, repoId);
    say(`Failed: ${msg}`);
    try { fs.rmSync(dest, { recursive: true, force: true }); } catch { /* best effort */ }
    job.ok = false;
    return false;
  } finally {
    job.running = false;
    job.ended_at = now();
    changed(repoId);
  }
}

/** `git fetch --prune origin` on the canonical clone (never a pull: nothing is checked out there). */
export function fetchRepo(name: string): Promise<Repo> {
  const repo = getRepo(name);
  if (!repo) return Promise.reject(new Error("No such repo"));
  if (repo.status !== "ready" && repo.status !== "error") return Promise.reject(new Error(`${name} is ${repo.status}`));
  if (repo.status === "error" && !fs.existsSync(path.join(clonePath(name), ".git"))) {
    return Promise.reject(new Error(`${name} isn't cloned; retry the clone`));
  }
  return withLock(repo.id, async () => {
    const r = await git(["fetch", "--prune", "--quiet", "origin"], { cwd: clonePath(name), timeoutMs: TIMEOUTS.fetch });
    if (r.code === 0) run(`UPDATE repos SET last_fetch_at = ?, error = NULL, status = 'ready' WHERE id = ?`, now(), repo.id);
    else run(`UPDATE repos SET error = ? WHERE id = ?`, gitError(r, "git fetch").message, repo.id);
    changed(repo.id);
    const next = getRepoById(repo.id)!;
    if (r.code !== 0) throw new Error(next.error ?? "git fetch failed");
    return next;
  });
}

export async function fetchAll() {
  const out: { name: string; ok: boolean; error?: string }[] = [];
  for (const r of listRepos({ archived: false }).filter((x) => x.status === "ready")) {
    try { await fetchRepo(r.name); out.push({ name: r.name, ok: true }); } catch (e: any) { out.push({ name: r.name, ok: false, error: e.message }); }
  }
  return out;
}

// --- settings ---------------------------------------------------------------------------------------

export type RepoPatch = Partial<{
  description: string; test_command: string; default_branch: string; protected_branches: unknown; allowed_roles: unknown;
  agents_may_merge: boolean; agents_may_deploy: boolean; propose_map_pr: boolean; lead_may_merge: boolean;
  /** An agent's id or name; null or "": let the helper pick next time it's mapped. */
  mapper_role_id: string | null;
}>;

export function updateRepo(name: string, patch: RepoPatch): Repo {
  const repo = getRepo(name);
  if (!repo) throw new Error("No such repo");
  if (repo.status === "archived") throw new Error(`${name} is archived`);
  const next = { ...repo };
  if (patch.description !== undefined) next.description = String(patch.description).trim().slice(0, 300);
  if (patch.test_command !== undefined) next.test_command = String(patch.test_command).trim().slice(0, 300);
  if (/[\n\r\x00]/.test(next.test_command)) throw new Error("The test command is one line");
  if (patch.default_branch !== undefined) next.default_branch = checkBranch(String(patch.default_branch).trim());
  if (patch.protected_branches !== undefined) {
    if (!Array.isArray(patch.protected_branches)) throw new Error("protected_branches must be a list");
    next.protected_branches = [...new Set(patch.protected_branches.map((b) => checkBranch(String(b).trim())))];
  }
  if (patch.allowed_roles !== undefined) next.allowed_roles = resolveRoles(patch.allowed_roles);
  for (const k of ["agents_may_merge", "agents_may_deploy", "propose_map_pr", "lead_may_merge"] as const) {
    if (patch[k] !== undefined) next[k] = patch[k] === true;
  }
  if (patch.mapper_role_id !== undefined) {
    const m = patch.mapper_role_id ? checkMapper(String(patch.mapper_role_id), next.allowed_roles) : null;
    if ((m?.id ?? null) !== repo.mapper_role_id) { next.mapper_role_id = m?.id ?? null; next.mapper_note = m ? "Chosen by the owner" : null; }
  }
  run(`UPDATE repos SET mapper_role_id = ?, mapper_note = ? WHERE id = ?`, next.mapper_role_id, next.mapper_note, repo.id);
  run(
    `UPDATE repos SET description = ?, test_command = ?, default_branch = ?, protected_branches = ?, allowed_roles = ?,
       agents_may_merge = ?, agents_may_deploy = ?, propose_map_pr = ?, lead_may_merge = ? WHERE id = ?`,
    next.description, next.test_command, next.default_branch, JSON.stringify(next.protected_branches), JSON.stringify(next.allowed_roles),
    next.agents_may_merge ? 1 : 0, next.agents_may_deploy ? 1 : 0, next.propose_map_pr ? 1 : 0, next.lead_may_merge ? 1 : 0, repo.id,
  );
  changed(repo.id);
  return getRepoById(repo.id)!;
}

// --- worktrees ------------------------------------------------------------------------------------------

const shortId = (instanceId: string) => instanceId.replace(/-/g, "").slice(0, 8);
const live = (instanceId: string) => { const a = getAgent(instanceId); return !!a && !a.retired_at; };

function mustUsable(repo: Repo | undefined, name: string, agent: Agent): Repo {
  if (!repo || repo.status === "archived") {
    const names = listRepos({ archived: false }).filter((r) => r.status === "ready" && roleAllowed(r, agent)).map((r) => r.name);
    throw new Error(`No repo called "${name}". Repos you can use: ${names.join(", ") || "none"}`);
  }
  if (!agent.base_agent_id) throw new Error("Repos are used by tasks (instances), not by roles");
  if (!roleAllowed(repo, agent)) throw new Error(`${getAgent(roleOf(agent))?.name ?? "This role"} isn't allowed to use ${repo.name} (the owner limits it to: ${repo.allowed_roles.map((id) => getAgent(id)?.name ?? id).join(", ")})`);
  if (repo.status !== "ready") throw new Error(`${repo.name} isn't ready (${repo.status}${repo.error ? `: ${repo.error}` : ""})`);
  return repo;
}

/** Bind a task to a repo (its worktree is created by the runner before the next turn, or by use_repo). */
export function bindRepo(instance: Agent, name: string, purpose: "task" | "onboard" = "task"): Worktree {
  const repo = mustUsable(getRepo(name), name, instance);
  const existing = get<Worktree>(`SELECT * FROM repo_worktrees WHERE repo_id = ? AND instance_id = ?`, repo.id, instance.id);
  if (existing) return existing;
  const id = newId();
  run(`INSERT INTO repo_worktrees (id, repo_id, instance_id, purpose, status, created_at) VALUES (?, ?, ?, ?, 'pending', ?)`, id, repo.id, instance.id, purpose, now());
  changed(repo.id);
  return getWorktree(id)!;
}

/** Bind and create now (use_repo, New Task): the worktree path. */
export async function ensureWorktree(instance: Agent, name: string, purpose: "task" | "onboard" = "task"): Promise<Worktree & { repo: Repo }> {
  const row = bindRepo(instance, name, purpose);
  const repo = getRepoById(row.repo_id)!;
  const wt = await materialize(row, repo, instance);
  return { ...wt, repo };
}

/** Before a turn: every repo bound to this task has its worktree (created or recreated). */
export async function prepareWorktrees(agent: Agent): Promise<{ ready: (Worktree & { repo: Repo })[]; problems: string[] }> {
  const ready: (Worktree & { repo: Repo })[] = [];
  const problems: string[] = [];
  if (!agent.base_agent_id) return { ready, problems };
  for (const row of worktreesFor(agent.id)) {
    const repo = getRepoById(row.repo_id);
    if (!repo || repo.status === "archived") continue;
    try {
      mustUsable(repo, repo.name, agent);
      ready.push({ ...(await materialize(row, repo, agent)), repo });
    } catch (e: any) {
      problems.push(`${repo.name}: ${e.message}`);
    }
  }
  return { ready, problems };
}

async function isWorktree(p: string) {
  if (!fs.existsSync(path.join(p, ".git"))) return false;
  const r = await git(["rev-parse", "--is-inside-work-tree"], { cwd: p });
  return r.code === 0 && r.stdout.trim() === "true";
}

function materialize(row: Worktree, repo: Repo, instance: Agent): Promise<Worktree> {
  return withLock(repo.id, async () => {
    const fresh = getWorktree(row.id) ?? row;
    const canon = clonePath(repo.name);
    const short = shortId(instance.id);
    const wtPath = inside(worktreesRoot(), repo.name, short);
    const branch = fresh.branch ?? checkBranch(`agentbox/${short}-${slugify(instance.label ?? "task").slice(0, 30).replace(/-+$/, "") || "task"}`);
    if (fresh.status === "active" && fresh.path === wtPath && await isWorktree(wtPath)) return fresh;
    if (fs.existsSync(wtPath) && await isWorktree(wtPath)) {
      // Kept (unpushed work) and now reopened, or the row lost track: reuse it as it is.
      run(`UPDATE repo_worktrees SET path = ?, branch = COALESCE(branch, ?), status = 'active', note = NULL, closed_at = NULL WHERE id = ?`, wtPath, branch, row.id);
      changed(repo.id);
      return getWorktree(row.id)!;
    }
    if (!fs.existsSync(path.join(canon, ".git"))) throw new Error(`${repo.name}'s clone is missing; fetch or re-clone it from the Repos page`);
    await git(["worktree", "prune"], { cwd: canon });
    if (fs.existsSync(wtPath)) {
      if (fs.readdirSync(wtPath).length) throw new Error(`${wtPath} exists but isn't a worktree; the owner must move it away`);
      fs.rmdirSync(wtPath);
    }
    // A fresh enough base: fetch first if the last fetch is older than five minutes.
    if (!repo.last_fetch_at || Date.now() - Date.parse(repo.last_fetch_at) > 5 * 60_000) {
      const f = await git(["fetch", "--prune", "--quiet", "origin"], { cwd: canon, timeoutMs: TIMEOUTS.fetch });
      if (f.code === 0) run(`UPDATE repos SET last_fetch_at = ? WHERE id = ?`, now(), repo.id);
    }
    fs.mkdirSync(path.dirname(wtPath), { recursive: true });
    const exists = (await git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: canon })).code === 0;
    const args = exists
      ? ["worktree", "add", "--", wtPath, branch]
      : ["worktree", "add", "--no-track", "-b", branch, "--", wtPath, `origin/${repo.default_branch}`];
    const r = await git(args, { cwd: canon, timeoutMs: TIMEOUTS.worktree });
    if (r.code !== 0) {
      const err = gitError(r, "git worktree add");
      run(`UPDATE repo_worktrees SET status = 'error', note = ? WHERE id = ?`, err.message, row.id);
      changed(repo.id);
      throw err;
    }
    run(`UPDATE repo_worktrees SET path = ?, branch = ?, status = 'active', note = NULL, closed_at = NULL WHERE id = ?`, wtPath, branch, row.id);
    changed(repo.id);
    return getWorktree(row.id)!;
  });
}

/** Uncommitted files and commits that no remote has, in a worktree. */
export async function inspectWorktree(p: string, branch: string | null): Promise<{ dirty: number; unpushed: number }> {
  const st = await git(["status", "--porcelain", "--untracked-files=normal"], { cwd: p });
  if (st.code !== 0) throw gitError(st, "git status");
  const refs = ["HEAD"];
  if (branch && (await git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: p })).code === 0) refs.push(`refs/heads/${branch}`);
  const rl = await git(["rev-list", "--count", ...refs, "--not", "--remotes"], { cwd: p });
  if (rl.code !== 0) throw gitError(rl, "git rev-list");
  return { dirty: st.stdout.split("\n").filter((l) => l.trim()).length, unpushed: Number(rl.stdout.trim()) || 0 };
}

/** Task closed: remove each worktree with nothing uncommitted or unpushed; keep (and flag) the rest. */
export async function closeWorktrees(instanceId: string): Promise<Worktree[]> {
  const out: Worktree[] = [];
  for (const row of worktreesFor(instanceId)) {
    if (row.status === "pending" || row.status === "error") {
      run(`UPDATE repo_worktrees SET status = 'removed', closed_at = ? WHERE id = ?`, now(), row.id);
      changed(row.repo_id);
    } else if (row.status === "active") {
      const repo = getRepoById(row.repo_id);
      if (!repo) continue;
      await withLock(repo.id, () => closeOne(row, repo));
    }
    out.push(getWorktree(row.id)!);
  }
  // An onboarding run that ends without a map.
  for (const r of all<{ id: string }>(`SELECT id FROM repos WHERE map_task_id = ? AND map_status = 'running'`, instanceId)) {
    setMap(r.id, "error", "The mapping task ended without a map. Re-map to try again.");
  }
  return out;
}

async function closeOne(row: Worktree, repo: Repo) {
  const p = row.path;
  if (!p || !fs.existsSync(p)) {
    run(`UPDATE repo_worktrees SET status = 'removed', closed_at = ?, note = NULL WHERE id = ?`, now(), row.id);
    return changed(repo.id);
  }
  let state: { dirty: number; unpushed: number };
  try { state = await inspectWorktree(p, row.branch); } catch (e: any) {
    run(`UPDATE repo_worktrees SET status = 'kept', closed_at = ?, note = ? WHERE id = ?`, now(), `kept: couldn't check it (${e.message})`, row.id);
    return changed(repo.id);
  }
  if (state.dirty || state.unpushed) {
    const why = [state.dirty ? `${state.dirty} uncommitted file(s)` : "", state.unpushed ? `${state.unpushed} unpushed commit(s)` : ""].filter(Boolean).join(", ");
    run(`UPDATE repo_worktrees SET status = 'kept', closed_at = ?, note = ? WHERE id = ?`, now(), `kept: unpushed work (${why})`, row.id);
    return changed(repo.id);
  }
  const canon = clonePath(repo.name);
  const r = fs.existsSync(path.join(canon, ".git"))
    ? await git(["worktree", "remove", "--", p], { cwd: canon, timeoutMs: TIMEOUTS.worktree })
    : { code: 1, stdout: "", stderr: "the canonical clone is gone", timedOut: false };
  if (r.code !== 0) {
    run(`UPDATE repo_worktrees SET status = 'kept', closed_at = ?, note = ? WHERE id = ?`, now(), `kept: ${gitError(r, "git worktree remove").message}`, row.id);
  } else {
    run(`UPDATE repo_worktrees SET status = 'removed', closed_at = ?, note = NULL WHERE id = ?`, now(), row.id);
  }
  changed(repo.id);
}

/** The owner's "Discard": remove a kept worktree and its local branch, unpushed work included. */
export async function discardWorktree(id: string): Promise<Worktree> {
  const row = getWorktree(id);
  if (!row) throw new Error("No such worktree");
  if (row.status !== "kept" && !(row.status === "active" && !live(row.instance_id))) throw new Error("Only kept worktrees of closed tasks can be discarded");
  const repo = getRepoById(row.repo_id);
  if (!repo) throw new Error("No such repo");
  await withLock(repo.id, async () => {
    const canon = repo.status === "archived" && repo.archive_path ? repo.archive_path : clonePath(repo.name);
    if (row.path) {
      const p = inside(worktreesRoot(), path.relative(worktreesRoot(), row.path));
      if (fs.existsSync(path.join(canon, ".git"))) {
        await git(["worktree", "remove", "--force", "--force", "--", p], { cwd: canon, timeoutMs: TIMEOUTS.worktree });
        if (row.branch) await git(["branch", "-D", "--", row.branch], { cwd: canon });
        await git(["worktree", "prune"], { cwd: canon });
      }
      if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
    }
    run(`UPDATE repo_worktrees SET status = 'discarded', note = 'discarded by the owner', closed_at = COALESCE(closed_at, ?) WHERE id = ?`, now(), id);
    changed(repo.id);
  });
  return getWorktree(id)!;
}

/**
 * The daily sweep: `git worktree prune` on every clone, close worktrees of tasks that are gone or
 * closed (missed events, restarts), remove orphaned clean worktree folders nobody tracks, and delete
 * local agentbox/* branches of removed worktrees that have nothing unpushed.
 */
export async function sweep(): Promise<{ closed: number; orphans: number; branches: number }> {
  let closed = 0, orphans = 0, branches = 0;
  for (const row of all<Worktree>(`SELECT * FROM repo_worktrees WHERE status IN ('active', 'pending')`)) {
    if (!live(row.instance_id)) { await closeWorktrees(row.instance_id); closed++; }
  }
  for (const repo of listRepos({ archived: false }).filter((r) => r.status === "ready")) {
    const canon = clonePath(repo.name);
    if (!fs.existsSync(path.join(canon, ".git"))) continue;
    await withLock(repo.id, async () => {
      await git(["worktree", "prune"], { cwd: canon });
      const tracked = new Set(worktreesOf(repo.id).filter((w) => w.status === "active" || w.status === "kept").map((w) => w.path));
      let dir: string;
      try { dir = inside(worktreesRoot(), repo.name); } catch { return; }
      for (const d of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
        const p = path.join(dir, d);
        if (tracked.has(p) || !fs.statSync(p).isDirectory()) continue;
        if (!(await isWorktree(p))) continue;
        try {
          const s = await inspectWorktree(p, null);
          if (!s.dirty && !s.unpushed && (await git(["worktree", "remove", "--", p], { cwd: canon })).code === 0) orphans++;
        } catch { /* leave it */ }
      }
      for (const w of worktreesOf(repo.id).filter((x) => (x.status === "removed" || x.status === "discarded") && x.branch)) {
        if ((await git(["rev-parse", "--verify", "--quiet", `refs/heads/${w.branch}`], { cwd: canon })).code !== 0) continue;
        const n = await git(["rev-list", "--count", `refs/heads/${w.branch}`, "--not", "--remotes"], { cwd: canon });
        if (n.code === 0 && n.stdout.trim() === "0" && (await git(["branch", "-D", "--", w.branch!], { cwd: canon })).code === 0) branches++;
      }
    });
  }
  return { closed, orphans, branches };
}

// --- removing ------------------------------------------------------------------------------------------

export class RepoConflict extends Error {
  constructor(message: string, public detail: { kind: "busy" | "unpushed" | "cloning"; tasks?: { id: string; name: string; label: string | null }[]; worktrees?: Worktree[] }) {
    super(message);
  }
}

/** Live tasks bound to a repo. */
export function openUsers(repoId: string) {
  return worktreesOf(repoId).filter((w) => ["pending", "active", "error"].includes(w.status) && live(w.instance_id))
    .map((w) => { const a = getAgent(w.instance_id)!; return { id: a.id, name: a.name, label: a.label ?? null }; });
}

/**
 * Archive (never delete): refused while open tasks use it; with kept worktrees (unpushed work) only
 * once the owner confirmed. The clone moves to <repos>/.archive/<name>-<date>; the map stays.
 */
export async function archiveRepo(name: string, opts: { confirmUnpushed?: boolean } = {}): Promise<Repo> {
  const repo = getRepo(name);
  if (!repo) throw new Error("No such repo");
  if (repo.status === "archived") throw new Error(`${name} is already archived`);
  if (jobs.get(repo.id)?.running) throw new RepoConflict(`${name} is still cloning; wait for it to finish`, { kind: "cloning" });
  const users = openUsers(repo.id);
  if (users.length) {
    throw new RepoConflict(`${users.length} open task(s) use ${name}: ${users.map((u) => `${u.name} (${u.label ?? "task"})`).join(", ")}. Wait for them to finish, or mark them done, then archive.`, { kind: "busy", tasks: users });
  }
  const kept = worktreesOf(repo.id).filter((w) => w.status === "kept");
  if (kept.length && !opts.confirmUnpushed) {
    throw new RepoConflict(`${kept.length} worktree(s) of ${name} hold unpushed work. Archive anyway? They stay on disk until you discard them or purge the repo.`, { kind: "unpushed", worktrees: kept });
  }
  return withLock(repo.id, async () => {
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*$/, "").replace("T", "-");
    const dest = inside(reposRoot(), ".archive", `${repo.name}-${stamp}`);
    const canon = clonePath(repo.name);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    let archivePath: string | null = null;
    if (fs.existsSync(canon)) {
      fs.renameSync(canon, dest);
      archivePath = dest;
      // Kept worktrees point at the old place: re-link them so their work stays reachable.
      const paths = kept.map((w) => w.path).filter((p): p is string => !!p && fs.existsSync(p));
      if (paths.length) await git(["worktree", "repair", "--", ...paths], { cwd: dest });
    }
    run(`UPDATE repos SET status = 'archived', archive_path = ?, archived_at = ? WHERE id = ?`, archivePath, now(), repo.id);
    changed(repo.id);
    return getRepoById(repo.id)!;
  });
}

/** The owner's purge of an archived repo: its archived clone, any worktrees, its map and its record. */
export async function purgeRepo(name: string) {
  const repo = getRepo(name);
  if (!repo) throw new Error("No such repo");
  if (repo.status !== "archived") throw new Error(`Archive ${name} first`);
  await withLock(repo.id, async () => {
    if (repo.archive_path) {
      const p = inside(path.join(reposRoot(), ".archive"), path.basename(repo.archive_path));
      fs.rmSync(p, { recursive: true, force: true });
    }
    fs.rmSync(inside(worktreesRoot(), repo.name), { recursive: true, force: true });
    fs.rmSync(inside(mapsRoot(), repo.name), { recursive: true, force: true });
    run(`DELETE FROM repos WHERE id = ?`, repo.id);
  });
  changed(repo.id);
  return { purged: name };
}

// --- maps (the onboarding run) ---------------------------------------------------------------------------

function setMap(repoId: string, status: Repo["map_status"], error: string | null = null, taskId?: string | null) {
  run(`UPDATE repos SET map_status = ?, map_error = ?, map_task_id = COALESCE(?, map_task_id),
         map_updated_at = CASE WHEN ? = 'ready' THEN ? ELSE map_updated_at END WHERE id = ?`,
    status, error, taskId ?? null, status, now(), repoId);
  changed(repoId);
}

export function mapFiles(name: string) {
  const dir = mapDir(name);
  return MAP_FILES.map((f) => {
    const p = path.join(dir, f);
    let st: fs.Stats | null = null;
    try { st = fs.statSync(p); } catch { /* missing */ }
    return { file: f, path: p, exists: !!st?.isFile(), size: st?.size ?? 0, modified: st ? st.mtime.toISOString() : null };
  });
}

/** Who maps a repo: tech-lead if it exists, otherwise a coding role, otherwise any role allowed on it. */
/** The agents (roles) allowed to use a repo. */
const allowedRoles = (allowed: string[]) =>
  listAgents().filter((a) => !a.base_agent_id && !a.builtin && (allowed.length === 0 || allowed.includes(a.id)));

/** An agent the owner (or the helper) names to map a repo: one allowed to use it. */
function checkMapper(ref: string, allowed: string[]): Agent {
  const k = ref.trim().toLowerCase().replace(/^@/, "");
  const roles = allowedRoles(allowed);
  const r = roles.find((a) => a.id === ref || a.slug === k || a.name.toLowerCase() === k);
  if (!r) throw new Error(`"${ref}" can't map it: pick one of the agents allowed to use the repo (${roles.map((a) => a.name).join(", ") || "none"})`);
  return r;
}

/** Who maps the repo: its chosen agent while that agent still exists and may use it. */
export function onboardingRole(repo: Repo): Agent | undefined {
  if (!repo.mapper_role_id) return undefined;
  return allowedRoles(repo.allowed_roles).find((a) => a.id === repo.mapper_role_id);
}

/**
 * The agents the helper chooses a mapper from: each crew's lead among the agents allowed to use the
 * repo (its chosen lead, else its first planning agent, else its first agent), plus the same for the
 * agents in no crew.
 */
export function mapperCandidates(repo: Repo): Agent[] {
  const byCrew = new Map<string, Agent[]>();
  for (const r of allowedRoles(repo.allowed_roles)) {
    const k = crewIdOf(r) ?? "";
    byCrew.set(k, [...(byCrew.get(k) ?? []), r]);
  }
  return [...byCrew.entries()].map(([crew, members]) => {
    const chosen = crew ? getCrew(crew)?.lead_role_id : null;
    return members.find((m) => m.id === chosen) ?? members.find((m) => m.can_scale) ?? members[0];
  });
}

export function onboardingPrompt(repo: Repo, worktree: string) {
  const dir = mapDir(repo.name);
  return `Map the repo **${repo.name}** for the team, with the \`onboard-repo\` skill.

- Your worktree: ${worktree} (branch of origin/${repo.default_branch}). Work and run commands there.
- The canonical clone ${clonePath(repo.name)} is read-only: never edit, build or check out in it.
- Write the map to ${dir}/ (not into the repo): ${MAP_FILES.join(", ")}. High level only: the architecture and the features.
- Read, don't run: no installing dependencies, builds, tests or dev servers (the team's repo memory gathers that detail as they work). Don't push or change anything outside your worktree.
${repo.propose_map_pr
    ? `- The owner wants these proposed to the repo as well: after writing the map, commit copies under docs/agent/ on your branch and open a PR to ${repo.default_branch}. Never merge it.`
    : "- Don't open a PR or push anything: the map stays in agentbox's store."}
- When both files are written, call \`mcp__team__repo_map_done\` with name "${repo.name}" and a one-line description of the repo. It records the map as ready.

Report the architecture in a few lines and the main features you found.`;
}

/**
 * Start (or restart) the onboarding run: a task for the repo's mapper, bound to the repo. With no mapper
 * chosen, the helper picks one first (a quick look at the repo, then choose_repo_mapper starts the run);
 * with only one agent that could, it's that one. Returns the task started (the mapper's, or the helper's).
 */
export function startOnboarding(name: string, deps?: { send?: (instanceId: string, threadId: string, text: string) => void; chosen?: boolean }) {
  const repo = getRepo(name);
  if (!repo) throw new Error("No such repo");
  if (repo.status !== "ready") throw new Error(`${name} isn't ready (${repo.status})`);
  if (repo.map_status === "running" && repo.map_task_id && live(repo.map_task_id)) {
    throw new Error(`${name} is already being mapped (${getAgent(repo.map_task_id)?.name})`);
  }
  if (repo.map_status === "choosing" && repo.map_task_id && live(repo.map_task_id) && !deps?.chosen) {
    throw new Error(`The helper is choosing who maps ${name}; pick one yourself on its card to skip that`);
  }
  const send = deps?.send ?? defaultSend;
  let role = onboardingRole(repo);
  if (!role) {
    const candidates = mapperCandidates(repo);
    if (!candidates.length) {
      setMap(repo.id, "error", "No agent can map it: create an agent (or allow one to use the repo), then Map it.");
      throw new Error("No agent can map it: create an agent first");
    }
    if (candidates.length > 1 && setupRole()) return askHelperToChoose(repo, candidates, send);
    role = candidates[0];
    run(`UPDATE repos SET mapper_role_id = ?, mapper_note = ? WHERE id = ?`, role.id, candidates.length === 1 ? "The only crew lead that can use it" : "Chosen automatically", repo.id);
  }
  const inst = spawnInstance(role.id, { label: `Map repo ${name}`, createdBy: "owner" });
  bindRepo(inst, name, "onboard");
  setMap(repo.id, "running", null, inst.id);
  const wt = inside(worktreesRoot(), repo.name, shortId(inst.id));
  send(inst.id, dmThreadOf(inst.id)!, onboardingPrompt(repo, wt));
  return inst;
}

/** The helper's task: look at the repo, choose which crew lead maps it (choose_repo_mapper starts the run). */
function askHelperToChoose(repo: Repo, candidates: Agent[], send: (instanceId: string, threadId: string, text: string) => void) {
  const helper = spawnInstance(setupRole()!.id, { label: `Choose who maps ${repo.name}`, createdBy: "owner" });
  setMap(repo.id, "choosing", null, helper.id);
  send(helper.id, dmThreadOf(helper.id)!, `[agentbox] The owner added the repo **${repo.name}** (${repo.url}) without saying who should map it. Choose the agent best suited to map it, from the nature of the repo.

1. Take a quick, read-only look (a couple of minutes): the clone is ${clonePath(repo.name)}. Read the README and look at the
   top-level files, folders and languages (e.g. \`git -C ${clonePath(repo.name)} ls-files | head -200\`). Don't install, build, run
   or change anything there.
2. Pick one of these (each crew's lead among the agents allowed to use it):
${candidates.map((c) => `   - **${c.name}** (${c.title}; ${crewName(crewIdOf(c))} crew): ${c.summary}`).join("\n")}
3. Call \`mcp__setup__choose_repo_mapper\` with repo "${repo.name}", the agent, and a one-sentence reason. That starts the mapping.

Then tell the owner in one or two lines who maps it and why. If none fits, say so and don't choose: the owner picks one on the Repos page.`);
  return helper;
}

/** The helper's choice (choose_repo_mapper): record who maps the repo and start the run. Only while it's choosing. */
export function chooseMapper(helper: Agent, name: string, agentRef: string, reason: string) {
  const repo = getRepo(name);
  if (!repo) throw new Error(`No repo called "${name}"`);
  if (repo.map_status !== "choosing" || repo.map_task_id !== helper.id) {
    throw new Error(`You weren't asked to choose who maps ${name} (or the owner already did). The owner sets it on the Repos page.`);
  }
  const role = checkMapper(agentRef, repo.allowed_roles);
  const why = String(reason ?? "").trim().replace(/\s+/g, " ").slice(0, 300);
  run(`UPDATE repos SET mapper_role_id = ?, mapper_note = ? WHERE id = ?`, role.id, `Chosen by the helper${why ? `: ${why}` : ""}`, repo.id);
  setMap(repo.id, "none", null, null);
  return startOnboarding(name, { send: defaultSend, chosen: true });
}

// A helper task that ends without choosing leaves the repo for the owner to pick.
subscribe((e) => {
  if (e.type !== "task.updated" || !["done", "failed", "stopped"].includes(e.task?.status)) return;
  for (const r of all<{ id: string }>(`SELECT id FROM repos WHERE map_status = 'choosing' AND map_task_id = ?`, e.task.agent_id)) {
    setMap(r.id, "error", "The helper didn't choose who maps it. Pick an agent under \"Mapped by\", then Map it.");
  }
});
let defaultSend: (instanceId: string, threadId: string, text: string) => void = () => { throw new Error("repos: no sender"); };
/** runner.ts wires its sendMessage here (avoids an import cycle at load time). */
export function setSender(fn: typeof defaultSend) { defaultSend = fn; }

/** `repo_map_done`: the pack is complete; fill in an empty description / test command. */
export function finishMap(agent: Agent, name: string, info: { description?: string; test_command?: string }) {
  const repo = getRepo(name);
  if (!repo) throw new Error(`No repo called "${name}"`);
  if (!worktreesFor(agent.id).some((w) => w.repo_id === repo.id)) throw new Error(`You're not working on ${name} (use_repo first)`);
  const missing = mapFiles(name).filter((f) => !f.exists || f.size === 0).map((f) => f.file);
  if (missing.length) throw new Error(`The map isn't complete; missing or empty in ${mapDir(name)}: ${missing.join(", ")}`);
  const desc = String(info.description ?? "").replace(/\s+/g, " ").trim().slice(0, 300);
  const test = String(info.test_command ?? "").replace(/[\r\n]+/g, " ").trim().slice(0, 300);
  run(`UPDATE repos SET description = CASE WHEN description = '' THEN ? ELSE description END,
         test_command = CASE WHEN test_command = '' THEN ? ELSE test_command END WHERE id = ?`, desc, test, repo.id);
  setMap(repo.id, "ready");
  return getRepoById(repo.id)!;
}

// --- the instruction layer ------------------------------------------------------------------------------

const layerCache = new Map<string, { version: number; text: string }>();

/** Ready repos a role may use. */
export const reposFor = (agent: Agent) => listRepos({ archived: false }).filter((r) => r.status === "ready" && roleAllowed(r, agent));

/**
 * The "Repos" layer: for each ready repo the role may use, a line (description, default branch, test
 * command, its map), cached per role; plus this task's own worktrees (not cached).
 */
export function reposLayer(agent: Agent): string {
  const role = getAgent(roleOf(agent));
  if (!role || role.builtin) return "";
  let cached = layerCache.get(role.id);
  if (!cached || cached.version !== version) {
    const repos = reposFor(agent).slice(0, 40);
    const text = repos.length ? `## Repos
The owner's repos you may use. Work in **your task worktree**: \`mcp__team__use_repo(name)\` gives you one (its own
branch off origin/<default branch>; reused if you're asked for rework). The canonical clones in ${reposRoot()}/ are
**read-only** (never edit, build, commit or check out there) and are kept fetched by agentbox. Read a repo's map
before exploring it.
${repos.map((r) => {
  const map = r.map_status === "ready" ? `map: ${mapDir(r.name)}/ (start with AGENTS.md)` : r.map_status === "running" ? "map: being written" : "no map yet";
  const rules = [r.agents_may_merge ? "" : `no pushes to ${r.protected_branches.join(", ") || r.default_branch}; ${r.lead_may_merge ? "the work's lead merges routine PRs into it (CI green, no breaking changes; epics and risky changes go to the owner)" : "merges into it are the owner's"}`, r.agents_may_deploy ? "" : "no deploys"].filter(Boolean).join("; ");
  const mapsIt = r.mapper_role_id === role.id ? " · **you map it** (keep its map current)" : "";
  return `- **${r.name}**${mapsIt}${r.description ? `: ${r.description}` : ""} · default branch \`${r.default_branch}\`${r.test_command ? ` · tests: \`${r.test_command}\`` : ""} · ${map}${rules ? ` · ${rules}` : ""}`;
}).join("\n")}` : "";
    cached = { version, text };
    layerCache.set(role.id, cached);
  }
  const mine = worktreesFor(agent.id).flatMap((w) => {
    const r = getRepoById(w.repo_id);
    if (!r || r.status === "archived" || !["active", "pending", "kept"].includes(w.status)) return [];
    const p = w.path ?? inside(worktreesRoot(), r.name, shortId(agent.id));
    return [`- ${r.name}: ${p}${w.branch ? ` (branch \`${w.branch}\`)` : ""}`];
  });
  const own = mine.length ? `\n\nThis task's worktrees (work here; commit and push your branch, open a PR):\n${mine.join("\n")}` : "";
  return cached.text ? cached.text + own : own.trim() ? `## Repos${own}` : "";
}

/** Folders the turn may work in (additional directories for Claude). */
export function worktreeDirs(agent: Agent): string[] {
  return worktreesFor(agent.id).filter((w) => w.status === "active" && w.path && fs.existsSync(w.path)).map((w) => w.path!);
}

// --- background: fetch every 15 min, sweep daily, clean up on task close ----------------------------------

let timers: NodeJS.Timeout[] = [];
let unsub: (() => void) | null = null;

export function startRepos(opts: { log?: (m: string) => void } = {}) {
  const log = opts.log ?? ((m: string) => console.log(m));
  // A clone that was running when the server stopped can never finish.
  run(`UPDATE repos SET status = 'error', error = 'Interrupted by a restart; retry the clone' WHERE status = 'cloning'`);
  unsub?.();
  unsub = subscribe((e) => {
    if (e.type === "agent.retired") void closeWorktrees(e.agentId).catch((err) => log(`repos: closing worktrees of ${e.agentId} failed: ${err?.message ?? err}`));
  });
  const fetchMs = Number(process.env.AGENTBOX_REPO_FETCH_MS ?? 15 * 60_000);
  const sweepMs = Number(process.env.AGENTBOX_REPO_SWEEP_MS ?? 24 * 3600_000);
  timers.forEach(clearInterval);
  timers = [
    setInterval(() => { void fetchAll().catch(() => {}); }, fetchMs),
    setInterval(() => { void sweep().then((s) => (s.closed || s.orphans || s.branches) && log(`repos: sweep ${JSON.stringify(s)}`)).catch(() => {}); }, sweepMs),
  ];
  for (const t of timers) t.unref();
  setTimeout(() => { void sweep().catch(() => {}); }, 30_000).unref();
  return { stop: () => { timers.forEach(clearInterval); timers = []; unsub?.(); unsub = null; } };
}

// --- views -------------------------------------------------------------------------------------------------

export function repoView(r: Repo) {
  const job = jobs.get(r.id);
  return {
    ...r,
    path: r.status === "archived" ? r.archive_path : clonePath(r.name),
    map_dir: mapDir(r.name),
    map_files: r.map_status === "none" ? [] : mapFiles(r.name),
    job: job ? { ...job, lines: job.lines.slice(-40) } : null,
    worktrees: worktreesOf(r.id).filter((w) => w.status !== "removed" && w.status !== "discarded").map((w) => {
      const a = getAgent(w.instance_id);
      return { ...w, instance: a ? { id: a.id, name: a.name, label: a.label ?? null, retired: !!a.retired_at, root_id: a.parent_instance_id ? null : a.id } : null };
    }),
    users: openUsers(r.id),
  };
}

/** The task header's repo chips. */
export function bindingsOf(instanceId: string) {
  return worktreesFor(instanceId).flatMap((w) => {
    const r = getRepoById(w.repo_id);
    return r ? [{ id: w.id, repo: r.name, branch: w.branch, path: w.path, status: w.status, note: w.note }] : [];
  });
}
