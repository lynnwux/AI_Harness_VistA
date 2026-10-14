"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { graph, rec, IM } = require("./helpers");
const { buildOrchestratorSpec, renderOrchestrator } = require("../lib/specs/orchestrator");

const decided = {
  dec: { "OQ.WorkOrderPolicy": "Business rule" },
  oqPolicy: { "OQ.WorkOrderPolicy": "Create incoming inspection work order if TYPE OF ENTRY = NX", "OQ.PMEnrollmentPolicy": "later phase", "OQ.FAConfirmation": "no FAP target here" },
};
const withWrite = { ...IM, api: [...IM.api, { id: "write:6920", endpoint: "POST /work-orders", what: "x" }] };

test("untouched record: three decisions missing and only the mandatory bulletin is built", () => {
  const s = buildOrchestratorSpec(graph, rec(), IM);
  assert.deepEqual(s.missing.filter(m => m.kind === "decide").map(m => m.id), ["OQ.WorkOrderPolicy", "OQ.PMEnrollmentPolicy", "OQ.FAConfirmation"]);
  assert.deepEqual(s.detail.built.map(e => e.id), ["SIDE.Bulletin"]);
  assert.deepEqual(s.missing.filter(m => m.id === "SIDE.Bulletin").map(m => m.key), ["via", "channel", "recipients", "content"]);
  assert.equal(s.complete, false);
});

test("a business-rule work order needs bindings, target details and the unbuilt 6920 write", () => {
  const s = buildOrchestratorSpec(graph, rec(decided), IM);
  assert.equal(s.detail.rules[0].policy, "Create incoming inspection work order if TYPE OF ENTRY = NX");
  assert.ok(s.missing.some(m => m.id === "OQ.WorkOrderPolicy" && m.kind === "binding"));
  assert.deepEqual(s.missing.filter(m => m.id === "SIDE.WorkOrder").map(m => m.key), ["via", "writePath", "fields", "operatorValues"]);
  assert.deepEqual(s.needs, [{ for: "SIDE.WorkOrder", service: "write:6920", what: "write file 6920 for Incoming inspection work order — proposed in the API spec from `IIWO^ENWONEW3(IEN)`", from: "api", met: false }]);
});

test("with PM and FA deferred, recording the rest and building the 6920 write makes the spec complete — deferring never blocks", () => {
  const r = rec({
    ...decided,
    ruleBindings: { "OQ.WorkOrderPolicy": { "TYPE OF ENTRY": "7" } },
    targets: {
      "SIDE.WorkOrder": { via: "vista", writePath: "new REST endpoint", fields: "as legacy", operatorValues: "defaults" },
      "SIDE.Bulletin": { via: "iris", channel: "email", recipients: "eng-group", content: "as legacy" },
    },
  });
  const s = buildOrchestratorSpec(graph, r, withWrite);
  assert.deepEqual(s.missing, []);
  assert.equal(s.complete, true);
});

