#!/usr/bin/env node
// The agentbox command (docs/V2-ARCHITECTURE.md § 4). Installed by setup/bootstrap.sh as
// /usr/local/bin/agentbox → /opt/agentbox/cli/agentbox.mjs. Commands that change the system
// re-run themselves through sudo; reads (status, config get, module check) don't need root.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parse, parseDocument, stringify } from "yaml";
import {
  integrationState, normalizeIntegration, parseAssignments, remainingGates, render, renderContext, stepViews, validateSettings,
} from "./integrations.mjs";
import { readSecretTty } from "./secret-input.mjs";

// The portal and the guide run with UMask=0077, and their agents' sudo inherits it: as root, system
// files (the config, apt keyrings, units) must get normal modes, or the agent user and apt can't read them.
if (process.getuid?.() === 0) process.umask(0o022);
const SELF = fileURLToPath(import.meta.url);
const CONFIG = process.env.AGENTBOX_CONFIG || "/etc/agentbox/config.yaml";
const REQUIRED = ["core", "claude", "access"];
/** Integration settings, summaries and connect records (no secrets). */
const INT_DIR = process.env.AGENTBOX_INTEGRATIONS_DIR || "/etc/agentbox/integrations";
const tty = process.stdout.isTTY;
const c = (code, s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const green = (s) => c(32, s), red = (s) => c(31, s), yellow = (s) => c(33, s), dim = (s) => c(2, s), bold = (s) => c(1, s);

class Fail extends Error {}
const fail = (msg) => { throw new Fail(msg); };

// --- config ---------------------------------------------------------------------------------------

function readDoc() {
  let text;
  try { text = fs.readFileSync(CONFIG, "utf8"); } catch (e) {
    fail(`cannot read ${CONFIG} (${e.code ?? e}). Run setup/bootstrap.sh first, or set AGENTBOX_CONFIG.`);
  }
  const doc = parseDocument(text);
  if (doc.errors.length) fail(`${CONFIG}: ${doc.errors[0].message}`);
  return doc;
}
const cfg = () => readDoc().toJS() ?? {};
const keyPath = (key) => {
  if (!/^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$/.test(key)) fail(`bad key: ${key}`);
  return key.split(".");
};
function getIn(obj, parts) {
  let v = obj;
  for (const p of parts) {
    if (v === null || typeof v !== "object" || !(p in v)) return undefined;
    v = v[p];
  }
  return v;
}

/** Light validation for `config set`; the server re-validates everything at start. */
function validate(parts, value) {
  const [top, sub] = parts;
  const want = (ok, msg) => { if (!ok) fail(`${parts.join(".")}: ${msg}`); };
  if (top === "host") want(["cloud", "lima"].includes(value), "cloud or lima");
  else if (top === "access") want(["tailscale", "cloudflare", "ssh-tunnel"].includes(value), "tailscale, cloudflare or ssh-tunnel");
  else if (top === "user") want(typeof value === "string" && /^[a-z_][a-z0-9_-]{0,31}$/.test(value), "a unix user name");
  else if (top === "agent_sudo" || top === "docker") want(typeof value === "boolean", "true or false");
  else if (top === "paths") want(typeof value === "string" && path.isAbsolute(value), "an absolute path");
  else if (top === "ports" || (top === "mobile" && sub === "serve_port")) want(Number.isInteger(value) && value > 0 && value < 65536, "a TCP port");
  else if (top === "limits") want(Number.isInteger(value) && value >= 1 && value <= 100, "a whole number from 1 to 100");
  else if (top === "modules") {
    want(typeof value === "boolean", "true or false");
    want(!(REQUIRED.includes(sub) && value === false), "this module is always on");
  }
}

function writeDoc(doc) {
  const tmp = `${CONFIG}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, String(doc), { mode: 0o644 });
  fs.chmodSync(tmp, 0o644); // the mode above is masked by the umask; the config is world-readable, no secrets
  fs.renameSync(tmp, CONFIG);
}

function setValue(key, raw) {
  const parts = keyPath(key);
  let value = raw === "" ? "" : parse(raw);
  if (value === null || value === undefined) value = "";
  if (typeof value === "object") fail("set one value at a time (a scalar)");
  validate(parts, value);
  const doc = readDoc();
  doc.setIn(parts, value);
  writeDoc(doc);
}

function printValue(v) {
  if (v === undefined) return false;
  if (v !== null && typeof v === "object") process.stdout.write(stringify(v));
  else console.log(v === null ? "" : String(v));
  return true;
}

// --- privileges and helpers ----------------------------------------------------------------------

const isRoot = () => process.getuid?.() === 0;
/** Re-run this command as root (keeping the config and source locations). */
function asRoot(args) {
  // AGENTBOX_NO_SUDO=1 (the CLI's tests): run as is; writes simply fail without the permissions.
  if (isRoot() || process.env.AGENTBOX_NO_SUDO === "1") return;
  const env = [`AGENTBOX_CONFIG=${CONFIG}`];
  if (process.env.AGENTBOX_SRC) env.push(`AGENTBOX_SRC=${process.env.AGENTBOX_SRC}`);
  if (process.env.AGENTBOX_INTEGRATIONS_DIR) env.push(`AGENTBOX_INTEGRATIONS_DIR=${process.env.AGENTBOX_INTEGRATIONS_DIR}`);
  // Not interactive (the portal's setup agent, scripts): `sudo -n`, so a missing grant fails at once
  // ("a password is required") instead of waiting for a password nobody can type. The portal runs
  // these only while the setup agent holds its temporary grant (server/src/sudo.ts).
  const nonInteractive = !process.stdin.isTTY ? ["-n"] : [];
  const r = spawnSync("sudo", [...nonInteractive, "env", ...env, process.execPath, SELF, ...args], { stdio: "inherit" });
  process.exit(r.status ?? 1);
}
const agentUser = (conf) => conf.user || "agentbox";
function homeOf(user) {
  const r = spawnSync("getent", ["passwd", user], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.split(":")[5] : `/home/${user}`;
}
function srcDir(conf) {
  const s = process.env.AGENTBOX_SRC || conf.paths?.src;
  if (!s || !fs.existsSync(path.join(s, "setup", "modules"))) fail(`the agentbox source isn't at ${s} (paths.src in ${CONFIG})`);
  return s;
}
const has = (cmd) => spawnSync("bash", ["-c", `command -v ${cmd}`], { stdio: "ignore" }).status === 0;
const systemd = () => has("systemctl") && fs.existsSync("/run/systemd/system");
function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: "inherit", ...opts });
  if (r.status !== 0) fail(`${cmd} ${args.join(" ")} failed (exit ${r.status ?? r.signal})`);
}
function systemctl(...args) {
  if (!systemd()) { console.log(dim(`  (no systemd here: skipped systemctl ${args.join(" ")})`)); return; }
  sh("systemctl", args);
}

/** Run a read-only check as the agent user: bash -lc, 10 s timeout. True when it exits 0. */
function runCheck(conf, check) {
  const user = agentUser(conf);
  const me = os.userInfo().username;
  const [cmd, args] = me === user ? ["bash", ["-lc", check]] : ["sudo", ["-n", "-H", "-u", user, "--", "bash", "-lc", check]];
  const r = spawnSync("timeout", ["10", cmd, ...args], { stdio: "ignore" });
  return r.status === 0;
}

/** The same, without blocking (for status of many integrations): { ok, code, output, timedOut }. */
function runCheckAsync(conf, check, { capture = false, timeoutMs = 10_000 } = {}) {
  const user = agentUser(conf);
  const me = os.userInfo().username;
  const [cmd, args] = me === user ? ["bash", ["-lc", check]] : ["sudo", ["-n", "-H", "-u", user, "--", "bash", "-lc", check]];
  return new Promise((resolve) => {
    let out = "", stdout = "", timedOut = false;
    // Its own process group, so a timeout kills the whole check (bash and its children).
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], detached: true });
    const timer = setTimeout(() => { timedOut = true; try { process.kill(-child.pid, "SIGKILL"); } catch { /* gone */ } }, timeoutMs);
    const take = (b) => { out += b; if (out.length > 64 * 1024) out = out.slice(-16 * 1024); };
    child.stdout.on("data", (b) => { take(b); if (capture && stdout.length < 64 * 1024) stdout += b; });
    child.stderr.on("data", take);
    child.on("error", (e) => { clearTimeout(timer); resolve({ ok: false, code: 127, output: e.message, timedOut: false }); });
    child.on("close", (code) => {
      clearTimeout(timer);
      const text = out.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").trim();
      // capture: stdout only (a login shell may print noise on stderr), whole.
      resolve({ ok: code === 0 && !timedOut, code: timedOut ? null : code, output: capture ? stdout.trim() : text.split("\n").slice(-6).join("\n").slice(-600), timedOut });
    });
  });
}
/** Run async jobs with a concurrency limit, keeping order. */
async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  }));
  return out;
}

