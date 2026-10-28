/**
 * Group workspaces (groupWork.ts): a group's lead launches a workspace per item, keeps the group's roadmap,
 * steers them, answers their questions before the owner, and finishes them. In-process, throwaway database,
 * agents paused (tasks only queue).
 *
 *   node --disable-warning=ExperimentalWarning --import tsx --test test/group-workspaces.test.ts
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentbox-gws-")));
const dirs = Object.fromEntries(["data", "agents", "work", "skills", "team", "secrets", "integrations"].map((d) => {
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
const C = await import("../src/crews.ts");
const G = await import("../src/groups.ts");
const GW = await import("../src/groupWork.ts");
const TM = await import("../src/team.ts");
const RM = await import("../src/roadmaps.ts");
const W = await import("../src/work.ts");
const L = await import("../src/linkedWork.ts");
const RU = await import("../src/runner.ts");
const Fastify = (await import("fastify")).default;
const app = Fastify();
GW.registerGroupWorkRoutes(app);
after(async () => { await app.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

const mk = (name: string, scale = false) => {
  const a = A.createAgent({ name, title: name, summary: `${name} role`, model: "sonnet", instructions: `# ${name}\n`, interview: {} });
  if (scale) run(`UPDATE agents SET can_scale = 1 WHERE id = ?`, a.id);
  return A.getAgent(a.id)!;
};
const techLead = mk("tech-lead", true);
const coder = mk("coder");
const cad = mk("cad");
C.createCrew({ name: "Software", members: [techLead.id, coder.id] });
C.createCrew({ name: "Robotics", members: [cad.id] });
const group = G.createGroup({ name: "code-quality", purpose: "Code quality rework", members: [techLead.id, coder.id], lead: techLead.id });
const lead = G.groupInstance(group, techLead.id);
const member = G.groupInstance(group, coder.id);

const taskIn = (agentId: string, threadId: string, source = "group") => {
  const id = newId();
  run(`INSERT INTO tasks (id, agent_id, thread_id, source, title, prompt, status, created_at) VALUES (?, ?, ?, ?, 't', 'p', 'running', ?)`, id, agentId, threadId, source, now());
  return id;
};
const call = async (agent: any, name: string, args: any, threadId = group.id) => {
  const t = TM.teamTools(agent, taskIn(agent.id, threadId)).find((x: any) => x.name === name)!;
  const r: any = await (t as any).handler(args, {});
  return { text: r.content.map((c: any) => c.text).join("\n"), error: !!r.isError };
};
const program = () => RM.roadmapsOf(lead.id)[0];
const step = (id: string) => RM.itemsOf(program().id).find((i) => i.id === id)!;
let ws: any;

test("only the group's lead launches; members and other work can't", async () => {
  assert.match((await call(member, "launch_workspace", { title: "x", brief: "y" })).text, /Only a group's lead/);
  const solo = A.spawnInstance(techLead.id, { label: "Solo", createdBy: "owner" });
  assert.equal((await call(solo, "launch_workspace", { title: "x", brief: "y" }, A.dmThreadOf(solo.id)!)).error, true);
  assert.match(GW.groupLeadNote(lead), /You lead #code-quality/);
  assert.equal(GW.groupLeadNote(member), "");
});

test("launching: a top-level workspace led from the crew, a step on the group roadmap, a brief, a link to read it", async () => {
  assert.match((await call(lead, "launch_workspace", { title: "CAD", brief: "x", lead: "cad" })).text, /not your crew/);
  const r = await call(lead, "launch_workspace", { title: "Payments: dead code", brief: "Remove dead code in payments. Done = PR merged." });
  assert.equal(r.error, false, r.text);
  ws = A.listAgents().find((a) => a.label === "Payments: dead code")!;
  assert.equal(ws.base_agent_id, techLead.id);
  assert.equal(ws.created_by, `glead:${group.id}`);
  assert.ok(W.workList().live.some((w) => w.root.id === ws.id), "listed under Work");
  assert.equal(program().title, "Workspaces · #code-quality");
  assert.deepEqual([step("payments-dead-code").status, step("payments-dead-code").owner, step("payments-dead-code").link], ["doing", ws.name, `#/work/${ws.id}`]);
  const first = get<any>(`SELECT * FROM tasks WHERE agent_id = ? ORDER BY created_at LIMIT 1`, ws.id);
  assert.equal(first.source, "agent");
  assert.equal(first.from_agent_id, lead.id, "its report goes back to the group lead");
  assert.match(first.prompt, /Remove dead code in payments/);
  assert.equal(L.linksOf(lead.id).links[0].work.id, ws.id, "the group lead reads it");
  assert.match(GW.workspaceNote(ws), /launched by tech-lead/);
  // A second, waiting for the first.
  await call(lead, "launch_workspace", { title: "Auth: tests", brief: "Add tests", lead: "coder", after: ["payments-dead-code"] });
  assert.deepEqual(step("auth-tests").after, ["payments-dead-code"]);
  assert.match((await call(lead, "list_workspaces", {})).text, /"Payments: dead code" — tech-lead#\d+: idle.*\n- "Auth: tests" — coder#\d+/s);
  const page = (await app.inject({ method: "GET", url: `/api/groups/${group.id}/workspaces` })).json();
  assert.equal(page.lead_instance_id, lead.id);
  assert.equal(page.workspaces.length, 2);
});

test("a question from inside a workspace goes to the group lead first, blocks its step, and its answer unblocks it", async () => {
  const helper = A.spawnInstance(coder.id, { label: "Piece", createdBy: ws.id, parentInstanceId: ws.id });
  const r = await call(helper, "ask_owner", { question: "Delete the v1 refund path too?" }, A.dmThreadOf(helper.id)!);
  assert.match(r.text, /went to tech-lead#\d+, the lead of the group/);
  assert.equal(all(`SELECT 1 FROM attention`).length, 0, "the owner isn't asked");
  const q = get<any>(`SELECT * FROM tasks WHERE agent_id = ? AND title LIKE 'Question from%'`, lead.id);
  assert.equal(q.thread_id, A.dmThreadOf(lead.id), "outside the group chat");
  assert.equal(q.from_agent_id, helper.id, "the lead's reply goes back to the asker");
  assert.equal(step("payments-dead-code").status, "blocked");
  assert.match(step("payments-dead-code").note, /Delete the v1 refund path/);
  assert.match((await call(lead, "list_workspaces", {})).text, /ASKS YOU: Delete the v1 refund path/);
  publish({ type: "task.updated", task: { id: q.id, agent_id: lead.id, status: "done" } });
  assert.equal(step("payments-dead-code").status, "doing");
  // Work the owner started still asks the owner.
  const own = A.spawnInstance(coder.id, { label: "Own", createdBy: "owner" });
  await call(own, "ask_owner", { question: "Which DB?" }, A.dmThreadOf(own.id)!);
  assert.equal(all(`SELECT 1 FROM attention`).length, 1);
});

test("steering, posting to the group and finishing", async () => {
  assert.match((await call(lead, "message_workspace", { workspace: "payments", text: "Also drop the legacy cron." })).text, /Sent to tech-lead#/);
  const m = get<any>(`SELECT * FROM tasks WHERE agent_id = ? ORDER BY rowid DESC LIMIT 1`, ws.id);
  assert.equal(m.from_agent_id, lead.id);
  assert.match(m.prompt, /Also drop the legacy cron/);
  assert.equal((await call(lead, "message_workspace", { workspace: "nope", text: "x" })).error, true);
  await call(lead, "post_to_group", { text: "Payments cleanup PR is up." }, A.dmThreadOf(lead.id)!);
  assert.ok(get(`SELECT 1 FROM messages WHERE thread_id = ? AND author = ? AND content = 'Payments cleanup PR is up.'`, group.id, lead.id));
  // Busy work isn't finished; once it's quiet, it is, and its step is done.
  assert.match((await call(lead, "finish_workspace", { workspace: "payments" })).text, /Still working/);
  run(`UPDATE tasks SET status = 'done' WHERE agent_id IN (SELECT id FROM agents WHERE id = ? OR parent_instance_id = ?)`, ws.id, ws.id);
  const done = await call(lead, "finish_workspace", { workspace: "payments" });
  assert.equal(done.error, false, done.text);
  assert.ok(A.getAgent(ws.id)!.retired_at);
  assert.equal(step("payments-dead-code").status, "done");
});

test("the owner finishing a workspace moves its step too; at most 8 live", async () => {
  const auth = A.listAgents().find((a) => a.label === "Auth: tests")!;
  run(`UPDATE tasks SET status = 'done' WHERE agent_id = ?`, auth.id);
  W.finishTree(auth.id);
  assert.equal(step("auth-tests").status, "done");
  for (let i = 0; i < 8; i++) assert.equal((await call(lead, "launch_workspace", { title: `Item ${i}`, brief: "b" })).error, false);
  assert.match((await call(lead, "launch_workspace", { title: "Ninth", brief: "b" })).text, /8 live workspaces, the limit/);
  assert.ok(RU); // runner loaded (instructions include the notes)
});
