import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import fastifyWebsocket from "@fastify/websocket";
import { all, get } from "./db.ts";
import { ports } from "./config.ts";
import { subscribe, type BusEvent } from "./bus.ts";
import { AGENTS_ROOT, WORK_ROOT, dmThreadOf, getAgent, instanceTree, type Agent } from "./agents.ts";
import { roomDocuments } from "./work.ts";
import { allowed, contentType } from "./documents.ts";
import { listNotes } from "./notes.ts";
import { roadmapsOf, roadmapView } from "./roadmaps.ts";
import { roomServices } from "./hosting.ts";
import { listProgress } from "./progress.ts";
import { enqueueTask, stopTask } from "./runner.ts";
import { attachmentsForAgent, checkAttachments, displayWithAttachments, saveUpload } from "./uploads.ts";
import { redactSecrets } from "./redact.ts";
import { publicHost, shareByToken, shareById, isLive, touch, type Share } from "./shares.ts";

/**
 * The guest server for shared work (docs/SHARING.md). It listens on 127.0.0.1:<ports.share> and is
 * reached from outside only through the ngrok tunnel, which runs while a link is live (shares.ts).
 *
 * It knows exactly one thing per guest: the room their link shares. There is no portal API here, no
 * session with the owner's identity, no proxy to the screen, terminal or hosted apps; the routes below
 * are the whole surface, and every one is scoped to the link's room:
 *   GET  /                 the guest page (web/share.html); /assets/* its bundle
 *   POST /api/session      trade the link's token (from the URL #fragment) for an HttpOnly cookie
 *   GET  /api/room         conversation, members, tasks, live progress (no tool logs, no prompts)
 *   GET  /api/roadmaps, /api/documents, /api/notes, /api/services, /api/file?path=
 *   WS   /api/events       live updates for this room only
 *   edit links only: POST /api/messages, /api/uploads, /api/stop
 * Text a guest reads is passed through the secret redactor; files that look like credentials are
 * never listed or served.
 */

export const COOKIE = "__Host-agentbox_guest";
const RATE = { messagesPerMin: 20, uploadsPer10Min: 30, badSessionsPerMin: 30 };
const CARD_AUTHORS = new Set(["plan", "review", "roadmap", "approval", "setup_request", "integration"]);
// Files that look like credentials are never listed or served to a guest.
const SENSITIVE = /(^|\/)([^/]*\.env(\.[^/]*)?|\.envrc|\.npmrc|\.netrc|\.pgpass|\.git-credentials|id_(rsa|ecdsa|ed25519|dsa)[^/]*|[^/]*\.(pem|key|p12|pfx|kdbx|ovpn|jks|keystore)|[^/]*(credential|secret|token|password|passwd)[^/]*)$/i;
const IMAGE = /\.(png|jpe?g|gif|webp|svg)$/i;
// Formats served as they are (they aren't text, so there's nothing to redact in place).
const BINARY = /\.(png|jpe?g|gif|webp|pdf|docx|xlsx|pptx|odt|ods|odp|rtf|zip|gz|tgz|7z|tar|step|stp|stl|3mf|glb|mp4|webm|mp3|wav)$/i;
export const MAX_TEXT = 4 * 1024 * 1024;

/**
 * A file's text, if it is text: no NUL bytes and valid UTF-8, whatever its name or type says (logs,
 * YAML, JSON, scripts and configs come as application/octet-stream). null: binary.
 */
export function textOf(file: string): string | null {
  const buf = fs.readFileSync(file);
  if (buf.subarray(0, 64 * 1024).includes(0)) return null;
  try { return new TextDecoder("utf-8", { fatal: true }).decode(buf); } catch { return null; }
}

const red = (t: unknown) => (typeof t === "string" ? redactSecrets(t) : t);
const here = path.dirname(fileURLToPath(import.meta.url));

// --- what a guest sees of a room ------------------------------------------------------------------

type RoomCtx = { roomId: string; members: Set<string>; threads: Set<string> };

export function roomCtx(roomId: string): RoomCtx {
  const tree = instanceTree(roomId);
  const ids = tree.map((a) => a.id);
  const threads = ids.length
    ? all<{ id: string }>(`SELECT id FROM threads WHERE agent_id IN (${ids.map(() => "?").join(",")}) AND kind IN ('dm', 'handoff', 'routine')`, ...ids)
    : [];
  return { roomId, members: new Set(ids), threads: new Set(threads.map((t) => t.id)) };
}

