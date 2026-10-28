// The agentbox portal client (docs/CLI.md): everything the portal does, from a terminal, on your own
// computer or on the VM. It talks to the portal's HTTP API and live event stream as you:
//   - from your computer: a profile (agentbox login) with the portal's URL. In tailscale mode your
//     tailnet identity signs you in, as in the browser; in ssh-tunnel mode it's the tunnel's localhost
//     (opened for you for a Lima VM).
//   - on the VM: the local token. Agents can read that token too, so owner-only actions (approvals,
//     reviews, plans, starting setup…) are refused there; run those from your computer.
// No dependencies beyond Node 22 (fetch, WebSocket, readline).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn, spawnSync } from "node:child_process";
import readline from "node:readline";

// --- output ---------------------------------------------------------------------------------------

const tty = process.stdout.isTTY;
const c = (code, s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const green = (s) => c(32, s), red = (s) => c(31, s), yellow = (s) => c(33, s), dim = (s) => c(2, s), bold = (s) => c(1, s), cyan = (s) => c(36, s);

export class Fail extends Error {}
const fail = (msg) => { throw new Fail(msg); };
const out = (s = "") => console.log(s);
const json = (v) => out(JSON.stringify(v, null, 2));

const ago = (iso) => {
  if (!iso) return "—";
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (s < 0) return `in ${dur(-s)}`;
  return s < 90 ? `${s}s ago` : s < 5400 ? `${Math.round(s / 60)}m ago` : s < 129600 ? `${Math.round(s / 3600)}h ago` : `${Math.round(s / 86400)}d ago`;
};
const dur = (s) => (s < 90 ? `${s}s` : s < 5400 ? `${Math.round(s / 60)}m` : `${Math.round(s / 3600)}h`);
const cut = (s, n) => { s = String(s ?? "").replace(/\s+/g, " ").trim(); return s.length > n ? s.slice(0, n - 1) + "…" : s; };
const visible = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, "");

/** A plain table: columns sized to their content, the last one free. */
function table(rows, head) {
  if (!rows.length) return;
  const all = head ? [head.map((h) => dim(h)), ...rows] : rows;
  const w = all[0].map((_, i) => Math.max(...all.map((r) => visible(r[i] ?? "").length)));
  for (const r of all) out(r.map((v, i) => (i === r.length - 1 ? String(v ?? "") : String(v ?? "") + " ".repeat(Math.max(0, w[i] - visible(v ?? "").length)))).join("  "));
}
const STATUS = { working: green("● working"), idle: dim("○ idle"), limited: yellow("◐ limited"), error: red("✖ error"), done: dim("✔ done") };
const status = (s) => STATUS[s] ?? s;

// --- arguments ------------------------------------------------------------------------------------

/** argv → { _: positionals, flags }. --x v, --x=v, -x v; repeated flags collect into arrays. */
function args(argv, { bool = [], multi = [], alias = {} } = {}) {
  const r = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i];
    if (a === "--") { r._.push(...argv.slice(i + 1)); break; }
    if (/^-[a-zA-Z]$/.test(a) && alias[a.slice(1)]) a = `--${alias[a.slice(1)]}`;
    if (!a.startsWith("--") || a === "-") { r._.push(a); continue; }
    let [k, v] = a.slice(2).split(/=(.*)/s);
    if (bool.includes(k)) { r.flags[k] = v === undefined ? true : v !== "false"; continue; }
    if (v === undefined) { v = argv[++i]; if (v === undefined) fail(`--${k} needs a value`); }
    if (multi.includes(k)) (r.flags[k] ??= []).push(v); else r.flags[k] = v;
  }
  return r;
}
const list = (v) => (Array.isArray(v) ? v : v ? [v] : []).flatMap((x) => String(x).split(",")).map((x) => x.trim()).filter(Boolean);

// --- connection -----------------------------------------------------------------------------------

const CONFIG_DIR = process.env.AGENTBOX_CLIENT_DIR || path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "agentbox");
const PROFILES = path.join(CONFIG_DIR, "profiles.json");
const readProfiles = () => { try { return JSON.parse(fs.readFileSync(PROFILES, "utf8")); } catch { return { default: null, profiles: {} }; } };
function writeProfiles(p) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(PROFILES, JSON.stringify(p, null, 2) + "\n", { mode: 0o600 });
}

/** How to reach the portal: a profile, or the VM's own portal with the local token. */
export function connection(opts = {}) {
  const p = readProfiles();
  const name = opts.profile || process.env.AGENTBOX_PROFILE || p.default;
  if (name) {
    const prof = p.profiles?.[name];
    if (!prof) fail(`No profile "${name}". Profiles: ${Object.keys(p.profiles ?? {}).join(", ") || "none"} (agentbox login)`);
    return { name, url: prof.url.replace(/\/+$/, ""), lima: prof.lima ?? null, local: false };
  }
  const conf = opts.localConf?.();
  if (conf) {
    const file = process.env.AGENTBOX_LOCAL_TOKEN_FILE || path.join(conf.paths?.data ?? "/opt/agentbox/data", "local-token");
    let token = null;
    try { token = fs.readFileSync(file, "utf8").trim(); } catch { /* run as the agent user or root */ }
    return { name: "this VM", url: `http://127.0.0.1:${conf.ports?.portal ?? 7700}`, token, local: true };
  }
  fail("Not connected to a portal. Add one: agentbox login <name> --url https://<node>.ts.net   (or --url http://localhost:8720 --lima <vm>)");
}

/** A Lima profile opens its own ssh tunnel when the local port is closed. */
async function ensureTunnel(conn) {
  if (!conn.lima) return;
  const u = new URL(conn.url);
  const port = Number(u.port || 80);
  const open = () => new Promise((res) => { const s = net.connect(port, "127.0.0.1"); s.once("connect", () => { s.destroy(); res(true); }); s.once("error", () => res(false)); });
  if (await open()) return;
  const home = conn.lima.home || process.env.LIMA_HOME || path.join(os.homedir(), ".lima");
  const sshConfig = path.join(home, conn.lima.vm, "ssh.config");
  if (!fs.existsSync(sshConfig)) fail(`Can't open the tunnel: ${sshConfig} is missing. Is the VM (${conn.lima.vm}) running? (limactl start ${conn.lima.vm})`);
  const r = spawnSync("ssh", ["-F", sshConfig, "-f", "-N", "-o", "ServerAliveInterval=30", "-o", "ExitOnForwardFailure=yes",
    "-L", `${port}:127.0.0.1:${conn.lima.port ?? 7720}`, `lima-${conn.lima.vm}`], { stdio: ["ignore", "ignore", "pipe"], timeout: 30_000 });
  if (r.status !== 0 || !(await open())) fail(`Couldn't open the tunnel to ${conn.lima.vm}: ${String(r.stderr ?? "").trim() || "ssh failed"}`);
}

export function client(conn) {
  let ready = null;
  async function request(method, p, body, { raw = false, timeout = 60_000 } = {}) {
    ready ??= ensureTunnel(conn);
    await ready;
    const headers = {};
    if (conn.token) headers["x-agentbox-local-token"] = conn.token;
    if (body !== undefined) headers["content-type"] = "application/json";
    let r;
    try {
      r = await fetch(conn.url + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeout), redirect: "manual" });
    } catch (e) {
      fail(`${conn.name}: the portal isn't answering at ${conn.url} (${e.cause?.code ?? e.message})`);
    }
    if (raw && r.ok) return r;
    const text = await r.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
    if (!r.ok) {
      let msg = data?.error ?? data?.message ?? `${r.status} ${text.slice(0, 200)}`;
      if (r.status === 401) msg += conn.local ? "" : ` (is this computer signed in to ${conn.url}? In tailscale mode it must be on your tailnet)`;
      if (r.status === 403 && conn.local && /owner|portal/i.test(msg)) msg += "\n  This needs you, the owner: run it from your own computer (agentbox login …), not on the VM, where agents could too.";
      throw new Fail(msg);
    }
    return data;
  }
  return {
    conn,
    get: (p) => request("GET", p),
    post: (p, b = {}) => request("POST", p, b),
    put: (p, b = {}) => request("PUT", p, b),
    patch: (p, b = {}) => request("PATCH", p, b),
    del: (p) => request("DELETE", p),
    raw: (p) => request("GET", p, undefined, { raw: true }),
    /** The live event stream (every change in agentbox), as a callback per event. Returns close(). */
    async events(onEvent) {
      ready ??= ensureTunnel(conn);
      await ready;
      const ws = new WebSocket(conn.url.replace(/^http/, "ws") + "/api/events", conn.token ? { headers: { "x-agentbox-local-token": conn.token } } : undefined);
      ws.addEventListener("message", (m) => { try { onEvent(JSON.parse(String(m.data))); } catch { /* not JSON */ } });
      await new Promise((res, rej) => { ws.addEventListener("open", res, { once: true }); ws.addEventListener("error", () => rej(new Fail("couldn't open the live event stream")), { once: true }); });
      return () => ws.close();
    },
  };
}

// --- finding things by name -----------------------------------------------------------------------

/** Everything needed to resolve names: agents (roles and live tasks), crews, groups, work. */
async function world(api) {
  const [state, work] = await Promise.all([api.get("/api/state"), api.get("/api/work")]);
  const done = work.done.map((w) => w.root);
  const byId = new Map([...state.agents, ...(state.retired ?? [])].map((a) => [a.id, a]));
  for (const r of done) if (!byId.has(r.id)) byId.set(r.id, r);
  return { state, work, roles: state.agents.filter((a) => !a.base_agent_id), tasks: state.agents.filter((a) => a.base_agent_id), done, byId, crews: state.crews ?? [], groups: state.groups ?? [] };
}
const norm = (s) => String(s ?? "").trim().toLowerCase().replace(/^@/, "");
function pick(kind, ref, items, keys) {
  const k = norm(ref);
  if (!k) fail(`Which ${kind}?`);
  const exact = items.filter((i) => i.id === ref || keys(i).some((x) => norm(x) === k));
  if (exact.length === 1) return exact[0];
  const pre = items.filter((i) => k.length >= 4 && String(i.id).startsWith(k));
  if (pre.length === 1) return pre[0];
  const sub = items.filter((i) => keys(i).some((x) => norm(x).includes(k)));
  if (sub.length === 1) return sub[0];
  const many = exact.length > 1 ? exact : sub.length > 1 ? sub : [];
  if (many.length) fail(`"${ref}" matches several ${kind}s: ${many.slice(0, 8).map((i) => `${keys(i)[0]} (${String(i.id).slice(0, 8)})`).join(", ")}`);
  fail(`No ${kind} "${ref}"`);
}
/** A task: coder#3, its title, or an id (prefix). Live ones first, then finished work. */
const findTask = (w, ref) => pick("task", ref, [...w.tasks, ...w.done.filter((d) => !w.tasks.some((t) => t.id === d.id))], (t) => [t.name, t.label ?? "", t.slug ?? ""]);
const findRole = (w, ref) => pick("agent", ref, w.roles.filter((r) => !r.builtin || norm(ref) === norm(r.name)), (r) => [r.name, r.slug]);
const findCrew = (w, ref) => pick("crew", ref, w.crews, (x) => [x.name, x.slug]);
const findGroup = (w, ref) => pick("group", ref, w.groups, (g) => [g.name, `#${g.name}`]);
/** The work (room root) a task belongs to. */
function rootOf(w, t) {
  let cur = t;
  for (let i = 0; i < 20 && cur.parent_instance_id; i++) cur = w.byId.get(cur.parent_instance_id) ?? cur;
  return cur;
}
const who = (w, id) => (id === "user" ? "You" : id === "system" ? "agentbox" : w.byId.get(id)?.name ?? "agent");
const CARD = { plan: "plan card", review: "review card", roadmap: "roadmap card", setup_request: "setup request", approval: "approval card", integration: "integration steps" };

// --- files ----------------------------------------------------------------------------------------

