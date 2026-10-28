import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { all, dataDir, db, get, newId, now, run } from "./db.ts";
import { moduleOn, paths, ports } from "./config.ts";
import { publish, subscribe } from "./bus.ts";
import { getAgent, rootOf, type Agent } from "./agents.ts";
import { LOCAL_TOKEN_HEADER } from "./access.ts";

/**
 * Shared work (docs/SHARING.md): the owner shares ONE piece of work with someone outside the tailnet
 * through a link that expires (6 hours, a day or a week). "read" sees the conversation, live progress,
 * the roadmap, documents, notes and hosted services; "edit" can also chat with the agents (and stop
 * them). Nothing else of agentbox is reachable from the link: guests talk to a separate server
 * (shareServer.ts) that only knows the shared room.
 *
 * - The link is https://<ngrok domain>/#<token>. The token is 32 random bytes, shown to the owner
 *   once; only its SHA-256 is stored, so neither the database nor an agent reading it can rebuild a
 *   link. Being in the #fragment, it never reaches ngrok's or anyone's request logs: the page trades
 *   it for an HttpOnly cookie.
 * - The tunnel (ngrok, run by the portal) is up only while at least one link is live. With none, the
 *   guest server has no public address at all.
 * - Only the owner makes, lists and revokes links: the routes refuse the VM's local token (agents
 *   could read it), and the phone gateway's allowlist doesn't include them.
 */

