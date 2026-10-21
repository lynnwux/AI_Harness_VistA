"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs   = require("fs");
const path = require("path");
const { graph, rec, IM } = require("./helpers");
const { runTool, TOOL_SPECS } = require("../lib/tools");

const inv = JSON.parse(fs.readFileSync(
  path.join(__dirname, "..", "..", "capability-graph", "inventory-fields.json"), "utf8"
));

const ctx        = record => ({ graph, decisions: record, implemented: IM });
const ctxWithInv = record => ({ graph, decisions: record, implemented: IM, inventory: inv });

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

test("credentials in other shapes are refused too — in target details and in policy text", () => {
  for (const v of ["https://svc:Hunter2@host.example/api", "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc", "pwd=Hunter2", "pass: Hunter2"]) {
    const r = rec();
    const out = runTool("setTarget", { nodeId: "SIDE.Bulletin", recipients: v }, ctx(r));
    assert.equal(out.ok, false, v);
    assert.equal(r.targets["SIDE.Bulletin"], undefined, v);
  }
  const r = rec();
  const out = runTool("resolveOpenQuestion", { id: "OQ.WorkOrderPolicy", mode: "Business rule", policy: "always; password=Hunter2" }, ctx(r));
  assert.equal(out.ok, false);
  assert.match(out.message, /credential/);
  assert.equal(r.oqPolicy["OQ.WorkOrderPolicy"], undefined);
  assert.equal(r.dec["OQ.WorkOrderPolicy"], "Defer");
});

test("tool descriptions and explanations carry no example drawn from a real item", () => {
  const text = JSON.stringify(TOOL_SPECS);
  for (const real of ["TYPE OF ENTRY", "ENFACS", "$P(^ENG(6914", "work-order", "work order"]) assert.ok(!text.includes(real), real);
  const pm = runTool("explainMapping", { nodeId: "SIDE.PMSchedule" }, ctx(rec()));
  assert.ok(!/work-order|work order/i.test(pm.mapsThroughLayers.join(" ")), pm.mapsThroughLayers.join(" | "));
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

// ── setQuickQuestion ──────────────────────────────────────────────────────────

test("setQuickQuestion records keep, wording, and valid params", () => {
  const r = rec();
  const out = runTool("setQuickQuestion", {
    id: "AIQ.HighValueNoContract",
    keep: true,
    wording: "Which high-value items have no service contract?",
    params: { threshold: 50000, valueColumn: "TOTAL_ASSET_VALUE", useStatuses: ["1"] },
  }, ctxWithInv(r));
  assert.equal(out.ok, true, out.message);
  assert.ok(r.aiQuestions["AIQ.HighValueNoContract"], "aiQuestions entry created");
  assert.equal(r.aiQuestions["AIQ.HighValueNoContract"].keep, true);
  assert.equal(r.aiQuestions["AIQ.HighValueNoContract"].params.threshold, 50000);
});

test("setQuickQuestion merges params (partial update)", () => {
  const r = rec();
  runTool("setQuickQuestion", { id: "AIQ.HighValueNoContract", params: { threshold: 50000 } }, ctxWithInv(r));
  runTool("setQuickQuestion", { id: "AIQ.HighValueNoContract", params: { valueColumn: "ORIGINAL_ASSET_VALUE" } }, ctxWithInv(r));
  assert.equal(r.aiQuestions["AIQ.HighValueNoContract"].params.threshold, 50000);
  assert.equal(r.aiQuestions["AIQ.HighValueNoContract"].params.valueColumn, "ORIGINAL_ASSET_VALUE");
});

test("setQuickQuestion refuses unknown id", () => {
  const r = rec();
  const out = runTool("setQuickQuestion", { id: "AIQ.Nope" }, ctx(r));
  assert.equal(out.ok, false);
  assert.match(out.message, /unknown/i);
  assert.equal(r.aiQuestions["AIQ.Nope"], undefined);
});

test("setQuickQuestion refuses wording that looks like a secret", () => {
  const r = rec();
  const out = runTool("setQuickQuestion", { id: "AIQ.HighValueNoContract", wording: "token: abc123456" }, ctxWithInv(r));
  assert.equal(out.ok, false);
  assert.match(out.message, /credential/);
  assert.equal(r.aiQuestions["AIQ.HighValueNoContract"], undefined);
});

test("setQuickQuestion refuses an unknown param key", () => {
  const r = rec();
  const out = runTool("setQuickQuestion", { id: "AIQ.AgingOutFY", params: { badKey: 99 } }, ctxWithInv(r));
  assert.equal(out.ok, false);
  assert.match(out.message, /badKey/);
});

test("setQuickQuestion refuses an invalid param value and lists valid options", () => {
  const r = rec();
  const out = runTool("setQuickQuestion", {
    id: "AIQ.AgingOutFY",
    params: { fiscalYear: 1800 },
  }, ctxWithInv(r));
  assert.equal(out.ok, false);
  assert.match(out.message, /fiscalYear/);
});

test("getState.ai returns questions with ids, defaultWording, and stage", () => {
  const st = runTool("getState", {}, ctxWithInv(rec()));
  assert.ok(st.ai, "ai section present");
  assert.ok(Array.isArray(st.ai.questions), "ai.questions is array");
  assert.equal(st.ai.questions.length, 4, "four questions");
  assert.ok(st.ai.questions.every(q => q.id && q.defaultWording && Array.isArray(q.params) && Array.isArray(q.missing)), "question shape ok");
  assert.ok(st.ai.stage, "ai.stage present");
  assert.equal(st.ai.stage.total, 4);
});

test("getState.ai sqlPreview is set when all params are recorded and valid", () => {
  const r = rec();
  runTool("setQuickQuestion", {
    id: "AIQ.AgingOutFY",
    params: { fiscalYear: 2030, capitalizedMeans: "INVESTMENT_CATEGORY = 1", useStatuses: ["ALL"] },
  }, ctxWithInv(r));
  const st = runTool("getState", {}, ctxWithInv(r));
  const q = st.ai.questions.find(q => q.id === "AIQ.AgingOutFY");
  assert.ok(q.sqlPreview, "sqlPreview present when all params valid");
  assert.match(q.sqlPreview, /FROM VISTA\.EQUIPMENT_INV_6914/);
});
