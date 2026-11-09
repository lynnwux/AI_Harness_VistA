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
    { ruleBindings: { "OQ.WorkOrderPolicy": { cost: "12" } } },
  ];
  for (const v of variants) {
    const i = inputs(rec(v)); const b = generate(i).api;
    assert.equal(JSON.stringify(b), JSON.stringify(a), JSON.stringify(v));
    assert.equal(render("api", b, i), amd, JSON.stringify(v));
  }
});

test("discovery candidates are not spec inputs: adding one leaves every spec, hash and the API design hash unchanged", () => {
  const withCandidates = JSON.parse(JSON.stringify(graph));
  withCandidates.capabilities[0].discoveryCandidates = [{ id: "DC.Test", status: "candidate", finding: "x" }];
  const a = inputs(rec()), b = { ...a, graph: withCandidates };
  const sa = generate(a), sb = generate(b);
  for (const l of ["api", "orchestrator", "ai"]) {
    assert.deepEqual(inputHashes(l, b), inputHashes(l, a), l);
    assert.equal(JSON.stringify(sb[l]), JSON.stringify(sa[l]), l);
  }
  assert.equal(designHash(sb.api), designHash(sa.api));
  assert.equal(render("api", sb.api, b), render("api", sa.api, a));
  assert.equal(render("orchestrator", sb.orchestrator, b), render("orchestrator", sa.orchestrator, a));
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

test("a spec that matches the decisions but not this code is regenerated — a server started before the code changed wrote it", () => {
  const { currentSpec, loadInputs } = require("../lib/specs");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "specs-code-"));
  const paths = { graph: path.join(dir, "g.json"), decisions: path.join(dir, "d.json"), implemented: path.join(dir, "i.json"), inventory: path.join(dir, "inv.json"), specsDir: path.join(dir, "specs") };
  const inventory = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "capability-graph", "inventory-fields.json"), "utf8"));
  fs.writeFileSync(paths.graph, JSON.stringify(graph)); fs.writeFileSync(paths.decisions, JSON.stringify(rec()));
  fs.writeFileSync(paths.implemented, JSON.stringify(IM)); fs.writeFileSync(paths.inventory, JSON.stringify(inventory));
  try {
    const i = loadInputs(paths);
    writeSpecs(paths.specsDir, generate(i), i);
    const file = path.join(paths.specsDir, "ai.json"), read = () => JSON.parse(fs.readFileSync(file, "utf8"));
    assert.deepEqual(currentSpec("ai", read(), paths).regenerated, false, "this code's own spec is used as it is");
    // what older code wrote: same inputs, different content
    const old = read(); old.detail.general.rowCap = 999; fs.writeFileSync(file, JSON.stringify(old));
    const r = currentSpec("ai", old, paths);
    assert.equal(r.regenerated, true);
    assert.equal(r.spec.detail.general.rowCap, 200, "the build uses what this code generates");
    assert.equal(read().detail.general.rowCap, 200, "and the spec files are rewritten to match");
    // a spec that no longer matches the decisions is left for the caller's stale check
    const stale = { ...read(), inputs: { ...read().inputs, decisions: "x" } };
    assert.equal(currentSpec("ai", stale, paths).spec, stale);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