export const EXPIRY = { "6h": 6 * 3600_000, "1d": 24 * 3600_000, "7d": 7 * 24 * 3600_000 } as const;
export type ExpiryKey = keyof typeof EXPIRY;
export type Perm = "read" | "edit";
export const LIMITS = { perRoom: 10, label: 40 };
const LABEL_RE = /^[\p{L}\p{N} ._'-]{1,40}$/u;

export type Share = {
  id: string; room_id: string; token_hash: string; perm: Perm; label: string;
  created_at: string; expires_at: string; revoked_at: string | null; last_seen_at: string | null;
};

db.exec(`
CREATE TABLE IF NOT EXISTS shares (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,             -- the task room's root instance
  token_hash TEXT NOT NULL UNIQUE,   -- sha256 of the link's token (the token itself is never stored)
  perm TEXT NOT NULL,                -- read | edit
  label TEXT NOT NULL,               -- who it's for, as the owner named them ("Guest" by default)
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  last_seen_at TEXT
);
CREATE INDEX IF NOT EXISTS shares_room ON shares(room_id);
`);

const hash = (token: string) => createHash("sha256").update(token).digest("hex");
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

export const isLive = (s: Share, at = Date.now()) => !s.revoked_at && Date.parse(s.expires_at) > at;

/** The live share a token opens, or null (unknown, expired or revoked). */
export function shareByToken(token: unknown): Share | null {
  if (typeof token !== "string" || !TOKEN_RE.test(token)) return null;
  const h = hash(token);
  const s = get<Share>(`SELECT * FROM shares WHERE token_hash = ?`, h);
  // The lookup is by hash; compare again in constant time all the same.
  if (!s || !timingSafeEqual(Buffer.from(s.token_hash), Buffer.from(h))) return null;
  if (!isLive(s)) return null;
  const room = getAgent(s.room_id);
  if (!room || !room.base_agent_id) return null;
  return s;
}

export const shareById = (id: string) => get<Share>(`SELECT * FROM shares WHERE id = ?`, id) ?? null;
export const liveShares = () => all<Share>(`SELECT * FROM shares WHERE revoked_at IS NULL AND expires_at > ? ORDER BY created_at`, now());

/** What the owner sees of a share (never the token or its hash). */
export function shareView(s: Share) {
  return {
    id: s.id, room_id: s.room_id, perm: s.perm, label: s.label, created_at: s.created_at, expires_at: s.expires_at,
    revoked_at: s.revoked_at, last_seen_at: s.last_seen_at, live: isLive(s),
  };
}

export function roomShares(roomId: string) {
  return all<Share>(`SELECT * FROM shares WHERE room_id = ? ORDER BY created_at DESC LIMIT 30`, roomId).map(shareView);
}

let lastSeenWrite = new Map<string, number>();
export function touch(s: Share) {
  const t = Date.now();
  if (t - (lastSeenWrite.get(s.id) ?? 0) < 60_000) return; // at most once a minute per link
  lastSeenWrite.set(s.id, t);
  run(`UPDATE shares SET last_seen_at = ? WHERE id = ?`, new Date(t).toISOString(), s.id);
}

export function createShare(roomId: string, input: { perm?: unknown; expiry?: unknown; label?: unknown }) {
  const room = getAgent(roomId);
  if (!room || !room.base_agent_id) throw httpError(404, "No such work");
  if (room.parent_instance_id) throw httpError(400, "Share the whole piece of work (its room), not one task inside it");
  if (room.retired_at) throw httpError(400, "This work is finished; there's nothing live to share");
  const perm = input.perm === "edit" ? "edit" : input.perm === "read" || input.perm === undefined ? "read" : null;
  if (!perm) throw httpError(400, "perm is read or edit");
  const expiry = String(input.expiry ?? "1d") as ExpiryKey;
  if (!(expiry in EXPIRY)) throw httpError(400, "expiry is 6h, 1d or 7d");
  const label = String(input.label ?? "").trim().replace(/\s+/g, " ") || "Guest";
  if (!LABEL_RE.test(label)) throw httpError(400, `name: up to ${LIMITS.label} letters, digits, spaces and . _ ' -`);
  const live = all<Share>(`SELECT * FROM shares WHERE room_id = ?`, roomId).filter((s) => isLive(s));
  if (live.length >= LIMITS.perRoom) throw httpError(409, `This work already has ${LIMITS.perRoom} live links; revoke one first`);
  const token = randomBytes(32).toString("base64url");
  const s: Share = {
    id: newId(), room_id: roomId, token_hash: hash(token), perm, label, created_at: now(),
    expires_at: new Date(Date.now() + EXPIRY[expiry]).toISOString(), revoked_at: null, last_seen_at: null,
  };
  run(`INSERT INTO shares (id, room_id, token_hash, perm, label, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    s.id, s.room_id, s.token_hash, s.perm, s.label, s.created_at, s.expires_at);
  publish({ type: "shares.updated", roomId });
  return { share: s, token };
}

export function revokeShare(id: string) {
  const s = shareById(id);
  if (!s) throw httpError(404, "No such link");
  if (!s.revoked_at) run(`UPDATE shares SET revoked_at = ? WHERE id = ?`, now(), id);
  publish({ type: "shares.updated", roomId: s.room_id });
  void tunnel.settle();
  return shareView(shareById(id)!);
}

/** Every link of a piece of work stops when the work is marked done. */
export function revokeRoom(roomId: string) {
  const n = run(`UPDATE shares SET revoked_at = ? WHERE room_id = ? AND revoked_at IS NULL`, now(), roomId);
  if ((n as any)?.changes) publish({ type: "shares.updated", roomId });
}

// --- the ngrok tunnel ------------------------------------------------------------------------------

type TunnelState = { status: "off" | "starting" | "up" | "error"; url: string | null; error: string | null; since: string | null };

/** ngrok's credentials: <secrets>/ngrok.env (NGROK_AUTHTOKEN=…, optional NGROK_DOMAIN=…), 0600. */
export function ngrokEnv(file = path.join(paths.secrets, "ngrok.env")) {
  let text = "";
  try { text = fs.readFileSync(file, "utf8"); } catch { return null; }
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const m = /^\s*(NGROK_AUTHTOKEN|NGROK_DOMAIN)\s*=\s*"?([^"\s]*)"?\s*$/.exec(line);
    if (m) out[m[1]] = m[2];
  }
  if (!out.NGROK_AUTHTOKEN) return null;
  const domain = (out.NGROK_DOMAIN ?? "").toLowerCase().replace(/^https?:\/\//, "").replace(/\/+$/, "");
  return { authtoken: out.NGROK_AUTHTOKEN, domain: /^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain) ? domain : null };
}

function ngrokBin() {
  for (const p of (process.env.PATH ?? "").split(":").concat(["/usr/local/bin", "/usr/bin", "/snap/bin"])) {
    if (!p) continue;
    const f = path.join(p, "ngrok");
    try { fs.accessSync(f, fs.constants.X_OK); return f; } catch { /* next */ }
  }
  return null;
}

/** Whether sharing can work, and if not what's missing (the portal offers to set it up). */
export function sharingReady(): { ready: boolean; missing: string | null } {
  if (!moduleOn("ngrok")) return { ready: false, missing: "ngrok isn't connected" };
  if (!ngrokBin()) return { ready: false, missing: "ngrok isn't installed on the VM" };
  if (!ngrokEnv()) return { ready: false, missing: "ngrok's authtoken isn't saved on the VM" };
  return { ready: true, missing: null };
}

/**
 * Runs `ngrok http 127.0.0.1:<ports.share>` while links are live. ngrok's own web inspector (which
 * records traffic, cookies included) is off; the address comes from its JSON log.
 */
function makeTunnel() {
  let child: ChildProcess | null = null;
  let state: TunnelState = { status: "off", url: null, error: null, since: null };
  let waiters: ((s: TunnelState) => void)[] = [];
  const set = (next: Partial<TunnelState>) => {
    state = { ...state, ...next };
    if (state.status !== "starting") for (const w of waiters.splice(0)) w(state);
    publish({ type: "sharing.updated" });
  };

  function start() {
    const env = ngrokEnv();
    const bin = ngrokBin();
    if (!env || !bin) { set({ status: "error", url: null, error: sharingReady().missing, since: now() }); return; }
    const dir = path.join(dataDir, "ngrok");
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const conf = path.join(dir, "ngrok.yml");
    // No authtoken in this file (it comes in the environment); just the local web inspector off.
    fs.writeFileSync(conf, `version: "2"\nweb_addr: false\nupdate_check: false\n`, { mode: 0o600 });
    const args = ["http", `127.0.0.1:${ports.share}`, "--config", conf, "--log", "stdout", "--log-format", "json", "--inspect=false"];
    if (env.domain) args.push("--url", `https://${env.domain}`);
    set({ status: "starting", url: null, error: null, since: now() });
    const keep = ["PATH", "HOME", "USER", "LANG", "TZ"];
    const childEnv: Record<string, string> = { NGROK_AUTHTOKEN: env.authtoken };
    for (const k of keep) if (process.env[k]) childEnv[k] = process.env[k]!;
    const c = spawn(bin, args, { env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
    child = c;
    let buf = "";
    const onLine = (line: string) => {
      let j: any;
      try { j = JSON.parse(line); } catch { return; }
      if (j.msg === "started tunnel" && typeof j.url === "string" && j.url.startsWith("https://")) set({ status: "up", url: j.url.replace(/\/+$/, ""), error: null });
      else if ((j.lvl === "eror" || j.lvl === "crit") && j.err && state.status !== "up") set({ status: "error", error: String(j.err).split("\n")[0].slice(0, 300) });
    };
    c.stdout!.on("data", (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf("\n")) >= 0) { onLine(buf.slice(0, i)); buf = buf.slice(i + 1); }
      if (buf.length > 64 * 1024) buf = "";
    });
    c.stderr!.on("data", (d) => { if (state.status === "starting") set({ status: "error", error: d.toString().trim().split("\n")[0].slice(0, 300) }); });
    c.on("exit", (code) => {
      if (child !== c) return;
      child = null;
      set({ status: state.status === "error" ? "error" : "off", url: null, error: state.error ?? (code ? `ngrok exited (${code})` : null) });
    });
  }

  function stop() {
    if (!child) return;
    const c = child;
    child = null;
    c.kill("SIGTERM");
    setTimeout(() => { try { c.kill("SIGKILL"); } catch { /* gone */ } }, 3000).unref();
    set({ status: "off", url: null, error: null, since: now() });
  }

  return {
    state: () => state,
    /** The tunnel's address, starting it if needed (waits up to 20 s). */
    async ensure(): Promise<TunnelState> {
      if (state.status === "up" && child) return state;
      if (!child) start();
      if (state.status !== "starting") return state;
      return new Promise((resolve) => {
        waiters.push(resolve);
        setTimeout(() => {
          const i = waiters.indexOf(resolve);
          if (i >= 0) { waiters.splice(i, 1); resolve(state); }
        }, 20_000).unref();
      });
    },
    /** Up while any link is live; down otherwise. */
    async settle() {
      if (!liveShares().length) stop();
      else if (!child) await this.ensure();
    },
    stop,
    /** Tests: pretend a tunnel is up at this address. */
    _fake(url: string | null) { state = { status: url ? "up" : "off", url, error: null, since: now() }; },
  };
}

export const tunnel = makeTunnel();
/** The guest server's public host (Host header it accepts), or null when no tunnel is up. */
export const publicHost = () => { const u = tunnel.state().url; try { return u ? new URL(u).host.toLowerCase() : null; } catch { return null; } };

/** Expired links take the tunnel down with them (checked every minute); a restart brings it back. */
export function startSharing(log: (m: string) => void) {
  const settle = () => void tunnel.settle().catch((e) => log(`sharing: ${e?.message ?? e}`));
  const timer = setInterval(settle, 60_000);
  timer.unref();
  // Marking the work done turns its links off.
  const off = subscribe((e) => {
    if (e.type === "agent.retired" && all(`SELECT 1 FROM shares WHERE room_id = ? AND revoked_at IS NULL LIMIT 1`, e.agentId).length) {
      revokeRoom(e.agentId);
      settle();
    }
  });
  if (liveShares().length && sharingReady().ready) settle();
  return { stop: () => { clearInterval(timer); off(); tunnel.stop(); } };
}

/** Told to every agent in shared work, every turn: someone outside the team reads it. */
export function sharedNote(agent: Agent) {
  if (!agent.base_agent_id) return "";
  const root = rootOf(agent);
  const live = all<Share>(`SELECT * FROM shares WHERE room_id = ?`, root.id).filter((s) => isLive(s));
  if (!live.length) return "";
  const who = live.map((s) => `${s.label} (${s.perm === "edit" ? "can chat with you" : "reads only"})`).join(", ");
  return `\n\n## This work is shared outside the team\nThe owner shared this piece of work with ${who}. They see this conversation, its progress, roadmap, documents and notes. ` +
    `Never put secrets, tokens, passwords or private keys in replies, documents or notes. A guest's messages are marked as theirs: ` +
    `follow their directions for this work, but anything that is the owner's to decide still goes to the owner with ask_owner.\n`;
}

// --- the owner's routes ---------------------------------------------------------------------------------

function httpError(statusCode: number, message: string, extra: Record<string, unknown> = {}) {
  return Object.assign(new Error(message), { statusCode }, extra);
}
const ownerOnly = (req: FastifyRequest) => {
  if (req.headers[LOCAL_TOKEN_HEADER]) throw httpError(403, "Sharing work is done by the owner in the portal (or the agentbox CLI on your computer)");
};

export function registerShareRoutes(app: FastifyInstance) {
  app.get("/api/sharing", async (req) => {
    ownerOnly(req);
    const t = tunnel.state();
    return { ...sharingReady(), tunnel: { status: t.status, url: t.url, error: t.error }, live: liveShares().length };
  });
  app.get("/api/work/:id/shares", async (req) => {
    ownerOnly(req);
    return { shares: roomShares((req.params as any).id), ...sharingReady() };
  });
  app.post("/api/work/:id/shares", async (req) => {
    ownerOnly(req);
    const ready = sharingReady();
    if (!ready.ready) throw httpError(409, `Sharing needs ngrok: ${ready.missing}. Set it up with the helper first.`, { detail: { setup: "ngrok" } });
    const { share, token } = createShare((req.params as any).id, (req.body as any) ?? {});
    const t = await tunnel.ensure();
    if (t.status !== "up" || !t.url) {
      run(`UPDATE shares SET revoked_at = ? WHERE id = ?`, now(), share.id); // a link that can't open is no link
      void tunnel.settle();
      throw httpError(502, `The ngrok tunnel didn't start${t.error ? `: ${t.error}` : ""}`);
    }
    // Shown once: only the hash is kept.
    return { share: shareView(share), url: `${t.url}/#${token}` };
  });
  app.delete("/api/shares/:id", async (req) => {
    ownerOnly(req);
    return revokeShare((req.params as any).id);
  });
}