// --- modules ---------------------------------------------------------------------------------------

function modulesDir(conf) { return path.join(srcDir(conf), "setup", "modules"); }
function loadModule(conf, id) {
  if (!/^[a-z0-9-]+$/.test(id)) fail(`bad module id: ${id}`);
  const dir = path.join(modulesDir(conf), id);
  const file = path.join(dir, "module.yaml");
  if (!fs.existsSync(file)) fail(`no such module: ${id} (${file})`);
  const m = parse(fs.readFileSync(file, "utf8"));
  return { ...m, dir, depends: m.depends ?? [], steps: m.steps ?? [], units: m.units ?? [] };
}
function allModules(conf) {
  return fs.readdirSync(modulesDir(conf), { withFileTypes: true })
    .filter((d) => d.isDirectory() && fs.existsSync(path.join(modulesDir(conf), d.name, "module.yaml")))
    .map((d) => loadModule(conf, d.name));
}
const isEnabled = (conf, id) => REQUIRED.includes(id) || conf.modules?.[id] === true;
/** Base modules (kind: base) are the first run's; everything else is an integration (§ 10). */
const isIntegration = (m) => m.kind === "integration";
const baseModules = (conf) => allModules(conf).filter((m) => !isIntegration(m));
function notAnIntegration(m, verb) {
  if (isIntegration(m)) fail(`${m.id} is an integration: use \`agentbox integration ${verb} ${m.id}\` (agentbox module is for the base modules)`);
}

/** Dependency order (depends first). */
function ordered(conf, ids) {
  const out = [];
  const seen = new Set();
  const visit = (id, chain = []) => {
    if (seen.has(id)) return;
    if (chain.includes(id)) fail(`dependency cycle: ${[...chain, id].join(" → ")}`);
    let m;
    try { m = loadModule(conf, id); } catch (e) { if (id === "access") return; throw e; } // access: its own workstream
    for (const d of m.depends) visit(d, [...chain, id]);
    seen.add(id);
    out.push(m);
  };
  for (const id of ids) visit(id);
  return out;
}

function scriptEnv(conf, m) {
  const user = agentUser(conf);
  return {
    ...process.env,
    PATH: `/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
    DEBIAN_FRONTEND: "noninteractive",
    AGENTBOX_CONFIG: CONFIG,
    AGENTBOX_SRC: srcDir(conf),
    AGENTBOX_MODULE: m.id,
    AGENTBOX_MODULE_DIR: m.dir,
    AGENTBOX_USER: user,
    AGENTBOX_HOME: homeOf(user),
  };
}
function runScript(conf, m, name, logFile = null) {
  const file = path.join(m.dir, name);
  if (!fs.existsSync(file)) return false;
  console.log(bold(`==> ${m.id}: ${name}`));
  if (logFile) {
    // Also into the setup guide's progress log for this module (the guide shows it live).
    try { fs.appendFileSync(logFile, `==> ${m.id}: ${name}\n`); } catch { /* best effort */ }
    sh("bash", ["-c", 'set -o pipefail; bash "$1" 2>&1 | tee -a "$2"', "agentbox-module", file, logFile], { cwd: m.dir, env: scriptEnv(conf, m) });
  } else {
    sh("bash", [file], { cwd: m.dir, env: scriptEnv(conf, m) });
  }
  return true;
}

/**
 * While the setup guide is installed, `module install` (run by the setup agent, output not a TTY)
 * also writes each module's script output to <data>/guide/runs/<id>.log (0600, the agent user's),
 * so the guide can show it live in the step's card. A fresh file (new inode) per run.
 */
function progressLog(conf, m) {
  if (process.stdout.isTTY || !isRoot()) return null;
  const guideDir = path.join(conf.paths?.data ?? "/opt/agentbox/data", "guide");
  if (!fs.existsSync(guideDir)) return null;
  try {
    const user = agentUser(conf);
    const runs = path.join(guideDir, "runs");
    fs.mkdirSync(runs, { recursive: true, mode: 0o700 });
    spawnSync("chown", [`${user}:${user}`, runs]);
    const file = path.join(runs, `${m.id}.log`);
    fs.rmSync(file, { force: true });
    fs.writeFileSync(file, "", { mode: 0o600 });
    spawnSync("chown", [`${user}:${user}`, file]);
    return file;
  } catch { return null; }
}

/** Fill @PLACEHOLDERS@ in a unit file from the config. */
function renderUnit(conf, text) {
  const user = agentUser(conf);
  const p = conf.paths ?? {}, ports = conf.ports ?? {};
  const vars = {
    USER: user, HOME: homeOf(user), APP: p.app, DATA: p.data, SRC: srcDir(conf), SECRETS: p.secrets, WORK: p.work,
    PORTAL_PORT: ports.portal, SCREEN_PORT: ports.screen, TERMINAL_PORT: ports.terminal, GATEWAY_PORT: ports.gateway,
    GUIDE_PORT: ports.guide, CONFIG,
  };
  return text.replace(/@([A-Z_]+)@/g, (all, k) => {
    if (vars[k] === undefined || vars[k] === null) fail(`unit placeholder ${all} has no value (check ${CONFIG})`);
    return String(vars[k]);
  });
}

/** Install every file under units/ (drop-in dirs included) into /etc/systemd/system. */
function installUnits(conf, m) {
  const dir = path.join(m.dir, "units");
  if (!fs.existsSync(dir)) return;
  const walk = (rel) => {
    for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const r = path.join(rel, e.name);
      if (e.isDirectory()) { walk(r); continue; }
      const dest = path.join("/etc/systemd/system", r);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, renderUnit(conf, fs.readFileSync(path.join(dir, r), "utf8")), { mode: 0o644 });
      console.log(dim(`  unit ${dest}`));
    }
  };
  walk("");
  systemctl("daemon-reload");
}
function removeUnits(m) {
  const dir = path.join(m.dir, "units");
  if (!fs.existsSync(dir)) return;
  if (m.units.length) {
    if (systemd()) spawnSync("systemctl", ["disable", "--now", ...m.units], { stdio: "inherit" });
  }
  const walk = (rel) => {
    for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const r = path.join(rel, e.name);
      if (e.isDirectory()) { walk(r); continue; }
      fs.rmSync(path.join("/etc/systemd/system", r), { force: true });
    }
  };
  walk("");
  if (systemd()) spawnSync("systemctl", ["daemon-reload"], { stdio: "inherit" });
}

/** Copy team-rule examples to /team (never overwriting the owner's edits). */
function copyTeam(conf, m) {
  const dir = path.join(m.dir, "team");
  if (!fs.existsSync(dir)) return;
  const team = conf.paths?.team ?? "/team";
  const user = agentUser(conf);
  fs.mkdirSync(team, { recursive: true });
  for (const f of fs.readdirSync(dir)) {
    const dest = path.join(team, f);
    if (fs.existsSync(dest)) continue;
    fs.copyFileSync(path.join(dir, f), dest);
    spawnSync("chown", [`${user}:${user}`, dest]);
    console.log(dim(`  team rule example ${dest} (edit it to fit your team)`));
  }
}

function installModule(conf, m, { gates = true } = {}) {
  console.log(bold(`\n### ${m.id}: ${m.title ?? ""}`));
  const logFile = progressLog(conf, m);
  runScript(conf, m, "install.sh", logFile);
  installUnits(conf, m);
  runScript(conf, m, "configure.sh", logFile);
  copyTeam(conf, m);
  if (m.units.length) {
    systemctl("enable", ...m.units);
    systemctl("restart", ...m.units);
  }
  if (!gates) return 0;
  const pending = m.steps.filter((s) => s.human && s.check && when(conf, s.when) && !runCheck(conf, s.check));
  for (const s of pending) {
    console.log(yellow(`  YOUR TURN: ${s.title}`));
    for (const line of String(s.instructions ?? "").trim().split("\n")) console.log(`    ${line}`);
  }
  return pending.length;
}

/** A step's `when:` condition, e.g. "access == tailscale" or "host != lima". No condition: true. */
function when(conf, cond) {
  if (cond === undefined || cond === null || cond === "") return true;
  const m = /^\s*([A-Za-z0-9_.-]+)\s*(==|!=)\s*"?([^"]*?)"?\s*$/.exec(String(cond));
  if (!m) fail(`bad when: ${cond}`);
  const v = getIn(conf, m[1].split("."));
  const eq = String(v ?? "") === m[3];
  return m[2] === "==" ? eq : !eq;
}

