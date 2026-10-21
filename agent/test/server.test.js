"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createApp } = require("../server");
const { runTool } = require("../lib/tools");
const { inputHashes, loadInputs } = require("../lib/specs");

function setup(fakeAgent, prepare) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "srv-"));
  const graphCopy = path.join(dir, "graph.json");
  fs.copyFileSync(path.join(__dirname, "..", "..", "capability-graph", "new-inventory-entry.json"), graphCopy);
  const paths = { graph: graphCopy, decisions: path.join(dir, "decisions.json"), implemented: path.join(__dirname, "..", "implemented.json"), specsDir: path.join(dir, "specs") };
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
