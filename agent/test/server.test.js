"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createApp } = require("../server");
const { runTool } = require("../lib/tools");
const { inputHashes, loadInputs } = require("../lib/specs");

function setup(fakeAgent) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "srv-"));
  const graphCopy = path.join(dir, "graph.json");
  fs.copyFileSync(path.join(__dirname, "..", "..", "capability-graph", "new-inventory-entry.json"), graphCopy);
  const paths = { graph: graphCopy, decisions: path.join(dir, "decisions.json"), implemented: path.join(__dirname, "..", "implemented.json"), specsDir: path.join(dir, "specs") };
  const made = createApp({ paths, runAgentImpl: fakeAgent || (async () => ({ reply: "ok", toolTrace: [] })) });
  return new Promise(resolve => {
    const srv = made.app.listen(0, "127.0.0.1", () => resolve({ ...made, srv, paths, base: `http://127.0.0.1:${srv.address().port}` }));
  });
}

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
