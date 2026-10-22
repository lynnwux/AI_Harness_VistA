"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { graph, rec, IM } = require("./helpers");
const { generate, render, writeSpecs, stage, inputHashes, designHash } = require("../lib/specs");
const { PHASE1_SERVICES, emptyImplemented, builtApi } = require("../lib/implemented");

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

test("stage starts at Phase 1 until the API layer is built and verified", () => {
  // emptyImplemented(), api:verified=false, and api as old array (PHASE1_SERVICES) → all return api/build
  for (const im of [emptyImplemented(), { ...IM, api: { ...builtApi(), verified: false } }, { ...IM, api: PHASE1_SERVICES }]) {
    assert.deepEqual(stage(generate(inputs(rec(), im)), im), { layer: "api", step: "build", next: null });
  }
  // orchestrator built but API not → still api layer
  const orchDone = { ...emptyImplemented(), orchestrator: { built: true, verified: true } };
  assert.equal(stage(generate(inputs(rec(), orchDone)), orchDone).layer, "api");
  // IM has api built and verified → moves to orchestrator
  assert.equal(stage(generate(inputs(rec())), IM).layer, "orchestrator");
});

test("a Phase 1 decision after the build marks it out of date", () => {
  const currentHash = designHash(generate(inputs(rec())).api);
  const im = { ...IM, api: builtApi(PHASE1_SERVICES, { builtFrom: currentHash }) };
  // same spec → not out of date
  assert.equal(stage(generate(inputs(rec())), im).apiOutOfDate, undefined);
  // changed spec → out of date, but orchestrator layer continues
  const st = stage(generate(inputs(rec({ dec: { "FLD.model": "Omit" } }))), im);
  assert.equal(st.apiOutOfDate, true);
  assert.equal(st.layer, "orchestrator");
});

test("building Phase 1 never makes the API spec look stale", () => {
  // builtFrom and verifiedRecord are never hashed — extra fields in api record don't shift the input hash
  assert.deepEqual(
    inputHashes("api", inputs(rec(), IM)),
    inputHashes("api", inputs(rec(), { ...IM, api: builtApi(PHASE1_SERVICES, { verifiedRecord: { ien: 9 }, builtFrom: "x" }) }))
  );
});
