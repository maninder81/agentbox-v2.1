/**
 * Shared work (shares.ts, shareServer.ts): links with an expiry and read/edit access to one piece of
 * work, a guest server that only knows that work, and the owner-only routes that make links.
 * In-process, throwaway database, agents paused (tasks only queue), the tunnel faked.
 *
 *   node --disable-warning=ExperimentalWarning --import tsx --test test/shares.test.ts
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentbox-shares-")));
const dirs = Object.fromEntries(["data", "agents", "work", "skills", "team", "secrets", "integrations", "web"].map((d) => {
  fs.mkdirSync(path.join(tmp, d), { recursive: true });
  return [d, path.join(tmp, d)];
}));
const configFile = path.join(tmp, "config.yaml");
fs.writeFileSync(configFile, `host: lima\naccess: ssh-tunnel\nuser: ${os.userInfo().username}\npaths: { data: ${dirs.data}, work: ${dirs.work}, agents: ${dirs.agents}, skills: ${dirs.skills}, team: ${dirs.team}, secrets: ${dirs.secrets}, integrations: ${dirs.integrations} }\n`);
Object.assign(process.env, {
  AGENTBOX_CONFIG: configFile, AGENTBOX_DATA: dirs.data, AGENTBOX_AGENTS: dirs.agents, AGENTBOX_WORK: dirs.work, AGENTBOX_SKILLS: dirs.skills,
  AGENTBOX_TEAM: dirs.team, AGENTBOX_SECRETS: dirs.secrets, AGENTBOX_INTEGRATIONS: dirs.integrations, AGENTBOX_CLI: "/nonexistent/agentbox",
  AGENTBOX_PROGRESS_TICK_MS: "3600000", NO_COLOR: "1",
});

const { setPaused } = await import("../src/control.ts");
setPaused(true);
const { run, get, all, newId, now } = await import("../src/db.ts");
const { publish } = await import("../src/bus.ts");
const A = await import("../src/agents.ts");
const S = await import("../src/shares.ts");
const SS = await import("../src/shareServer.ts");
const { LOCAL_TOKEN_HEADER } = await import("../src/access.ts");
const Fastify = (await import("fastify")).default;

const HOST = "guest-test.ngrok.app";
const ORIGIN = `https://${HOST}`;
fs.mkdirSync(path.join(dirs.web, "assets"), { recursive: true });
fs.writeFileSync(path.join(dirs.web, "share.html"), "<!doctype html><title>Shared work</title>");
fs.writeFileSync(path.join(dirs.web, "index.html"), "<!doctype html><title>the owner's portal</title>");
const guest = await SS.buildShareServer({ host: () => HOST, webDist: dirs.web });
const owner = Fastify();
owner.setErrorHandler((err: any, _req, reply) => reply.status(err.statusCode ?? 400).send({ error: err.message, ...(err.detail ? { detail: err.detail } : {}) }));
S.registerShareRoutes(owner);
after(async () => { await guest.close(); await owner.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

const role = A.createAgent({ name: "tech-lead", title: "Tech lead", summary: "leads", model: "sonnet", instructions: "# tl\n", interview: {} });
const coderRole = A.createAgent({ name: "coder", title: "Coder", summary: "codes", model: "sonnet", instructions: "# c\n", interview: {} });
const room = A.spawnInstance(role.id, { label: "Payments cleanup", createdBy: "owner" });
const helper = A.spawnInstance(coderRole.id, { label: "Piece", createdBy: room.id, parentInstanceId: room.id });
const other = A.spawnInstance(role.id, { label: "Secret other work", createdBy: "owner" });

const say = (agentId: string, author: string, content: string) => {
  const id = newId();
  run(`INSERT INTO messages (id, thread_id, author, task_id, content, created_at) VALUES (?, ?, ?, NULL, ?, ?)`, id, A.dmThreadOf(agentId), author, content, now());
  return id;
};
say(room.id, "user", "Please clean up payments");
say(room.id, room.id, "On it. The key is ghp_abcdefghijklmnopqrstuvwxyz0123456789 (oops)");
say(other.id, "user", "This belongs to other work");

// Files: one attached in the shared conversation, one credential-looking, one only in the other work.
const up = path.join(dirs.work, "uploads", "2026-10");
fs.mkdirSync(up, { recursive: true });
const shot = path.join(up, "shot-1.png"); fs.writeFileSync(shot, "png");
const envFile = path.join(up, "prod.env"); fs.writeFileSync(envFile, "A=1");
const otherFile = path.join(up, "other-2.txt"); fs.writeFileSync(otherFile, "other");
say(room.id, "user", `Look: ![shot](/api/file?path=${encodeURIComponent(shot)}) [📎 prod.env](/api/file?path=${encodeURIComponent(envFile)})`);
say(other.id, "user", `[📎 other](/api/file?path=${encodeURIComponent(otherFile)})`);
// Files agents name in a message: this work's open; the other work's don't.
const plan = path.join(dirs.work, "rooms", "pay", "PLAN.md"); fs.mkdirSync(path.dirname(plan), { recursive: true }); fs.writeFileSync(plan, "# Plan\nkey ghp_abcdefghijklmnopqrstuvwxyz0123456789\n");
const otherPlan = path.join(dirs.work, "rooms", "other", "PLAN.md"); fs.mkdirSync(path.dirname(otherPlan), { recursive: true }); fs.writeFileSync(otherPlan, "other");
fs.mkdirSync(path.join(path.dirname(plan), "PLAN-img"), { recursive: true });
const fig = path.join(path.dirname(plan), "PLAN-img", "01-overview.png"); fs.writeFileSync(fig, "png");
const stray = path.join(path.dirname(plan), "PLAN-img", "not-shown.png"); fs.writeFileSync(stray, "png");
fs.appendFileSync(plan, "\n![Overview](PLAN-img/01-overview.png)\n");
// The work's own folders: its shared room folder, and a worktree of one of its tasks.
run(`UPDATE agents SET workspace = ? WHERE id = ?`, path.dirname(plan), room.id);
const wt = path.join(dirs.work, "worktrees", "app", "h1"); fs.mkdirSync(wt, { recursive: true });
const wtFile = path.join(wt, "REPORT.md"); fs.writeFileSync(wtFile, "report");
run(`INSERT INTO repos (id, name, url, provider, status, created_at) VALUES ('r1', 'app', 'https://x/app.git', 'github', 'ready', ?)`, now());
run(`INSERT INTO repo_worktrees (id, repo_id, instance_id, path, status, created_at) VALUES ('w1', 'r1', ?, ?, 'active', ?)`, helper.id, wt, now());
// Outside the work: an agent's memory, another work's worktree, and an image above the plan's folder.
const memo = path.join(dirs.agents, "tech-lead", "memory", "notes.md"); fs.mkdirSync(path.dirname(memo), { recursive: true }); fs.writeFileSync(memo, "private");
const otherWt = path.join(dirs.work, "worktrees", "infra", "h9", "main.tf"); fs.mkdirSync(path.dirname(otherWt), { recursive: true }); fs.writeFileSync(otherWt, "infra");
const escape = path.join(dirs.work, "rooms", "escape.png"); fs.writeFileSync(escape, "png");
fs.appendFileSync(plan, "\n![x](../escape.png)\n");
say(room.id, room.id, `I wrote the plan to ${plan}. Report: ${wtFile}. My notes: ${memo}`);
say(other.id, other.id, `Mine is at ${otherPlan}`);

const tokenOf = (url: string) => url.split("#")[1];
const cookieFor = (token: string) => `${SS.COOKIE}=${token}`;
const g = (method: string, url: string, opts: { token?: string; body?: unknown; headers?: Record<string, string> } = {}) =>
  guest.inject({
    method: method as any, url,
    headers: {
      host: HOST, ...(method === "GET" ? {} : { origin: ORIGIN, "sec-fetch-site": "same-origin" }),
      ...(opts.token ? { cookie: cookieFor(opts.token) } : {}), ...(opts.body !== undefined ? { "content-type": "application/json" } : {}), ...opts.headers,
    },
    ...(opts.body !== undefined ? { payload: JSON.stringify(opts.body) } : {}),
  });

let readToken = "", editToken = "", editId = "";

test("making links: the whole work only, valid access and expiry; only a hash is stored", () => {
  assert.throws(() => S.createShare(helper.id, {}), /whole piece of work/);
  assert.throws(() => S.createShare(room.id, { perm: "admin" }), /read or edit/);
  assert.throws(() => S.createShare(room.id, { expiry: "30d" }), /6h, 1d or 7d/);
  assert.throws(() => S.createShare(room.id, { label: "<script>" }), /name/);
  const r = S.createShare(room.id, { perm: "read", expiry: "6h", label: "Priya" });
  readToken = r.token;
  const e = S.createShare(room.id, { perm: "edit", expiry: "7d", label: "Sam" });
  editToken = e.token; editId = e.share.id;
  assert.equal(r.share.perm, "read");
  assert.ok(Math.abs(Date.parse(r.share.expires_at) - Date.now() - 6 * 3600_000) < 5000);
  const dump = JSON.stringify(all(`SELECT * FROM shares`));
  assert.ok(!dump.includes(readToken) && !dump.includes(editToken), "tokens are never stored");
  assert.equal(S.shareByToken(readToken)?.id, r.share.id);
  assert.equal(S.shareByToken("x".repeat(43)), null);
  assert.equal(S.shareByToken(readToken.slice(0, -1) + (readToken.endsWith("A") ? "B" : "A")), null);
  assert.ok(!("token_hash" in S.shareView(r.share)), "the owner's view has no hash");
});

test("owner routes: refused with the VM's local token; no ngrok means 'set it up' first", async () => {
  const viaToken = await owner.inject({ method: "GET", url: `/api/work/${room.id}/shares`, headers: { [LOCAL_TOKEN_HEADER]: "x" } });
  assert.equal(viaToken.statusCode, 403);
  const make = await owner.inject({ method: "POST", url: `/api/work/${room.id}/shares`, payload: { perm: "read" } });
  assert.equal(make.statusCode, 409);
  assert.equal(make.json().detail.setup, "ngrok");
  const list = await owner.inject({ method: "GET", url: `/api/work/${room.id}/shares` });
  assert.equal(list.json().shares.length, 2);
  assert.equal(list.json().ready, false);
});

test("the guest server answers only on the tunnel's host and only with a live link", async () => {
  assert.equal((await guest.inject({ method: "GET", url: "/", headers: { host: "127.0.0.1:7785" } })).statusCode, 404);
  const page = await g("GET", "/");
  assert.equal(page.statusCode, 200);
  assert.match(page.body, /Shared work/);
  assert.match(String(page.headers["content-security-policy"]), /frame-ancestors 'none'/);
  assert.equal(page.headers["x-frame-options"], "DENY");
  assert.equal((await g("GET", "/index.html")).statusCode, 404, "not the owner's portal");
  assert.equal((await g("GET", "/api/room")).statusCode, 401);
  assert.equal((await g("GET", "/api/state")).statusCode, 401, "no portal API, signed in or not");
  assert.equal((await g("POST", "/api/session", { body: { token: "nope" } })).statusCode, 401);
  const ok = await g("POST", "/api/session", { body: { token: readToken } });
  assert.equal(ok.statusCode, 200);
  assert.match(String(ok.headers["set-cookie"]), new RegExp(`^${SS.COOKIE}=[^;]+; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=\\d+$`));
  assert.equal((await g("GET", "/api/agents", { token: readToken })).statusCode, 404);
});

test("cross-site and non-JSON writes are refused", async () => {
  assert.equal((await g("POST", "/api/session", { body: { token: readToken }, headers: { origin: "https://evil.example" } })).statusCode, 403);
  assert.equal((await g("POST", "/api/session", { body: { token: readToken }, headers: { "sec-fetch-site": "cross-site" } })).statusCode, 403);
  const form = await guest.inject({ method: "POST", url: "/api/messages", headers: { host: HOST, origin: ORIGIN, cookie: cookieFor(editToken), "content-type": "text/plain" }, payload: "hi" });
  assert.equal(form.statusCode, 415);
});

test("a guest reads the shared room only, without tool logs or prompts, secrets redacted", async () => {
  const r = (await g("GET", "/api/room", { token: readToken })).json();
  assert.equal(r.share.perm, "read");
  assert.equal(r.root.label, "Payments cleanup");
  assert.deepEqual(r.members.map((m: any) => m.label).sort(), ["Payments cleanup", "Piece"]);
  const text = JSON.stringify(r);
  assert.ok(!text.includes("This belongs to other work"), "other work stays private");
  assert.ok(!text.includes("ghp_abcdefghijklmnopqrstuvwxyz0123456789"), "secrets are redacted");
  assert.ok(!("steps" in r) && !text.includes('"prompt"'), "no step logs or prompts");
  assert.equal(r.messages[0].author.kind, "owner");
  assert.equal(r.messages[1].author.kind, "agent");
  assert.match(r.messages[1].author.name, /^tech-lead#\d+$/);
});

test("files: only what the shared work holds, never credential-looking ones", async () => {
  const f = (p: string) => g("GET", `/api/file?path=${encodeURIComponent(p)}`, { token: readToken });
  assert.equal((await f(shot)).statusCode, 200);
  const named = await f(plan);
  assert.equal(named.statusCode, 200, "a file named in this work's conversation");
  assert.ok(!named.body.includes("ghp_abcdefghijklmnopqrstuvwxyz0123456789"), "text files are redacted");
  assert.equal((await f(otherPlan)).statusCode, 403, "a file named only in other work");
  assert.equal((await f(fig)).statusCode, 200, "an image the shared document shows");
  assert.equal((await f(stray)).statusCode, 200, "the work's shared folder is all its documents");
  assert.equal((await f(escape)).statusCode, 403, "nor an image above the document's folder (../)");
  assert.equal((await f(wtFile)).statusCode, 200, "a file in one of the work's worktrees, named by an agent");
  assert.equal((await f(memo)).statusCode, 403, "an agent naming a file outside the work's folders");
  assert.equal((await f(envFile)).statusCode, 403, "a .env file isn't served even if attached");
  assert.equal((await f(otherFile)).statusCode, 403, "another work's file");
  assert.equal((await f("/etc/passwd")).statusCode, 403);
  // Every text format is redacted, whatever its extension says; unknown binaries and huge text aren't served.
  const secret = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
  const ws = path.dirname(plan);
  const names = ["deploy.log", "config.yaml", "settings.json", "run.sh", "main.tf", "notes"];
  for (const n of names) fs.writeFileSync(path.join(ws, n), `token: ${secret}\n`);
  const db = path.join(ws, "cache.sqlite"); fs.writeFileSync(db, Buffer.from([0x53, 0x51, 0, 1, 2, 0, 3]));
  const big = path.join(ws, "huge.log"); fs.writeFileSync(big, "x".repeat(SS.MAX_TEXT + 1));
  const png = path.join(ws, "chart.png"); fs.writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0]));
  // An agent names them in the conversation (they're inside the work's shared folder).
  say(room.id, room.id, `Outputs: ${[...names.map((n) => path.join(ws, n)), db, big, png].join(" ")}`);
  for (const n of names) {
    const p = path.join(ws, n);
    const r = await f(p);
    assert.equal(r.statusCode, 200, n);
    assert.ok(!r.body.includes(secret), `${n} is redacted`);
    assert.match(String(r.headers["content-type"]), /^text\//, `${n} is served as text`);
  }
  assert.equal((await f(db)).statusCode, 415, "an unknown binary");
  assert.equal((await f(big)).statusCode, 413, "text too big to redact");
  assert.equal((await f(png)).statusCode, 200, "images as they are");
});

test("read links can't post; edit links talk to the lead as the guest, attaching only their own uploads", async () => {
  assert.equal((await g("POST", "/api/messages", { token: readToken, body: { text: "do it" } })).statusCode, 403);
  assert.equal((await g("POST", "/api/uploads", { token: readToken, body: { name: "a.txt", data: "aGk=" } })).statusCode, 403);
  // Someone else's upload, by path: refused.
  const sneaky = await g("POST", "/api/messages", { token: editToken, body: { text: "see", files: [otherFile] } });
  assert.equal(sneaky.statusCode, 403);
  const upl = (await g("POST", "/api/uploads", { token: editToken, body: { name: "notes.txt", type: "text/plain", data: Buffer.from("hello").toString("base64") } })).json();
  const sent = await g("POST", "/api/messages", { token: editToken, body: { text: "Please also drop the legacy cron.", files: [upl.path] } });
  assert.equal(sent.statusCode, 200, sent.body);
  const t = get<any>(`SELECT * FROM tasks WHERE id = ?`, sent.json().task_id);
  assert.equal(t.agent_id, room.id);
  assert.match(t.prompt, /A message from Sam, a guest the owner shared this piece of work with \(edit access\), not from the owner/);
  assert.match(t.prompt, /\[Attached by Sam/);
  const m = get<any>(`SELECT * FROM messages WHERE task_id = ?`, t.id);
  assert.equal(m.author, "guest:Sam");
  const view = (await g("GET", "/api/room", { token: readToken })).json();
  assert.equal(view.messages.find((x: any) => x.task_id === t.id).author.name, "Sam");
  // A guest naming another work's files (a path, or a file link) doesn't make them readable.
  const bait = await g("POST", "/api/messages", { token: editToken, body: { text: `Look at ${otherWt} and [this](/api/file?path=${encodeURIComponent(otherPlan)}) and ${memo}` } });
  assert.equal(bait.statusCode, 200);
  for (const p of [otherWt, otherPlan, memo]) {
    assert.equal((await g("GET", `/api/file?path=${encodeURIComponent(p)}`, { token: editToken })).statusCode, 403, p);
  }
  // Stop: tasks in this work only.
  const otherTask = newId();
  run(`INSERT INTO tasks (id, agent_id, thread_id, source, title, prompt, status, created_at) VALUES (?, ?, ?, 'user', 't', 'p', 'queued', ?)`, otherTask, other.id, A.dmThreadOf(other.id), now());
  assert.equal((await g("POST", "/api/stop", { token: editToken, body: { task_id: otherTask } })).statusCode, 404);
  assert.equal((await g("POST", "/api/stop", { token: editToken, body: { task_id: t.id } })).statusCode, 200);
  assert.equal(get<any>(`SELECT status FROM tasks WHERE id = ?`, t.id).status, "stopped");
});

test("live events: only this room's", () => {
  const ctx = SS.roomCtx(room.id);
  const mine = { id: "m1", thread_id: A.dmThreadOf(helper.id), author: helper.id, task_id: null, content: "x", created_at: now() };
  const theirs = { ...mine, thread_id: A.dmThreadOf(other.id) };
  assert.equal(SS.guestEvent(ctx, { type: "message.created", message: mine })?.type, "message");
  assert.equal(SS.guestEvent(ctx, { type: "message.created", message: theirs }), null);
  assert.equal(SS.guestEvent(ctx, { type: "attention.updated", item: {} }), null);
  assert.equal(SS.guestEvent(ctx, { type: "approval.updated", approval: {} }), null);
});

test("agents are told the work is shared; revoking, expiry and finishing the work turn links off", async () => {
  assert.match(S.sharedNote(helper), /shared this piece of work with Priya \(reads only\), Sam \(can chat with you\)/);
  assert.equal(S.sharedNote(other), "");
  S.revokeShare(editId);
  assert.equal((await g("GET", "/api/room", { token: editToken })).statusCode, 401);
  run(`UPDATE shares SET expires_at = ? WHERE room_id = ?`, new Date(Date.now() - 1000).toISOString(), room.id);
  assert.equal((await g("GET", "/api/room", { token: readToken })).statusCode, 401);
  assert.equal(S.sharedNote(helper), "");
  const again = S.createShare(room.id, { perm: "read" });
  S.revokeRoom(room.id);
  assert.equal(S.shareByToken(again.token), null);
  publish({ type: "shares.updated", roomId: room.id });
});
