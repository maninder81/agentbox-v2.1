// The portal client (portal.mjs): every route the portal serves is reachable from the CLI (or listed
// here with why not), and the pieces commands are built from behave.
//   node --test test/portal.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _test } from "../portal.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverSrc = path.join(here, "..", "..", "server", "src");

// Routes the CLI deliberately doesn't call, and why.
const EXEMPT = {
  "/api/bench/bridge.py": "downloaded by the device bridge's installer on your computer",
  "/api/bench/install.sh": "the device bridge's installer (curl | sh on your computer)",
  "/api/bench/connect": "the device bridge's own WebSocket",
  "/api/bench/status": "shown by agentbox health / the Integrations page; the bridge reports it",
  "/api/bench/test": "a button that pings the bridge from the Integrations page",
  "/api/voice/transcribe": "voice input in the portal and the app (mic)",
  "/api/voice/clean": "voice input in the portal and the app (mic)",
  "/api/pdf": "the document reader's Download PDF (rendered HTML from the browser)",
  "/api/screen/credential": "noVNC's password, for the browser's screen view",
  "/api/setup/sudo": "the helper's root-owned sudo helper asks it",
  "/api/setup/terminal/info": "the browser terminal's size and status",
  "/api/setup/plans/:x/steps/:x": "the checklist's step buttons (Check now, Skip…) in the Setup workspace",
  "/api/auth/logout": "ends a browser session (the CLI has none)",
  "/api/file/info": "the reader's header; agentbox open fetches the file itself",
  "/api/agents/:x/threads": "a task's extra threads (handoffs) in the portal; agentbox log shows the room",
  "/api/agents/:x/documents": "an agent's documents; agentbox docs <task> covers its work",
  "/api/agents/:x/repos": "a task's repo chips; agentbox show/changes cover them",
  "/api/agents/:x/replicas": "the old 'add a replica' button (instances start with tasks now)",
  "/api/agents/:x/retire": "retires one instance; agentbox done finishes the work",
  "/api/agents/:x/changes/summary": "a count for the portal's Changes button",
  "/api/agents/:x/reviews": "past reviews in the Changes view; agentbox review sends one",
  "/api/reviews/:x": "one past review, for the Changes view",
  "/api/roadmaps/:x": "one roadmap by id; agentbox roadmap lists them per work",
  "/api/tasks/:x": "one turn's detail on the Tasks board",
  "/api/threads/:x": "covered by agentbox log/chat through /api/work and /api/threads/:x/messages",
  "/api/integrations/:x": "one integration's detail on its page; agentbox integrations lists them",
  "/api/setup-requests/:x": "one request; agentbox setup requests lists them",
  "/api/skill-drafts/:x/approve": "called by agentbox skill draft approve",
  "/api/attention/seen-room/:x": "opening a room in the portal marks it seen",
  "/api/setup-requests": "POST: raising a request from the portal's Add repo (no access); agents raise them",
  "/api/progress": "used by agentbox dash",
  "/api/state": "every command's name lookup",
  "/api/tasks": "the Tasks board (every turn); agentbox tasks and dash show what's live",
};