const MIME = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", pdf: "application/pdf", md: "text/markdown", txt: "text/plain", csv: "text/csv", json: "application/json" };
async function upload(api, files) {
  const paths = [];
  for (const f of files) {
    let data;
    try { data = fs.readFileSync(f); } catch (e) { fail(`Can't read ${f} (${e.code ?? e.message})`); }
    if (data.length > 20 * 1024 * 1024) fail(`${f} is over 20 MB`);
    const r = await api.post("/api/uploads", { name: path.basename(f), type: MIME[path.extname(f).slice(1).toLowerCase()] ?? "", data: data.toString("base64") });
    paths.push(r.path);
  }
  return paths;
}
function readText(v) {
  if (v === undefined) return undefined;
  if (v === "-") return fs.readFileSync(0, "utf8");
  if (v.startsWith("@")) return fs.readFileSync(v.slice(1), "utf8");
  return v;
}
/** Edit text in $EDITOR (or vi); returns the new text. */
function editText(initial, suffix = ".md") {
  const f = path.join(os.tmpdir(), `agentbox-${process.pid}-${Date.now()}${suffix}`);
  fs.writeFileSync(f, initial ?? "", { mode: 0o600 });
  const ed = process.env.VISUAL || process.env.EDITOR || "vi";
  const r = spawnSync(ed, [f], { stdio: "inherit", shell: true });
  const text = fs.readFileSync(f, "utf8");
  fs.rmSync(f, { force: true });
  if (r.status !== 0) fail(`${ed} exited with ${r.status}`);
  return text;
}
async function ask(q) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try { return (await new Promise((res) => rl.question(q, res))).trim(); } finally { rl.close(); }
}
async function confirm(q, yes) {
  if (yes) return true;
  if (!process.stdin.isTTY) fail(`${q} Re-run with --yes to confirm.`);
  return /^y(es)?$/i.test(await ask(`${q} [y/N] `));
}

// --- printing work --------------------------------------------------------------------------------

function printMessage(w, m) {
  if (m.author === "system") { out(dim(`  · ${cut(m.content, 300)}`)); return; }
  const name = CARD[m.author] ? cyan(`[${CARD[m.author]} ${String(m.content).slice(0, 8)}]`) : bold(who(w, m.author));
  out(`${name} ${dim(ago(m.created_at))}`);
  if (!CARD[m.author]) out(String(m.content).replace(/!\[([^\]]*)\]\(\/api\/file\?path=([^)]+)\)/g, (_, n, p) => `[image ${decodeURIComponent(p)}]`)
    .replace(/\[📎 ([^\]]*)\]\(\/api\/file\?path=([^)]+)\)/g, (_, n, p) => `[file ${decodeURIComponent(p)}]`).split("\n").map((l) => `  ${l}`).join("\n"));
}
function printProgress(w, p) {
  const name = w.byId.get(p.agent_id)?.name ?? "agent";
  const since = p.started_at ? dur(Math.round((Date.now() - Date.parse(p.started_at)) / 1000)) : "";
  out(`${p.state === "stalled" ? yellow("◐ possibly stuck") : green("●")} ${name}: ${cut(p.activity, 100)} ${dim(since)}`);
}
function printRoadmap(r) {
  const c = r.counts ?? {};
  out(`${bold(r.title)} ${dim(`${c.done ?? 0}/${c.total ?? 0} done${c.blocked ? `, ${c.blocked} blocked` : ""}${r.status === "archived" ? " · archived" : ""}`)}`);
  const mark = { done: green("✔"), doing: cyan("▶"), blocked: red("■"), todo: dim("○"), skipped: dim("–") };
  for (const i of r.items ?? []) {
    out(`  ${mark[i.status] ?? "?"} ${i.phase ? dim(`${i.phase} · `) : ""}${i.title}${i.owner ? dim(` (${i.owner})`) : ""}${i.after?.length ? dim(` after ${i.after.join(", ")}`) : ""}${i.note ? yellow(`  ${cut(i.note, 120)}`) : ""}${i.link ? dim(`  ${i.link}`) : ""}`);
  }
}

// --- commands -------------------------------------------------------------------------------------

const H = {};
const help = {};
/** Register a command: name (with spaces for subcommands), usage line, handler(api, argv). */
const cmd = (name, usage, fn) => { H[name] = fn; help[name] = usage; };

// connection
cmd("login", "login <name> --url <url> [--lima <vm>] [--vm-port 7720] [--lima-home dir] [--default]   save a portal profile", async (_api, argv) => {
  const a = args(argv, { bool: ["default"] });
  const name = a._[0];
  if (!name || !a.flags.url) fail("usage: agentbox login <name> --url <url> [--lima <vm>] [--default]");
  if (!/^[\w.-]{1,40}$/.test(name)) fail("A profile name is letters, digits, - _ .");
  const url = String(a.flags.url).replace(/\/+$/, "");
  if (!/^https?:\/\/[^/]+$/.test(url)) fail("--url is the portal's address, e.g. https://node.tailnet.ts.net or http://localhost:8720");
  const p = readProfiles();
  p.profiles ??= {};
  p.profiles[name] = { url, ...(a.flags.lima ? { lima: { vm: a.flags.lima, port: Number(a.flags["vm-port"] ?? 7720), ...(a.flags["lima-home"] ? { home: a.flags["lima-home"] } : {}) } } : {}) };
  if (a.flags.default || !p.default) p.default = name;
  writeProfiles(p);
  const api = client({ name, url, lima: p.profiles[name].lima ?? null, local: false });
  const me = await api.get("/api/auth/me").catch((e) => ({ error: e.message }));
  if (me?.error) { out(yellow(`Saved "${name}", but the portal didn't answer: ${me.error}`)); return 1; }
  out(`${green("✔")} ${name} → ${url}${p.default === name ? dim(" (default)") : ""}  signed in as ${me.identity?.login ?? me.identity?.email ?? (me.identity?.kind === "local" ? "the owner (localhost)" : "?")}`);
});
cmd("profiles", "profiles                                   the saved portals (* = default)", async () => {
  const p = readProfiles();
  const rows = Object.entries(p.profiles ?? {}).map(([n, x]) => [n === p.default ? green("*") : " ", n, x.url, x.lima ? dim(`lima ${x.lima.vm}`) : ""]);
  if (!rows.length) out("No profiles yet: agentbox login <name> --url …"); else table(rows);
});
cmd("use", "use <name>                                 make a profile the default", async (_api, argv) => {
  const p = readProfiles();
  if (!p.profiles?.[argv[0]]) fail(`No profile "${argv[0]}"`);
  p.default = argv[0];
  writeProfiles(p);
  out(`Default: ${argv[0]}`);
});
cmd("logout", "logout <name>                              forget a profile", async (_api, argv) => {
  const p = readProfiles();
  if (!p.profiles?.[argv[0]]) fail(`No profile "${argv[0]}"`);
  delete p.profiles[argv[0]];
  if (p.default === argv[0]) p.default = Object.keys(p.profiles)[0] ?? null;
  writeProfiles(p);
  out(`Forgot ${argv[0]}`);
});
cmd("whoami", "whoami                                     which portal, and who it thinks you are", async (api) => {
  const me = await api.get("/api/auth/me");
  out(`${api.conn.name}: ${api.conn.url} · ${me.identity?.login ?? me.identity?.email ?? me.identity?.kind ?? "?"} · access ${me.mode ?? "?"}${api.conn.local ? dim(" · local token (owner actions refused)") : ""}`);
});

// overview
cmd("dash", "dash [--json]                              needs you, in progress, routines running, hosted", async (api, argv) => {
  const a = args(argv, { bool: ["json"] });
  const [w, att, prog, runs, hosted, control] = await Promise.all([world(api), api.get("/api/attention"), api.get("/api/progress"), api.get("/api/routine-runs?state=active"), api.get("/api/hosting"), api.get("/api/control")]);
  const needs = (att.items ?? []).filter((i) => !i.seen_at && i.kind !== "reply");
  if (a.flags.json) return json({ needs, unread: (att.items ?? []).filter((i) => !i.seen_at && i.kind === "reply"), progress: prog, work: w.work.live.map((x) => x.root), runs: runs.runs, hosted: hosted.services, control });
  out(`${bold(api.conn.name)} ${dim(api.conn.url)}${control.paused ? red("  ⏸ paused") : ""}  ${dim(`${control.running} running`)}`);
  out(`\n${bold(`Needs you (${needs.length})`)}`);
  if (!needs.length) out(dim("  nothing"));
  for (const i of needs) out(`  ${yellow("!")} ${cut(i.title, 110)} ${dim(`${ago(i.created_at)} · ${i.id.slice(0, 8)}`)}`);
  const unread = (att.items ?? []).filter((i) => !i.seen_at && i.kind === "reply");
  if (unread.length) out(dim(`  + ${unread.length} unread repl${unread.length === 1 ? "y" : "ies"} (agentbox needs --all)`));
  out(`\n${bold(`In progress (${w.work.live.length})`)}`);
  for (const r of w.work.live) {
    const busy = r.members.filter((m) => m.status === "working");
    out(`  ${busy.length ? green("●") : dim("○")} ${cut(r.root.label ?? r.root.name, 60)} ${dim(`${r.root.name}${r.members.length > 1 ? ` +${r.members.length - 1}` : ""} · ${ago(r.last_activity)}`)}`);
  }
  for (const p of prog) { out(""); printProgress(w, p); break; }
  if ((runs.runs ?? []).length) { out(`\n${bold("Routines running")}`); for (const r of runs.runs) out(`  ${green("●")} ${r.routine_name} ${dim(ago(r.at))}`); }
  const live = (hosted.services ?? []).filter((s) => s.status === "running");
  if (live.length) { out(`\n${bold("Hosted")}`); for (const s of live) out(`  ${s.name} ${dim(s.url)}`); }
});
cmd("needs", "needs [--all] [--json] | needs seen <id>|--all   the 'needs you' items (and replies with --all)", async (api, argv) => {
  if (argv[0] === "seen") {
    if (argv[1] === "--all") { await api.post("/api/attention/seen-all"); out("All marked seen."); return; }
    const att = await api.get("/api/attention");
    const it = pick("item", argv[1], att.items ?? [], (i) => [i.title]);
    await api.post(`/api/attention/${it.id}/seen`);
    out("Marked seen.");
    return;
  }
  const a = args(argv, { bool: ["all", "json"] });
  const att = await api.get("/api/attention");
  const items = (att.items ?? []).filter((i) => a.flags.all || (!i.seen_at && i.kind !== "reply"));
  if (a.flags.json) return json(items);
  if (!items.length) out(dim("Nothing needs you."));
  table(items.map((i) => [i.seen_at ? dim("seen") : yellow(i.kind), cut(i.title, 90), dim(ago(i.created_at)), dim(i.id.slice(0, 8))]));
});
cmd("activity", "activity [--n 30] [--json]                 who did what, newest first", async (api, argv) => {
  const a = args(argv, { bool: ["json"] });
  const d = await api.get(`/api/activity?limit=${Number(a.flags.n ?? 30)}`);
  const items = Array.isArray(d) ? d : d.items ?? [];
  if (a.flags.json) return json(items);
  const w = await world(api);
  for (const e of items.slice(0, Number(a.flags.n ?? 30))) out(`${dim(ago(e.ts).padEnd(8))} ${dim(e.kind.padEnd(9))} ${bold(who(w, e.actor))} ${cut(e.title, 110)}`);
});
cmd("graph", "graph [--json]                             the delegation graph (who handed work to whom)", async (api) => json(await api.get("/api/graph")));
cmd("pause", "pause [--keep-running]                     Pause all: no new turns (and stop running ones)", async (api, argv) => {
  await api.post("/api/pause", { stopRunning: !argv.includes("--keep-running") });
  out("Paused. agentbox resume to carry on.");
});
cmd("resume", "resume                                     resume after Pause all", async (api) => { await api.post("/api/resume"); out("Resumed."); });
cmd("health", "health [--json]                            modules, integrations and tools on the VM", async (api, argv) => {
  const h = await api.get("/api/health");
  if (argv.includes("--json")) return json(h);
  for (const [k, v] of Object.entries(h)) out(`${bold(k)}: ${typeof v === "object" ? JSON.stringify(v) : v}`);
});