function stepStates(conf, m) {
  return m.steps.map((s) => {
    if (!when(conf, s.when)) return { ...s, state: "skip" };
    if (!s.check) return { ...s, state: "-" };
    const okNow = runCheck(conf, s.check);
    return { ...s, state: okNow ? "ok" : s.human ? "you" : "fail" };
  });
}

// --- integrations (§ 10) ---------------------------------------------------------------------------

function loadIntegration(conf, id) {
  const m = loadModule(conf, id);
  if (!isIntegration(m)) fail(`${id} is a base module, not an integration: use \`agentbox module …\``);
  try { return normalizeIntegration(m); } catch (e) { fail(e.message); }
}
function allIntegrations(conf) {
  return allModules(conf).filter(isIntegration).map((m) => {
    try { return normalizeIntegration(m); } catch (e) { fail(e.message); }
  });
}
const intFile = (id, ext) => path.join(INT_DIR, `${id}${ext}`);
const teamFile = (conf, id) => path.join(conf.paths?.team ?? "/team", "integrations", `${id}.md`);

function readYamlFile(file) {
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch (e) { if (e.code === "ENOENT") return null; fail(`cannot read ${file} (${e.code ?? e})`); }
  try { return parse(text) ?? {}; } catch (e) { fail(`${file}: ${e.message}`); }
}
/** The saved settings (null: never saved). */
const readSettings = (id) => readYamlFile(intFile(id, ".yaml"));
function writeAtomic(file, text, mode = 0o644) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o755 });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, text, { mode });
  fs.chmodSync(tmp, mode);
  fs.renameSync(tmp, file);
}
function writeSettings(m, values) {
  const head = `# ${m.title} integration settings (agentbox integration settings ${m.id}). No secrets here.\n`;
  writeAtomic(intFile(m.id, ".yaml"), head + stringify(values ?? {}));
}
/** The last connect / verify / disconnect (for the error and disconnected states). */
function readLast(id) {
  try { return JSON.parse(fs.readFileSync(intFile(id, ".state.json"), "utf8")); } catch { return null; }
}
function writeLast(id, last) {
  try { writeAtomic(intFile(id, ".state.json"), `${JSON.stringify({ ...last, at: new Date().toISOString() })}\n`); } catch { /* not root: a read-only caller */ }
}

/** Render a template text for an integration with its settings (a broken template is a manifest bug). */
function renderFor(conf, m, text, saved) {
  try { return render(text, renderContext(m.settings, saved ?? readSettings(m.id) ?? {}, conf)); } catch (e) { fail(`${m.id}: ${e.message}`); }
}

/** /team/integrations/<id>.md and <INT_DIR>/<id>.summary.md from the templates and the settings. */
function renderIntegration(conf, m) {
  const saved = readSettings(m.id) ?? {};
  const written = [];
  if (m.instructions.summary) {
    const f = intFile(m.id, ".summary.md");
    writeAtomic(f, `${renderFor(conf, m, m.instructions.summary, saved).trim()}\n`);
    written.push(f);
  }
  if (m.instructions.file) {
    const tpl = path.join(m.dir, m.instructions.file);
    if (!fs.existsSync(tpl)) fail(`${m.id}: ${tpl} is missing`);
    const body = renderFor(conf, m, fs.readFileSync(tpl, "utf8"), saved).replace(/\n{3,}/g, "\n\n").trim();
    const head = `<!-- Generated by agentbox from setup/modules/${m.id}/${m.instructions.file} and ${intFile(m.id, ".yaml")}.\n` +
      `     Don't edit: change the settings (agentbox integration settings ${m.id} --set key=value), or put\n` +
      `     your team's own rules in ${conf.paths?.team ?? "/team"}/*.md. -->\n\n`;
    const f = teamFile(conf, m.id);
    const dir = path.dirname(f);
    fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
    fs.chmodSync(dir, 0o755);
    writeAtomic(f, `${head}${body}\n`);
    written.push(f);
  }
  return written;
}
function removeRendered(conf, m) {
  const gone = [];
  for (const f of [teamFile(conf, m.id), intFile(m.id, ".summary.md")]) {
    if (fs.existsSync(f)) { fs.rmSync(f, { force: true }); gone.push(f); }
  }
  return gone;
}

/** Everything the portal and the setup agent need about one integration (`integration status --json`). */
async function integrationView(conf, m, { checks = true } = {}) {
  const enabled = conf.modules?.[m.id] === true;
  const savedRaw = readSettings(m.id);
  const v = validateSettings(m.settings, savedRaw ?? {});
  const results = {};
  if (checks && m.available) {
    const todo = m.steps.filter((s) => s.check && when(conf, s.when));
    const rs = await pool(todo, 4, (s) => runCheckAsync(conf, s.check));
    todo.forEach((s, i) => { results[s.id] = rs[i]; });
  }
  const ctx = renderContext(m.settings, savedRaw ?? {}, conf);
  const renderText = (t) => { try { return render(t, ctx); } catch { return t; } };
  const steps = stepViews(m.steps, results, { enabled, applies: (s) => when(conf, s.when), renderText });
  const last = readLast(m.id);
  const state = integrationState({ available: m.available, enabled, steps, settingsSaved: savedRaw !== null || m.settings.length === 0, missing: v.missing, errors: v.errors, last });
  let account = null;
  if (checks && enabled && m.account && steps.every((s) => s.state !== "pending" || !s.human)) {
    const r = await runCheckAsync(conf, m.account, { capture: true });
    if (r.ok) account = r.output.split("\n")[0].trim().slice(0, 120) || null;
  }
  let summary = null;
  if (m.instructions.summary) summary = renderText(m.instructions.summary).trim();
  const tf = m.instructions.file ? teamFile(conf, m.id) : null;
  const view = {
    id: m.id,
    title: m.title ?? m.id,
    description: String(m.description ?? "").trim(),
    category: m.category,
    available: m.available,
    enabled,
    state,
    account,
    depends: m.depends,
    steps,
    settings: {
      file: intFile(m.id, ".yaml"),
      saved: savedRaw !== null,
      schema: m.settings,
      values: v.values,
      missing: v.missing,
      errors: v.errors,
    },
    instructions: {
      summary,
      summary_file: m.instructions.summary ? intFile(m.id, ".summary.md") : null,
      file: tf,
      rendered: tf ? fs.existsSync(tf) : !!(m.instructions.summary && fs.existsSync(intFile(m.id, ".summary.md"))),
    },
    skills: m.skills,
    default_roles: m.default_roles,
    revoke: m.revoke,
    gates: [],
    last,
    checked_at: checks ? new Date().toISOString() : null,
  };
  view.gates = enabled ? remainingGates(view) : [];
  return view;
}

const STATE_MARK = { connected: green("✔"), connecting: yellow("⏸"), error: red("✖"), available: dim("○"), disconnected: dim("○"), unavailable: dim("·") };

function printView(v) {
  console.log(`${STATE_MARK[v.state] ?? " "} ${bold(v.id)} ${dim(`(${v.category})`)}  ${v.state}${v.account ? `  ${dim("as")} ${v.account}` : ""}`);
  for (const s of v.steps) {
    const icon = { done: green("✔"), human: yellow("⏸"), failed: red("✖"), pending: dim("○"), skipped: dim("─") }[s.state];
    console.log(`    ${icon} ${s.id.padEnd(10)} ${s.title}`);
    if (s.state === "failed" && s.check?.output) for (const l of s.check.output.split("\n").slice(-3)) console.log(dim(`        ${l}`));
  }
  for (const e of v.settings.errors) console.log(red(`    setting ${e.key}: ${e.error}`));
}