function serverRoutes() {
  const out = new Set();
  for (const f of fs.readdirSync(serverSrc).filter((f) => f.endsWith(".ts"))) {
    for (const m of fs.readFileSync(path.join(serverSrc, f), "utf8").matchAll(/app\.(?:get|post|put|patch|delete)\("(\/api\/[^"]+)"/g)) {
      out.add(m[1].replace(/:[A-Za-z_]+/g, ":x"));
    }
  }
  return out;
}
/** The API paths in portal.mjs, each ${…} (however nested) as a wildcard segment. */
function clientPaths() {
  const src = fs.readFileSync(path.join(here, "..", "portal.mjs"), "utf8");
  const out = [];
  for (let i = src.indexOf("/api/"); i >= 0; i = src.indexOf("/api/", i + 1)) {
    let p = "";
    for (let j = i; j < src.length; j++) {
      const ch = src[j];
      if (ch === "$" && src[j + 1] === "{") {
        let depth = 0;
        for (; j < src.length; j++) { if (src[j] === "{") depth++; else if (src[j] === "}" && --depth === 0) break; }
        p += ":x";
        continue;
      }
      if (/["`'?\s)]/.test(ch)) break;
      p += ch;
    }
    out.push(new RegExp(`^${p.replace(/\/+$/, "").split(":x").map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[^/]+")}$`));
  }
  return out;
}

test("every portal route has a CLI command, or a reason it doesn't", () => {
  const client = clientPaths();
  const missing = [...serverRoutes()].filter((r) => !client.some((re) => re.test(r)) && !EXEMPT[r]);
  assert.deepEqual(missing, [], `routes with no agentbox command: ${missing.join(", ")}`);
});

test("args: positionals, --k v, --k=v, booleans, repeated flags, aliases, --", () => {
  const a = _test.args(["task", "--crew", "software", "-f", "a.md", "--file=b.md", "--plan-first", "fix", "it", "--", "--not-a-flag"],
    { bool: ["plan-first"], multi: ["file"], alias: { f: "file" } });
  assert.deepEqual(a._, ["task", "fix", "it", "--not-a-flag"]);
  assert.deepEqual(a.flags, { crew: "software", file: ["a.md", "b.md"], "plan-first": true });
  assert.throws(() => _test.args(["--crew"]), /needs a value/);
});

test("pick: id, id prefix, exact name, unique substring; ambiguity and misses explained", () => {
  const items = [{ id: "3a67cfe2-aa", name: "tech-lead#6", label: "YT stream events" }, { id: "96ce1ebf-bb", name: "tech-lead#41", label: "Lookalike scan" }, { id: "20a66846-cc", name: "coder#3", label: "Lookalike fixes" }];
  const keys = (t) => [t.name, t.label];
  assert.equal(_test.pick("task", "tech-lead#41", items, keys).id, "96ce1ebf-bb");
  assert.equal(_test.pick("task", "3a67", items, keys).id, "3a67cfe2-aa");
  assert.equal(_test.pick("task", "yt stream", items, keys).id, "3a67cfe2-aa");
  assert.throws(() => _test.pick("task", "lookalike", items, keys), /matches several tasks/);
  assert.throws(() => _test.pick("task", "nothing", items, keys), /No task "nothing"/);
});

test("follow: a reply streams in once, then the finished message isn't printed twice", async () => {
  let emit;
  const api = {
    get: async (p) => (p.startsWith("/api/work/") ? { threads: [{ id: "th1" }], members: [{ id: "lead1" }] } : {}),
    events: async (fn) => { emit = fn; return () => {}; },
  };
  const w = { byId: new Map([["lead1", { id: "lead1", name: "tech-lead#1" }]]) };
  const writes = [];
  const origW = process.stdout.write.bind(process.stdout);
  const origL = console.log;
  process.stdout.write = (s) => { writes.push(String(s)); return true; };
  console.log = (s = "") => { writes.push(String(s) + "\n"); };
  try {
    await _test.follow(api, w, { id: "th1", name: "tech-lead#1", task: { id: "lead1" } });
    await emit({ type: "turn.delta", taskId: "t1", agentId: "lead1", text: "Hello " });
    await emit({ type: "turn.delta", taskId: "t1", agentId: "lead1", text: "there" });
    await emit({ type: "message.created", message: { thread_id: "th1", task_id: "t1", author: "lead1", content: "Hello there", created_at: new Date().toISOString() } });
    await emit({ type: "message.created", message: { thread_id: "other", task_id: "t9", author: "lead1", content: "elsewhere", created_at: new Date().toISOString() } });
    await emit({ type: "progress.updated", progress: { agent_id: "lead1", activity: "Running npm test", state: "stalled", started_at: new Date().toISOString() } });
  } finally { process.stdout.write = origW; console.log = origL; }
  const text = writes.join("").replace(/\x1b\[[0-9;]*m/g, "");
  assert.match(text, /tech-lead#1 writing…\n  Hello there\n/);
  assert.equal(text.match(/Hello there/g).length, 1, "not printed again when it's saved");
  assert.doesNotMatch(text, /elsewhere/);
  assert.match(text, /possibly stuck tech-lead#1: Running npm test/);
});