// work and tasks
cmd("work", "work [list] [--done] [--json] | work show <task> [--json]   pieces of work (task rooms)", async (api, argv) => {
  if (argv[0] === "show") return H["show"](api, argv.slice(1));
  const a = args(argv[0] === "list" ? argv.slice(1) : argv, { bool: ["done", "json"] });
  const w = await world(api);
  const rooms = a.flags.done ? w.work.done : w.work.live;
  if (a.flags.json) return json(rooms);
  if (!rooms.length) out(dim(a.flags.done ? "Nothing finished lately." : "Nothing in progress. agentbox task new …"));
  table(rooms.map((r) => [status(r.members.some((m) => m.status === "working") ? "working" : r.root.status), cut(r.root.label ?? r.root.name, 56), r.root.name, r.members.length > 1 ? `${r.members.length} tasks` : "", dim(ago(r.last_activity)), dim(r.root.id.slice(0, 8))]), ["", "work", "lead", "", "last", "id"]);
});
cmd("show", "show <task> [--n 15] [--json]              a task or room: members, roadmap, latest messages", async (api, argv) => {
  const a = args(argv, { bool: ["json"] });
  const w = await world(api);
  const t = findTask(w, a._.join(" "));
  const root = rootOf(w, t);
  const [room, maps, links, notes, svc] = await Promise.all([
    api.get(`/api/work/${root.id}`), api.get(`/api/agents/${root.id}/roadmaps`).catch(() => []),
    api.get(`/api/work/${root.id}/links`).catch(() => null), api.get(`/api/work/${root.id}/notes`).catch(() => null), api.get(`/api/hosting?room=${root.id}`).catch(() => null),
  ]);
  if (a.flags.json) return json({ room, roadmaps: maps, links, notes, services: svc?.services });
  out(`${bold(room.root.label ?? room.root.name)} ${dim(`${room.root.id.slice(0, 8)} · led by ${room.root.name}`)}`);
  if (room.workspace) out(dim(`shared folder: ${room.workspace}`));
  for (const m of room.members) out(`  ${status(m.status)} ${m.name} ${dim(cut(m.label ?? "", 50))}${m.current ? `  ${cut(m.current, 60)}` : ""}`);
  for (const r of Array.isArray(maps) ? maps : maps.roadmaps ?? []) { out(""); printRoadmap(r); }
  if (links?.links?.length) out(`\n${dim("reads:")} ${links.links.map((l) => `${l.work.label} (${l.work.crew_name})`).join(", ")}`);
  if (notes?.notes?.length) out(`${dim("notes:")} ${notes.notes.length} (agentbox notes ${t.name})`);
  const live = (svc?.services ?? []).filter((s) => s.status === "running");
  if (live.length) out(`${dim("hosted:")} ${live.map((s) => `${s.name} ${s.url}`).join("  ")}`);
  out("");
  for (const m of room.messages.slice(-Number(a.flags.n ?? 15))) printMessage(w, m);
});
cmd("task new", "task new [--crew c] [--to agent] [--title t] [--repo r]… [--link work]… [--plan-first] [-f file]… <text|->", async (api, argv) => {
  const a = args(argv, { bool: ["plan-first", "json"], multi: ["repo", "link", "file"], alias: { f: "file", t: "title", c: "crew" } });
  const text = (a._[0] === "-" ? fs.readFileSync(0, "utf8") : a._.join(" ")).trim();
  if (!text && !a.flags.file) fail("Say what needs doing: agentbox task new --crew software \"Fix the login retry\"");
  const w = await world(api);
  let role;
  if (a.flags.to) role = findRole(w, a.flags.to);
  else {
    const crew = a.flags.crew ? findCrew(w, a.flags.crew) : null;
    const members = w.roles.filter((r) => !r.builtin && (crew ? r.crew_id === crew.id : !w.crews.length || !w.crews.some((x) => x.id === r.crew_id)));
    role = members.find((m) => m.id === crew?.lead_role_id) ?? members.find((m) => m.can_scale) ?? members[0];
    if (!role) fail(crew ? `${crew.name} has no agents` : "Pick an agent with --to, or a crew with --crew");
  }
  const links = list(a.flags.link).map((l) => rootOf(w, findTask(w, l)).id);
  const images = await upload(api, list(a.flags.file));
  const inst = await api.post("/api/work", { role_id: role.id, text, title: a.flags.title, images, repos: list(a.flags.repo), require_plan: !!a.flags["plan-first"] || undefined, links: links.length ? links : undefined });
  if (a.flags.json) return json(inst);
  out(`${green("✔")} Started ${bold(inst.name)} "${inst.label}"  ${dim(inst.id.slice(0, 8))}\n  follow it: agentbox chat ${inst.name}`);
});
cmd("send", "send <task|#group> [-f file]… <text|->     message a task (or a group)", async (api, argv) => {
  const a = args(argv, { multi: ["file"], alias: { f: "file" } });
  const [ref, ...rest] = a._;
  const text = (rest[0] === "-" ? fs.readFileSync(0, "utf8") : rest.join(" ")).trim();
  const w = await world(api);
  const thread = threadFor(w, ref);
  const images = await upload(api, list(a.flags.file));
  if (!text && !images.length) fail("Nothing to send");
  await api.post(`/api/threads/${thread.id}/messages`, { text, images });
  out(`${green("✔")} Sent to ${thread.name}`);
});
/** Where a message goes: a group's thread, or a task's (a room's lead's) conversation. */
function threadFor(w, ref) {
  if (String(ref).startsWith("#") || w.groups.some((g) => norm(g.name) === norm(ref))) { const g = findGroup(w, ref); return { id: g.id, name: `#${g.name}`, group: g }; }
  const t = findTask(w, ref);
  const a = w.byId.get(t.id);
  if (!a?.dm_thread_id) fail(`${t.name} is finished; start a new task instead`);
  return { id: a.dm_thread_id, name: t.name, task: t };
}
cmd("stop", "stop <task>                                stop what's running in that task's room", async (api, argv) => {
  const w = await world(api);
  const t = findTask(w, argv.join(" "));
  const root = rootOf(w, t);
  const room = await api.get(`/api/work/${root.id}`);
  const running = room.tasks.filter((x) => x.status === "running" || x.status === "queued");
  for (const x of running) await api.post(`/api/tasks/${x.id}/stop`);
  out(running.length ? `Stopped ${running.length} turn(s) in "${root.label ?? root.name}".` : "Nothing running there.");
});
cmd("done", "done <task> [--yes]                        mark the work done (finishes every task in it)", async (api, argv) => {
  const a = args(argv, { bool: ["yes"] });
  const w = await world(api);
  const root = rootOf(w, findTask(w, a._.join(" ")));
  if (!(await confirm(`Mark "${root.label ?? root.name}" and everything in it done?`, a.flags.yes))) return 1;
  const r = await api.post(`/api/agents/${root.id}/done`);
  out(`Done: ${r.finished} task(s).`);
});
cmd("keep", "keep <task> [--off]                        keep a finished room listed (or stop keeping it)", async (api, argv) => {
  const a = args(argv, { bool: ["off"] });
  const w = await world(api);
  const t = findTask(w, a._.join(" "));
  await api.patch(`/api/agents/${t.id}/meta`, { kept: !a.flags.off });
  out(a.flags.off ? "No longer kept." : "Kept.");
});
cmd("rename", "rename <task> <new title>                  rename a task", async (api, argv) => {
  const w = await world(api);
  const t = findTask(w, argv[0]);
  const label = argv.slice(1).join(" ").trim();
  if (!label) fail("Give the new title");
  await api.patch(`/api/agents/${t.id}/meta`, { label });
  out(`Renamed ${t.name} to "${label}".`);
});
cmd("log", "log <task|#group> [--n 30] [--json]        the conversation", async (api, argv) => {
  const a = args(argv, { bool: ["json"] });
  const w = await world(api);
  const th = threadFor(w, a._.join(" "));
  const d = th.task ? await api.get(`/api/work/${rootOf(w, th.task).id}`) : await api.get(`/api/threads/${th.id}`);
  const msgs = (d.messages ?? []).slice(-Number(a.flags.n ?? 30));
  if (a.flags.json) return json(msgs);
  for (const m of msgs) printMessage(w, m);
});

// live: watch and chat
async function liveRoom(api, w, th) {
  // The threads to follow: a group's, or every conversation in the task's room.
  let threads = new Set([th.id]);
  let agentsIn = new Set();
  const refresh = async () => {
    if (!th.task) { agentsIn = new Set((th.group?.members ?? [])); return; }
    const room = await api.get(`/api/work/${rootOf(w, th.task).id}`);
    threads = new Set(room.threads.map((x) => x.id));
    agentsIn = new Set(room.members.map((m) => m.id));
  };
  await refresh();
  return { threads: () => threads, agents: () => agentsIn, refresh };
}
async function follow(api, w, th, { onIdle, showMine = false } = {}) {
  const room = await liveRoom(api, w, th);
  let streaming = null;
  let lastActivity = "";
  const close = await api.events(async (e) => {
    if (e.type === "agent.created") { const a = e.agent; if (a) w.byId.set(a.id, a); await room.refresh(); }
    if (e.type === "turn.delta" && (room.agents().has(e.agentId) || room.threads().size === 1)) {
      if (!room.agents().has(e.agentId) && !th.group) return;
      if (streaming !== e.taskId) { if (streaming) process.stdout.write("\n"); streaming = e.taskId; process.stdout.write(`${bold(who(w, e.agentId))} ${dim("writing…")}\n  `); }
      process.stdout.write(e.text.replace(/\n/g, "\n  "));
    }
    if (e.type === "message.created" && room.threads().has(e.message.thread_id)) {
      const m = e.message;
      if (streaming && m.task_id === streaming && m.author !== "user") { process.stdout.write("\n"); streaming = null; return; }
      if (m.author === "user" && !showMine) return; // what you typed is already on screen
      if (streaming) { process.stdout.write("\n"); streaming = null; }
      printMessage(w, m);
    }
    if (e.type === "progress.updated" && room.agents().has(e.progress.agent_id) && !streaming) {
      const p = e.progress;
      const line = `${p.agent_id}|${p.activity}|${p.state}`;
      if (line !== lastActivity) { lastActivity = line; printProgress(w, p); }
    }
    if (e.type === "task.updated" && room.agents().has(e.task.agent_id) && ["failed", "stopped"].includes(e.task.status)) {
      if (streaming) { process.stdout.write("\n"); streaming = null; }
      out(e.task.status === "failed" ? red(`✖ ${who(w, e.task.agent_id)}: the turn failed: ${e.task.error ?? ""}`) : dim(`■ ${who(w, e.task.agent_id)} stopped`));
    }
    if (e.type === "progress.cleared") onIdle?.();
  });
  return close;
}
cmd("watch", "watch <task|#group>                        follow a room or group live (Ctrl-C to leave)", async (api, argv) => {
  const w = await world(api);
  const th = threadFor(w, argv.join(" "));
  out(dim(`Following ${th.name} live. Ctrl-C to leave.`));
  await follow(api, w, th, { showMine: true });
  await new Promise(() => {});
});
cmd("chat", "chat <task|#group> | chat --to <agent|crew> \"first message\"   talk live, like the Claude CLI", async (api, argv) => {
  const a = args(argv, { multi: ["file"], alias: { f: "file" } });
  let w = await world(api);
  let th;
  if (a.flags.to) {
    const first = a._.join(" ").trim();
    if (!first) fail('Say what needs doing: agentbox chat --to software "…"');
    const crew = w.crews.find((x) => norm(x.name) === norm(a.flags.to) || x.slug === norm(a.flags.to));
    const startArgs = [...(crew ? ["--crew", crew.name] : ["--to", a.flags.to]), ...list(a.flags.file).flatMap((f) => ["-f", f]), "--json", first];
    const r = await captureJson(() => H["task new"](api, startArgs));
    w = await world(api);
    th = threadFor(w, r.id);
  } else th = threadFor(w, a._.join(" "));
  const room = th.task ? await api.get(`/api/work/${rootOf(w, th.task).id}`) : await api.get(`/api/threads/${th.id}`);
  out(dim(`── ${th.name}${th.task ? ` · "${th.task.label ?? ""}"` : ""} · /help for commands, Ctrl-D to leave ──`));
  for (const m of (room.messages ?? []).slice(-8)) printMessage(w, m);
  let pending = [];
  let rl = null;
  // The stream first, then the input: lines typed (or piped) before it's open would be lost.
  const close = await follow(api, w, th, { onIdle: () => rl?.prompt(true) });
  rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: cyan("› "), terminal: !!process.stdin.isTTY });
  rl.prompt();
  let buffer = "";
  for await (const lineRaw of rl) {
    const line = buffer + lineRaw;
    if (line.endsWith("\\")) { buffer = line.slice(0, -1) + "\n"; continue; }
    buffer = "";
    const t = line.trim();
    try {
      if (!t) { rl.prompt(); continue; }
      if (t === "/quit" || t === "/exit") break;
      if (t === "/help") out(dim("/stop  /done  /attach <file>  /note <text>  /notes  /link <work>  /show  /roadmap  /changes  /quit · end a line with \\ for more lines"));
      else if (t === "/stop") await H["stop"](api, [th.task?.id ?? th.id]);
      else if (t === "/done") await H["done"](api, [th.task?.id, "--yes"]);
      else if (t.startsWith("/attach ")) { pending.push(t.slice(8).trim()); out(dim(`attached ${t.slice(8).trim()} (goes with your next message)`)); }
      else if (t.startsWith("/note ")) await H["note"](api, [th.task?.id, t.slice(6)]);
      else if (t === "/notes") await H["notes"](api, [th.task?.id]);
      else if (t.startsWith("/link ")) await H["link"](api, [th.task?.id, t.slice(6)]);
      else if (t === "/show") await H["show"](api, [th.task?.id ?? "", "--n", "0"]);
      else if (t === "/roadmap") await H["roadmap"](api, [th.task?.id]);
      else if (t === "/changes") await H["changes"](api, [th.task?.id, "--stat"]);
      else if (t.startsWith("/")) out(dim("Unknown command; /help"));
      else {
        const images = await upload(api, pending);
        pending = [];
        await api.post(`/api/threads/${th.id}/messages`, { text: line.trim(), images });
      }
    } catch (e) { out(red(e.message)); }
    rl.prompt();
  }
  close();
  out(dim("Left the chat; the work carries on."));
});
/** Run a command that prints --json and return what it printed. */
async function captureJson(fn) {
  const orig = console.log;
  let buf = "";
  console.log = (s) => { buf += s + "\n"; };
  try { await fn(); } finally { console.log = orig; }
  return JSON.parse(buf);
}

