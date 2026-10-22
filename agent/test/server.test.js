"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createApp } = require("../server");
const { runTool } = require("../lib/tools");
const { inputHashes, loadInputs } = require("../lib/specs");
const { builtApi, emptyImplemented } = require("../lib/implemented");
const { IM } = require("./helpers");

function setup(fakeAgent, prepare) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "srv-"));
  const graphCopy = path.join(dir, "graph.json");
  fs.copyFileSync(path.join(__dirname, "..", "..", "capability-graph", "new-inventory-entry.json"), graphCopy);
  // write temp implemented.json with IM so setup() never touches agent/implemented.json
  const implPath = path.join(dir, "implemented.json");
  fs.writeFileSync(implPath, JSON.stringify(IM));
  const paths = { graph: graphCopy, decisions: path.join(dir, "decisions.json"), implemented: implPath, specsDir: path.join(dir, "specs") };
  if (prepare) prepare(paths);
  const made = createApp({ paths, runAgentImpl: fakeAgent || (async () => ({ reply: "ok", toolTrace: [] })) });
  return new Promise(resolve => {
    const srv = made.app.listen(0, "127.0.0.1", () => resolve({ ...made, srv, paths, dir, base: `http://127.0.0.1:${srv.address().port}` }));
  });
}
const chat = (t, message) => fetch(t.base + "/api/agent/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message, history: [] }) });

test("GET /api/specs serves all three layers; writing decisions over HTTP is gone", async () => {
  const t = await setup();
  try {
    const s = await (await fetch(t.base + "/api/specs")).json();
    assert.match(s.layers.api.md, /^# API layer spec/);
    assert.equal(s.stage.step, "decide");
    assert.ok(fs.existsSync(path.join(t.paths.specsDir, "orchestrator.json")));
    assert.ok(fs.existsSync(t.paths.decisions), "default record materialized");
    const put = await fetch(t.base + "/api/decisions", { method: "PUT", headers: { "Content-Type": "application/json" }, body: "{\"dec\":{}}" });
    assert.equal(put.status, 404);
  } finally { t.srv.close(); }
});

test("a chat turn saves the record, regenerates the specs and returns exactly what changed", async () => {
  const fake = async (_m, _h, ctx) => {
    runTool("resolveOpenQuestion", { id: "OQ.FAConfirmation", mode: "Defer", policy: "no FAP target yet" }, ctx);
    return { reply: "done", toolTrace: [] };
  };
  const t = await setup(fake);
  try {
    const r = await (await fetch(t.base + "/api/agent/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: "defer FA", history: [] }) })).json();
    assert.deepEqual(r.recorded.map(c => [c.id, c.field, c.after]), [["OQ.FAConfirmation", "oqPolicy", "no FAP target yet"], ["SIDE.FinancialAsset", "scope", "Defer"]]);
    assert.equal(JSON.parse(fs.readFileSync(t.paths.decisions, "utf8")).oqPolicy["OQ.FAConfirmation"], "no FAP target yet");
    const o = JSON.parse(fs.readFileSync(path.join(t.paths.specsDir, "orchestrator.json"), "utf8"));
    assert.ok(!o.missing.some(m => m.id === "OQ.FAConfirmation"));
  } finally { t.srv.close(); }
});

test("the chat route runs the grounding guardrail and returns the evidence for the card", async () => {
  const BAD = "For the incoming inspection work order, the legacy calls ENEQ3 automatically for capitalized NX items.";
  const GOOD = "For the incoming inspection work order, ENEQ1 ADDEQ asks the clerk; IIWO^ENWONEW3 creates the 6920 work order.";
  let calls = 0;
  const fake = async () => ({ reply: ++calls === 1 ? BAD : GOOD, toolTrace: [] });
  const t = await setup(fake);
  try {
    const r = await (await fetch(t.base + "/api/agent/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: "tell me about the work order", history: [] }) })).json();
    assert.equal(calls, 2);
    assert.ok(r.reply.startsWith(GOOD));
    assert.match(r.reply, /↻ Grounding check/);
    assert.equal(r.grounding.retried, true);
    assert.deepEqual(r.evidence.map(e => e.id), ["OQ.WorkOrderPolicy"]);
  } finally { t.srv.close(); }
});

test("the chat's instructions carry the method and the record, never a past outcome", async () => {
  const t = await setup();
  try {
    const p = t.systemPrompt();
    assert.match(p, /Current stage: /);
    assert.match(p, /MANDATORY in the production[^\n]*SIDE\.Bulletin/);
    for (const banned of ["50,000", "50000", "≥", "RELOCATE", "right move"]) assert.ok(!p.includes(banned), banned);
    // no worked example drawn from a real item — the model transfers them to other items
    for (const realExample of ["TYPE OF ENTRY = NX", "ENFACS security key", "$P(^ENG(6914"]) assert.ok(!p.includes(realExample), realExample);
    assert.match(p, /EVIDENCE IS PER ITEM/);
  } finally { t.srv.close(); }
});

test("the chat's instructions build stub-first: only the real operations' details are asked, stub wiring is later", async () => {
  const t = await setup();
  try {
    const p = t.systemPrompt();
    assert.match(p, /STUB-FIRST/);
    assert.match(p, /then ask where to send it/);
    assert.match(p, /^Stubs in this build \(registered, not wired\): /m);
    assert.doesNotMatch(p, /bind each resolved rule's data words to fields → record target details for each built side effect/);
  } finally { t.srv.close(); }
});

test("the grounding check ignores what a rejected draft recorded, and the retry starts from the record as it was", async () => {
  let calls = 0, seenOnRetry = "unset";
  const fake = async (_m, _h, ctx) => {
    if (++calls === 1) {
      runTool("resolveOpenQuestion", { id: "OQ.PMEnrollmentPolicy", mode: "Business rule", policy: "enroll when cost >= $25,000" }, ctx);
      return { reply: "PM enrollment: enroll when cost >= $25,000.", toolTrace: [] };
    }
    seenOnRetry = ctx.decisions.oqPolicy["OQ.PMEnrollmentPolicy"];
    return { reply: "PM enrollment: the legacy asks the clerk.", toolTrace: [] };
  };
  const t = await setup(fake);
  try {
    const r = await (await chat(t, "what about PM?")).json();
    assert.equal(calls, 2, "the model's own write must not make its threshold look grounded");
    assert.equal(seenOnRetry, undefined, "the rejected draft's write is undone before the retry");
    assert.ok(!r.recorded.some(c => c.id === "OQ.PMEnrollmentPolicy"), JSON.stringify(r.recorded));
    assert.equal(JSON.parse(fs.readFileSync(t.paths.decisions, "utf8")).oqPolicy["OQ.PMEnrollmentPolicy"], undefined);
  } finally { t.srv.close(); }
});

test("overlapping chat turns run one at a time, so each reports only its own changes", async () => {
  const fake = async (m, _h, ctx) => {
    if (m === "first") { await new Promise(r => setTimeout(r, 150)); runTool("resolveOpenQuestion", { id: "OQ.FAConfirmation", mode: "Defer", policy: "first" }, ctx); }
    else runTool("resolveOpenQuestion", { id: "OQ.WorkOrderPolicy", mode: "Defer", policy: "second" }, ctx);
    return { reply: "ok", toolTrace: [] };
  };
  const t = await setup(fake);
  try {
    const p1 = chat(t, "first").then(r => r.json());
    await new Promise(r => setTimeout(r, 30));
    const p2 = chat(t, "second").then(r => r.json());
    const [r1, r2] = await Promise.all([p1, p2]);
    const ids = r => [...new Set(r.recorded.map(c => c.id))].sort();
    assert.deepEqual(ids(r1), ["OQ.FAConfirmation", "SIDE.FinancialAsset"]);
    assert.deepEqual(ids(r2), ["OQ.WorkOrderPolicy", "SIDE.WorkOrder"]);
  } finally { t.srv.close(); }
});

test("a record that cannot be saved answers an error, records nothing, and the server keeps running", async () => {
  const fake = async (_m, _h, ctx) => { runTool("resolveOpenQuestion", { id: "OQ.FAConfirmation", mode: "Defer", policy: "x" }, ctx); return { reply: "ok", toolTrace: [] }; };
  const t = await setup(fake);
  try {
    fs.rmSync(t.paths.decisions); fs.mkdirSync(t.paths.decisions);   // the save's rename now fails
    const resp = await chat(t, "defer FA");
    assert.equal(resp.status, 500);
    const j = await resp.json();
    assert.match(j.error, /could not be saved/);
    assert.deepEqual(j.recorded, []);
    assert.equal(t.state.record.oqPolicy["OQ.FAConfirmation"], undefined);
    assert.equal((await fetch(t.base + "/api/specs")).status, 200);
  } finally { t.srv.close(); }
});

test("a corrupt decisions file at start is backed up, replaced on disk, announced, and does not block builds", async () => {
  const t = await setup(null, paths => fs.writeFileSync(paths.decisions, "{ not json"));
  try {
    const backups = () => fs.readdirSync(t.dir).filter(f => /corrupt/.test(f));
    assert.equal(backups().length, 1);
    assert.equal(fs.readFileSync(path.join(t.dir, backups()[0]), "utf8"), "{ not json");
    assert.ok(JSON.parse(fs.readFileSync(t.paths.decisions, "utf8")).dec, "the defaults were saved over the unreadable file");
    const s = await (await fetch(t.base + "/api/specs")).json();
    assert.match(s.notice || "", /backed up/);
    assert.ok(s.notice.includes(backups()[0]));
    const { buildConfig } = require("../build-runner");
    assert.doesNotThrow(() => buildConfig(path.join(t.paths.specsDir, "api.json"), t.paths));
    fs.writeFileSync(t.paths.decisions, "{ again");
    loadInputs(t.paths);
    assert.equal(backups().length, 1, "reading inputs for a build never writes backups");
  } finally { t.srv.close(); }
});

test("regenerate re-reads the graph, so an edited graph never leaves builds stuck as stale", async () => {
  const t = await setup();
  try {
    const g = JSON.parse(fs.readFileSync(t.paths.graph, "utf8"));
    g.workflow.name = "Edited while running";
    fs.writeFileSync(t.paths.graph, JSON.stringify(g));
    t.regenerate();
    const spec = JSON.parse(fs.readFileSync(path.join(t.paths.specsDir, "api.json"), "utf8"));
    assert.deepEqual(spec.inputs, inputHashes("api", loadInputs(t.paths)));
  } finally { t.srv.close(); }
});

test("the production build refuses an orchestrator spec that is not complete, and starts nothing", async () => {
  const t = await setup();
  try {
    const r = await fetch(t.base + "/api/build/production", { method: "POST" });
    assert.equal(r.status, 409);
    const body = await r.json();
    assert.equal(body.started, false);
    assert.match(body.error, /not complete/);
    assert.ok(body.missing.length > 0);
  } finally { t.srv.close(); }
});

test("POST /api/build/ai on a default record (orchestrator still being decided) returns 409 and starts nothing", async () => {
  const t = await setup();
  try {
    const r = await fetch(t.base + "/api/build/ai", { method: "POST" });
    assert.equal(r.status, 409);
    const body = await r.json();
    assert.equal(body.started, false);
    assert.match(body.error, /orchestrator/);
    assert.equal(body.stage.layer, "orchestrator");
  } finally { t.srv.close(); }
});

test("POST /ai/chat with no IRIS_AI_HUB_URL returns 502 naming the setting", async () => {
  const t = await setup();
  try {
    const r = await fetch(t.base + "/ai/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: "hi" }) });
    assert.equal(r.status, 502);
    const body = await r.json();
    assert.match(body.error, /IRIS_AI_HUB_URL/);
  } finally { t.srv.close(); }
});

test("when the orchestrator is verified, the system prompt guides the AI layer and drops the no-AI ban", async () => {
  // Minimal decisions: all OQs deferred with policy text, mandatory SIDE.Bulletin has recipients.
  const minDec = {
    dec: {
      "OQ.WorkOrderPolicy": "Defer", "OQ.PMEnrollmentPolicy": "Defer", "OQ.FAConfirmation": "Defer",
      "SIDE.WorkOrder": "Business Operation", "SIDE.PMSchedule": "Business Operation",
      "SIDE.FinancialAsset": "Business Operation", "SIDE.Bulletin": "Event",
    },
    oqPolicy: {
      "OQ.WorkOrderPolicy": "Deferred — will decide later",
      "OQ.PMEnrollmentPolicy": "Deferred — will decide later",
      "OQ.FAConfirmation": "Deferred — will decide later",
    },
    scope: {}, targets: { "SIDE.Bulletin": { recipients: "equipment@va.gov" } }, ruleBindings: {},
  };
  // Write a temp implemented.json with orchestrator verified — redirect paths.implemented
  // so the real agent/implemented.json is never touched.
  const t = await setup(null, paths => {
    fs.writeFileSync(paths.decisions, JSON.stringify(minDec));
    const tempImpl = path.join(path.dirname(paths.decisions), "implemented.json");
    fs.writeFileSync(tempImpl, JSON.stringify({
      api: builtApi(),
      orchestrator: { built: true, verified: true },
    }));
    paths.implemented = tempImpl;
  });
  try {
    const p = t.systemPrompt();
    assert.match(p, /AI layer/i);
    assert.match(p, /setQuickQuestion/);
    assert.match(p, /Build AI button stays disabled until the AI spec is complete/);
    assert.doesNotMatch(p, /Never start or offer the AI layer/);
  } finally { t.srv.close(); }
});

// ── Final review M7 / M8 / trivial ─────────────────────────────────────────────
const http = require("http");
const { EventEmitter } = require("events");
const INVENTORY = path.join(__dirname, "..", "..", "capability-graph", "inventory-fields.json");
const MIN_DEC = {
  dec: { "OQ.WorkOrderPolicy": "Defer", "OQ.PMEnrollmentPolicy": "Defer", "OQ.FAConfirmation": "Defer",
         "SIDE.WorkOrder": "Business Operation", "SIDE.PMSchedule": "Business Operation", "SIDE.FinancialAsset": "Business Operation", "SIDE.Bulletin": "Event" },
  oqPolicy: { "OQ.WorkOrderPolicy": "Deferred — will decide later", "OQ.PMEnrollmentPolicy": "Deferred — will decide later", "OQ.FAConfirmation": "Deferred — will decide later" },
  scope: {}, targets: { "SIDE.Bulletin": { recipients: "equipment@va.gov" } }, ruleBindings: {},
};
const ALL_KEPT = {
  "AIQ.AgingOutFY":             { keep: true, wording: "Ages out?",   params: { fiscalYear: 2031, capitalizedMeans: "INVESTMENT_CATEGORY = 1", useStatuses: ["ALL"] } },
  "AIQ.HighValueNoContract":    { keep: true, wording: "High value?", params: { threshold: 50000, valueColumn: "TOTAL_ASSET_VALUE", useStatuses: ["ALL"] } },
  "AIQ.JCAHOPendingInspection": { keep: true, wording: "JCAHO?",      params: { workOrderStatusColumn: "STATUS", workOrderStatuses: ["ALL"], useStatuses: ["ALL"] } },
  "AIQ.CapitalPlanningTotals":  { keep: true, wording: "Totals?",     params: { useStatuses: ["ALL"], valueColumns: ["TOTAL_ASSET_VALUE"], groupBy: "none" } },
};

// A server whose builds are fake processes: nothing is spawned, and every file it writes or removes is a temp file.
async function buildSetup({ apiBuilt = true, orchestratorVerified = true, aiQuestions = undefined, agentCalls = [], killTreeImpl = () => {}, inventory = INVENTORY, vademoFetch, localTeardownImpl } = {}) {
  const procs = [];
  const spawnImpl = (_cmd, args, opts) => { const p = new EventEmitter(); p.args = args; p.opts = opts; p.pid = 1000 + procs.length; p.unref = () => {}; procs.push(p); return p; };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "srv-b-"));
  const paths = { graph: path.join(dir, "graph.json"), decisions: path.join(dir, "decisions.json"), implemented: path.join(dir, "implemented.json"), inventory, specsDir: path.join(dir, "specs") };
  fs.copyFileSync(path.join(__dirname, "..", "..", "capability-graph", "new-inventory-entry.json"), paths.graph);
  fs.writeFileSync(paths.decisions, JSON.stringify(aiQuestions ? { ...MIN_DEC, aiQuestions } : MIN_DEC));
  fs.writeFileSync(paths.implemented, JSON.stringify({ api: apiBuilt ? builtApi() : emptyImplemented().api, orchestrator: { built: orchestratorVerified, verified: orchestratorVerified } }));
  const statusFiles = { build: path.join(dir, "build-status.json"), production: path.join(dir, "production-status.json"), ai: path.join(dir, "ai-status.json"), restore: path.join(dir, "restore-status.json"), teardown: path.join(dir, "teardown-status.json") };
  // the reset's local teardown works only inside dir
  const roots = { agentDir: path.join(dir, "agent"), repoRoot: path.join(dir, "repo"), knownGoodRoot: path.join(dir, "agent", "_known-good"), tmpDir: path.join(dir, "tmp") };
  const made = createApp({ paths, runAgentImpl: async m => { agentCalls.push(m); return { reply: "ok", toolTrace: [] }; }, spawnImpl, statusFiles, killTreeImpl, ...roots, ...(vademoFetch ? { vademoFetch } : {}), ...(localTeardownImpl ? { localTeardownImpl } : {}) });
  const t = await new Promise(resolve => {
    const srv = made.app.listen(0, "127.0.0.1", () => resolve({ ...made, srv, paths, dir, base: `http://127.0.0.1:${srv.address().port}` }));
  });
  const done = async () => {
    for (const p of procs) p.emit("exit", 0);
    await new Promise(res => setTimeout(res, 30));     // let the exit handlers' regenerate run first
    t.srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  };
  return { ...t, procs, statusFiles, done };
}
const post = (t, p) => fetch(t.base + p, { method: "POST" });

test("the production build is refused (409) until Phase 1 is built", async () => {
  // MIN_DEC is complete enough for the orchestrator spec; the gate fires on api.built, not completeness
  const t = await buildSetup({ apiBuilt: false, orchestratorVerified: false });
  try {
    const r = await post(t, "/api/build/production");
    assert.equal(r.status, 409);
    assert.match((await r.json()).error, /Phase 2 opens after the Phase 1 build/);
    assert.equal(t.procs.length, 0, "nothing was started");
  } finally { await t.done(); }
});

test("production and AI builds are refused while Phase 1 is out of date", async () => {
  const t = await buildSetup({ aiQuestions: ALL_KEPT });
  try {
    // mark api.builtFrom with a stale hash — the route's regenerate() will set apiOutOfDate:true
    const im = JSON.parse(fs.readFileSync(t.paths.implemented, "utf8"));
    im.api = { ...im.api, builtFrom: "stale" };
    fs.writeFileSync(t.paths.implemented, JSON.stringify(im));
    const r1 = await post(t, "/api/build/production");
    assert.equal(r1.status, 409);
    assert.match((await r1.json()).error, /the API layer changed/);
    const r2 = await post(t, "/api/build/ai");
    assert.equal(r2.status, 409);
    assert.match((await r2.json()).error, /the API layer changed/);
    assert.equal(t.procs.length, 0, "nothing was started");
  } finally { await t.done(); }
});

test("the API build route uses the injected spawn and status file, and regenerates on exit", async () => {
  // start with Phase 1 not built so exit(0) moves stage from api to orchestrator
  const t = await buildSetup({ apiBuilt: false, orchestratorVerified: false });
  try {
    const r = await (await post(t, "/api/build")).json();
    assert.equal(r.started, true, JSON.stringify(r));
    assert.ok(t.procs[0].args.some(a => /build-runner\.js$/.test(a)), "spawned build-runner.js");
    assert.ok(fs.existsSync(t.statusFiles.build), "build status file written");
    assert.equal(JSON.parse(fs.readFileSync(t.statusFiles.build, "utf8")).state, "starting");
    // write builtApi() then signal exit(0) — the exit handler regenerates so specs update
    const im = JSON.parse(fs.readFileSync(t.paths.implemented, "utf8"));
    im.api = builtApi();
    fs.writeFileSync(t.paths.implemented, JSON.stringify(im));
    t.procs[0].emit("exit", 0);
    await new Promise(res => setTimeout(res, 50));
    const s = await (await fetch(t.base + "/api/specs")).json();
    assert.equal(s.stage.layer, "orchestrator");
  } finally { await t.done(); }
});

test("the API build spawn options include windowsHide: true", async () => {
  const t = await buildSetup({ apiBuilt: false, orchestratorVerified: false });
  try {
    await post(t, "/api/build");
    assert.strictEqual(t.procs[0].opts && t.procs[0].opts.windowsHide, true, "spawn opts.windowsHide must be true");
  } finally { await t.done(); }
});

test("angular-build.js spawns with windowsHide: true (static check)", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "lib", "angular-build.js"), "utf8");
  assert.match(src, /windowsHide\s*:\s*true/, "angular-build.js must set windowsHide: true in spawn options");
});

test("POST /api/build/ai is refused (409) until the orchestrator is built and verified — the spec's offer rule", async () => {
  const t = await buildSetup({ orchestratorVerified: false, aiQuestions: ALL_KEPT });
  try {
    const r = await post(t, "/api/build/ai");
    assert.equal(r.status, 409);
    const body = await r.json();
    assert.equal(body.started, false);
    assert.match(body.error, /orchestrator/i);
    assert.equal(t.procs.length, 0, "nothing was started");
  } finally { await t.done(); }
});

test("POST /api/build/ai on an incomplete AI spec (orchestrator verified) returns 409 with the missing items", async () => {
  const t = await buildSetup();
  try {
    const r = await post(t, "/api/build/ai");
    assert.equal(r.status, 409);
    const body = await r.json();
    assert.ok(Array.isArray(body.missing) && body.missing.length > 0);
    assert.equal(t.procs.length, 0);
  } finally { await t.done(); }
});

test("the AI build and the production build never run at the same time", async () => {
  const t = await buildSetup({ aiQuestions: ALL_KEPT });
  try {
    const p = await (await post(t, "/api/build/production")).json();
    assert.equal(p.started, true, JSON.stringify(p));
    const r = await post(t, "/api/build/ai");
    assert.equal(r.status, 409);
    assert.match((await r.json()).error, /production build is running/);
    t.procs[0].emit("exit", 0);                       // the production build ends
    await new Promise(res => setTimeout(res, 20));
    const a = await (await post(t, "/api/build/ai")).json();
    assert.equal(a.started, true, JSON.stringify(a));
    assert.match(t.procs[1].args.join(" "), /ai-runner\.js/);
    const r2 = await post(t, "/api/build/production");
    assert.equal(r2.status, 409);
    assert.match((await r2.json()).error, /AI build is running/);
    assert.ok(fs.existsSync(t.statusFiles.ai) && fs.existsSync(t.statusFiles.production), "the status files are the temp ones");
  } finally { await t.done(); }
});

async function withHub(handler, fn) {
  const hub = http.createServer(handler);
  await new Promise(r => hub.listen(0, "127.0.0.1", r));
  const keys = ["IRIS_AI_HUB_URL", "IRIS_AI_HUB_USER", "IRIS_AI_HUB_PASSWORD"];
  const saved = Object.fromEntries(keys.map(k => [k, process.env[k]]));
  Object.assign(process.env, { IRIS_AI_HUB_URL: `http://127.0.0.1:${hub.address().port}`, IRIS_AI_HUB_USER: "u", IRIS_AI_HUB_PASSWORD: "fake-pass" });
  try { const t = await setup(); try { await fn(t); } finally { t.srv.close(); } }
  finally { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } hub.close(); }
}

test("/ai/* proxy: an IRIS answer that is not JSON is a 502 that says so, never 'Unexpected token <'", async () => {
  await withHub((_req, res) => { res.writeHead(401, { "Content-Type": "text/html" }); res.end("<html><body>Unauthorized</body></html>"); }, async t => {
    for (const p of ["/ai/chat", "/ai/quick/AgingOutFY"]) {
      const r = await fetch(t.base + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      assert.equal(r.status, 502, p);
      const body = await r.json();
      assert.match(body.error, /IRIS answered HTTP 401 \(not JSON\) — has the AI layer been built\?/, p);
      assert.doesNotMatch(body.error, /Unexpected token/);
    }
  });
});

test("/ai/* proxy passes a JSON answer through with its status", async () => {
  await withHub((_req, res) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ reply: "295", rows: [] })); }, async t => {
    const r = await fetch(t.base + "/ai/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: "hi" }) });
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { reply: "295", rows: [] });
  });
});

