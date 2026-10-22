"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { graph, rec, IM } = require("./helpers");
const { generate, render, writeSpecs, stage, inputHashes } = require("../lib/specs");

const inputs = (record, implemented = IM) => ({ graph, record, implemented });

test("one-way rule: no orchestrator-layer decision changes the API spec or its markdown", () => {
  const base = inputs(rec()); const a = generate(base).api; const amd = render("api", a, base);
  const variants = [
    { dec: { "OQ.WorkOrderPolicy": "Business rule" }, oqPolicy: { "OQ.WorkOrderPolicy": "always" } },
    { dec: { "SIDE.PMSchedule": "Integration", "RULE.FinancialEligibility": "Drop", "SEC.ENFACS": "Note" } },
    { scope: { "SIDE.WorkOrder": "Defer" } },
    { targets: { "SIDE.Bulletin": { via: "iris", channel: "email" } } },
    { ruleBindings: { "OQ.WorkOrderPolicy": { cost: "31.5" } } },
  ];
  for (const v of variants) {
    const i = inputs(rec(v)); const b = generate(i).api;
    assert.equal(JSON.stringify(b), JSON.stringify(a), JSON.stringify(v));
    assert.equal(render("api", b, i), amd, JSON.stringify(v));
  }
});

test("a Phase 1 decision does change the API spec", () => {
  assert.notEqual(JSON.stringify(generate(inputs(rec({ dec: { "FLD.serial": "Omit" } }))).api), JSON.stringify(generate(inputs(rec())).api));
});

test("API input hashes ignore orchestrator decisions; orchestrator hashes do not", () => {
  const later = rec({ oqPolicy: { "OQ.FAConfirmation": "later" } });
  assert.deepEqual(inputHashes("api", inputs(rec())), inputHashes("api", inputs(later)));
  assert.notDeepEqual(inputHashes("orchestrator", inputs(rec())), inputHashes("orchestrator", inputs(later)));
});

test("writeSpecs writes json and markdown for all three layers", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "specs-")); const i = inputs(rec());
  const md = writeSpecs(dir, generate(i), i);
  assert.deepEqual(fs.readdirSync(dir).sort(), ["ai.json", "ai.md", "api.json", "api.md", "orchestrator.json", "orchestrator.md"]);
  assert.match(md.ai, /^# AI layer spec/);
});

test("stage walks decide → the bulletin's recipients → ready → ai (discovery, no inventory in inputs helper)", () => {
  assert.equal(stage(generate(inputs(rec())), IM).step, "decide");
  const d = { dec: { "OQ.WorkOrderPolicy": "Business rule" }, oqPolicy: { "OQ.WorkOrderPolicy": "a rule", "OQ.PMEnrollmentPolicy": "later", "OQ.FAConfirmation": "later" } };
  const st = stage(generate(inputs(rec(d))), IM);
  assert.equal(st.step, "target"); assert.equal(st.next.id, "SIDE.Bulletin"); assert.equal(st.next.key, "recipients");
  const t = { ...d, targets: { "SIDE.Bulletin": { recipients: "x" } } };
  assert.equal(stage(generate(inputs(rec(t))), IM).step, "ready");
  const done = { ...IM, orchestrator: { built: true, verified: true } };
  // inputs() has no inventory → AI spec reports "discovery" missing → stage step is "discovery"
  const aiStage = stage(generate(inputs(rec(t), done)), done);
  assert.equal(aiStage.layer, "ai");
  assert.equal(aiStage.step, "discovery");
});

test("stage starts at Phase 1 — 🔨 Build on the API tab — until the entry form has been built from its spec", () => {
  const { entryForm: _e, ...noForm } = IM;
  for (const im of [noForm, { ...IM, entryForm: { built: false } }]) {
    const st = stage(generate(inputs(rec(), im)), im);
    assert.deepEqual(st, { layer: "api", step: "build", next: null });
  }
  // the entry form comes first even when the production is already built
  const orchDone = { ...noForm, orchestrator: { built: true, verified: true } };
  assert.equal(stage(generate(inputs(rec(), orchDone)), orchDone).layer, "api");
  assert.equal(stage(generate(inputs(rec())), IM).layer, "orchestrator");
});

test("building the entry form never makes the API spec look stale", () => {
  const { entryForm: _e, ...noForm } = IM;
  assert.deepEqual(inputHashes("api", inputs(rec(), IM)), inputHashes("api", inputs(rec(), noForm)));
});
