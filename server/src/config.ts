import fs from "node:fs";
import path from "node:path";
import { parse } from "yaml";

/**
 * The agentbox config (docs/V2-ARCHITECTURE.md § 2): /etc/agentbox/config.yaml, or the file named by
 * AGENTBOX_CONFIG. Read at start; it holds no secrets. `modules.*` is re-read when the file changes
 * (refreshModules(): a cheap mtime check, throttled), because `agentbox integration connect|disconnect`
 * flips them without restarting the portal (docs/V2-ARCHITECTURE.md, Changes (integrations)).
 * Every other key needs a restart.
 *
 * Without a config file (development, the in-process tests) the built-in defaults reproduce the
 * pre-v2 behaviour: data in ./data, every module on, the usual ports.
 *
 * The older per-path env overrides (AGENTBOX_DATA, AGENTBOX_AGENTS, AGENTBOX_WORK, AGENTBOX_SKILLS,
 * PORT, AGENTBOX_MOBILE_PORT) still win over the file, so the tests can point everything at a temp
 * folder.
 */

export const MODULE_IDS = [
  "core", "claude", "access", "display", "terminal",
  // integrations (§10.2)
  "github", "gitlab", "bitbucket", "aws", "gcp", "azure", "kubernetes", "db-tunnel", "env-files",
  "voice", "mobile", "mobile-app", "push", "teams", "slack", "bench", "onshape", "ngrok",
] as const;
export type ModuleId = (typeof MODULE_IDS)[number];
/** Always on, whatever the file says. */
export const REQUIRED_MODULES: ModuleId[] = ["core", "claude", "access"];

export type AccessMode = "tailscale" | "cloudflare" | "ssh-tunnel";

export type Config = {
  host: "cloud" | "lima";
  access: AccessMode;
  /** The unix user agents run as. */
  user: string;
  /** Passwordless sudo for the agent user (audit H3: selftest warns while true). */
  agent_sudo: boolean;
  paths: {
    src: string; app: string; data: string; work: string; agents: string; team: string; skills: string; secrets: string;
    /** Integration settings and rendered prompt summaries (§10.2): <id>.yaml, <id>.summary.md. */
    integrations: string;
  };
  /**
   * apps: the hosting gateway (hosting.ts); its services listen on apps+10 … apps+109.
   * share: the guest server for shared work (shareServer.ts), reached only through the ngrok tunnel.
   */
  ports: { portal: number; screen: number; terminal: number; gateway: number; guide: number; bench: number; apps: number; share: number };
  modules: Record<ModuleId, boolean>;
  tailscale: { hostname: string };
  cloudflare: { hostname: string; team_domain: string; aud: string };
  owner: { tailscale_login: string; email: string };
  mobile: { serve_port: number };
  /** Hosted services' link: https://<node>.ts.net:<serve_port>/<name>/ (tailscale serve: 443, 8443 or 10000). */
  hosting: { serve_port: number };
  /**
   * How much work runs at once. running_turns: agent turns in flight across all agents (each is a
   * Claude process; AGENTBOX_MAX_RUNNING still wins). per_role: live tasks of one role an agent may
   * start (role.max_replicas overrides, up to this or 6, whichever is larger).
   */
  limits: { running_turns: number; per_role: number };
  /** Where this config came from: a file path, or "defaults". */
  source: string;
};

/** Defaults for keys a config file leaves out (the values bootstrap writes). */
const FILE_DEFAULTS: Omit<Config, "source"> = {
  host: "cloud",
  access: "tailscale",
  user: "agentbox",
  agent_sudo: true,
  paths: {
    src: "/opt/agentbox/src", app: "/opt/agentbox/app", data: "/opt/agentbox/data", work: "/work", agents: "/agents",
    team: "/team", skills: "/skills", secrets: "/secrets", integrations: "/etc/agentbox/integrations",
  },
  ports: { portal: 7700, screen: 7701, terminal: 7702, gateway: 7710, guide: 7699, bench: 7740, apps: 7790, share: 7785 },
  modules: {
    core: true, claude: true, access: true, display: true, terminal: true,
    // Integrations are off until connected (setup/config.default.yaml).
    github: false, gitlab: false, bitbucket: false, aws: false, gcp: false, azure: false, kubernetes: false,
    "db-tunnel": false, "env-files": false, voice: false, mobile: false, "mobile-app": false, push: false,
    teams: false, slack: false, bench: false, onshape: false, ngrok: false,
  },
  tailscale: { hostname: "" },
  cloudflare: { hostname: "", team_domain: "", aud: "" },
  owner: { tailscale_login: "", email: "" },
  mobile: { serve_port: 8443 },
  hosting: { serve_port: 10000 },
  limits: { running_turns: 10, per_role: 10 },
};