function printGates(v) {
  if (!v.gates.length) return;
  console.log(yellow(`\nWaiting for you (${v.id}):`));
  for (const g of v.gates) {
    if (g.kind === "setting") { console.log(yellow(`  - setting ${g.key}: ${g.title}`)); console.log(`      ${g.command}`); continue; }
    console.log(yellow(`  - ${g.title}`));
    for (const line of String(g.instructions ?? "").split("\n")) console.log(`      ${line}`);
  }
}

/** The non-flag arguments (skipping the values of flags that take one). */
function positional(args) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    if (["--set", "--unset", "--values", "--get"].includes(args[i])) { i++; continue; }
    if (!args[i].startsWith("-")) out.push(args[i]);
  }
  return out;
}

/** --set k=v (repeatable), --values '<json object>', --unset k (repeatable) → { changes } */
function settingArgs(rest) {
  const sets = [], unsets = [];
  let json = null;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--set") sets.push(rest[++i] ?? fail("--set key=value"));
    else if (a.startsWith("--set=")) sets.push(a.slice(6));
    else if (a === "--unset") unsets.push(rest[++i] ?? fail("--unset key"));
    else if (a === "--values") {
      try { json = JSON.parse(rest[++i] ?? ""); } catch { fail("--values takes a JSON object"); }
      if (!json || typeof json !== "object" || Array.isArray(json)) fail("--values takes a JSON object");
    }
  }
  let changes;
  try { changes = parseAssignments(sets); } catch (e) { fail(e.message); }
  if (json) Object.assign(changes, json);
  for (const k of unsets) changes[k] = null;
  return changes;
}

/** Merge changes into the saved settings; fail (nothing written) on any invalid value. */
function applySettings(m, changes) {
  const saved = readSettings(m.id) ?? {};
  const v = validateSettings(m.settings, changes, { partial: true });
  if (v.errors.length) fail(v.errors.map((e) => `${m.id}.${e.key}: ${e.error}`).join("\n"));
  const next = { ...saved };
  for (const [k, val] of Object.entries(changes)) {
    // null / "" clear a setting (back to its default); a list given as [] is kept: an explicit "none".
    if (val === null || v.values[k] === "") delete next[k];
    else next[k] = v.values[k];
  }
  // Drop keys the schema no longer knows.
  for (const k of Object.keys(next)) if (!m.settings.some((d) => d.key === k)) delete next[k];
  writeSettings(m, next);
  return next;
}

function runVerifyScript(conf, m) {
  if (!fs.existsSync(path.join(m.dir, "verify.sh"))) return true;
  console.log(bold(`==> ${m.id}: verify.sh`));
  const user = agentUser(conf);
  const env = scriptEnv(conf, m);
  // verify.sh runs as the agent user, like the checks; it may sudo for root-only reads.
  const me = os.userInfo().username;
  const r = me === user
    ? spawnSync("bash", [path.join(m.dir, "verify.sh")], { stdio: "inherit", env, cwd: m.dir })
    : spawnSync("sudo", ["-H", "-u", user, "env", ...Object.entries(env).filter(([k]) => k.startsWith("AGENTBOX_") || k === "PATH").map(([k, v]) => `${k}=${v}`), "bash", path.join(m.dir, "verify.sh")], { stdio: "inherit", cwd: m.dir });
  if (r.status !== 0) { console.log(red(`✖ ${m.id}: verify.sh failed`)); return false; }
  return true;
}

async function integrationCmd(argv) {
  const [, sub, ...rest] = argv;
  const json = rest.includes("--json");
  const id = positional(rest)[0];
  const conf = cfg();
  switch (sub) {
    case "list": {
      const all = allIntegrations(conf);
      if (json) {
        console.log(JSON.stringify({ integrations: all.map((m) => ({
          id: m.id, title: m.title ?? m.id, description: String(m.description ?? "").trim(), category: m.category,
          available: m.available, enabled: conf.modules?.[m.id] === true, depends: m.depends,
        })) }, null, 2));
        return 0;
      }
      let cat = null;
      for (const m of [...all].sort((a, b) => CATEGORY_ORDER(a.category) - CATEGORY_ORDER(b.category) || a.id.localeCompare(b.id))) {
        if (m.category !== cat) { cat = m.category; console.log(bold(`\n${cat}`)); }
        const on = conf.modules?.[m.id] === true;
        const tag = !m.available ? dim("soon") : on ? green("on  ") : dim("off ");
        console.log(`  ${tag} ${m.id.padEnd(12)} ${m.title ?? ""}`);
      }
      console.log(dim("\nagentbox integration status [<id>] runs the checks; connect <id> sets one up."));
      return 0;
    }

    case "status": {
      const mods = id ? [loadIntegration(conf, id)] : allIntegrations(conf);
      const views = await pool(mods, 4, (m) => integrationView(conf, m, { checks: !rest.includes("--no-checks") }));
      if (json) { console.log(JSON.stringify(id ? views[0] : { integrations: views, checked_at: new Date().toISOString() }, null, 2)); return 0; }
      for (const v of views) printView(v);
      if (id) printGates(views[0]);
      return id ? (views[0].state === "connected" ? 0 : 1) : 0;
    }

    case "connect": {
      if (!id) fail("usage: agentbox integration connect <id> [--set key=value]…");
      asRoot(argv);
      const m = loadIntegration(conf, id);
      if (!m.available) fail(`${id} is coming soon: it can't be connected yet`);
      for (const d of m.depends) {
        let dm;
        try { dm = loadModule(conf, d); } catch { if (d === "access") continue; throw new Fail(`${id} needs ${d}, which doesn't exist`); }
        if (isIntegration(dm) && conf.modules?.[d] !== true) fail(`${id} needs ${d}: connect it first (agentbox integration connect ${d})`);
      }
      const changes = settingArgs(rest);
      if (Object.keys(changes).length) applySettings(m, changes);
      else if (readSettings(m.id) === null && m.settings.every((d) => !d.required)) writeSettings(m, {}); // nothing to ask: saved
      if (conf.modules?.[id] !== true) { setValue(`modules.${id}`, "true"); console.log(`modules.${id} = true`); }
      const conf2 = cfg();
      writeLast(id, { action: "connect", ok: null });
      try {
        installModule(conf2, m, { gates: false });
      } catch (e) {
        writeLast(id, { action: "connect", ok: false, error: String(e.message ?? e).slice(0, 2000) });
        throw e;
      }
      for (const f of renderIntegration(conf2, m)) console.log(dim(`  rendered ${f}`));
      writeLast(id, { action: "connect", ok: true });
      const v = await integrationView(conf2, m);
      console.log("");
      printView(v);
      printGates(v);
      if (v.state === "connected") console.log(green(`\n${id} connected.`));
      else if (!v.gates.length) console.log(yellow(`\n${id}: installed; run \`agentbox integration verify ${id}\` to finish.`));
      // The phone gateway and push start with the portal (server/src/index.ts); the rest is picked up live.
      if (STARTS_WITH_PORTAL.has(id)) console.log(yellow(`\nRestart the portal to start ${id === "push" ? "push notifications" : "the phone gateway"}: sudo agentbox restart (when no agent tasks are running).`));
      else console.log(dim("(The portal picks up the change on its own; nothing was restarted.)"));
      return 0;
    }

    case "verify": {
      if (!id) fail("usage: agentbox integration verify <id>");
      asRoot(argv);
      const m = loadIntegration(conf, id);
      if (conf.modules?.[id] !== true) fail(`${id} isn't connected: agentbox integration connect ${id}`);
      const ok = runVerifyScript(conf, m);
      const v = await integrationView(conf, m);
      const good = ok && v.state === "connected";
      writeLast(id, good ? { action: "verify", ok: true } : { action: "verify", ok: false, error: ok ? `not connected yet: ${v.gates.map((g) => g.title).join("; ") || v.steps.filter((s) => s.state === "failed").map((s) => s.title).join("; ")}` : "verify.sh failed" });
      const v2 = good ? v : await integrationView(conf, m, { checks: true });
      printView(v2);
      printGates(v2);
      if (good && v.instructions.file && !v.instructions.rendered) renderIntegration(conf, m);
      return good ? 0 : 1;
    }

    case "disconnect": {
      if (!id) fail("usage: agentbox integration disconnect <id> [--forget]");
      asRoot(argv);
      const m = loadIntegration(conf, id);
      const users = allModules(conf).filter((x) => x.id !== id && isEnabled(conf, x.id) && x.depends.includes(id));
      if (users.length) fail(`${users.map((x) => x.id).join(", ")} need(s) ${id}; disconnect those first`);
      runScript(conf, m, "disable.sh");
      removeUnits(m);
      for (const f of removeRendered(conf, m)) console.log(dim(`  removed ${f}`));
      if (conf.modules?.[id] === true) setValue(`modules.${id}`, "false");
      if (rest.includes("--forget")) { fs.rmSync(intFile(id, ".yaml"), { force: true }); console.log(dim(`  removed ${intFile(id, ".yaml")}`)); }
      writeLast(id, { action: "disconnect", ok: true });
      console.log(`${id} disconnected: its instructions are gone and agents no longer get it. Packages stay installed.`);
      if (m.revoke) {
        console.log(yellow("Credentials were left alone. To revoke them:"));
        for (const l of m.revoke.split("\n")) console.log(`  ${l}`);
      }
      return 0;
    }

    case "settings": {
      if (!id) fail("usage: agentbox integration settings <id> [--set key=value]… [--unset key] [--values JSON] [--get key] [--json]");
      const m = loadIntegration(conf, id);
      const gi = rest.indexOf("--get");
      if (gi >= 0) {
        const key = rest[gi + 1] ?? fail("--get <key>");
        if (!m.settings.some((d) => d.key === key)) fail(`${id} has no setting ${key}`);
        const ctx = renderContext(m.settings, readSettings(id) ?? {}, conf);
        const val = ctx[key];
        console.log(Array.isArray(val) ? val.join(",") : String(val ?? ""));
        return 0;
      }
      const changes = settingArgs(rest);
      if (Object.keys(changes).length) {
        asRoot(argv);
        applySettings(m, changes);
        if (conf.modules?.[id] === true) {
          runScript(conf, m, "configure.sh");
          for (const f of renderIntegration(conf, m)) console.log(dim(`  rendered ${f}`));
        }
      }
      const saved = readSettings(id);
      const v = validateSettings(m.settings, saved ?? {});
      if (json) { console.log(JSON.stringify({ id, file: intFile(id, ".yaml"), saved: saved !== null, schema: m.settings, values: v.values, missing: v.missing, errors: v.errors }, null, 2)); return 0; }
      if (!m.settings.length) { console.log(`${id} has no settings.`); return 0; }
      for (const d of m.settings) {
        const has = d.key in v.values;
        const shown = has ? (Array.isArray(v.values[d.key]) ? (v.values[d.key].join(", ") || "(none)") : String(v.values[d.key])) : d.default !== undefined ? dim(`${Array.isArray(d.default) ? d.default.join(", ") : d.default} (default)`) : dim("(not set)");
        console.log(`  ${(d.required && !has ? red : (x) => x)(d.key.padEnd(22))} ${shown}  ${dim(d.prompt)}`);
      }
      if (v.missing.length) console.log(red(`missing: ${v.missing.join(", ")}`));
      for (const e of v.errors) console.log(red(`${e.key}: ${e.error}`));
      return 0;
    }

    case "render": {
      asRoot(argv);
      const mods = id ? [loadIntegration(conf, id)] : allIntegrations(conf).filter((m) => conf.modules?.[m.id] === true);
      if (id && conf.modules?.[id] !== true) fail(`${id} isn't connected: agentbox integration connect ${id}`);
      for (const m of mods) for (const f of renderIntegration(conf, m)) console.log(`rendered ${f}`);
      if (!mods.length) console.log("no connected integrations");
      return 0;
    }
  }
  fail(`usage: agentbox integration list|status|connect|verify|disconnect|settings|render [<id>]\n${USAGE_INT}`);
}