// notes and links
cmd("notes", "notes <task> [--json]                      the work's notebook", async (api, argv) => {
  const a = args(argv, { bool: ["json"] });
  const w = await world(api);
  const t = findTask(w, a._.join(" "));
  const d = await api.get(`/api/work/${t.id}/notes`);
  if (a.flags.json) return json(d.notes);
  if (!d.notes.length) out(dim("No notes yet: agentbox note <task> \"…\""));
  for (const n of d.notes) {
    out(`${dim(`${n.id.slice(0, 8)} · ${ago(n.created_at)}`)}`);
    if (n.quote) out(n.quote.split("\n").map((l) => `  │ ${l}`).join("\n"));
    if (n.body) out(n.body.split("\n").map((l) => `  ${l}`).join("\n"));
  }
});
cmd("note", "note <task> <text|-> | note edit <id> <text> | note rm <id>   write, change or delete a note", async (api, argv) => {
  if (argv[0] === "rm") { await api.del(`/api/notes/${await noteId(api, argv[1])}`); out("Deleted."); return; }
  if (argv[0] === "edit") { await api.patch(`/api/notes/${await noteId(api, argv[1])}`, { body: readText(argv.slice(2).join(" ")) ?? "" }); out("Saved."); return; }
  const w = await world(api);
  const t = findTask(w, argv[0]);
  const body = (argv[1] === "-" ? fs.readFileSync(0, "utf8") : argv.slice(1).join(" ")).trim();
  if (!body) fail("Write the note");
  await api.post(`/api/work/${t.id}/notes`, { body });
  out("Noted.");
});
async function noteId(api, ref) {
  if (!ref) fail("Which note? (its id, from agentbox notes <task>)");
  const w = await world(api);
  for (const r of [...w.work.live, ...w.work.done]) {
    const d = await api.get(`/api/work/${r.root.id}/notes`).catch(() => ({ notes: [] }));
    const n = d.notes.find((x) => x.id === ref || x.id.startsWith(ref));
    if (n) return n.id;
  }
  fail(`No note "${ref}"`);
}
cmd("links", "links <task> [--json]                      the work this one reads, and what reads it", async (api, argv) => {
  const a = args(argv, { bool: ["json"] });
  const w = await world(api);
  const d = await api.get(`/api/work/${findTask(w, a._.join(" ")).id}/links`);
  if (a.flags.json) return json(d);
  out(bold("Reads"));
  table(d.links.map((l) => [l.work.label, dim(`${l.work.crew_name} crew · ${l.work.name} · ${l.work.status}`), dim(l.id.slice(0, 8))]));
  if (!d.links.length) out(dim("  nothing"));
  if (d.linked_from.length) { out(bold("Read by")); table(d.linked_from.map((l) => [l.work.label, dim(l.work.name)])); }
});
cmd("link", "link <task> <other work> | link rm <task> <other work>   let a task read other work", async (api, argv) => {
  const w = await world(api);
  if (argv[0] === "rm") {
    const t = findTask(w, argv[1]);
    const other = rootOf(w, findTask(w, argv.slice(2).join(" ")));
    const d = await api.get(`/api/work/${t.id}/links`);
    const l = d.links.find((x) => x.work.id === other.id);
    if (!l) fail("Not linked");
    await api.del(`/api/links/${l.id}`);
    out("Unlinked.");
    return;
  }
  const t = findTask(w, argv[0]);
  const other = rootOf(w, findTask(w, argv.slice(1).join(" ")));
  await api.post(`/api/work/${t.id}/links`, { work_id: other.id });
  out(`${t.name}'s work now reads "${other.label ?? other.name}".`);
});

// sharing one piece of work with a guest (outside the tailnet, through ngrok)
cmd("share", "share <task> [--edit] [--for 6h|1d|7d] [--name who] | share rm <link id> | share status   a link to this work for a guest", async (api, argv) => {
  if (argv[0] === "status") {
    const d = await api.get("/api/sharing");
    out(d.ready ? `${green("✔")} ready · tunnel ${d.tunnel.status}${d.tunnel.url ? ` ${d.tunnel.url}` : ""} · ${d.live} live link${d.live === 1 ? "" : "s"}` : `${yellow("✖")} ${d.missing}. Set it up: agentbox connect ngrok`);
    if (d.tunnel.error) out(red(`  ${d.tunnel.error}`));
    return;
  }
  if (argv[0] === "rm") {
    if (!argv[1]) fail("usage: agentbox share rm <link id>   (agentbox shares <task> lists them)");
    const v = await api.del(`/api/shares/${argv[1]}`);
    out(`Turned off the link for ${v.label}.`);
    return;
  }
  const a = args(argv, { bool: ["edit", "read"] });
  const w = await world(api);
  const t = rootOf(w, findTask(w, a._.join(" ")));
  const r = await api.post(`/api/work/${t.id}/shares`, { perm: a.flags.edit ? "edit" : "read", expiry: a.flags.for ?? "1d", label: a.flags.name });
  out(`${green("✔")} ${r.share.perm === "edit" ? "Can chat with the agents" : "Read-only"} link for ${r.share.label}, until ${new Date(r.share.expires_at).toLocaleString()}:`);
  out(`  ${bold(r.url)}`);
  out(dim("  Shown once; anyone with it can open this work until it expires. agentbox share rm " + r.share.id.slice(0, 8) + "… turns it off."));
});
cmd("shares", "shares <task> [--all] [--json]             links to this work and who they're for", async (api, argv) => {
  const a = args(argv, { bool: ["all", "json"] });
  const w = await world(api);
  const t = rootOf(w, findTask(w, a._.join(" ")));
  const d = await api.get(`/api/work/${t.id}/shares`);
  const list = a.flags.all ? d.shares : d.shares.filter((s) => s.live);
  if (a.flags.json) return json(list);
  if (!d.ready) out(yellow(`Sharing isn't set up: ${d.missing}. agentbox connect ngrok`));
  table(list.map((s) => [s.label, s.perm === "edit" ? "can chat" : "read-only",
    s.live ? `expires ${new Date(s.expires_at).toLocaleString()}` : dim(s.revoked_at ? "turned off" : "expired"),
    dim(s.last_seen_at ? `opened ${ago(s.last_seen_at)}` : "not opened yet"), dim(s.id)]));
  if (!list.length) out(dim("  no live links"));
});