/** No config file: today's behaviour (everything on, data next to the server). */
function devDefaults(): Omit<Config, "source"> {
  const d = structuredClone(FILE_DEFAULTS);
  d.access = "ssh-tunnel";
  d.user = process.env.USER ?? "agentbox";
  d.paths.data = path.resolve("data");
  for (const id of MODULE_IDS) d.modules[id] = true;
  d.mobile.serve_port = 443; // pre-v2: the gateway owned tailscale serve :443
  return d;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

function str(v: unknown, fallback: string) {
  return typeof v === "string" ? v : fallback;
}
function absPath(v: unknown, fallback: string, key: string) {
  if (v === undefined || v === null) return fallback;
  if (typeof v !== "string" || !path.isAbsolute(v)) throw new Error(`config: paths.${key} must be an absolute path`);
  return path.normalize(v);
}
function port(v: unknown, fallback: number, key: string) {
  if (v === undefined || v === null) return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`config: ports.${key} must be a TCP port`);
  return n;
}
function bool(v: unknown, fallback: boolean, key: string) {
  if (v === undefined || v === null) return fallback;
  if (typeof v !== "boolean") throw new Error(`config: ${key} must be true or false`);
  return v;
}
function count(v: unknown, fallback: number, key: string) {
  if (v === undefined || v === null) return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 100) throw new Error(`config: limits.${key} must be a whole number from 1 to 100`);
  return n;
}

/** Merge a parsed file over the defaults, validating as we go. Unknown keys are ignored. */
export function fromObject(raw: unknown, base: Omit<Config, "source"> = FILE_DEFAULTS): Omit<Config, "source"> {
  const c = structuredClone(base);
  if (raw === null || raw === undefined) return c;
  if (!isObj(raw)) throw new Error("config: the file must be a YAML mapping");
  if (raw.host !== undefined) {
    if (raw.host !== "cloud" && raw.host !== "lima") throw new Error("config: host must be cloud or lima");
    c.host = raw.host;
  }
  if (raw.access !== undefined) {
    if (!["tailscale", "cloudflare", "ssh-tunnel"].includes(raw.access as string)) throw new Error("config: access must be tailscale, cloudflare or ssh-tunnel");
    c.access = raw.access as AccessMode;
  }
  if (raw.user !== undefined) {
    if (typeof raw.user !== "string" || !/^[a-z_][a-z0-9_-]{0,31}$/.test(raw.user)) throw new Error("config: user must be a unix user name");
    c.user = raw.user;
  }
  c.agent_sudo = bool(raw.agent_sudo, c.agent_sudo, "agent_sudo");
  if (isObj(raw.paths)) for (const k of Object.keys(c.paths) as (keyof Config["paths"])[]) c.paths[k] = absPath(raw.paths[k], c.paths[k], k);
  if (isObj(raw.ports)) for (const k of Object.keys(c.ports) as (keyof Config["ports"])[]) c.ports[k] = port(raw.ports[k], c.ports[k], k);
  if (isObj(raw.modules)) for (const id of MODULE_IDS) c.modules[id] = bool(raw.modules[id], c.modules[id], `modules.${id}`);
  if (isObj(raw.tailscale)) c.tailscale.hostname = str(raw.tailscale.hostname, c.tailscale.hostname);
  if (isObj(raw.cloudflare)) for (const k of ["hostname", "team_domain", "aud"] as const) c.cloudflare[k] = str(raw.cloudflare[k], c.cloudflare[k]);
  if (isObj(raw.owner)) for (const k of ["tailscale_login", "email"] as const) c.owner[k] = str(raw.owner[k], c.owner[k]);
  if (isObj(raw.mobile)) c.mobile.serve_port = port(raw.mobile.serve_port, c.mobile.serve_port, "mobile.serve_port");
  if (isObj(raw.hosting)) c.hosting.serve_port = port(raw.hosting.serve_port, c.hosting.serve_port, "hosting.serve_port");
  if (isObj(raw.limits)) for (const k of Object.keys(c.limits) as (keyof Config["limits"])[]) c.limits[k] = count(raw.limits[k], c.limits[k], k);
  for (const id of REQUIRED_MODULES) c.modules[id] = true;
  return c;
}

/** Load the config: the file (if any), then the env overrides. Throws on an invalid file. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const file = env.AGENTBOX_CONFIG || "/etc/agentbox/config.yaml";
  let c: Omit<Config, "source">;
  let source = "defaults";
  let text: string | null = null;
  try { text = fs.readFileSync(file, "utf8"); } catch (e: any) {
    // An explicitly named file must exist; the default location is optional (dev).
    if (env.AGENTBOX_CONFIG || e?.code !== "ENOENT") throw new Error(`config: cannot read ${file}: ${e?.code ?? e}`);
  }
  if (text !== null) {
    c = fromObject(parse(text));
    source = file;
  } else {
    c = devDefaults();
  }
  if (env.AGENTBOX_DATA) c.paths.data = path.resolve(env.AGENTBOX_DATA);
  if (env.AGENTBOX_AGENTS) c.paths.agents = path.resolve(env.AGENTBOX_AGENTS);
  if (env.AGENTBOX_WORK) c.paths.work = path.resolve(env.AGENTBOX_WORK);
  if (env.AGENTBOX_SKILLS) c.paths.skills = path.resolve(env.AGENTBOX_SKILLS);
  if (env.AGENTBOX_TEAM) c.paths.team = path.resolve(env.AGENTBOX_TEAM);
  if (env.AGENTBOX_SECRETS) c.paths.secrets = path.resolve(env.AGENTBOX_SECRETS);
  if (env.AGENTBOX_INTEGRATIONS) c.paths.integrations = path.resolve(env.AGENTBOX_INTEGRATIONS);
  if (env.PORT) c.ports.portal = port(env.PORT, c.ports.portal, "portal (PORT)");
  if (env.AGENTBOX_MOBILE_PORT) c.ports.gateway = port(env.AGENTBOX_MOBILE_PORT, c.ports.gateway, "gateway (AGENTBOX_MOBILE_PORT)");
  return { ...c, source };
}

export const config: Config = loadConfig();
export const paths = config.paths;
export const ports = config.ports;

// --- live module switches ------------------------------------------------------------------------

let stamp = fileStamp(config.source);
let checkedAt = Date.now();
/** Every `modules.<id>: true|false` in the file, including ids this build doesn't know. */
let fileModules: Record<string, boolean> = readFileModules(config.source) ?? {};
const listeners = new Set<(changed: string[]) => void>();