const CATEGORY_ORDER = (c) => ["code-hosting", "cloud", "cluster", "database", "chat", "design", "connectivity", "extras"].indexOf(c);

// --- the portal ------------------------------------------------------------------------------------

/**
 * Local callers prove they're on the box with X-Agentbox-Local-Token: the contents of
 * <data>/local-token (0600, the agent user's; written by the portal at start). Readable by the agent
 * user and root only, so `agentbox api` re-runs itself through sudo for anyone else.
 */
function localToken(conf) {
  const file = process.env.AGENTBOX_LOCAL_TOKEN_FILE || path.join(conf.paths?.data ?? "/opt/agentbox/data", "local-token");
  try { return fs.readFileSync(file, "utf8").trim(); } catch { return null; }
}
async function api(conf, apiPath, { method = "GET", body } = {}) {
  if (!apiPath.startsWith("/")) apiPath = `/${apiPath}`;
  if (!apiPath.startsWith("/api/")) apiPath = `/api${apiPath}`;
  const headers = {};
  const token = localToken(conf);
  if (token) headers["x-agentbox-local-token"] = token;
  if (body !== undefined) headers["content-type"] = "application/json";
  const port = conf.ports?.portal ?? 7700;
  return fetch(`http://127.0.0.1:${port}${apiPath}`, { method, headers, body, signal: AbortSignal.timeout(30_000) });
}

async function busyCount(conf) {
  try {
    const r = await api(conf, "/api/tasks");
    if (!r.ok) return { n: 0, known: false };
    const tasks = await r.json();
    return { n: tasks.filter((t) => t.status === "running" || t.status === "queued").length, known: true };
  } catch { return { n: 0, known: false }; }
}
async function refuseIfBusy(conf, force, what) {
  if (force) return;
  const { n, known } = await busyCount(conf);
  if (n > 0) fail(`${n} agent task(s) running or queued; ${what} would interrupt them. Wait, use Pause all, or rerun with --force.`);
  if (!known) console.log(dim("  (couldn't ask the portal whether agents are busy; it may be stopped)"));
}

/** Units of every enabled module, core's web service last on start (first on stop). */
function enabledUnits(conf) {
  const mods = ordered(conf, Object.keys({ ...Object.fromEntries(REQUIRED.map((id) => [id, true])), ...(conf.modules ?? {}) }).filter((id) => isEnabled(conf, id)));
  const units = mods.flatMap((m) => m.units);
  return [...units.filter((u) => u !== "agentbox-web.service"), ...units.filter((u) => u === "agentbox-web.service")];
}

// --- repos (the portal owns them: clones, worktrees, maps; docs/V2-ARCHITECTURE.md, Changes (repos)) -----

async function apiJson(conf, apiPath, opts = {}) {
  let r;
  try { r = await api(conf, apiPath, opts); } catch (e) { fail(`the portal isn't answering on 127.0.0.1:${conf.ports?.portal ?? 7700} (${e.cause?.code ?? e.message})`); }
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  if (!r.ok) {
    const e = new Fail(data?.error ?? `${r.status} ${text.slice(0, 200)}`);
    e.detail = data?.detail;
    throw e;
  }
  return data;
}

const ago = (iso) => {
  if (!iso) return "never";
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  return s < 90 ? `${s}s ago` : s < 5400 ? `${Math.round(s / 60)}m ago` : s < 129600 ? `${Math.round(s / 3600)}h ago` : `${Math.round(s / 86400)}d ago`;
};
const REPO_MARK = { ready: green("✔"), cloning: yellow("●"), error: red("✖"), archived: dim("─") };

