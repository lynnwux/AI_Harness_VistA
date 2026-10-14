"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { graph, rec, IM } = require("./helpers");
const { runTool } = require("../lib/tools");

const ctx = record => ({ graph, decisions: record, implemented: IM });

test("Defer without a reason records a default reason and takes the gated side effect out of the build", () => {
  const r = rec();
  assert.equal(runTool("resolveOpenQuestion", { id: "OQ.FAConfirmation", mode: "Defer" }, ctx(r)).ok, true);
  assert.equal(r.oqPolicy["OQ.FAConfirmation"], "Deferred — not built in this phase; revisit later.");
  assert.equal(r.scope["SIDE.FinancialAsset"], "Defer");
});

test("a Business rule brings the gated side effect into the build", () => {
  const r = rec({ scope: { "SIDE.WorkOrder": "Defer" } });
  runTool("resolveOpenQuestion", { id: "OQ.WorkOrderPolicy", mode: "Business rule", policy: "if TYPE OF ENTRY = NX" }, ctx(r));
  assert.equal(r.scope["SIDE.WorkOrder"], "Build now");
});

test("re-resolving a question with a new policy clears bindings made for the old one", () => {
  const r = rec();
  runTool("resolveOpenQuestion", { id: "OQ.WorkOrderPolicy", mode: "Business rule", policy: "if TYPE OF ENTRY = NX" }, ctx(r));
  runTool("bindRuleTerms", { id: "OQ.WorkOrderPolicy", bindings: { "TYPE OF ENTRY": "7" } }, ctx(r));
  runTool("resolveOpenQuestion", { id: "OQ.WorkOrderPolicy", mode: "Business rule", policy: "if INVESTMENT CATEGORY = 1" }, ctx(r));
  assert.equal(r.ruleBindings["OQ.WorkOrderPolicy"], undefined);
});

test("the mandatory bulletin cannot be dropped or deferred, but its disposition can change", () => {
  const r = rec();
  assert.equal(runTool("setDisposition", { nodeId: "SIDE.Bulletin", option: "Drop" }, ctx(r)).ok, false);
  assert.equal(runTool("setBuildScope", { nodeId: "SIDE.Bulletin", phase: "Defer" }, ctx(r)).ok, false);
  assert.equal(runTool("setDisposition", { nodeId: "SIDE.Bulletin", option: "Business Operation" }, ctx(r)).ok, true);
  assert.equal(r.dec["SIDE.Bulletin"], "Business Operation");
});

test("setTarget accepts only the keys for the side effect's kind and never changes the disposition", () => {
  const r = rec();
  assert.equal(runTool("setTarget", { nodeId: "SIDE.WorkOrder", channel: "email" }, ctx(r)).ok, false);
  assert.equal(runTool("setTarget", { nodeId: "SIDE.WorkOrder", via: "somewhere" }, ctx(r)).ok, false);
  const ok = runTool("setTarget", { nodeId: "SIDE.WorkOrder", via: "vista", writePath: "new REST endpoint on VADEMO" }, ctx(r));
  assert.equal(ok.ok, true);
  assert.deepEqual(r.targets["SIDE.WorkOrder"], { via: "vista", writePath: "new REST endpoint on VADEMO" });
  assert.equal(r.dec["SIDE.WorkOrder"], "Business Operation");
});

test("setTarget refuses a value that looks like a credential", () => {
  const r = rec();
  const out = runTool("setTarget", { nodeId: "SIDE.Bulletin", recipients: "password=hunter2" }, ctx(r));
  assert.equal(out.ok, false);
  assert.match(out.message, /credential/);
  assert.equal(r.targets["SIDE.Bulletin"], undefined);
});

test("bindRuleTerms only binds a resolved rule, only to fields in the API request contract", () => {
  const r = rec();
  assert.equal(runTool("bindRuleTerms", { id: "OQ.WorkOrderPolicy", bindings: { "TYPE OF ENTRY": "7" } }, ctx(r)).ok, false);
  runTool("resolveOpenQuestion", { id: "OQ.WorkOrderPolicy", mode: "Business rule", policy: "if TYPE OF ENTRY = NX OR cost over a limit" }, ctx(r));
  const bad = runTool("bindRuleTerms", { id: "OQ.WorkOrderPolicy", bindings: { cost: "12" } }, ctx(r));
  assert.equal(bad.ok, false);
  assert.match(bad.message, /not in the API request contract/);
  assert.equal(runTool("bindRuleTerms", { id: "OQ.WorkOrderPolicy", bindings: { "TYPE OF ENTRY": 7 } }, ctx(r)).ok, true);
  assert.deepEqual(r.ruleBindings["OQ.WorkOrderPolicy"], { "TYPE OF ENTRY": "7" });
  assert.equal(runTool("bindRuleTerms", { id: "OQ.WorkOrderPolicy", bindings: {} }, ctx(r)).ok, true);
  assert.deepEqual(r.ruleBindings["OQ.WorkOrderPolicy"], {});
});

test("getState reports stage, missing items, evidence, the request contract and mandatory items", () => {
  const st = runTool("getState", {}, ctx(rec()));
  assert.equal(st.stage.step, "decide");
  assert.ok(st.sideEffects.find(s => s.id === "SIDE.Bulletin").evidence.length > 0);
  assert.ok(st.requestContract.some(f => f.field === "7"));
  assert.deepEqual(st.mandatory, ["SIDE.Bulletin"]);
  assert.deepEqual(st.blocking, ["OQ.WorkOrderPolicy", "OQ.PMEnrollmentPolicy", "OQ.FAConfirmation"]);
});