test("the server reads the inventory from paths.inventory and /api/state carries the AI questions with their codes", async () => {
  const t = await buildSetup();
  try {
    const s = await (await fetch(t.base + "/api/state")).json();
    const q = s.state.ai.questions.find(x => x.id === "AIQ.AgingOutFY");
    const use = q.params.find(p => p.key === "useStatuses");
    assert.ok(use.codes.length > 0, "codes come from the inventory");
    assert.equal(s.state.stage.layer, "ai");
  } finally { await t.done(); }
  // a missing inventory file at paths.inventory means no inventory — never a fixed path
  const t2 = await setup(null, paths => { paths.inventory = path.join(path.dirname(paths.decisions), "no-such-inventory.json"); });
  try {
    const sp = await (await fetch(t2.base + "/api/specs")).json();
    assert.ok(sp.layers.ai.missing.some(m => /inventory-fields\.json not loaded/.test(m.what)), "the AI spec reports the missing discovery file");
  } finally { t2.srv.close(); }
});

test("a recorded AI decision's card names the question by its wording, not its id", async () => {
  const { TEMPLATES } = require("../lib/ai-templates");
  const fake = async (_m, _h, ctx) => { runTool("setQuickQuestion", { id: "AIQ.AgingOutFY", keep: true }, ctx); return { reply: "ok", toolTrace: [] }; };
  const t = await setup(fake);
  try {
    const r = await (await chat(t, "keep it")).json();
    const card = r.recorded.find(c => c.id === "AIQ.AgingOutFY");
    assert.ok(card, JSON.stringify(r.recorded));
    assert.equal(card.label, TEMPLATES.find(x => x.id === "AIQ.AgingOutFY").defaultWording);
  } finally { t.srv.close(); }
});