function printRepo(r, long = false) {
  const wts = (r.worktrees ?? []).filter((w) => w.status === "active" || w.status === "kept");
  console.log(`${REPO_MARK[r.status] ?? "?"} ${r.name.padEnd(20)} ${r.status.padEnd(8)} ${String(r.default_branch ?? "?").padEnd(10)} fetched ${ago(r.last_fetch_at).padEnd(9)} map ${r.map_status.padEnd(7)} ${wts.length} worktree(s)${r.error ? red(`  ${r.error}`) : ""}`);
  if (!long) return;
  console.log(dim(`    ${r.url} · ${r.provider} · ${r.path ?? ""}`));
  if (r.description) console.log(dim(`    ${r.description}`));
  if (r.test_command) console.log(dim(`    tests: ${r.test_command}`));
  console.log(dim(`    protected: ${r.protected_branches.join(", ") || "none"} · agents may merge: ${r.agents_may_merge ? "yes" : "no"} · deploy: ${r.agents_may_deploy ? "yes" : "no"}`));
  for (const w of wts) console.log(`    ${w.status === "kept" ? yellow("kept") : "open"} ${w.path} (${w.branch}) ${w.instance ? `${w.instance.name}: ${w.instance.label ?? ""}` : ""}${w.note ? dim(` · ${w.note}`) : ""}`);
}

async function repoCmd(argv) {
  const [, sub, ...rest] = argv;
  const conf = cfg();
  const json = rest.includes("--json");
  const args = rest.filter((a) => a !== "--json");
  const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  switch (sub) {
    case "list": case undefined: {
      const d = await apiJson(conf, "/api/repos");
      if (json) { console.log(JSON.stringify(d.repos, null, 2)); return 0; }
      if (!d.repos.length) console.log(dim("No repos yet: agentbox repo add <url>"));
      for (const r of d.repos) printRepo(r);
      return 0;
    }
    case "status": {
      const name = args.find((a) => !a.startsWith("-"));
      const repos = name ? [await apiJson(conf, `/api/repos/${encodeURIComponent(name)}`)] : (await apiJson(conf, "/api/repos")).repos;
      if (json) { console.log(JSON.stringify(name ? repos[0] : repos, null, 2)); return 0; }
      for (const r of repos) printRepo(r, true);
      return repos.some((r) => r.status === "error") ? 1 : 0;
    }
    case "add": {
      const url = args.find((a) => !a.startsWith("-") && ![opt("--name"), opt("--branch"), opt("--roles")].includes(a));
      if (!url) fail("usage: agentbox repo add <url> [--name n] [--branch b] [--roles a,b] [--no-map] [--no-wait]");
      const body = { url, name: opt("--name"), default_branch: opt("--branch"), allowed_roles: opt("--roles") ? opt("--roles").split(",").map((s) => s.trim()).filter(Boolean) : undefined, onboard: !args.includes("--no-map") };
      let r = await apiJson(conf, "/api/repos", { method: "POST", body: JSON.stringify(body) });
      console.log(`added ${r.name}: cloning ${r.url}`);
      if (args.includes("--no-wait")) { if (json) console.log(JSON.stringify(r, null, 2)); return 0; }
      let shown = 0;
      const deadline = Date.now() + 35 * 60_000;
      while (r.status === "cloning" && Date.now() < deadline) {
        await new Promise((res) => setTimeout(res, 1000));
        r = await apiJson(conf, `/api/repos/${encodeURIComponent(r.name)}`);
        const lines = r.job?.lines ?? [];
        for (const l of lines.slice(Math.min(shown, lines.length))) console.log(dim(`  ${l.line}`));
        shown = lines.length;
      }
      if (json) console.log(JSON.stringify(r, null, 2));
      if (r.status !== "ready") { console.error(red(`agentbox: ${r.name}: ${r.error ?? r.status}`)); return 1; }
      console.log(green(`${r.name} is ready (default branch ${r.default_branch})${body.onboard ? "; the onboarding (map) run has started" : ""}`));
      return 0;
    }
    case "fetch": {
      const name = args.find((a) => !a.startsWith("-"));
      if (!name || args.includes("--all")) {
        const d = await apiJson(conf, "/api/repos/fetch-all", { method: "POST", body: "{}" });
        for (const x of d.results) console.log(`${x.ok ? green("✔") : red("✖")} ${x.name}${x.error ? `  ${x.error}` : ""}`);
        return d.results.every((x) => x.ok) ? 0 : 1;
      }
      const r = await apiJson(conf, `/api/repos/${encodeURIComponent(name)}/fetch`, { method: "POST", body: "{}" });
      console.log(`${green("✔")} ${r.name} fetched`);
      return 0;
    }
    case "remap": {
      const name = args.find((a) => !a.startsWith("-")) ?? fail("usage: agentbox repo remap <name>");
      const r = await apiJson(conf, `/api/repos/${encodeURIComponent(name)}/remap`, { method: "POST", body: "{}" });
      console.log(`mapping ${name} (task ${r.instance_id})`);
      return 0;
    }
    case "remove": {
      const name = args.find((a) => !a.startsWith("-")) ?? fail("usage: agentbox repo remove <name> [--keep-unpushed]");
      try {
        const r = await apiJson(conf, `/api/repos/${encodeURIComponent(name)}/archive`, { method: "POST", body: JSON.stringify({ confirm_unpushed: args.includes("--keep-unpushed") }) });
        console.log(`archived ${name} → ${r.archive_path ?? "(no clone)"}; its map stays. Purge it from the Repos page to delete it.`);
        return 0;
      } catch (e) {
        if (e.detail?.kind === "busy") for (const t of e.detail.tasks ?? []) console.error(`  open: ${t.name} (${t.label ?? "task"})`);
        if (e.detail?.kind === "unpushed") {
          for (const w of e.detail.worktrees ?? []) console.error(`  ${w.path}: ${w.note ?? "unpushed work"}`);
          console.error("  rerun with --keep-unpushed to archive anyway (the worktrees stay on disk)");
        }
        throw e;
      }
    }
  }
  fail("usage: agentbox repo list|status [<name>]|add <url>|fetch [<name>]|remap <name>|remove <name> [--json]");
}

// --- commands ----------------------------------------------------------------------------------------

const USAGE_INT = `  integration list [--json]            the catalog: GitHub, GitLab, AWS, Kubernetes… (on / off / soon)
  integration status [<id>] [--json]   checks, state, settings, what waits for you
  integration connect <id> [--set k=v]… install it, save settings, render its instructions (root)
  integration verify <id>              verify.sh and every check (root: records the result)
  integration disconnect <id> [--forget]  remove its instructions and units, run disable.sh (root)
  integration settings <id> [--set k=v]… [--unset k] [--values JSON] [--get k] [--json]
  integration render [<id>]            re-render /team/integrations/*.md from the settings (root)`;

const USAGE_REPO = `  repo list [--json]                   the repos agents work on (status, default branch, fetch, map)
  repo status [<name>] [--json]        settings, protected branches, open and kept worktrees
  repo add <url> [--name n] [--branch b] [--roles a,b] [--no-map] [--no-wait]
                                       register and clone it (https, ssh or git@; no credentials)
  repo fetch [<name>]                  git fetch --prune the canonical clone(s) now
  repo remap <name>                    run the onboarding (map) task again
  repo remove <name> [--keep-unpushed] archive it (refused while open tasks use it)`;

const USAGE = `usage: agentbox <command>
${bold("System")} (on the VM)
  status [--json]                      base modules and integrations (checks), services, listeners
  config get [<key>]                   e.g. agentbox config get paths.secrets
  config set <key> <value>             e.g. agentbox config set access tailscale (root)
  module list                          the base modules (core, claude, access, display, terminal)
  module check <id>                    run the module's checks (read-only)
  module install <id>... | --enabled   install.sh, units, configure.sh (root); --enabled: every
                                       enabled base module and connected integration (a repair)
  module enable <id>                   turn a base module on (and its dependencies), install it
  module disable <id>                  turn a base module off, remove its units
  module verify <id>                   verify.sh and every check
${USAGE_INT}
${USAGE_REPO}
  secret set <name>                    stdin → <secrets>/<name>, 0600, owned by the agent user
  update [--force]                     pull (cloud) or sync (lima), build, restart
  start | stop [--force] | restart [--force]
  api [-X METHOD] [-d JSON] <path>     call the local portal with the local token (e.g. api /api/health)
  selftest                             the security self-test
  guide                                the setup guide`;

/**
 * Portal commands (cli/portal.mjs: work, chat, routines, groups, crews, agents…) run anywhere: on your
 * computer through a profile (agentbox login), or here with the local token. System commands (module,
 * config, secret, update, services, the VM's repo/integration admin) stay on the VM.
 */