const who = (id: string | null | undefined) => {
  const a = id ? getAgent(id) : undefined;
  return a ? { id: a.id, name: a.name, color: a.color } : null;
};

/** A message as a guest sees it: who wrote it (by name), its text redacted; cards become a one-liner. */
export function guestMessage(m: any) {
  const base = { id: m.id, thread_id: m.thread_id, task_id: m.task_id ?? null, created_at: m.created_at };
  if (m.author === "user") return { ...base, author: { kind: "owner" }, content: red(m.content) };
  if (typeof m.author === "string" && m.author.startsWith("guest:")) return { ...base, author: { kind: "guest", name: m.author.slice(6) }, content: red(m.content) };
  if (m.author === "system" || m.author === "routine") return { ...base, author: { kind: "system" }, content: red(m.content) };
  if (CARD_AUTHORS.has(m.author)) return { ...base, author: { kind: "card", card: m.author }, content: "" };
  const a = who(m.author);
  return { ...base, author: a ? { kind: "agent", ...a } : { kind: "system" }, content: red(m.content) };
}

export function guestTask(t: any) {
  return {
    id: t.id, agent_id: t.agent_id, thread_id: t.thread_id, source: t.source, status: t.status, title: red(t.title),
    from: who(t.from_agent_id), created_at: t.created_at, started_at: t.started_at ?? null, finished_at: t.finished_at ?? null,
    error: t.error ? red(String(t.error).split("\n")[0].slice(0, 300)) : null,
  };
}

function guestProgress(p: any) {
  return { agent_id: p.agent_id, task_id: p.task_id, activity: red(p.activity), state: p.state, started_at: p.started_at, stalled_for_s: p.stalled_for_s };
}

function guestMember(a: Agent) {
  const running = get<{ title: string }>(`SELECT title FROM tasks WHERE agent_id = ? AND status = 'running' LIMIT 1`, a.id);
  const queued = get<{ n: number }>(`SELECT COUNT(*) AS n FROM tasks WHERE agent_id = ? AND status = 'queued'`, a.id)?.n ?? 0;
  return {
    id: a.id, name: a.name, label: red(a.label), color: a.color,
    status: a.retired_at ? "done" : running ? "working" : queued ? "queued" : "idle", current: running ? red(running.title) : null,
  };
}

export function guestRoom(roomId: string) {
  const root = getAgent(roomId);
  if (!root) throw new Error("No such work");
  const ctx = roomCtx(roomId);
  const tIds = [...ctx.threads];
  const marks = tIds.map(() => "?").join(",") || "''";
  const messages = tIds.length ? all(`SELECT * FROM messages WHERE thread_id IN (${marks}) ORDER BY created_at, rowid`, ...tIds) : [];
  const tasks = tIds.length ? all(`SELECT * FROM tasks WHERE thread_id IN (${marks}) ORDER BY created_at`, ...tIds) : [];
  return {
    root: { id: root.id, name: root.name, label: red(root.label), color: root.color, done: !!root.retired_at },
    members: instanceTree(roomId).map(guestMember),
    lead_thread: dmThreadOf(root.id),
    messages: (messages as any[]).map(guestMessage),
    tasks: (tasks as any[]).filter((t) => t.source !== "compact").map(guestTask),
    progress: listProgress().filter((p) => p.root_id === roomId).map(guestProgress),
    // Where file paths in messages point (the page links them to /api/file, which checks each one).
    roots: [AGENTS_ROOT, WORK_ROOT],
  };
}

function guestRoadmaps(roomId: string) {
  return roadmapsOf(roomId).map(roadmapView).map((r: any) => ({
    id: r.id, title: red(r.title), status: r.status, counts: r.counts, updated_at: r.updated_at,
    items: r.items.map((i: any) => ({ id: i.id, title: red(i.title), status: i.status, phase: i.phase ?? null, owner: i.owner ?? null, note: red(i.note ?? null), after: i.after ?? [] })),
  }));
}

function guestDocuments(roomId: string) {
  return roomDocuments(roomId).filter((d) => !SENSITIVE.test(d.path)).map((d) => ({
    path: d.path, name: d.name, location: d.location, size: d.size, modified: d.modified, task_title: red(d.task_title),
  }));
}