// plans, changes, roadmaps
cmd("roadmap", "roadmap <task|#group> [--archived] [--json] | roadmap archive <id> [--undo]", async (api, argv) => {
  if (argv[0] === "archive") { await api.post(`/api/roadmaps/${argv[1]}/archive`, { archived: !argv.includes("--undo") }); out("Done."); return; }
  const a = args(argv, { bool: ["archived", "json"] });
  const w = await world(api);
  const ref = a._.join(" ");
  let id;
  if (ref.startsWith("#") || w.groups.some((g) => norm(g.name) === norm(ref))) id = (await api.get(`/api/groups/${findGroup(w, ref).id}/workspaces`)).lead_instance_id;
  else id = rootOf(w, findTask(w, ref)).id;
  if (!id) { out(dim("No roadmap yet.")); return; }
  const d = await api.get(`/api/agents/${id}/roadmaps${a.flags.archived ? "?archived=1" : ""}`);
  const maps = Array.isArray(d) ? d : d.roadmaps ?? [];
  if (a.flags.json) return json(maps);
  if (!maps.length) out(dim("No roadmap yet."));
  for (const r of maps) { printRoadmap(r); out(dim(`  id ${r.id}`)); }
});
cmd("plans", "plans <task> [--json]                      plans shared in this work", async (api, argv) => {
  const a = args(argv, { bool: ["json"] });
  const w = await world(api);
  const d = await api.get(`/api/agents/${findTask(w, a._.join(" ")).id}/plans`);
  const plans = Array.isArray(d) ? d : d.plans ?? [];
  if (a.flags.json) return json(plans);
  for (const p of plans) out(`${p.status === "pending" ? yellow("? waiting") : dim(p.status)} ${bold(p.title)} ${dim(`${p.id.slice(0, 8)} · ${ago(p.created_at)}`)}`);
  if (!plans.length) out(dim("No plans."));
});
cmd("plan", "plan <id> [show] | plan <id> approve|changes|reject [-m note]   read or decide a plan", async (api, argv) => {
  const a = args(argv.slice(1), { alias: { m: "message" } });
  const verb = a._[0] ?? "show";
  if (verb === "show") {
    const p = await api.get(`/api/plans/${argv[0]}`);
    out(`${bold(p.title)} ${dim(p.status)}`);
    for (const k of ["summary", "why", "risks", "body"]) if (p[k]) out(`\n${String(p[k])}`);
    if (p.diagram) out(`\n${dim("diagram:")}\n${typeof p.diagram === "string" ? p.diagram : JSON.stringify(p.diagram, null, 2)}`);
    return;
  }
  if (!["approve", "changes", "reject"].includes(verb)) fail("plan <id> approve|changes|reject [-m note]");
  await api.post(`/api/plans/${argv[0]}/decide`, { verdict: verb, note: a.flags.message });
  out(`Plan ${verb === "approve" ? "approved" : verb === "changes" ? "sent back for changes" : "rejected"}.`);
});
cmd("plan-gate", "plan-gate <task> on|off                    require (or stop requiring) your OK on a plan before edits", async (api, argv) => {
  const w = await world(api);
  const t = findTask(w, argv[0]);
  await api.post(`/api/agents/${t.id}/plan-gate`, { required: argv[1] === "on" });
  out(`Approve a plan first: ${argv[1] === "on" ? "on" : "off"}.`);
});
cmd("changes", "changes <task> [--stat] [--json]           what the work changed in its repos (a diff)", async (api, argv) => {
  const a = args(argv, { bool: ["stat", "json"] });
  const w = await world(api);
  const d = await api.get(`/api/agents/${findTask(w, a._.join(" ")).id}/changes`);
  if (a.flags.json) return json(d);
  const trees = d.repos ?? [];
  if (!trees.length || trees.every((t) => !t.files.length)) { out(dim("No changes in any repo yet.")); return; }
  const mark = { added: green("A"), modified: yellow("M"), deleted: red("D"), untracked: green("?") };
  for (const t of trees.filter((x) => x.files.length || x.commits?.length || x.error)) {
    out(bold(`${t.repo} ${dim(`${t.branch ?? ""} vs ${t.base} · +${t.additions} -${t.deletions} · ${t.instance?.name ?? ""} · worktree ${t.worktree_id.slice(0, 8)}`)}`));
    for (const cm of t.commits ?? []) out(dim(`  ${cm.sha.slice(0, 7)} ${cm.subject}`));
    for (const f of t.files ?? []) {
      out(`  ${mark[f.status] ?? f.status} ${f.path} ${dim(`+${f.additions} -${f.deletions}${f.binary ? " binary" : ""}`)}`);
      if (a.flags.stat) continue;
      for (const l of f.lines ?? []) out(l.t === "hunk" ? cyan(`    ${l.s}`) : l.t === "add" ? green(`    +${l.s}`) : l.t === "del" ? red(`    -${l.s}`) : dim(`     ${l.s}`));
    }
    if (t.error) out(red(`  ${t.error}`));
  }
});
cmd("review", "review <task> approve|changes|reject [-m note] [--comment path:line=text]…   your review of the changes", async (api, argv) => {
  const a = args(argv, { multi: ["comment"], alias: { m: "message" } });
  const [ref, verdict] = a._;
  if (!["approve", "changes", "reject"].includes(verdict)) fail("review <task> approve|changes|reject [-m note] [--comment path:line=text]");
  const w = await world(api);
  const t = findTask(w, ref);
  const ch = a.flags.comment ? await api.get(`/api/agents/${t.id}/changes`) : null;
  const trees = ch?.repos ?? [];
  const comments = list(a.flags.comment).length ? (a.flags.comment ?? []).map((s) => {
    const m = /^(.+):(\d+)=(.+)$/s.exec(s);
    if (!m) fail(`--comment is path:line=text (got ${s})`);
    const tree = trees.find((x) => (x.files ?? []).some((f) => f.path === m[1])) ?? trees[0];
    if (!tree) fail("No changes to comment on");
    return { worktree_id: tree.worktree_id, path: m[1], line: Number(m[2]), side: "new", text: m[3] };
  }) : [];
  await api.post(`/api/agents/${t.id}/review`, { verdict, note: a.flags.message, comments });
  out(`Review sent (${verdict}${comments.length ? `, ${comments.length} comment(s)` : ""}).`);
});

// documents and files
cmd("docs", "docs [<task|#group>] [--q text] [--json]   documents agents wrote", async (api, argv) => {
  const a = args(argv, { bool: ["json"] });
  const w = await world(api);
  const ref = a._.join(" ");
  let docs;
  if (!ref) docs = await api.get("/api/documents");
  else if (ref.startsWith("#") || w.groups.some((g) => norm(g.name) === norm(ref))) docs = await api.get(`/api/groups/${findGroup(w, ref).id}/documents`);
  else docs = await api.get(`/api/work/${rootOf(w, findTask(w, ref)).id}/documents`);
  if (a.flags.q) docs = docs.filter((d) => `${d.name} ${d.path}`.toLowerCase().includes(String(a.flags.q).toLowerCase()));
  if (a.flags.json) return json(docs);
  table(docs.slice(0, 80).map((d) => [d.name, dim(ago(d.modified)), dim(w.byId.get(d.author)?.name ?? d.role ?? ""), dim(d.path)]));
  if (!docs.length) out(dim("No documents."));
});
cmd("open", "open <path> [-o file]                      print a document (or save any file with -o)", async (api, argv) => {
  const a = args(argv, { alias: { o: "output" } });
  const p = a._.join(" ");
  if (!p) fail("Which file? (a path from agentbox docs)");
  const r = await api.raw(`/api/file?path=${encodeURIComponent(p)}`);
  const buf = Buffer.from(await r.arrayBuffer());
  if (a.flags.output) { fs.writeFileSync(a.flags.output, buf); out(`Saved ${a.flags.output} (${buf.length} bytes)`); return; }
  const type = r.headers.get("content-type") ?? "";
  if (!/^text\/|json|xml|markdown/.test(type)) fail(`${path.basename(p)} is ${type || "binary"}: save it with -o <file>`);
  process.stdout.write(buf.toString("utf8"));
});

// hosting
cmd("services", "services [<task>] [--json] | services stop <name|id>   what agents host, with links", async (api, argv) => {
  const a = args(argv, { bool: ["json"] });
  if (a._[0] === "stop") {
    const d = await api.get("/api/hosting");
    const s = pick("service", a._[1], d.services, (x) => [x.name]);
    await api.post(`/api/hosting/${s.id}/stop`);
    out(`Stopped ${s.name}.`);
    return;
  }
  const w = await world(api);
  const d = a._.length ? await api.get(`/api/hosting?room=${rootOf(w, findTask(w, a._.join(" "))).id}`) : await api.get("/api/hosting");
  const svcs = d.services.filter((s) => a._.length || s.status === "running");
  if (a.flags.json) return json(svcs);
  if (!svcs.length) out(dim("Nothing hosted."));
  table(svcs.map((s) => [s.status === "running" ? green("●") : dim("○"), s.name, s.url, dim(s.kind === "command" ? cut(s.command, 40) : "static"), dim(s.started_by)]));
});