test("deferred side effects become unwired stubs with the recorded reason and add nothing to the missing list", () => {
  const s = buildOrchestratorSpec(graph, rec(decided), IM);
  assert.deepEqual(s.detail.deferred.map(e => [e.id, e.stub, e.reason]), [["SIDE.PMSchedule", true, "later phase"], ["SIDE.FinancialAsset", true, "no FAP target here"]]);
  assert.ok(!s.missing.some(m => m.id === "SIDE.PMSchedule" || m.id === "SIDE.FinancialAsset"));
  assert.ok(!s.needs.some(n => n.for === "SIDE.PMSchedule" || n.for === "SIDE.FinancialAsset"));
  assert.deepEqual(s.detail.notBuilt, []);
  assert.match(renderOrchestrator(graph, rec(decided), s), /## Deferred — stub only, not wired[\s\S]*\*\*FA document to Austin\*\* — no FAP target here/);
});

test("a side effect still waiting on its decision is listed as not built, not as a stub", () => {
  const s = buildOrchestratorSpec(graph, rec(), IM);
  assert.deepEqual(s.detail.notBuilt.map(e => e.id), ["SIDE.WorkOrder", "SIDE.PMSchedule", "SIDE.FinancialAsset"]);
  assert.deepEqual(s.detail.deferred, []);
});

test("a Required-input question is an unmet front-end need, never written into the API layer", () => {
  const s = buildOrchestratorSpec(graph, rec({ dec: { "OQ.PMEnrollmentPolicy": "Required input" }, oqPolicy: { "OQ.PMEnrollmentPolicy": "ask the clerk" } }), IM);
  assert.ok(s.needs.some(n => n.service === "prompt:OQ.PMEnrollmentPolicy" && n.met === false));
});

test("the rendered spec quotes the record verbatim and never invents a threshold", () => {
  const r = rec(decided);
  const md = renderOrchestrator(graph, r, buildOrchestratorSpec(graph, r, IM));
  assert.match(md, /"Create incoming inspection work order if TYPE OF ENTRY = NX"/);
  assert.match(md, /▢ via — where the work is performed/);
  assert.match(md, /unmet — requires Phase 1 work/);
  assert.match(md, /`ENEQ3` BULL \(line 60\): Recipients:/);
  assert.doesNotMatch(md, /50,?000/);
});

test("the bulletin shows the legacy email template and what it depends on", () => {
  const r = rec(decided);   // FA deferred
  const s = buildOrchestratorSpec(graph, r, IM);
  const b = s.detail.built.find(e => e.id === "SIDE.Bulletin");
  assert.equal(b.template.subject, "NEW EQUIPMENT: ENTRY #|1|");
  assert.deepEqual(b.templateNotes.map(n => n.slice(0, 5)), ["`|2|`", "`|7|`"]);
  const md = renderOrchestrator(graph, r, s);
  assert.match(md, /Subject: `NEW EQUIPMENT: ENTRY #\|1\|`/);
  assert.match(md, /⚠ `\|7\|` reports the outcome of FA document to Austin, which is not built in this phase/);
  assert.match(md, /⚠ `\|2\|`: no operator identity reaches the pipeline yet/);
  const withFA = rec({ ...decided, dec: { ...decided.dec, "OQ.FAConfirmation": "Business rule" }, oqPolicy: { ...decided.oqPolicy, "OQ.FAConfirmation": "send when eligible" } });
  assert.match(renderOrchestrator(graph, withFA, buildOrchestratorSpec(graph, withFA, IM)), /⚠ `\|7\|` reports the outcome of FA document to Austin — run the bulletin after that step, as the legacy does/);
});

test("a stale Drop of the mandatory bulletin in an older record keeps it built and asks how to implement it", () => {
  const s = buildOrchestratorSpec(graph, rec({ dec: { "SIDE.Bulletin": "Drop" } }), IM);
  assert.ok(s.detail.built.some(e => e.id === "SIDE.Bulletin"));
  assert.ok(!s.detail.notBuilt.some(e => e.id === "SIDE.Bulletin"));
  assert.ok(s.missing.some(m => m.id === "SIDE.Bulletin" && m.kind === "decide"));
});

test("a bound field the API contract no longer carries is an unmet need, so the spec cannot be complete", () => {
  const fld7 = graph.capabilities[0].data.find(d => d.field === "7").id;
  const bound = { ...decided, ruleBindings: { "OQ.WorkOrderPolicy": { "TYPE OF ENTRY": "7" } } };
  const okNeeds = buildOrchestratorSpec(graph, rec(bound), withWrite).needs.filter(n => n.for === "OQ.WorkOrderPolicy");
  assert.deepEqual(okNeeds, []);
  const omitted = rec({ ...bound, dec: { ...bound.dec, [fld7]: "Omit" } });
  const s = buildOrchestratorSpec(graph, omitted, withWrite);
  const n = s.needs.find(x => x.for === "OQ.WorkOrderPolicy");
  assert.ok(n && n.met === false, JSON.stringify(s.needs));
  assert.match(n.what, /TYPE OF ENTRY/);
  assert.equal(s.complete, false);
});

test("a resolved rule whose side effect is deferred by build scope never asks for bindings — deferring never blocks", () => {
  const r = rec({ dec: { "OQ.PMEnrollmentPolicy": "Business rule" }, oqPolicy: { "OQ.PMEnrollmentPolicy": "enroll when the developer says so" }, scope: { "SIDE.PMSchedule": "Defer" } });
  const s = buildOrchestratorSpec(graph, r, IM);
  assert.ok(s.detail.deferred.some(e => e.id === "SIDE.PMSchedule"));
  assert.ok(!s.missing.some(m => m.id === "OQ.PMEnrollmentPolicy"), JSON.stringify(s.missing));
});