const say = (t, message) => fetch(t.base + "/api/agent/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message, history: [] }) });

test("'restore last good' in the chat starts the restore without asking the model — the fallback must work when Bedrock doesn't", async () => {
  const agentCalls = [];
  const t = await buildSetup({ agentCalls });
  try {
    const r = await (await say(t, "  Restore Last Good. ")).json();
    assert.equal(agentCalls.length, 0, "the model is not called");
    assert.equal(r.restore && r.restore.started, true, JSON.stringify(r));
    assert.equal(r.restore.statusUrl, "/api/restore/status");
    assert.equal(t.procs.length, 1);
    assert.ok(t.procs[0].args.some(a => /restore-runner\.js$/.test(a)), t.procs[0].args.join(" "));
    assert.match(r.reply, /restor/i);
    assert.deepEqual(r.recorded, []);
    // while it runs: a second restore and both builds are refused
    const again = await (await say(t, "restore last good")).json();
    assert.equal(again.restore.started, false);
    assert.match(again.reply, /already running/i);
    assert.equal((await post(t, "/api/build/ai")).status, 409);
    assert.equal((await post(t, "/api/build/production")).status, 409);
    assert.equal(t.procs.length, 1, "nothing else was started");
  } finally { await t.done(); }
});

test("restore is refused while a build runs, and its status route answers idle before any restore", async () => {
  const t = await buildSetup({ aiQuestions: ALL_KEPT });
  try {
    assert.deepEqual(await (await fetch(t.base + "/api/restore/status")).json(), { state: "idle", step: "", log: [], results: [] });
    assert.equal((await (await post(t, "/api/build/ai")).json()).started, true);
    const r = await (await say(t, "restore last good")).json();
    assert.equal(r.restore.started, false);
    assert.match(r.reply, /build is running/i);
    assert.equal(t.procs.length, 1);
  } finally { await t.done(); }
});

test("only the exact command restores: a sentence that merely mentions it goes to the chat as usual", async () => {
  const agentCalls = [];
  const t = await buildSetup({ agentCalls });
  try {
    await say(t, "what does restore last good do?");
    assert.equal(agentCalls.length >= 1, true);
    assert.equal(t.procs.length, 0);
  } finally { await t.done(); }
});

const LIVE = ["starting", "building", "restoring", "tearing down"];
const liveStatus = f => { try { return LIVE.includes(JSON.parse(fs.readFileSync(f, "utf8")).state); } catch (_) { return false; } };
const BUILD_STATUS = t => [t.statusFiles.build, t.statusFiles.production, t.statusFiles.ai, t.statusFiles.restore];

test("reset: nothing built anywhere, the page opens in Phase 1", async () => {
  const t = await buildSetup({ aiQuestions: ALL_KEPT });
  try {
    const before = fs.readFileSync(t.paths.decisions, "utf8");
    for (const f of BUILD_STATUS(t)) fs.writeFileSync(f, JSON.stringify({ state: "done" }));
    const r = await (await post(t, "/api/demo/reset")).json();
    assert.equal(r.ok, true, JSON.stringify(r));
    // the record is the defaults: nothing decided
    const rec = JSON.parse(fs.readFileSync(t.paths.decisions, "utf8"));
    assert.deepEqual(rec.aiQuestions, {});
    assert.deepEqual(rec.targets, {});
    assert.deepEqual(rec.oqPolicy, {});
    // the old record is kept beside it
    assert.ok(r.backup && fs.existsSync(path.join(path.dirname(t.paths.decisions), r.backup)), r.backup);
    assert.equal(fs.readFileSync(path.join(path.dirname(t.paths.decisions), r.backup), "utf8"), before);
    // nothing is built for any layer, so the page opens in Phase 1
    assert.deepEqual(JSON.parse(fs.readFileSync(t.paths.implemented, "utf8")), emptyImplemented());
    const s = await (await fetch(t.base + "/api/specs")).json();
    assert.deepEqual(s.stage, { layer: "api", step: "build", next: null });
    // the last runs' build logs are gone; the local teardown is reported item by item
    for (const f of BUILD_STATUS(t)) assert.ok(!fs.existsSync(f), f);
    assert.deepEqual(await (await fetch(t.base + "/api/build/ai/status")).json(), { state: "idle", step: "", log: [] });
    assert.ok(Array.isArray(r.local) && r.local.some(x => x.item === "ai-status.json" && x.outcome === "removed"), JSON.stringify(r.local));
    // the remote teardown is a job the page follows
    assert.deepEqual(r.teardown, { started: true, statusUrl: "/api/demo/reset/status" });
    assert.equal(r.localFailed, undefined, "nothing failed locally");
    assert.match(t.procs.at(-1).args.at(-1), /teardown-runner\.js$/);
    assert.equal((await (await fetch(t.base + "/api/demo/reset/status")).json()).state, "starting");
  } finally { await t.done(); }
});

test("the reset status answers idle before any reset", async () => {
  const t = await buildSetup();
  try {
    assert.deepEqual(await (await fetch(t.base + "/api/demo/reset/status")).json(), { state: "idle", step: "", log: [], results: [] });
  } finally { await t.done(); }
});

test("reset stops a running build, then tears down", async () => {
  const kills = [];
  const t = await buildSetup({ aiQuestions: ALL_KEPT, killTreeImpl: pid => kills.push({ pid, spawned: t.procs.length }) });
  try {
    assert.equal((await (await post(t, "/api/build/ai")).json()).started, true);
    fs.writeFileSync(t.statusFiles.ai, JSON.stringify({ state: "building", step: "Deploying", log: [] }));
    const r = await post(t, "/api/demo/reset");
    assert.equal(r.status, 200);
    assert.equal((await r.json()).ok, true);
    assert.deepEqual(kills, [{ pid: t.procs[0].pid, spawned: 1 }], "the AI build's tree was killed before the teardown runner was spawned");
    assert.match(t.procs[1].args.at(-1), /teardown-runner\.js$/);
    t.procs[0].emit("exit", 1);                        // the killed runner's exit arrives later
    await new Promise(res => setTimeout(res, 30));
    for (const f of BUILD_STATUS(t)) assert.ok(!liveStatus(f), f);
  } finally { await t.done(); }
});

test("builds wait while the reset tears down", async () => {
  const t = await buildSetup({ aiQuestions: ALL_KEPT });
  try {
    assert.equal((await (await post(t, "/api/demo/reset")).json()).ok, true);
    for (const p of ["/api/build", "/api/build/production", "/api/build/ai"]) {
      const r = await post(t, p);
      assert.equal(r.status, 409, p);
      assert.match((await r.json()).error, /still tearing down/, p);
    }
    const rs = await (await say(t, "restore last good")).json();
    assert.equal(rs.restore.started, false);
    assert.match(rs.reply, /still tearing down/);
    assert.equal(t.procs.length, 1, "only the teardown runner was started");
    t.procs[0].emit("exit", 0);
    await new Promise(res => setTimeout(res, 30));
    assert.equal((await (await post(t, "/api/build")).json()).started, true);
  } finally { await t.done(); }
});

test("a local item the reset could not remove is counted and handed to the teardown job", async () => {
  const local = [{ item: "prototype/build", outcome: "failed: EBUSY: resource busy or locked" }, { item: "prototype/chat", outcome: "removed" }];
  const seen = [];
  const t = await buildSetup({ localTeardownImpl: opts => { seen.push(opts); return local; } });
  try {
    const r = await (await post(t, "/api/demo/reset")).json();
    assert.equal(r.ok, true, "the reset itself ran");
    assert.equal(r.localFailed, 1);
    assert.deepEqual(r.local, local);
    assert.equal(seen[0].decisionsFile, t.paths.decisions);
    const s = await (await fetch(t.base + "/api/demo/reset/status")).json();
    assert.deepEqual(s.results, local.map(x => ({ where: "local", ...x })), "the job's status starts with the local results");
  } finally { await t.done(); }
});

test("reset clears the lookup cache", async () => {
  const keys = ["VADEMO_URL", "VADEMO_USER", "VADEMO_PASSWORD"];
  const saved = Object.fromEntries(keys.map(k => [k, process.env[k]]));
  Object.assign(process.env, { VADEMO_URL: "http://vademo.invalid", VADEMO_USER: "u", VADEMO_PASSWORD: "fake-pass" });
  const answers = [[{ ien: 1, c0: "A" }], [{ ien: 1, c0: "A" }, { ien: 2, c0: "B" }]];
  let calls = 0;
  const vademoFetch = async () => ({ json: async () => ({ result: { content: answers[Math.min(calls++, 1)] } }) });
  let t;
  try { t = await buildSetup({ vademoFetch }); }
  finally { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
  try {
    const items = async () => (await (await fetch(t.base + "/lookup/VENDOR440?all=1")).json()).items;
    assert.equal((await items()).length, 1);
    assert.equal((await items()).length, 1, "cached");
    assert.equal((await (await post(t, "/api/demo/reset")).json()).ok, true);
    assert.equal((await items()).length, 2);
  } finally { await t.done(); }
});

test("the guide is told Phase 1 is not built, and never that it is", async () => {
  const t1 = await buildSetup({ apiBuilt: false, orchestratorVerified: false });
  try {
    assert.match(t1.systemPrompt(), /PHASE 1 IS NOT BUILT/);
    assert.doesNotMatch(t1.systemPrompt(), /built and verified/);
  } finally { await t1.done(); }
  const t2 = await buildSetup({ apiBuilt: true });
  try {
    assert.match(t2.systemPrompt(), /The API layer .* is built and verified/);
  } finally { await t2.done(); }
});

test("stopping a production build kills it first, then marks it cancelled, and the exit leaves it cancelled", async () => {
  const events = [];
  let statusFilePath;
  const killTreeImpl = _pid => {
    try { events.push({ type: "kill", state: JSON.parse(fs.readFileSync(statusFilePath, "utf8")).state }); }
    catch (_) { events.push({ type: "kill", state: "unknown" }); }
  };
  const t = await buildSetup({ killTreeImpl });
  statusFilePath = t.statusFiles.production;
  try {
    const r = await (await post(t, "/api/build/production")).json();
    assert.equal(r.started, true);
    // simulate runner setting the status to "building"
    fs.writeFileSync(t.statusFiles.production, JSON.stringify({ state: "building", step: "", log: [] }));
    const cr = await (await post(t, "/api/build/production/cancel")).json();
    assert.equal(cr.cancelled, true);
    // kill fired exactly once, and the status was still "building" when it fired (not yet "cancelled")
    assert.equal(events.length, 1, "kill called once");
    assert.equal(events[0].state, "building", "kill happened before mark-cancelled");
    // status is now cancelled
    const s = JSON.parse(fs.readFileSync(t.statusFiles.production, "utf8"));
    assert.equal(s.state, "cancelled");
    // exit does NOT change cancelled to error (reconcileExit leaves cancelled alone)
    t.procs[0].emit("exit", 1);
    await new Promise(r => setTimeout(r, 30));
    const s2 = JSON.parse(fs.readFileSync(t.statusFiles.production, "utf8"));
    assert.equal(s2.state, "cancelled");
  } finally { await t.done(); }
});

test("a changed inventory file is picked up without a restart", async () => {
  // Use a writable temp copy of the inventory
  const tempInvDir = fs.mkdtempSync(path.join(os.tmpdir(), "srv-inv-"));
  const inventoryPath = path.join(tempInvDir, "inventory-fields.json");
  fs.copyFileSync(INVENTORY, inventoryPath);
  const t = await buildSetup({ aiQuestions: ALL_KEPT, inventory: inventoryPath });
  try {
    // Rewrite the inventory with a minor change
    const inv = JSON.parse(fs.readFileSync(inventoryPath, "utf8"));
    inv._testModified = true;
    fs.writeFileSync(inventoryPath, JSON.stringify(inv));
    // A chat turn triggers regenerate() which must re-read paths.inventory
    await say(t, "hi");
    // The AI spec's inventory hash now matches the modified inventory
    const aiSpec = JSON.parse(fs.readFileSync(path.join(t.paths.specsDir, "ai.json"), "utf8"));
    assert.deepEqual(aiSpec.inputs.inventory, inputHashes("ai", loadInputs(t.paths)).inventory);
  } finally {
    await t.done();
    fs.rmSync(tempInvDir, { recursive: true, force: true });
  }
});

test("cancelling with no live process still marks a stale status as cancelled", async () => {
  const t = await buildSetup();
  try {
    // Write a stale "building" state without starting any process
    fs.writeFileSync(t.statusFiles.production, JSON.stringify({ state: "building", step: "Deploying", log: [] }));
    const cr = await (await post(t, "/api/build/production/cancel")).json();
    assert.equal(cr.cancelled, false, "no process was running");
    const s = JSON.parse(fs.readFileSync(t.statusFiles.production, "utf8"));
    assert.equal(s.state, "cancelled", "stale building status must be marked cancelled");
  } finally { await t.done(); }
});

test("createApp over a building production status marks it error with restart message", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "srv-stale-"));
  const graphPath = path.join(dir, "graph.json");
  fs.copyFileSync(path.join(__dirname, "..", "..", "capability-graph", "new-inventory-entry.json"), graphPath);
  const paths = { graph: graphPath, decisions: path.join(dir, "d.json"), implemented: path.join(dir, "impl.json"), specsDir: path.join(dir, "specs") };
  fs.writeFileSync(paths.implemented, JSON.stringify(emptyImplemented()));
  const statusFiles = {
    build:      path.join(dir, "b.json"), production: path.join(dir, "p.json"),
    ai:         path.join(dir, "a.json"), restore:    path.join(dir, "r.json"),
    teardown:   path.join(dir, "t.json"),
  };
  // Stale live states left by the previous server run
  fs.writeFileSync(statusFiles.production, JSON.stringify({ state: "building", step: "Deploying", log: [] }));
  fs.writeFileSync(statusFiles.teardown, JSON.stringify({ state: "tearing down", step: "IRIS", log: [], results: [] }));
  const spawnImpl = (_cmd, args) => { const p = new EventEmitter(); p.args = args; p.pid = 0; p.unref = () => {}; return p; };
  const made = createApp({ paths, statusFiles, spawnImpl });
  const srv = await new Promise(resolve => { const s = made.app.listen(0, "127.0.0.1", () => resolve(s)); });
  try {
    const s = JSON.parse(fs.readFileSync(statusFiles.production, "utf8"));
    assert.equal(s.state, "error");
    assert.match(s.error, /restarted while this was running/);
    assert.equal(JSON.parse(fs.readFileSync(statusFiles.teardown, "utf8")).state, "error", "a teardown left running is reconciled too");
  } finally {
    srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the API build and the production or AI build never run at the same time", async () => {
  const t = await buildSetup({ aiQuestions: ALL_KEPT });
  try {
    assert.equal((await (await post(t, "/api/build/production")).json()).started, true);
    const r = await post(t, "/api/build");
    assert.equal(r.status, 409);
    assert.match((await r.json()).error, /production build is running/);
    t.procs[0].emit("exit", 0);
    await new Promise(res => setTimeout(res, 20));
    assert.equal((await (await post(t, "/api/build/ai")).json()).started, true);
    const r1 = await post(t, "/api/build");
    assert.equal(r1.status, 409);
    assert.match((await r1.json()).error, /AI build is running/);
    t.procs[1].emit("exit", 0);
    await new Promise(res => setTimeout(res, 20));
    assert.equal((await (await post(t, "/api/build")).json()).started, true);
    for (const p of ["/api/build/production", "/api/build/ai"]) {
      const r2 = await post(t, p);
      assert.equal(r2.status, 409, p);
      assert.match((await r2.json()).error, /the API build is running/, p);
    }
    assert.equal(t.procs.length, 3, "nothing else was started");
  } finally { await t.done(); }
});