// routines
cmd("routines", "routines [--json]                          scheduled jobs", async (api, argv) => {
  const rs = await api.get("/api/routines");
  if (argv.includes("--json")) return json(rs);
  const w = await world(api);
  table(rs.map((r) => [r.enabled ? green("on ") : dim("off"), r.name, dim(r.cron), dim(r.timezone), w.byId.get(r.agent_id)?.name ?? "?", dim(r.context_mode ?? ""), dim(r.id.slice(0, 8))]), ["", "routine", "cron", "tz", "agent", "context", "id"]);
  if (!rs.length) out(dim("No routines: agentbox routine new …"));
});
const findRoutine = async (api, ref) => pick("routine", ref, await api.get("/api/routines"), (r) => [r.name]);
cmd("routine", `routine show|run|enable|disable|compact|fresh|rm <routine>
  routine new --agent a --name n --cron "0 9 * * 1-5" [--tz Asia/Kolkata] [--fresh] [--off] --prompt <text|@file|->
  routine edit <routine> [--name] [--cron] [--tz] [--prompt] [--agent] [--fresh|--continue]
  routine runs [<routine>] [--active] [--json] · routine run-show <run id> · routine preview "<cron>" [--tz]`, async (api, argv) => {
  const [sub, ...rest] = argv;
  const a = args(rest, { bool: ["fresh", "continue", "off", "json", "active", "yes"] });
  const w = await world(api);
  const input = async (base = {}) => ({
    agent_id: a.flags.agent ? findRole(w, a.flags.agent).id : base.agent_id, name: a.flags.name ?? base.name, cron: a.flags.cron ?? base.cron,
    timezone: a.flags.tz ?? base.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone, prompt: readText(a.flags.prompt) ?? base.prompt,
    enabled: a.flags.off ? false : base.enabled ?? true, context_mode: a.flags.fresh ? "fresh" : a.flags.continue ? "continue" : base.context_mode, rules: base.rules,
  });
  switch (sub) {
    case "new": {
      const b = await input();
      if (!b.agent_id || !b.name || !b.cron || !b.prompt) fail("routine new needs --agent, --name, --cron and --prompt");
      const r = await api.post("/api/routines", b);
      out(`${green("✔")} ${r.name} ${dim(r.id.slice(0, 8))} · ${r.enabled ? "on" : "off"}`);
      return;
    }
    case "edit": { const r = await findRoutine(api, a._[0]); await api.put(`/api/routines/${r.id}`, await input(r)); out("Saved."); return; }
    case "show": {
      const r = await findRoutine(api, a._[0]);
      const d = await api.get(`/api/routines/${r.id}`);
      if (a.flags.json) return json(d);
      out(`${bold(r.name)} ${r.enabled ? green("on") : dim("off")} · ${r.cron} ${dim(r.timezone)} · ${w.byId.get(r.agent_id)?.name} · context ${r.context_mode ?? "continue"}\n\n${r.prompt}\n`);
      for (const run of (d.runs ?? []).slice(0, 10)) out(`  ${dim(ago(run.at))} ${run.outcome} ${dim(run.summary ?? run.reason ?? "")}`);
      return;
    }
    case "run": { const r = await findRoutine(api, a._[0]); await api.post(`/api/routines/${r.id}/run`); out(`Started ${r.name}.`); return; }
    case "enable": case "disable": { const r = await findRoutine(api, a._[0]); await api.put(`/api/routines/${r.id}`, { ...r, enabled: sub === "enable" }); out(`${r.name}: ${sub}d.`); return; }
    case "compact": { const r = await findRoutine(api, a._[0]); await api.post(`/api/routines/${r.id}/compact`); out("Compacting its context."); return; }
    case "fresh": { const r = await findRoutine(api, a._[0]); await api.post(`/api/routines/${r.id}/fresh`); out("Its next run starts fresh."); return; }
    case "rm": {
      const r = await findRoutine(api, a._[0]);
      if (!(await confirm(`Delete the routine "${r.name}"?`, a.flags.yes))) return 1;
      await api.del(`/api/routines/${r.id}`); out("Deleted."); return;
    }
    case "runs": {
      const q = new URLSearchParams();
      if (a.flags.active) q.set("state", "active");
      if (a._[0]) q.set("routine_id", (await findRoutine(api, a._[0])).id);
      const d = await api.get(`/api/routine-runs?${q}`);
      if (a.flags.json) return json(d.runs);
      table((d.runs ?? []).map((r) => [r.outcome === "started" && !r.finished_at ? green("● running") : dim(r.status ?? r.outcome), r.routine_name, dim(ago(r.at)), r.duration_s ? dim(dur(r.duration_s)) : "", cut(r.summary ?? r.reason ?? "", 70), dim(r.id.slice(0, 8))]));
      if (!(d.runs ?? []).length) out(dim("No runs."));
      return;
    }
    case "run-show": { json(await api.get(`/api/routine-runs/${a._[0]}`)); return; }
    case "preview": {
      const d = await api.post("/api/routines/preview", { cron: a._.join(" "), timezone: a.flags.tz ?? Intl.DateTimeFormat().resolvedOptions().timeZone });
      const tz = a.flags.tz ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
      out(`${d.describe} ${dim(`(${tz})`)}\n${d.next_runs.map((x) => `  ${new Date(x).toLocaleString(undefined, { timeZone: tz, weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}`).join("\n")}`);
      return;
    }
  }
  fail(`usage: agentbox ${help.routine}`);
});
cmd("wakeups", "wakeups [--json] | wakeups cancel <id>     one-time wake-ups agents set", async (api, argv) => {
  if (argv[0] === "cancel") { await api.post(`/api/wakeups/${argv[1]}/cancel`); out("Cancelled."); return; }
  const d = await api.get("/api/wakeups");
  if (argv.includes("--json")) return json(d.wakeups);
  const w = await world(api);
  table((d.wakeups ?? []).map((x) => [x.status ?? "", w.byId.get(x.agent_id)?.name ?? "?", dim(ago(x.due_at)), cut(x.note, 80), dim(x.id.slice(0, 8))]));
  if (!(d.wakeups ?? []).length) out(dim("No wake-ups."));
});

// groups
cmd("groups", "groups [--json]                            group chats", async (api, argv) => {
  const w = await world(api);
  if (argv.includes("--json")) return json(w.groups);
  table(w.groups.map((g) => [`#${g.name}`, dim(g.members.map((m) => w.byId.get(m)?.name).join(", ")), dim(`lead ${w.byId.get(g.lead_agent_id)?.name ?? "?"}`), g.paused ? yellow("paused") : "", dim(cut(g.purpose, 50))]));
  if (!w.groups.length) out(dim("No groups: agentbox group new …"));
});
cmd("group", `group new <name> --members a,b [--lead a] [--purpose text] · group edit <#g> [--name] [--members] [--lead] [--purpose]
  group rm <#g> · group post <#g> <text> · group continue <#g> · group workspaces <#g> [--json]`, async (api, argv) => {
  const [sub, ...rest] = argv;
  const a = args(rest, { bool: ["json", "yes"] });
  const w = await world(api);
  const members = (v) => list(v).map((m) => findRole(w, m).id);
  switch (sub) {
    case "new": {
      const g = await api.post("/api/groups", { name: a._[0], purpose: a.flags.purpose ?? "", members: members(a.flags.members), lead: a.flags.lead ? findRole(w, a.flags.lead).id : null });
      out(`${green("✔")} #${g.name}`); return;
    }
    case "edit": {
      const g = findGroup(w, a._[0]);
      await api.put(`/api/groups/${g.id}`, { name: a.flags.name ?? g.name, purpose: a.flags.purpose ?? g.purpose, members: a.flags.members ? members(a.flags.members) : g.members, lead: a.flags.lead ? findRole(w, a.flags.lead).id : g.lead_agent_id });
      out("Saved."); return;
    }
    case "rm": {
      const g = findGroup(w, a._[0]);
      if (!(await confirm(`Delete #${g.name}?`, a.flags.yes))) return 1;
      await api.del(`/api/groups/${g.id}`); out("Deleted."); return;
    }
    case "post": return H["send"](api, [`#${findGroup(w, a._[0]).name}`, ...a._.slice(1)]);
    case "continue": { await api.post(`/api/groups/${findGroup(w, a._[0]).id}/continue`); out("Continued."); return; }
    case "workspaces": {
      const g = findGroup(w, a._[0]);
      const d = await api.get(`/api/groups/${g.id}/workspaces`);
      if (a.flags.json) return json(d);
      if (!d.workspaces.length) out(dim(`No workspaces. Ask #${g.name}'s lead to launch one per item.`));
      table(d.workspaces.map((x) => [status(x.lead?.status ?? "idle"), x.title, x.lead?.name ?? "?", dim(x.step ?? ""), dim(x.roadmaps.map((m) => `${m.done}/${m.total}`).join(" ")), x.question ? yellow(`asks: ${cut(x.question, 50)}`) : ""]));
      return;
    }
  }
  fail(`usage: agentbox ${help.group}`);
});

// crews
cmd("crews", "crews [--json]                             separate teams, their leads and agents", async (api, argv) => {
  const w = await world(api);
  if (argv.includes("--json")) return json(w.crews);
  const roles = w.roles.filter((r) => !r.builtin);
  for (const c of [...w.crews, { id: null, name: "No crew" }]) {
    const members = roles.filter((r) => (c.id ? r.crew_id === c.id : !w.crews.some((x) => x.id === r.crew_id)));
    if (!c.id && !members.length) continue;
    const lead = members.find((m) => m.id === c.lead_role_id) ?? members.find((m) => m.can_scale);
    out(`${bold(c.name)}${c.summary ? dim(`  ${c.summary}`) : ""}`);
    out(`  ${members.map((m) => (m === lead ? `${m.name} ${dim("(lead)")}` : m.name)).join(", ") || dim("no agents")}`);
  }
});
cmd("crew", "crew new <name> [--summary s] [--members a,b] · crew rename <crew> <name> · crew lead <crew> <agent> · crew move <agent> <crew|none> · crew rm <crew>", async (api, argv) => {
  const [sub, ...rest] = argv;
  const a = args(rest, { bool: ["yes"] });
  const w = await world(api);
  switch (sub) {
    case "new": { const c = await api.post("/api/crews", { name: a._.join(" "), summary: a.flags.summary ?? "", members: list(a.flags.members).map((m) => findRole(w, m).id) }); out(`${green("✔")} ${c.name}`); return; }
    case "rename": { await api.patch(`/api/crews/${findCrew(w, a._[0]).id}`, { name: a._.slice(1).join(" ") }); out("Renamed."); return; }
    case "summary": { await api.patch(`/api/crews/${findCrew(w, a._[0]).id}`, { summary: a._.slice(1).join(" ") }); out("Saved."); return; }
    case "lead": { await api.patch(`/api/crews/${findCrew(w, a._[0]).id}`, { lead_role_id: findRole(w, a._[1]).id }); out("Lead set."); return; }
    case "move": { const r = findRole(w, a._[0]); await api.put(`/api/agents/${r.id}/crew`, { crew_id: a._[1] && norm(a._[1]) !== "none" ? findCrew(w, a._[1]).id : null }); out(`Moved ${r.name}.`); return; }
    case "rm": {
      const cr = findCrew(w, a._[0]);
      if (!(await confirm(`Delete the crew ${cr.name}? (its agents stay, in no crew)`, a.flags.yes))) return 1;
      await api.del(`/api/crews/${cr.id}`); out("Deleted."); return;
    }
  }
  fail(`usage: agentbox ${help.crew}`);
});

// agents
cmd("agents", "agents [--json]                            the agents (roles): crew, model, live tasks", async (api, argv) => {
  const w = await world(api);
  if (argv.includes("--json")) return json(w.roles);
  const crew = (id) => w.crews.find((c) => c.id === id)?.name ?? "";
  table(w.roles.map((r) => [r.name, dim(r.title), dim(crew(r.crew_id)), r.model, r.can_scale ? cyan("lead") : r.builtin ? dim("built in") : "", dim(`${w.tasks.filter((t) => t.base_agent_id === r.id).length} live`)]), ["agent", "title", "crew", "model", "", "tasks"]);
});
cmd("tasks", "tasks [--agent a] [--json]                 live tasks (instances) and what each is doing", async (api, argv) => {
  const a = args(argv, { bool: ["json"] });
  const w = await world(api);
  const role = a.flags.agent ? findRole(w, a.flags.agent) : null;
  const tasks = w.tasks.filter((t) => !role || t.base_agent_id === role.id);
  if (a.flags.json) return json(tasks);
  table(tasks.map((t) => [status(t.status), t.name, cut(t.label ?? "", 60), dim(t.id.slice(0, 8))]));
});
cmd("agent", `agent show <agent> [--instructions] [--json] · agent edit <agent>   (job description in $EDITOR)
  agent new --name n --title t [--summary s] [--model sonnet] [--crew c] [--skills a,b] [--lead] --from <CLAUDE.md>
  agent new --interview [--crew c]                       the hiring interview, then review and create
  agent set <agent> [--title] [--summary] [--model] [--max-turns n] [--replicas n] [--lead|--no-lead] [--crew c|none]
  agent skills <agent> a,b · agent integrations <agent> github,aws · agent notes <helper> <text>
  agent reset <task> · agent rm <agent>`, async (api, argv) => {
  const [sub, ...rest] = argv;
  const a = args(rest, { bool: ["json", "instructions", "lead", "no-lead", "interview", "yes"] });
  const w = await world(api);
  switch (sub) {
    case "show": {
      const r = findRole(w, a._[0]);
      const d = await api.get(`/api/agents/${r.id}`);
      if (a.flags.json) return json(d);
      if (a.flags.instructions) { process.stdout.write(d.instructions); return; }
      const ag = d.agent;
      out(`${bold(ag.name)} ${dim(ag.title)} · ${ag.model}${ag.can_scale ? cyan(" · lead") : ""} · crew ${w.crews.find((x) => x.id === ag.crew_id)?.name ?? "none"}`);
      out(`${ag.summary}\nskills: ${ag.skills.join(", ") || "none"} · integrations: ${(ag.integrations ?? []).join(", ") || "none"} · ${ag.live_instances ?? 0} live task(s)`);
      out(dim(`\n${d.instructions.split("\n").slice(0, 12).join("\n")}\n… (agentbox agent show ${ag.name} --instructions)`));
      return;
    }
    case "edit": {
      const r = findRole(w, a._[0]);
      const d = await api.get(`/api/agents/${r.id}`);
      const text = editText(d.instructions);
      if (text === d.instructions) { out("No change."); return; }
      await api.put(`/api/agents/${r.id}/instructions`, { text });
      out("Saved: it applies from each task's next turn.");
      return;
    }
    case "new": {
      if (a.flags.interview) return interview(api, w, a);
      if (!a.flags.name || !a.flags.title || !a.flags.from) fail("agent new needs --name, --title and --from <CLAUDE.md> (or --interview)");
      const ag = await api.post("/api/agents", {
        name: a.flags.name, title: a.flags.title, summary: a.flags.summary ?? a.flags.title, model: a.flags.model ?? "sonnet",
        instructions: readText(`@${a.flags.from}`), interview: { source: "cli" }, skills: list(a.flags.skills), crew_id: a.flags.crew ? findCrew(w, a.flags.crew).id : null,
      });
      if (a.flags.lead) await api.patch(`/api/agents/${ag.id}`, { can_scale: true });
      out(`${green("✔")} ${ag.name} created.`);
      return;
    }
    case "set": {
      const r = findRole(w, a._[0]);
      const patch = {};
      if (a.flags.title) patch.title = a.flags.title;
      if (a.flags.summary) patch.summary = a.flags.summary;
      if (a.flags.model) patch.model = a.flags.model;
      if (a.flags["max-turns"]) patch.max_turns = Number(a.flags["max-turns"]);
      if (a.flags.replicas !== undefined) patch.max_replicas = Number(a.flags.replicas);
      if (a.flags.lead) patch.can_scale = true;
      if (a.flags["no-lead"]) patch.can_scale = false;
      if (Object.keys(patch).length) await api.patch(`/api/agents/${r.id}`, patch);
      if (a.flags.crew) await api.put(`/api/agents/${r.id}/crew`, { crew_id: norm(a.flags.crew) === "none" ? null : findCrew(w, a.flags.crew).id });
      out("Saved.");
      return;
    }
    case "skills": { const r = findRole(w, a._[0]); await api.put(`/api/agents/${r.id}/skills`, { skills: list(a._.slice(1)) }); out("Skills set."); return; }
    case "integrations": { const r = findRole(w, a._[0]); await api.put(`/api/agents/${r.id}/integrations`, { integrations: list(a._.slice(1)) }); out("Integrations set."); return; }
    case "notes": { const r = findRole(w, a._[0]); await api.put(`/api/agents/${r.id}/notes`, { text: readText(a._.slice(1).join(" ")) ?? "" }); out("Notes saved."); return; }
    case "reset": {
      const t = findTask(w, a._.join(" "));
      await api.post(`/api/agents/${t.id}/reset-session`, {});
      out(`${t.name} starts its conversation fresh (history and memory stay).`);
      return;
    }
    case "rm": {
      const r = findRole(w, a._[0]);
      if (!(await confirm(`Delete the agent ${r.name} (its tasks' history stays)?`, a.flags.yes))) return 1;
      await api.del(`/api/agents/${r.id}`); out("Deleted."); return;
    }
  }
  fail(`usage: agentbox ${help.agent}`);
});
/** New agent by interview: the core questions, follow-ups, a drafted job description to review. */
async function interview(api, w, a) {
  const { questions, templates } = await api.get("/api/interview");
  out(bold("New agent: the interview") + dim(" (Enter skips an optional question)"));
  templates.forEach((t, i) => out(`  ${i + 1}. ${t.label} ${dim(cut(t.job, 70))}`));
  const t = templates[Number(await ask(`Start from a role (1-${templates.length}, Enter for something else): `)) - 1];
  const answers = t ? { name: t.name, job: t.job, done: t.done } : {};
  for (const q of questions) {
    const def = answers[q.id];
    const v = await ask(`\n${bold(q.question)}${q.hint ? dim(`\n  ${q.hint}`) : ""}${q.options ? dim(`\n  options: ${q.options.join(" | ")} (comma-separated)`) : ""}${def ? dim(`\n  [${cut(Array.isArray(def) ? def.join(", ") : def, 80)}]`) : ""}\n› `);
    if (v) answers[q.id] = q.kind === "multi" ? list(v) : v;
  }
  out(dim("\nThinking of follow-up questions…"));
  const fu = await api.post("/api/interview/follow-ups", { answers });
  const extra = [];
  for (const q of fu.questions ?? []) {
    const v = await ask(`\n${bold(q.question)}${q.hint ? dim(`\n  ${q.hint}`) : ""}\n› `);
    extra.push({ ...q, answer: v });
    answers[`fu_${q.id}`] = v;
  }
  out(dim("\nDrafting the job description…"));
  const draft = await api.post("/api/interview/draft", { answers, extra });
  out(`\n${bold(draft.title)} · ${draft.model}\n${draft.summary}\n${dim("─".repeat(40))}\n${draft.instructions}\n${dim("─".repeat(40))}`);
  const choice = await ask("Create it (y), edit the job description first (e), or cancel (n)? ");
  if (/^n/i.test(choice) || !choice) { out("Cancelled."); return 1; }
  const instructions = /^e/i.test(choice) ? editText(draft.instructions) : draft.instructions;
  const name = String(answers.name ?? "").trim() || await ask("Its name: ");
  const ag = await api.post("/api/agents", {
    name, title: draft.title, summary: draft.summary, model: draft.model, instructions, interview: { role: t?.id ?? "custom", answers, followUps: fu.questions ?? [], source: "cli" },
    skills: [], crew_id: a.flags.crew ? findCrew(w, a.flags.crew).id : null,
  });
  out(`${green("✔")} ${ag.name} created${a.flags.crew ? ` in ${a.flags.crew}` : ""}. Give it skills: agentbox agent skills ${ag.name} a,b`);
}

// skills
cmd("skills", "skills [--json] · skills drafts             the skill library (and drafts agents proposed)", async (api, argv) => {
  const d = await api.get("/api/skills");
  if (argv[0] === "drafts") {
    if (argv.includes("--json")) return json(d.drafts);
    table((d.drafts ?? []).map((x) => [x.name, dim(cut(x.description, 70)), dim(x.id.slice(0, 8))]));
    if (!(d.drafts ?? []).length) out(dim("No drafts."));
    return;
  }
  if (argv.includes("--json")) return json(d.skills);
  const w = await world(api);
  table(d.skills.map((s) => [s.name, dim(cut(s.description, 70)), dim((s.agents ?? []).map((x) => w.byId.get(x)?.name).filter(Boolean).join(", "))]));
});
cmd("skill", `skill show <name> · skill edit <name>  ($EDITOR) · skill rm <name>
  skill new <name> --description d [--agents a,b] --from <SKILL.md body>
  skill draft show|approve|reject <id> [--agents a,b]`, async (api, argv) => {
  const [sub, ...rest] = argv;
  const a = args(rest, { bool: ["yes"] });
  const w = await world(api);
  const agents = (v) => list(v).map((x) => findRole(w, x).id);
  switch (sub) {
    case "show": { const s = await api.get(`/api/skills/${encodeURIComponent(a._[0])}`); out(`${bold(s.name)} ${dim(s.description)}\n\n${s.body}`); return; }
    case "edit": {
      const s = await api.get(`/api/skills/${encodeURIComponent(a._[0])}`);
      const body = editText(s.body);
      if (body === s.body) { out("No change."); return; }
      await api.put(`/api/skills/${encodeURIComponent(s.name)}`, { description: s.description, body });
      out("Saved.");
      return;
    }
    case "new": {
      if (!a._[0] || !a.flags.description || !a.flags.from) fail("skill new <name> --description d --from <file>");
      await api.post("/api/skills", { name: a._[0], description: a.flags.description, body: readText(`@${a.flags.from}`), agents: a.flags.agents ? agents(a.flags.agents) : undefined });
      out(`${green("✔")} ${a._[0]}`);
      return;
    }
    case "rm": {
      if (!(await confirm(`Delete the skill ${a._[0]}?`, a.flags.yes))) return 1;
      await api.del(`/api/skills/${encodeURIComponent(a._[0])}`); out("Deleted."); return;
    }
    case "draft": {
      const [verb, id] = a._;
      const d = await api.get(`/api/skill-drafts/${id}`);
      if (verb === "show") { out(`${bold(d.name)} ${dim(d.description)}\n\n${d.body}`); return; }
      if (verb === "approve") { await api.post(`/api/skill-drafts/${id}/approve`, { name: d.name, description: d.description, body: d.body, agents: a.flags.agents ? agents(a.flags.agents) : d.agents ?? [] }); out("Approved into the library."); return; }
      if (verb === "reject") { await api.post(`/api/skill-drafts/${id}/reject`); out("Rejected."); return; }
    }
  }
  fail(`usage: agentbox ${help.skill}`);
});

// approvals, setup requests, the helper
cmd("approvals", "approvals [--all] [--json]                cards waiting for you (the helper's team changes)", async (api, argv) => {
  const d = await api.get("/api/approvals");
  const items = (Array.isArray(d) ? d : d.approvals ?? []).filter((x) => argv.includes("--all") || x.status === "pending");
  if (argv.includes("--json")) return json(items);
  table(items.map((x) => [x.status === "pending" ? yellow("pending") : dim(x.status), cut(x.title, 80), dim(ago(x.created_at)), dim(x.id.slice(0, 8))]));
  if (!items.length) out(dim("Nothing waiting."));
});
cmd("approval", "approval show|approve|reject|undo <id>     read or decide a card", async (api, argv) => {
  const [verb, ref] = argv;
  const d = await api.get("/api/approvals");
  const a = pick("approval", ref, Array.isArray(d) ? d : d.approvals ?? [], (x) => [x.title]);
  if (verb === "show") return json(await api.get(`/api/approvals/${a.id}`));
  if (!["approve", "reject", "undo"].includes(verb)) fail("approval show|approve|reject|undo <id>");
  await api.post(`/api/approvals/${a.id}/${verb}`, {});
  out(`${verb === "approve" ? "Approved" : verb === "reject" ? "Rejected" : "Undone"}: ${a.title}`);
});
cmd("setup", `setup requests [--all] [--json] · setup start|reject <id> · setup done|failed <id> [-m note]
  setup checklist [<helper task>]                        what agents need, and the helper's checklist`, async (api, argv) => {
  const [sub, ref, ...rest] = argv;
  const a = args(rest, { alias: { m: "message" } });
  if (sub === "requests" || !sub) {
    const d = await api.get("/api/setup-requests");
    d.requests = (d.requests ?? []).filter((r) => argv.includes("--all") || ["pending", "in_progress"].includes(r.status));
    if (argv.includes("--json")) return json(d.requests);
    table((d.requests ?? []).map((r) => [r.status, cut(r.title, 70), dim(r.agent_name ?? ""), dim(ago(r.created_at)), dim(r.id.slice(0, 8))]));
    if (!(d.requests ?? []).length) out(dim("No setup requests waiting."));
    return;
  }
  if (sub === "checklist") {
    const list_ = (await api.get("/api/setup/sessions")).sessions ?? [];
    const s = ref ? pick("session", ref, list_, (x) => [x.label ?? "", x.name]) : list_[0];
    if (!s) { out(dim("No helper session.")); return; }
    const plan = (await api.get(`/api/setup/plans/${s.id}`)).plan ?? {};
    out(bold(plan.title ?? "Checklist"));
    for (const st of plan.steps ?? []) out(`  ${st.state === "done" ? green("✔") : st.state === "running" ? cyan("▶") : st.state === "failed" ? red("✖") : dim("○")} ${st.title}${st.commands?.length ? dim(`\n      ${st.commands.join("\n      ")}`) : ""}`);
    return;
  }
  const d = await api.get("/api/setup-requests");
  const r = pick("request", ref, d.requests ?? [], (x) => [x.title]);
  if (sub === "start") { const x = await api.post(`/api/setup-requests/${r.id}/start`, {}); out(`The helper is on it${x.instance_id ? ` (agentbox chat ${x.instance_id})` : ""}. Logins happen in its terminal: agentbox helper terminal`); return; }
  if (sub === "reject") { await api.post(`/api/setup-requests/${r.id}/reject`, { reason: a.flags.message ?? "" }); out("Rejected."); return; }
  if (sub === "done" || sub === "failed") { await api.post(`/api/setup-requests/${r.id}/mark`, { status: sub, note: a.flags.message }); out(`Marked ${sub}.`); return; }
  fail(`usage: agentbox ${help.setup}`);
});
cmd("helper", `helper "<what you need>"    ask the helper (setup, integrations, agents, skills): a live chat
  helper terminal                                        attach to your terminal on the VM (where logins happen)`, async (api, argv) => {
  if (argv[0] === "terminal") return attachTerminal(api);
  const w = await world(api);
  const role = w.roles.find((r) => r.builtin === "setup");
  if (!role) fail("No helper on this agentbox");
  const text = argv.join(" ").trim();
  if (!text) fail('Say what you need: agentbox helper "connect GitHub"');
  const inst = await api.post("/api/work", { role_id: role.id, text });
  return H["chat"](api, [inst.id]);
});
/** Your terminal in the Setup workspace, in this terminal: raw keys in, output out (like ssh). */
async function attachTerminal(api) {
  const conn = api.conn;
  const ws = new WebSocket(conn.url.replace(/^http/, "ws") + "/api/setup/terminal", conn.token ? { headers: { "x-agentbox-local-token": conn.token } } : undefined);
  await new Promise((res, rej) => { ws.addEventListener("open", res, { once: true }); ws.addEventListener("error", () => rej(new Fail("couldn't attach (the terminal is the owner's: from your own computer only)")), { once: true }); });
  out(dim("Attached to your setup terminal. Ctrl-] to detach."));
  const resize = () => ws.send(JSON.stringify({ t: "r", c: process.stdout.columns, r: process.stdout.rows }));
  resize();
  process.stdout.on("resize", resize);
  ws.addEventListener("message", (m) => process.stdout.write(typeof m.data === "string" ? m.data : Buffer.from(m.data)));
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.resume();
  await new Promise((res) => {
    process.stdin.on("data", (b) => { if (b.length === 1 && b[0] === 0x1d) return res(); ws.send(JSON.stringify({ t: "i", d: b.toString("utf8") })); });
    ws.addEventListener("close", res);
  });
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  ws.close();
  out(dim("\nDetached."));
  process.exit(0);
}

// integrations (the portal's side: the catalog, who may use what, a helper task to connect)
cmd("integrations", "integrations [--json]                      the catalog and who may use each", async (api, argv) => {
  const d = await api.get("/api/integrations");
  const items = Array.isArray(d) ? d : d.integrations ?? [];
  if (argv.includes("--json")) return json(items);
  const w = await world(api);
  const mark = { connected: green("● connected"), connecting: yellow("◐ connecting"), error: red("✖ error"), available: dim("○ available"), unavailable: dim("– soon"), disconnected: dim("○ off") };
  table(items.map((i) => [mark[i.state] ?? i.state, i.id, dim(i.title), dim((i.roles ?? []).map((r) => w.byId.get(r)?.name).filter(Boolean).join(", "))]));
});
cmd("integration-roles", "integration-roles <id> a,b                 which agents may use an integration", async (api, argv) => {
  const w = await world(api);
  await api.put(`/api/integrations/${argv[0]}/roles`, { roles: list(argv.slice(1)).map((x) => findRole(w, x).id) });
  out("Saved.");
});
cmd("connect", "connect <integration> [--reconnect|--disconnect]   the helper connects it (logins in its terminal)", async (api, argv) => {
  const a = args(argv, { bool: ["reconnect", "disconnect"] });
  const r = await api.post(`/api/integrations/${a._[0]}/task`, { action: a.flags.disconnect ? "disconnect" : a.flags.reconnect ? "reconnect" : "connect" });
  out(`The helper is connecting ${a._[0]}. Follow: agentbox chat ${r.instance_id ?? r.id ?? ""}   Logins: agentbox helper terminal`);
});

// repos (the portal's side; the VM-only commands stay in agentbox.mjs)
cmd("repos", "repos [--json]                             registered repos, maps and who maps each", async (api, argv) => {
  const d = await api.get("/api/repos");
  if (argv.includes("--json")) return json(d);
  const w = await world(api);
  table(d.repos.map((r) => [r.status, r.name, dim(r.default_branch ?? "?"), `map ${r.map_status}`, dim(`by ${w.byId.get(r.mapper_role_id)?.name ?? "helper's choice"}`), dim(ago(r.last_fetch_at))]));
});
cmd("repo-set", `repo-set <repo> [--mapper agent|helper] [--roles a,b|all] [--description d] [--tests cmd] [--branch b]
  [--protected a,b] [--agents-merge|--no-agents-merge] [--agents-deploy|--no-agents-deploy] [--lead-merge|--no-lead-merge] [--map-pr|--no-map-pr]`, async (api, argv) => {
  const a = args(argv, { bool: ["agents-merge", "no-agents-merge", "agents-deploy", "no-agents-deploy", "lead-merge", "no-lead-merge", "map-pr", "no-map-pr"] });
  const w = await world(api);
  const patch = {};
  if (a.flags.mapper) patch.mapper_role_id = norm(a.flags.mapper) === "helper" ? null : findRole(w, a.flags.mapper).id;
  if (a.flags.roles) patch.allowed_roles = norm(a.flags.roles) === "all" ? [] : list(a.flags.roles).map((x) => findRole(w, x).id);
  if (a.flags.description !== undefined) patch.description = a.flags.description;
  if (a.flags.tests !== undefined) patch.test_command = a.flags.tests;
  if (a.flags.branch) patch.default_branch = a.flags.branch;
  if (a.flags.protected) patch.protected_branches = list(a.flags.protected);
  for (const [k, f] of [["agents_may_merge", "agents-merge"], ["agents_may_deploy", "agents-deploy"], ["lead_may_merge", "lead-merge"], ["propose_map_pr", "map-pr"]]) {
    if (a.flags[f]) patch[k] = true;
    if (a.flags[`no-${f}`]) patch[k] = false;
  }
  await api.patch(`/api/repos/${encodeURIComponent(a._[0])}`, patch);
  out("Saved.");
});
cmd("repo-admin", `repo-admin archive|purge|retry|map <repo> · repo-admin discard <worktree id> · repo-admin sweep|fetch-all|map-routine
  repo-admin check <url> · repo-admin available [--refresh]   (add from your computer: repo-admin add <url> [--mapper a] [--roles a,b])`, async (api, argv) => {
  const [sub, ref, ...rest] = argv;
  const a = args(rest, { bool: ["yes", "refresh", "confirm"] });
  const w = await world(api);
  const enc = encodeURIComponent(ref ?? "");
  switch (sub) {
    case "archive": { await api.post(`/api/repos/${enc}/archive`, { confirm_unpushed: !!a.flags.confirm }); out("Archived."); return; }
    case "purge": { if (!(await confirm(`Purge ${ref} (its clone, worktrees and map)?`, a.flags.yes))) return 1; await api.post(`/api/repos/${enc}/purge`, {}); out("Purged."); return; }
    case "retry": { await api.post(`/api/repos/${enc}/retry`, {}); out("Cloning again."); return; }
    case "fetch": { await api.post(`/api/repos/${enc}/fetch`, {}); out("Fetched."); return; }
    case "map": { const x = await api.post(`/api/repos/${enc}/remap`, {}); out(`Mapping: agentbox chat ${x.instance_id}`); return; }
    case "map-file": { json(await api.get(`/api/repos/${enc}/map`)); return; }
    case "discard": { await api.post(`/api/repos/worktrees/${ref}/discard`, {}); out("Discarded."); return; }
    case "sweep": { json(await api.post("/api/repos/sweep", {})); return; }
    case "fetch-all": { json(await api.post("/api/repos/fetch-all", {})); return; }
    case "map-routine": { const x = await api.post("/api/repos/map-routine", {}); out(x.created?.length ? `Added (paused) for ${x.created.join(", ")}` : "Every mapper already has one."); return; }
    case "check": { json(await api.post("/api/repos/check", { url: ref })); return; }
    case "available": { json(await api.get(`/api/repos/available${a.flags.refresh ? "?refresh=1" : ""}`)); return; }
    case "add": {
      const r = await api.post("/api/repos", { url: ref, mapper_role_id: a.flags.mapper ? findRole(w, a.flags.mapper).id : null, allowed_roles: list(a.flags.roles).map((x) => findRole(w, x).id) });
      out(`${green("✔")} ${r.name}: cloning, then ${a.flags.mapper ? `${a.flags.mapper} maps it` : "the helper picks who maps it"}.`);
      return;
    }
    case "status": { json(await api.get(`/api/repos/${enc}`)); return; }
  }
  fail(`usage: agentbox ${help["repo-admin"]}`);
});
cmd("memory", "memory [--json] · memory check             repo memory trees (notes, stale, drafts)", async (api, argv) => {
  if (argv[0] === "check") { json(await api.post("/api/memory/check", {})); return; }
  json(await api.get("/api/memory"));
});

// devices, screen
cmd("devices", `devices [--json] · devices approve|deny|revoke|test-push <id> · devices revoke-all
  devices pair [--cancel] · devices push [on|off] · devices gateway [<url>]`, async (api, argv) => {
  const [sub, ref] = argv;
  const cfg = await api.get("/api/config/public").catch(() => null);
  if (cfg && cfg.modules && cfg.modules.mobile === false) fail("Phone pairing is off on this agentbox (the mobile module isn't enabled).");
  switch (sub) {
    case undefined: case "--json": {
      const d = await api.get("/api/devices").catch((e) => { if (/Not Found/.test(e.message)) fail("Phone pairing is off on this agentbox (the mobile module isn't enabled)."); throw e; });
      if (sub === "--json") return json(d);
      const items = Array.isArray(d) ? d : d.devices ?? [];
      table(items.map((x) => [x.status, x.name ?? x.model ?? "phone", dim(x.fingerprint ?? ""), dim(ago(x.last_seen_at ?? x.created_at)), dim(String(x.id).slice(0, 8))]));
      if (!items.length) out(dim("No paired devices: agentbox devices pair"));
      return;
    }
    case "approve": case "deny": case "revoke": case "test-push": { await api.post(`/api/devices/${ref}/${sub}`, {}); out("Done."); return; }
    case "revoke-all": { json(await api.post("/api/devices/revoke-all", {})); return; }
    case "pair": {
      if (ref === "--cancel") { await api.del("/api/devices/pairings"); out("Cancelled."); return; }
      const p = await api.post("/api/devices/pairings", {});
      out(`Pairing code ${bold(p.code)} (expires ${ago(p.expires_at)}) · gateway ${p.url}\nScan it from the app's pairing screen, or type the code; then approve it: agentbox devices`);
      return;
    }
    case "push": {
      if (ref) { await api.put("/api/devices/push", { details: ref === "on" }); out(`Notification details: ${ref}.`); return; }
      json(await api.get("/api/devices/push")); return;
    }
    case "gateway": {
      if (ref) { await api.put("/api/devices/gateway", { url: ref }); out("Saved."); return; }
      json(await api.get("/api/devices/gateway")); return;
    }
  }
  fail(`usage: agentbox ${help.devices}`);
});
cmd("screen", "screen [take|release]                      the shared screen: open it, or take/release control", async (api, argv) => {
  if (argv[0] === "take" || argv[0] === "release") { json(await api.post(`/api/display/${argv[0]}`, {})); return; }
  const url = `${api.conn.url}/#/screen`;
  out(url);
  const opener = process.platform === "darwin" ? "open" : "xdg-open";
  spawn(opener, [url], { stdio: "ignore", detached: true }).on("error", () => {}).unref();
});
cmd("api", "api [-X METHOD] [-d JSON] <path>          call any portal API route (raw JSON)", async (api, argv) => {
  let method = "GET", body, p;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "-X") method = String(argv[++i] ?? "").toUpperCase();
    else if (argv[i] === "-d") { body = argv[++i] ?? ""; if (method === "GET") method = "POST"; }
    else p = argv[i];
  }
  if (!p) fail("usage: agentbox api [-X METHOD] [-d JSON] <path>");
  if (!p.startsWith("/")) p = `/${p}`;
  if (!p.startsWith("/api/")) p = `/api${p}`;
  const fn = { GET: api.get, POST: api.post, PUT: api.put, PATCH: api.patch, DELETE: api.del }[method];
  if (!fn) fail(`Unknown method ${method}`);
  json(await (body === undefined ? fn(p) : fn(p, JSON.parse(body))));
});
cmd("control", "control [--json]                           paused? running turns? who has the screen?", async (api) => json(await api.get("/api/control")));