const ATTACHED = /\/api\/file\?path=([^)\s"'<>]+)/g;
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// A file path written in a message, under the agents' homes or the work area (as the page links them).
const MENTIONED = new RegExp(`(?:${[AGENTS_ROOT, WORK_ROOT].map(esc).join("|")})\\/[^\\s\`'"“”‘’<>()\\[\\]{},;|*]+`, "g");

const real = (p: string) => { try { return fs.realpathSync(p); } catch { return null; } };
const inside = (p: string, dir: string) => p === dir || p.startsWith(dir + path.sep);

/** This work's own folders: its shared room folder and its tasks' git worktrees. */
function roomScopes(roomId: string, members: Set<string>) {
  const ids = [...members];
  const dirs = [getAgent(roomId)?.workspace ?? null];
  if (ids.length) {
    dirs.push(...all<{ path: string | null }>(`SELECT path FROM repo_worktrees WHERE instance_id IN (${ids.map(() => "?").join(",")})`, ...ids).map((w) => w.path));
  }
  return dirs.map((d) => (d ? real(d) : null)).filter((d): d is string => !!d);
}

/**
 * Files a guest may open:
 * - the work's documents (what its tasks wrote, and its shared folder);
 * - what this link uploaded;
 * - files attached or named in a message by the owner or an agent (never by a guest: a guest naming a
 *   path mustn't make it readable), and only inside this work's own folders, or the owner's own
 *   attachments in /work/uploads;
 * - images a document above shows by relative path, from inside that document's folder.
 * Each is still checked by /api/file: under the agents' homes or the work area, not credential-looking.
 */
function guestFiles(s: Share, uploads: Set<string>) {
  const ctx = roomCtx(s.room_id);
  const scopes = roomScopes(s.room_id, ctx.members);
  const out = new Set<string>();
  const add = (p: string | null) => { if (p) out.add(p); };
  for (const d of guestDocuments(s.room_id)) add(real(d.path));
  for (const u of uploads) add(real(u));
  const tIds = [...ctx.threads];
  if (tIds.length) {
    const rows = all<{ author: string; content: string }>(
      `SELECT author, content FROM messages WHERE thread_id IN (${tIds.map(() => "?").join(",")}) AND author NOT LIKE 'guest:%'`, ...tIds);
    const uploadsRoot = real(path.join(WORK_ROOT, "uploads"));
    for (const r of rows) {
      const named: string[] = [];
      for (const m of r.content.matchAll(ATTACHED)) { try { named.push(decodeURIComponent(m[1])); } catch { /* bad escape */ } }
      for (const m of r.content.matchAll(MENTIONED)) named.push(m[0].replace(/[.:,!?]+$/, ""));
      for (const n of named) {
        const p = real(n);
        if (!p) continue;
        if (scopes.some((d) => inside(p, d)) || (r.author === "user" && uploadsRoot && inside(p, uploadsRoot))) out.add(p);
      }
    }
  }
  // Images a Markdown document shows by relative path (e.g. report-img/fig.png next to report.md).
  for (const p of [...out]) {
    if (!/\.(md|markdown)$/i.test(p)) continue;
    let text = "";
    try { if (fs.statSync(p).size <= 2 * 1024 * 1024) text = fs.readFileSync(p, "utf8"); } catch { continue; }
    const folder = path.dirname(p);
    for (const m of text.matchAll(/!\[[^\]]*\]\(<?([^)\s>]+)>?[^)]*\)|<img[^>]+src="([^"]+)"/g)) {
      const rel = m[1] ?? m[2];
      if (!rel || /^([a-z][a-z0-9+.-]*:|\/|#)/i.test(rel) || !IMAGE.test(rel.split(/[?#]/)[0])) continue;
      let r = rel.split(/[?#]/)[0];
      try { r = decodeURIComponent(r); } catch { /* as written */ }
      const img = real(path.resolve(folder, r));
      if (img && inside(img, folder)) out.add(img); // no ../ out of the document's folder
    }
  }
  return out;
}

/** The event a guest's live view gets for a bus event, or null when it isn't about their room. */
export function guestEvent(ctx: RoomCtx, e: BusEvent): any | null {
  switch (e.type) {
    case "message.created":
      return ctx.threads.has(e.message.thread_id) ? { type: "message", message: guestMessage(e.message) } : null;
    case "task.updated":
      return ctx.threads.has(e.task?.thread_id) || ctx.members.has(e.task?.agent_id) ? { type: "task", task: guestTask(e.task) } : null;
    case "progress.updated":
      return e.progress?.root_id === ctx.roomId ? { type: "progress", progress: guestProgress(e.progress) } : null;
    case "progress.cleared":
      return ctx.members.has(e.agent_id) ? { type: "progress.cleared", task_id: e.task_id } : null;
    case "roadmap.updated":
      return e.roadmap?.root_id === ctx.roomId ? { type: "roadmaps" } : null;
    case "notes.updated":
      return e.roomId === ctx.roomId ? { type: "notes" } : null;
    case "hosting.updated":
      return e.service?.room_id === ctx.roomId ? { type: "services" } : null;
    case "agent.created": case "agent.updated":
      return ctx.members.has(e.agent?.id) || ctx.members.has(e.agent?.parent_instance_id) ? { type: "room" } : null;
    case "agent.retired": case "agent.status":
      return ctx.members.has(e.agentId) ? { type: "room" } : null;
    default:
      return null;
  }
}

// --- edit links: talking to the agents ----------------------------------------------------------------

/** A guest's message to the room's lead. Agents are told who it's from and what stays the owner's call. */
export function sendAsGuest(s: Share, text: string, files: string[]) {
  const root = getAgent(s.room_id);
  if (!root || root.retired_at) throw httpError(409, "This work is finished");
  const thread = dmThreadOf(root.id);
  if (!thread) throw httpError(409, "This work has no conversation to post to");
  const content = displayWithAttachments(text, files);
  const preface = `[A message from ${s.label}, a guest the owner shared this piece of work with (edit access), not from the owner. ` +
    `Follow their directions for this work. Anything that is the owner's to decide (spending, accounts, access or secrets, ` +
    `irreversible or breaking changes, anything outside this work) still goes to the owner with ask_owner. ` +
    `The guest reads this conversation, its documents and notes: never put secrets, tokens or credentials in them.]`;
  const firstLine = text.split("\n")[0] || "Attachment";
  return enqueueTask({
    agentId: root.id, threadId: thread, source: "user",
    prompt: `${preface}\n\n${attachmentsForAgent(content).replace("[Attached by the owner", `[Attached by ${s.label}`)}`,
    title: `${s.label}: ${firstLine.length > 70 ? firstLine.slice(0, 67) + "…" : firstLine}`,
    input: { author: `guest:${s.label}`, content },
  });
}

// --- the server ------------------------------------------------------------------------------------------

function httpError(statusCode: number, message: string) {
  return Object.assign(new Error(message), { statusCode });
}

function parseCookie(h: unknown, name: string) {
  if (typeof h !== "string") return undefined;
  for (const part of h.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return undefined;
}

/** A sliding window per key: allow() counts a hit if there's room; full() only looks. */
function limiter() {
  const hits = new Map<string, number[]>();
  const recent = (key: string, windowMs: number) => (hits.get(key) ?? []).filter((x) => Date.now() - x < windowMs);
  return {
    full: (key: string, max: number, windowMs: number) => recent(key, windowMs).length >= max,
    allow(key: string, max: number, windowMs: number) {
      const list = recent(key, windowMs);
      if (list.length >= max) { hits.set(key, list); return false; }
      list.push(Date.now());
      hits.set(key, list);
      if (hits.size > 5000) hits.clear();
      return true;
    },
  };
}

declare module "fastify" {
  interface FastifyRequest { guest?: Share }
}

export type ShareServerOptions = {
  /** The Host the server answers to (the tunnel's); tests inject one. */
  host?: () => string | null;
  /** The built web app (web/dist) holding share.html and assets/. */
  webDist?: string;
  /** The page's origin (https://<host> through the tunnel); a local trial run injects http://localhost:<port>. */
  origin?: (host: string) => string;
};

export async function buildShareServer(opts: ShareServerOptions = {}): Promise<FastifyInstance> {
  const hostOf = opts.host ?? publicHost;
  const originOf = opts.origin ?? ((host: string) => `https://${host}`);
  const webDist = opts.webDist ?? path.resolve(here, "../../web/dist");
  const share = Fastify({ logger: false, bodyLimit: 1024 * 1024, trustProxy: false });
  await share.register(fastifyWebsocket, { options: { maxPayload: 64 * 1024 } });
  const limits = limiter();
  const allow = limits.allow;
  const uploadsOf = new Map<string, Set<string>>(); // share id → files its guests uploaded

  const deny = (reply: FastifyReply, code: number, error: string) => reply.code(code).header("cache-control", "no-store").send({ error });

  share.addHook("onSend", async (req, reply, payload) => {
    const host = hostOf();
    reply.header("x-frame-options", "DENY");
    reply.header("x-content-type-options", "nosniff");
    reply.header("referrer-policy", "no-referrer");
    reply.header("permissions-policy", "camera=(), microphone=(), geolocation=(), usb=(), serial=()");
    reply.header("cross-origin-opener-policy", "same-origin");
    if (!reply.getHeader("content-security-policy")) {
      reply.header("content-security-policy",
        `default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; ` +
        `connect-src 'self'${host ? ` ${originOf(host).replace(/^http/, "ws")}` : ""}; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`);
    }
    if (req.url.startsWith("/api/")) reply.header("cache-control", "no-store");
    return payload;
  });

  // Every request: the tunnel's Host only; same-origin; JSON writes; a live link (but for the session trade).
  share.addHook("onRequest", async (req, reply) => {
    const host = hostOf();
    const h = String(req.headers.host ?? "").toLowerCase();
    if (!host || h !== host) return reply.code(404).header("cache-control", "no-store").send("Not found");
    const url = req.url.split("?")[0];
    if (!url.startsWith("/api/")) return;
    const site = req.headers["sec-fetch-site"];
    if (site !== undefined && site !== "same-origin" && site !== "none") return deny(reply, 403, "Cross-site request refused");
    const origin = req.headers.origin;
    if (origin !== undefined && origin !== originOf(host)) return deny(reply, 403, "Cross-origin request refused");
    if (!["GET", "HEAD"].includes(req.method)) {
      if (origin === undefined && site === undefined) return deny(reply, 403, "Cross-origin request refused");
      const len = Number(req.headers["content-length"] ?? 0);
      if ((len > 0 || req.headers["transfer-encoding"]) && !/^application\/json(\s*;|$)/i.test(String(req.headers["content-type"] ?? ""))) {
        return deny(reply, 415, "Send JSON");
      }
    }
    if (url === "/api/session") return;
    const s = shareByToken(parseCookie(req.headers.cookie, COOKIE));
    if (!s) return deny(reply, 401, "This link has expired or was turned off. Ask for a new one.");
    req.guest = s;
    touch(s);
  });

  share.setErrorHandler((err: any, _req, reply) => {
    const status = err.statusCode && err.statusCode >= 400 && err.statusCode < 600 ? err.statusCode : 400;
    // Guests get the message only, never a stack or detail.
    reply.code(status).header("cache-control", "no-store").send({ error: status >= 500 ? "Something went wrong" : String(err.message ?? "Bad request").slice(0, 300) });
  });

  const needEdit = (req: FastifyRequest) => {
    if (req.guest!.perm !== "edit") throw httpError(403, "This link is read-only");
  };

  // --- the page ---
  const sendFile = (reply: FastifyReply, file: string) => {
    let st: fs.Stats;
    try { st = fs.statSync(file); } catch { return reply.code(404).send("Not found"); }
    if (!st.isFile()) return reply.code(404).send("Not found");
    reply.header("content-type", file.endsWith(".js") ? "text/javascript; charset=utf-8" : file.endsWith(".css") ? "text/css; charset=utf-8"
      : file.endsWith(".html") ? "text/html; charset=utf-8" : contentType(file));
    reply.header("cache-control", file.endsWith(".html") ? "no-store" : "public, max-age=3600");
    return reply.send(fs.createReadStream(file));
  };
  share.get("/", async (_req, reply) => sendFile(reply, path.join(webDist, "share.html")));
  share.get("/assets/:file", async (req, reply) => {
    const f = String((req.params as any).file);
    if (!/^[A-Za-z0-9._-]+$/.test(f) || f.startsWith(".")) return reply.code(404).send("Not found");
    return sendFile(reply, path.join(webDist, "assets", f));
  });
  share.get("/favicon.svg", async (_req, reply) => sendFile(reply, path.join(webDist, "favicon.svg")));

  // --- the session ---
  share.post("/api/session", async (req, reply) => {
    // Only failed attempts count toward the limit (tokens are 256-bit; this just keeps guessing noisy and slow).
    if (limits.full("bad-session", RATE.badSessionsPerMin, 60_000)) return deny(reply, 429, "Too many attempts; wait a minute");
    const token = (req.body as any)?.token;
    const s = shareByToken(token);
    if (!s) {
      allow("bad-session", RATE.badSessionsPerMin, 60_000);
      return deny(reply, 401, "This link has expired or was turned off. Ask for a new one.");
    }
    const maxAge = Math.max(1, Math.floor((Date.parse(s.expires_at) - Date.now()) / 1000));
    reply.header("set-cookie", `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`);
    touch(s);
    return { perm: s.perm, label: s.label, expires_at: s.expires_at };
  });
  share.delete("/api/session", async (_req, reply) => {
    reply.header("set-cookie", `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`);
    return { ok: true };
  });

  // --- reading ---
  share.get("/api/room", async (req) => {
    const s = req.guest!;
    return { share: { perm: s.perm, label: s.label, expires_at: s.expires_at }, ...guestRoom(s.room_id) };
  });
  share.get("/api/roadmaps", async (req) => ({ roadmaps: guestRoadmaps(req.guest!.room_id) }));
  share.get("/api/documents", async (req) => ({ documents: guestDocuments(req.guest!.room_id) }));
  share.get("/api/notes", async (req) => ({
    notes: listNotes(req.guest!.room_id).map((n) => ({ id: n.id, quote: red(n.quote), body: red(n.body), created_at: n.created_at, updated_at: n.updated_at })),
  }));
  // Hosted services stay on the owner's private network: guests see what runs, not a way in.
  share.get("/api/services", async (req) => ({
    services: roomServices(req.guest!.room_id).map((v) => ({ id: v.id, name: v.name, status: v.status, started_by: v.started_by, created_at: v.created_at, stopped_at: v.stopped_at })),
  }));
  share.get("/api/file", async (req, reply) => {
    const s = req.guest!;
    const p = String((req.query as any).path ?? "");
    let real: string;
    try { real = fs.realpathSync(p); } catch { return deny(reply, 404, "File not found"); }
    if (!path.isAbsolute(p) || !allowed(real) || SENSITIVE.test(real) || !guestFiles(s, uploadsOf.get(s.id) ?? new Set()).has(real)) {
      return deny(reply, 403, "That file isn't part of this shared work");
    }
    const st = fs.statSync(real);
    if (!st.isFile()) return deny(reply, 404, "Not a file");
    const ct = contentType(real);
    const name = path.basename(real).replace(/[^\w.\- ]/g, "_");
    reply.header("content-disposition", `${(req.query as any).download ? "attachment" : "inline"}; filename="${name}"`);
    // Agent-written HTML/SVG runs nothing on this origin.
    if (/\.(html?|svg)$/i.test(real)) reply.header("content-security-policy", "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'");
    if (BINARY.test(real)) {
      reply.header("content-type", ct);
      return reply.send(fs.createReadStream(real));
    }
    // Anything else must read as text, so it can be redacted: unknown binaries (databases, keystores…) and
    // text too big to redact aren't served.
    if (st.size > MAX_TEXT) return deny(reply, 413, "This file is too large to share");
    const text = textOf(real);
    if (text === null) return deny(reply, 415, "This kind of file can't be shared");
    reply.header("content-type", ct.startsWith("text/") || ct === "image/svg+xml" ? ct : "text/plain; charset=utf-8");
    return reply.send(redactSecrets(text));
  });

  // --- edit links ---
  share.post("/api/uploads", { bodyLimit: 30 * 1024 * 1024 }, async (req, reply) => {
    const s = req.guest!;
    needEdit(req);
    if (!allow(`up:${s.id}`, RATE.uploadsPer10Min, 600_000)) return deny(reply, 429, "Too many uploads; wait a few minutes");
    const r = saveUpload(req.body as any);
    const set = uploadsOf.get(s.id) ?? new Set<string>();
    set.add(fs.realpathSync(r.path));
    uploadsOf.set(s.id, set);
    return r;
  });
  share.post("/api/messages", async (req, reply) => {
    const s = req.guest!;
    needEdit(req);
    if (!allow(`msg:${s.id}`, RATE.messagesPerMin, 60_000)) return deny(reply, 429, "Slow down: too many messages in a minute");
    const b = req.body as any;
    const text = String(b?.text ?? "").trim();
    if (text.length > 20_000) throw httpError(400, "That message is too long");
    // Only files this link uploaded may be attached.
    const mine = uploadsOf.get(s.id) ?? new Set<string>();
    const files = checkAttachments(b?.files);
    if (files.some((f) => !mine.has(f))) throw httpError(403, "Attach files by uploading them here");
    if (!text && !files.length) throw httpError(400, "Message is empty");
    const t = sendAsGuest(s, text, files);
    return { task_id: t.id };
  });
  share.post("/api/stop", async (req) => {
    const s = req.guest!;
    needEdit(req);
    const id = String((req.body as any)?.task_id ?? "");
    const t = get<any>(`SELECT id, agent_id, status FROM tasks WHERE id = ?`, id);
    if (!t || !roomCtx(s.room_id).members.has(t.agent_id)) throw httpError(404, "No such task in this work");
    if (t.status === "running" || t.status === "queued") stopTask(t.id);
    return { ok: true };
  });

  // --- live ---
  share.get("/api/events", { websocket: true }, (socket, req) => {
    const s = req.guest;
    if (!s) return socket.close(1008, "not allowed");
    let ctx = roomCtx(s.room_id);
    // Streamed replies: what's been said so far, redacted as a whole and sent at most 4 times a second.
    const live = new Map<string, { agent_id: string; text: string; timer: NodeJS.Timeout | null }>();
    const send = (o: unknown) => { if (socket.readyState === 1) socket.send(JSON.stringify(o)); };
    const flush = (taskId: string) => {
      const l = live.get(taskId);
      if (!l) return;
      l.timer = null;
      send({ type: "turn.text", task_id: taskId, agent_id: l.agent_id, text: redactSecrets(l.text) });
    };
    const off = subscribe((e) => {
      if (e.type === "turn.delta") {
        if (!ctx.members.has(e.agentId)) return;
        const l = live.get(e.taskId) ?? { agent_id: e.agentId, text: "", timer: null };
        l.text = (l.text + e.text).slice(-200_000);
        live.set(e.taskId, l);
        if (!l.timer) l.timer = setTimeout(() => flush(e.taskId), 250);
        return;
      }
      if (e.type === "shares.updated" && e.roomId === s.room_id) {
        const cur = shareById(s.id);
        if (!cur || !isLive(cur)) { send({ type: "expired" }); socket.close(4001, "link turned off"); }
        return;
      }
      if (e.type === "agent.created" || e.type === "agent.retired" || e.type === "thread.created") ctx = roomCtx(s.room_id);
      const out = guestEvent(ctx, e);
      if (!out) return;
      if (out.type === "message" && out.message.task_id) {
        const l = live.get(out.message.task_id);
        if (l?.timer) clearTimeout(l.timer);
        live.delete(out.message.task_id);
      }
      if (out.type === "task" && !["running", "queued"].includes(out.task.status)) {
        const l = live.get(out.task.id);
        if (l?.timer) clearTimeout(l.timer);
        live.delete(out.task.id);
      }
      send(out);
    });
    // Expiry ends the live view too.
    const check = setInterval(() => {
      const cur = shareById(s.id);
      if (!cur || !isLive(cur)) { send({ type: "expired" }); socket.close(4001, "link expired"); }
    }, 15_000);
    socket.on("close", () => {
      off();
      clearInterval(check);
      for (const l of live.values()) if (l.timer) clearTimeout(l.timer);
    });
    socket.on("message", () => { /* nothing is accepted from guests over the socket */ });
  });

  share.setNotFoundHandler((_req, reply) => reply.code(404).header("cache-control", "no-store").send({ error: "Not found" }));
  return share;
}

/** Listens on loopback only: ngrok, running on this machine, is the one way in. */
export async function startShareServer(log: (m: string) => void) {
  const share = await buildShareServer();
  await share.listen({ host: "127.0.0.1", port: ports.share });
  log(`sharing: guest server on 127.0.0.1:${ports.share} (public only while a link is live, through ngrok)`);
  return { stop: () => share.close() };
}