const SYSTEM_ONLY = new Set(["config", "module", "secret", "update", "start", "restart", "status", "selftest", "guide", "integration"]);
function portalRoute(argv) {
  const [cmd, ...rest] = argv;
  const onVm = fs.existsSync(CONFIG);
  const profile = argv.includes("--profile") || !!process.env.AGENTBOX_PROFILE;
  if (cmd === undefined) return onVm && !profile ? null : ["dash"];
  if (cmd === "stop") return rest.some((a) => !a.startsWith("-")) ? argv : null; // stop <task>; plain `stop` is the services
  if (cmd === "api" || cmd === "repo" || cmd === "repos") {
    if (onVm && !profile) return null;
    if (cmd === "api") return argv;
    // On your computer, `repo …` is the portal's repo admin.
    const [sub, ...more] = rest;
    if (sub === undefined || sub === "list") return ["repos", ...more];
    return ["repo-admin", { remove: "archive", remap: "map" }[sub] ?? sub, ...more];
  }
  if (SYSTEM_ONLY.has(cmd)) return null;
  return argv;
}

async function main(argv) {
  // --profile <name> anywhere picks the portal (the same as AGENTBOX_PROFILE).
  const pi = argv.indexOf("--profile");
  if (pi >= 0) {
    if (!argv[pi + 1]) fail("--profile needs a name (agentbox profiles)");
    process.env.AGENTBOX_PROFILE = argv[pi + 1];
    argv = [...argv.slice(0, pi), ...argv.slice(pi + 2)];
  }
  const [cmd, sub, ...rest] = argv;
  const routed = cmd === "help" || cmd === "-h" || cmd === "--help" ? null : portalRoute(argv);
  if (routed) {
    const { portalMain, PORTAL_COMMANDS } = await import("./portal.mjs");
    if (PORTAL_COMMANDS.has(routed[0])) {
      const code = await portalMain(routed, { localConf: () => (fs.existsSync(CONFIG) ? cfg() : null) });
      if (code !== null) return code;
    }
  }
  switch (cmd) {
    case undefined: case "help": case "-h": case "--help": {
      const { PORTAL_USAGE, portalMain } = await import("./portal.mjs");
      if (cmd === "help" && sub) return portalMain(["help", sub, ...rest]);
      console.log(`${USAGE}

${bold("Portal commands")} (agentbox help <command>)
${PORTAL_USAGE}`);
      return 0;
    }

    case "config": {
      if (sub === "get") {
        const conf = cfg();
        if (!rest[0]) { process.stdout.write(stringify(conf)); return 0; }
        return printValue(getIn(conf, keyPath(rest[0]))) ? 0 : 1;
      }
      if (sub === "set") {
        if (rest.length !== 2) fail("usage: agentbox config set <key> <value>");
        asRoot(argv);
        setValue(rest[0], rest[1]);
        console.log(`${rest[0]} = ${rest[1]}  (restart to apply: agentbox restart)`);
        return 0;
      }
      fail("usage: agentbox config get|set <key> [value]");
    }

    case "module": {
      const conf = cfg();
      if (sub === "list") {
        for (const m of baseModules(conf)) {
          const on = isEnabled(conf, m.id);
          console.log(`${on ? green("on ") : dim("off")}  ${m.id.padEnd(12)} ${m.title ?? ""}${m.depends.length ? dim(`  (needs ${m.depends.join(", ")})`) : ""}`);
        }
        console.log(dim("\nIntegrations (GitHub, AWS, Kubernetes…): agentbox integration list"));
        return 0;
      }
      if (sub === "check") {
        const m = loadModule(conf, rest[0] ?? fail("usage: agentbox module check <id>"));
        let bad = 0;
        for (const s of stepStates(conf, m)) {
          if (s.state === "-" || s.state === "skip") continue;
          if (s.state !== "ok") bad++;
          console.log(`${s.state === "ok" ? green("✔") : s.state === "you" ? yellow("⏸") : red("✖")} ${s.id.padEnd(12)} ${s.title}`);
        }
        return bad ? 1 : 0;
      }
      if (sub === "install") {
        asRoot(argv);
        const ids = rest.includes("--enabled")
          ? allModules(conf).map((m) => m.id).filter((id) => isEnabled(conf, id))
          : rest;
        if (!ids.length) fail("usage: agentbox module install <id>... | --enabled");
        let waiting = 0;
        // With explicit ids, only those (dependencies must already be installed).
        const mods = rest.includes("--enabled") ? ordered(conf, ids) : ids.map((id) => loadModule(conf, id));
        if (!rest.includes("--enabled")) for (const m of mods) notAnIntegration(m, "connect");
        for (const m of mods) {
          waiting += installModule(conf, m);
          if (isIntegration(m)) renderIntegration(conf, loadIntegration(conf, m.id));
        }
        console.log(waiting ? yellow(`\n${waiting} step(s) wait for you (above).`) : green("\ndone"));
        return 0;
      }
      if (sub === "enable") {
        asRoot(argv);
        const id = rest[0] ?? fail("usage: agentbox module enable <id>");
        notAnIntegration(loadModule(conf, id), "connect");
        const mods = ordered(conf, [id]);
        const fresh = new Set();
        for (const m of mods) {
          if (!isEnabled(conf, m.id)) { setValue(`modules.${m.id}`, "true"); fresh.add(m.id); console.log(`modules.${m.id} = true`); }
        }
        const conf2 = cfg();
        // The module itself (re-run if already on) and any dependency that was off until now.
        for (const m of mods) if (m.id === id || fresh.has(m.id)) installModule(conf2, m);
        restartPortalIfUp();
        return 0;
      }
      if (sub === "disable") {
        asRoot(argv);
        const id = rest[0] ?? fail("usage: agentbox module disable <id>");
        if (REQUIRED.includes(id)) fail(`${id} is always on`);
        const m = loadModule(conf, id);
        notAnIntegration(m, "disconnect");
        const users = allModules(conf).filter((x) => x.id !== id && isEnabled(conf, x.id) && x.depends.includes(id));
        if (users.length) fail(`${users.map((x) => x.id).join(", ")} need(s) ${id}; disable those first`);
        runScript(conf, m, "disable.sh");
        removeUnits(m);
        setValue(`modules.${id}`, "false");
        console.log(`modules.${id} = false  (packages stay installed; units removed)`);
        restartPortalIfUp();
        return 0;
      }
      if (sub === "verify") {
        const m = loadModule(conf, rest[0] ?? fail("usage: agentbox module verify <id>"));
        if (!runVerifyScript(conf, m)) return 1;
        return main(["module", "check", m.id]);
      }
      fail("usage: agentbox module list|check|install|enable|disable|verify <id>");
    }

    case "secret": {
      if (sub !== "set" || !rest[0]) fail("usage: agentbox secret set <name>   (reads the value from stdin)");
      const name = rest[0];
      if (!/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/.test(name) || name.split("/").some((p) => p === "." || p === "..")) fail(`bad secret name: ${name}`);
      const conf = cfg();
      const user = agentUser(conf);
      const me = os.userInfo().username;
      if (!isRoot() && me !== user) asRoot(argv); // stdin is inherited through sudo
      const tty = process.stdin.isTTY;
      let value;
      if (tty) {
        value = await readSecretTty(name);
        if (value === null) fail("cancelled; nothing saved");
      } else value = readStdin();
      if (!value.length) fail("nothing entered; nothing saved");
      const root = conf.paths?.secrets ?? "/secrets";
      const file = path.join(root, name);
      if (!file.startsWith(root + path.sep)) fail("bad secret name");
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      const tmp = `${file}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, value, { mode: 0o600 });
      fs.renameSync(tmp, file);
      if (isRoot()) {
        // Every directory from the secrets root down to the file belongs to the agent user, 0700.
        let d = path.dirname(file);
        const dirs = [];
        while (d.startsWith(root)) { dirs.push(d); if (d === root) break; d = path.dirname(d); }
        for (const x of dirs) { spawnSync("chown", [`${user}:${user}`, x]); fs.chmodSync(x, 0o700); }
        spawnSync("chown", [`${user}:${user}`, file]);
      }
      fs.chmodSync(file, 0o600);
      console.log(`saved ${file} (${value.length} bytes, 0600)`);
      return 0;
    }

    case "update": {
      asRoot(argv);
      const conf = cfg();
      await refuseIfBusy(conf, argv.includes("--force"), "an update restarts the portal and");
      const src = srcDir(conf);
      const env = { ...process.env, AGENTBOX_CONFIG: CONFIG, AGENTBOX_SRC: src, AGENTBOX_USER: agentUser(conf) };
      const script = conf.host === "cloud" ? path.join(src, "host", "cloud", "deploy.sh") : path.join(src, "setup", "lib", "deploy-app.sh");
      sh("bash", [script], { env });
      return 0;
    }

    case "start": case "stop": case "restart": {
      asRoot(argv);
      const conf = cfg();
      if (cmd !== "start") await refuseIfBusy(conf, argv.includes("--force"), `${cmd === "stop" ? "stopping" : "restarting"}`);
      const units = enabledUnits(conf);
      if (cmd === "stop") systemctl("stop", ...units.slice().reverse());
      else systemctl(cmd, ...units);
      console.log(`${cmd}: ${units.join(" ")}`);
      return 0;
    }

    case "status": return status(argv.includes("--json"));

    case "integration": case "integrations": return integrationCmd(argv);

    case "repo": case "repos": return repoCmd(argv);

    case "api": {
      const conf = cfg();
      const args = argv.slice(1);
      let method = "GET", body, p;
      for (let i = 0; i < args.length; i++) {
        if (args[i] === "-X") method = String(args[++i] ?? "").toUpperCase();
        else if (args[i] === "-d") { body = args[++i] ?? ""; if (method === "GET") method = "POST"; }
        else p = args[i];
      }
      if (!p) fail("usage: agentbox api [-X METHOD] [-d JSON] <path>");
      if (!isRoot() && os.userInfo().username !== agentUser(conf) && localToken(conf) === null) asRoot(argv);
      let r;
      try { r = await api(conf, p, { method, body }); } catch (e) { fail(`the portal isn't answering on 127.0.0.1:${conf.ports?.portal ?? 7700} (${e.cause?.code ?? e.message})`); }
      process.stdout.write(await r.text());
      if (process.stdout.isTTY) process.stdout.write("\n");
      return r.ok ? 0 : 22; // like curl -f
    }

    case "selftest": {
      asRoot(argv);
      const conf = cfg();
      const r = spawnSync("bash", [path.join(srcDir(conf), "setup", "selftest.sh")], {
        stdio: "inherit", env: { ...process.env, AGENTBOX_CONFIG: CONFIG, AGENTBOX_SRC: srcDir(conf) },
      });
      return r.status ?? 1;
    }

    case "guide": {
      const conf = cfg();
      const hook = path.join(srcDir(conf), "guide", "agentbox-guide.sh");
      if (fs.existsSync(hook)) {
        const r = spawnSync("bash", [hook, ...argv.slice(1)], { stdio: "inherit", env: { ...process.env, AGENTBOX_CONFIG: CONFIG } });
        return r.status ?? 1;
      }
      console.log("agentbox guide: the guide workstream provides this (guide/agentbox-guide.sh).");
      console.log("Meanwhile: agentbox module list · sudo agentbox module install --enabled · agentbox status");
      return 0;
    }
  }
  fail(`unknown command: ${cmd}\n${USAGE}`);
}