function fileStamp(file: string) {
  if (file === "defaults") return null;
  try { const st = fs.statSync(file); return `${st.mtimeMs}:${st.size}:${st.ino}`; } catch { return null; }
}
function readFileModules(file: string): Record<string, boolean> | null {
  if (file === "defaults") return null;
  try {
    const raw = parse(fs.readFileSync(file, "utf8"));
    const m = isObj(raw) && isObj(raw.modules) ? raw.modules : {};
    return Object.fromEntries(Object.entries(m).filter(([, v]) => typeof v === "boolean")) as Record<string, boolean>;
  } catch { return null; }
}

/** Called with the ids whose `modules.<id>` changed after the file was re-read. */
export function onModulesChange(fn: (changed: string[]) => void) {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/**
 * Re-read `modules.*` if the config file changed since the last look (mtime/size/inode; at most once
 * per `minIntervalMs`). Returns the ids that changed. An unreadable or invalid file keeps the
 * current switches (and logs). No file (development): nothing to watch.
 */
export function refreshModules(minIntervalMs = 1000): string[] {
  if (config.source === "defaults") return [];
  const t = Date.now();
  if (t - checkedAt < minIntervalMs) return [];
  checkedAt = t;
  const next = fileStamp(config.source);
  if (next === stamp) return [];
  let fresh: Record<ModuleId, boolean>;
  let raw: Record<string, boolean> | null;
  try {
    fresh = fromObject(parse(fs.readFileSync(config.source, "utf8"))).modules;
    raw = readFileModules(config.source);
  } catch (e: any) {
    console.error(`config: ${config.source} changed but can't be read; keeping the module switches:`, e?.message ?? e);
    return [];
  }
  stamp = next;
  const changed = new Set<string>(MODULE_IDS.filter((id) => fresh[id] !== config.modules[id]));
  for (const id of MODULE_IDS) config.modules[id] = fresh[id];
  if (raw) {
    for (const id of new Set([...Object.keys(raw), ...Object.keys(fileModules)])) {
      if (!(MODULE_IDS as readonly string[]).includes(id) && raw[id] !== fileModules[id]) changed.add(id);
    }
    fileModules = raw;
  }
  const ids = [...changed];
  if (ids.length) for (const fn of listeners) { try { fn([...ids]); } catch (e) { console.error("config: listener failed", e); } }
  return ids;
}

/**
 * `modules.<id>`, fresh. Ids this build doesn't know (a newer catalog) come from the file; without a
 * file (development) they count as on, like every module.
 */
export function moduleOn(id: string): boolean {
  refreshModules();
  if ((MODULE_IDS as readonly string[]).includes(id)) return config.modules[id as ModuleId] === true;
  return config.source === "defaults" ? true : fileModules[id] === true;
}

/**
 * Whether a module's features are on (re-reads the switches if the file changed). Dependencies
 * count: push needs mobile, mobile-app needs mobile.
 */
export function enabled(id: ModuleId): boolean {
  refreshModules();
  if (!config.modules[id]) return false;
  if (id === "push" || id === "mobile-app") return config.modules.mobile;
  if (id === "mobile") return config.access === "tailscale" || config.source === "defaults";
  return true;
}

/** GET /api/config/public: what the UI needs to show or hide features. No secrets, no paths. */
export function publicConfig() {
  return {
    host: config.host,
    access: config.access,
    modules: Object.fromEntries(MODULE_IDS.map((id) => [id, enabled(id)])) as Record<ModuleId, boolean>,
  };
}

/**
 * What the access layer (server/src/access-config.ts, access workstream) needs: the mode, the
 * identities it trusts and the ports it proxies (/term/, /screen/, /setup/). Wired in at merge.
 */
export function accessProjection() {
  return {
    access: config.access,
    tailscale: { hostname: config.tailscale.hostname },
    cloudflare: { hostname: config.cloudflare.hostname, team_domain: config.cloudflare.team_domain, aud: config.cloudflare.aud },
    owner: { tailscale_login: config.owner.tailscale_login, email: config.owner.email },
    ports: { screen: config.ports.screen, terminal: config.ports.terminal, guide: config.ports.guide },
  };
}
