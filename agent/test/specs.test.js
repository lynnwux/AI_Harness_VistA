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

test("stage walks decide → binding → target → needs → ready → ai", () => {
  assert.equal(stage(generate(inputs(rec())), IM).step, "decide");
  const d = { dec: { "OQ.WorkOrderPolicy": "Business rule" }, oqPolicy: { "OQ.WorkOrderPolicy": "if TYPE OF ENTRY = NX", "OQ.PMEnrollmentPolicy": "later", "OQ.FAConfirmation": "later" } };
  assert.equal(stage(generate(inputs(rec(d))), IM).step, "binding");
  const b = { ...d, ruleBindings: { "OQ.WorkOrderPolicy": { "TYPE OF ENTRY": "7" } } };
  assert.equal(stage(generate(inputs(rec(b))), IM).step, "target");
  const t = { ...b, targets: { "SIDE.WorkOrder": { via: "vista", writePath: "x", fields: "x", operatorValues: "x" }, "SIDE.Bulletin": { via: "iris", channel: "x", recipients: "x", content: "x" } } };
  const st = stage(generate(inputs(rec(t))), IM);
  assert.equal(st.step, "needs"); assert.equal(st.next.service, "write:6920");
  const im = { ...IM, api: [...IM.api, { id: "write:6920", endpoint: "POST /work-orders", what: "x" }] };
  assert.equal(stage(generate(inputs(rec(t), im)), im).step, "ready");
  const done = { ...im, orchestrator: { built: true, verified: true } };
  assert.equal(stage(generate(inputs(rec(t), done)), done).layer, "ai");
});