/** Integrations the portal only starts at startup: connecting one needs a restart. */
const STARTS_WITH_PORTAL = new Set(["mobile", "push"]);

/**
 * All of stdin, until EOF. readFileSync(0) fails with EAGAIN when the terminal left stdin non-blocking
 * (the portal's browser terminals do), so read in a loop and wait briefly whenever there's nothing yet.
 */
function readStdin() {
  const chunks = [];
  const buf = Buffer.alloc(64 * 1024);
  const nap = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    let n;
    try {
      n = fs.readSync(0, buf, 0, buf.length, null);
    } catch (e) {
      if (e.code === "EAGAIN") { Atomics.wait(nap, 0, 0, 20); continue; }
      if (e.code === "EOF") break;
      throw e;
    }
    if (n === 0) break;
    chunks.push(Buffer.from(buf.subarray(0, n)));
  }
  return Buffer.concat(chunks);
}

function restartPortalIfUp() {
  if (!systemd()) return;
  if (spawnSync("systemctl", ["is-active", "--quiet", "agentbox-web"]).status === 0) {
    console.log("restarting the portal so it picks up the module change");
    spawnSync("systemctl", ["restart", "agentbox-web"], { stdio: "inherit" });
  }
}

async function status(json) {
  const conf = cfg();
  const ints = await pool(allIntegrations(conf).filter((m) => conf.modules?.[m.id] === true), 4, (m) => integrationView(conf, m));
  const mods = baseModules(conf).map((m) => {
    const on = isEnabled(conf, m.id);
    return { id: m.id, title: m.title, enabled: on, steps: on ? stepStates(conf, m).map((s) => ({ id: s.id, title: s.title, state: s.state, human: !!s.human })) : [] };
  });
  const units = enabledUnits(conf).map((u) => {
    const r = spawnSync("systemctl", ["is-active", u], { encoding: "utf8" });
    return { unit: u, state: (r.stdout ?? "").trim() || "unknown" };
  });
  const ss = spawnSync("ss", ["-Hltn"], { encoding: "utf8" });
  const listeners = (ss.stdout ?? "").split("\n").filter(Boolean).map((l) => l.trim().split(/\s+/)[3]).filter(Boolean)
    .map((addr) => ({ addr, loopback: /^(127\.[\d.]+(%\w+)?|\[::1\](%\w+)?):\d+$/.test(addr) }));
  if (json) {
    const integrations = ints.map((v) => ({ id: v.id, title: v.title, category: v.category, state: v.state, steps: v.steps.map((s) => ({ id: s.id, title: s.title, state: s.state, human: s.human })) }));
    console.log(JSON.stringify({ host: conf.host, access: conf.access, modules: mods, integrations, units, listeners }, null, 2));
    return 0;
  }
  console.log(bold(`agentbox · host ${conf.host} · access ${conf.access} · user ${agentUser(conf)}`));
  console.log(bold("\nmodules"));
  for (const m of mods) {
    if (!m.enabled) { console.log(dim(`  ─ ${m.id.padEnd(12)} off`)); continue; }
    const bad = m.steps.filter((s) => s.state === "fail").length, you = m.steps.filter((s) => s.state === "you").length;
    const mark = bad ? red("✖") : you ? yellow("⏸") : green("✔");
    const note = [...m.steps.filter((s) => s.state === "fail").map((s) => red(s.title)), ...m.steps.filter((s) => s.state === "you").map((s) => yellow(`your turn: ${s.title}`))].join(" · ");
    console.log(`  ${mark} ${m.id.padEnd(12)} ${note}`);
  }
  console.log(bold("\nintegrations"));
  if (!ints.length) console.log(dim("  none connected (agentbox integration list)"));
  for (const v of ints) {
    const waiting = v.gates.map((g) => yellow(`your turn: ${g.title}`));
    const failed = v.steps.filter((s) => s.state === "failed").map((s) => red(s.title));
    console.log(`  ${STATE_MARK[v.state]} ${v.id.padEnd(12)} ${v.state}${v.account ? dim(` as ${v.account}`) : ""} ${[...failed, ...waiting].join(" · ")}`);
  }
  console.log(bold("\nservices"));
  for (const u of units) console.log(`  ${u.state === "active" ? green("●") : red("●")} ${u.unit.padEnd(40)} ${u.state}`);
  console.log(bold("\nlisteners (TCP)"));
  for (const l of listeners) console.log(`  ${l.loopback ? green("loopback") : yellow("NOT loopback")}  ${l.addr}`);
  return 0;
}

// Exit only once stdout is flushed: piped output is written asynchronously, and exiting straight away
// cut large replies short (e.g. `agentbox api /skills | …`).
main(process.argv.slice(2)).then((code) => process.stdout.write("", () => process.exit(code ?? 0)), (e) => {
  if (e instanceof Fail || e?.constructor?.name === "Fail") { console.error(`agentbox: ${e.message}`); process.exit(1); }
  console.error(e);
  process.exit(1);
});