test("a runner that cannot be spawned ends its status in error and blocks nothing", async () => {
  const t = await buildSetup({ aiQuestions: ALL_KEPT });
  const st = f => JSON.parse(fs.readFileSync(f, "utf8"));
  try {
    // without an 'error' listener each of these would crash the server
    assert.equal((await (await post(t, "/api/build/production")).json()).started, true);
    t.procs[0].emit("error", new Error("spawn ENOENT"));
    assert.match(st(t.statusFiles.production).error, /the production build could not start: spawn ENOENT/);
    assert.equal(st(t.statusFiles.production).state, "error");
    assert.equal((await (await post(t, "/api/build/ai")).json()).started, true, "the failed production no longer blocks the AI build");
    t.procs[1].emit("error", new Error("spawn EPERM"));
    assert.equal(st(t.statusFiles.ai).state, "error");
    assert.equal((await (await post(t, "/api/build")).json()).started, true, "the failed AI build no longer blocks the API build");
    t.procs[2].emit("error", new Error("x"));
    const b = await (await fetch(t.base + "/api/build/status")).json();
    assert.equal(b.state, "error");
    assert.match(b.error, /the build could not start: x/);
    const rs = await (await say(t, "restore last good")).json();
    assert.equal(rs.restore.started, true, JSON.stringify(rs));
    t.procs[3].emit("error", new Error("y"));
    assert.equal(st(t.statusFiles.restore).state, "error");
    assert.equal((await (await post(t, "/api/demo/reset")).json()).ok, true);
    t.procs[4].emit("error", new Error("z"));
    const s = await (await fetch(t.base + "/api/demo/reset/status")).json();
    assert.equal(s.state, "error");
    assert.match(s.error, /the demo reset teardown could not start: z/);
    assert.equal((await (await post(t, "/api/build")).json()).started, true, "the teardown no longer blocks a build");
  } finally { await t.done(); }
});