// --- help and dispatch ----------------------------------------------------------------------------

export const PORTAL_USAGE = `On your computer (agentbox login …) or the VM. Tasks, agents, groups and routines are named by name,
title or id prefix (coder#3, "Fix login", 3a67cf). Most commands take --json.

  ${bold("connect")}     login · profiles · use · logout · whoami
  ${bold("overview")}    agentbox (dash) · needs · activity · graph · health · control · pause · resume
  ${bold("work")}        task new · work · show · log · send · chat · watch · stop · done · keep · rename
              notes · note · links · link · services · docs · open · share · shares
  ${bold("review")}      roadmap · plans · plan · plan-gate · changes · review
  ${bold("routines")}    routines · routine · wakeups
  ${bold("team")}        crews · crew · agents · agent · tasks · groups · group · skills · skill
  ${bold("setup")}       helper · setup · approvals · approval · integrations · integration-roles · connect
              repos · repo-set · repo-admin · memory · devices · screen

agentbox help <command> for its options. Global: --profile <name> (or AGENTBOX_PROFILE).`;

export const PORTAL_COMMANDS = new Set([...Object.keys(H).map((k) => k.split(" ")[0]), "help"]);

export async function portalMain(argv, { localConf } = {}) {
  // --profile anywhere selects the portal.
  let profile;
  const i = argv.indexOf("--profile");
  if (i >= 0) { profile = argv[i + 1]; argv = [...argv.slice(0, i), ...argv.slice(i + 2)]; }
  const [first, ...rest] = argv;
  if (first === "help") {
    const k = rest.join(" ");
    const hits = Object.entries(help).filter(([n]) => n === k || n.split(" ")[0] === k);
    out(hits.length ? hits.map(([, u]) => `agentbox ${u}`).join("\n") : PORTAL_USAGE);
    return 0;
  }
  const name = first === undefined ? "dash" : H[`${first} ${rest[0]}`] ? `${first} ${rest[0]}` : first;
  const fn = H[name];
  if (!fn) return null;
  const local = ["login", "profiles", "use", "logout"].includes(name);
  const api = local ? null : client(connection({ profile, localConf }));
  const r = await fn(api, name.includes(" ") ? rest.slice(1) : first === undefined ? [] : rest);
  return typeof r === "number" ? r : 0;
}

/** For the coverage test: every API path this client calls. */
export const SOURCE = new URL(import.meta.url);

/** For tests only. */
export const _test = { args, pick, follow, world };
