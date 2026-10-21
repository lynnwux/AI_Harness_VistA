"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { graph, rec, IM } = require("./helpers");
const { buildOrchestratorSpec, renderOrchestrator } = require("../lib/specs/orchestrator");

// all three questions decided, one per mode, in the developer's own (abstract) words
const decided = {
  dec: { "OQ.WorkOrderPolicy": "Required input", "OQ.PMEnrollmentPolicy": "Business rule", "OQ.FAConfirmation": "Defer" },
  oqPolicy: { "OQ.WorkOrderPolicy": "ask the clerk", "OQ.PMEnrollmentPolicy": "a rule the developer stated", "OQ.FAConfirmation": "no FAP target here" },
};
const withRecipients = { ...decided, targets: { "SIDE.Bulletin": { recipients: "eng-group@example.org" } } };
const ids = list => list.map(e => e.id);

test("untouched record: the three decisions are missing and only the mandatory bulletin is a real operation", () => {
  const s = buildOrchestratorSpec(graph, rec(), IM);
  assert.deepEqual(s.missing.filter(m => m.kind === "decide").map(m => m.id), ["OQ.WorkOrderPolicy", "OQ.PMEnrollmentPolicy", "OQ.FAConfirmation"]);
  assert.deepEqual(ids(s.detail.built), ["SIDE.Bulletin"]);
  assert.deepEqual(ids(s.detail.notBuilt), ["SIDE.WorkOrder", "SIDE.PMSchedule", "SIDE.FinancialAsset"]);
  assert.deepEqual(s.detail.stubs, []);
  assert.equal(s.complete, false);
});

test("once decided, work order, PM and FA are stubs and only the bulletin's email recipients remain", () => {
  const s = buildOrchestratorSpec(graph, rec(decided), IM);
  assert.deepEqual(s.missing.map(m => [m.id, m.kind, m.key]), [["SIDE.Bulletin", "target", "recipients"]]);
  assert.deepEqual(ids(s.detail.stubs), ["SIDE.WorkOrder", "SIDE.PMSchedule", "SIDE.FinancialAsset"]);
  assert.ok(s.detail.stubs.every(e => e.stub === true));
  assert.deepEqual(s.needs, []);
  assert.equal(s.complete, false);
});

test("recording the recipients makes the spec complete — no bindings, target details or Phase 1 work are asked for", () => {
  const s = buildOrchestratorSpec(graph, rec(withRecipients), IM);
  assert.deepEqual(s.missing, []);
  assert.deepEqual(s.needs, []);
  assert.equal(s.complete, true);
  assert.match(renderOrchestrator(graph, rec(withRecipients), s), /^✅ Complete — ready for the production build\./m);
});

test("the bulletin is an email sent from IRIS with the legacy template, unless the record says otherwise", () => {
  const b = buildOrchestratorSpec(graph, rec(decided), IM).detail.built.find(e => e.id === "SIDE.Bulletin");
  assert.equal(b.target.via, "iris");
  assert.equal(b.target.channel, "email");
  assert.match(b.target.content, /legacy message template/);
  assert.deepEqual(b.defaults, ["via", "channel", "content"]);
  const md = renderOrchestrator(graph, rec(decided), buildOrchestratorSpec(graph, rec(decided), IM));
  assert.match(md, /- channel: email \(default\)/);
  assert.match(md, /- ▢ recipients — who receives it/);
  const own = rec({ ...decided, targets: { "SIDE.Bulletin": { channel: "Teams", recipients: "x" } } });
  const b2 = buildOrchestratorSpec(graph, own, IM).detail.built.find(e => e.id === "SIDE.Bulletin");
  assert.equal(b2.target.channel, "Teams");
  assert.deepEqual(b2.defaults, ["via", "content"]);
});

test("each stub carries what wiring it later will take, and none of it blocks", () => {
  const s = buildOrchestratorSpec(graph, rec(withRecipients), IM);
  const stub = id => s.detail.stubs.find(e => e.id === id);
  const wo = stub("SIDE.WorkOrder").later.join("\n");
  assert.match(wo, /operator prompt on the front end/);
  assert.match(wo, /via, writePath, fields, operatorValues/);
  assert.match(wo, /write:6920/);
  assert.match(stub("SIDE.PMSchedule").later.join("\n"), /bind the policy's data words/);
  assert.equal(stub("SIDE.FinancialAsset").reason, "no FAP target here");
  assert.equal(stub("SIDE.WorkOrder").decision.mode, "Required input");
  const md = renderOrchestrator(graph, rec(withRecipients), s);
  assert.match(md, /## Stubs — registered in the production, not wired/);
  assert.match(md, /Later, to wire this stub:/);
});

test("a bound field the API contract no longer carries is flagged for later wiring, not blocking", () => {
  const fld7 = graph.capabilities[0].data.find(d => d.field === "7").id;
  const r = rec({ ...withRecipients, dec: { ...withRecipients.dec, [fld7]: "Omit" }, ruleBindings: { "OQ.PMEnrollmentPolicy": { "a word": "7" } } });
  const s = buildOrchestratorSpec(graph, r, IM);
  assert.match(s.detail.stubs.find(e => e.id === "SIDE.PMSchedule").later.join("\n"), /"a word" is bound to fld 7, which the API request contract no longer carries/);
  assert.equal(s.complete, true);
});

test("a dropped side effect is not built, and a scope-deferred one is a stub with its reason", () => {
  const s = buildOrchestratorSpec(graph, rec({ ...decided, dec: { ...decided.dec, "SIDE.WorkOrder": "Drop" }, scope: { "SIDE.PMSchedule": "Defer" } }), IM);
  assert.deepEqual(s.detail.notBuilt.map(e => [e.id, e.reason]), [["SIDE.WorkOrder", "dropped — not carried forward"]]);
  assert.equal(s.detail.stubs.find(e => e.id === "SIDE.PMSchedule").reason, "deferred to a later phase");
});

test("a stale Drop of the mandatory bulletin in an older record keeps it built and asks how to implement it", () => {
  const s = buildOrchestratorSpec(graph, rec({ dec: { "SIDE.Bulletin": "Drop" } }), IM);
  assert.ok(s.detail.built.some(e => e.id === "SIDE.Bulletin"));
  assert.ok(!s.detail.notBuilt.some(e => e.id === "SIDE.Bulletin"));
  assert.ok(s.missing.some(m => m.id === "SIDE.Bulletin" && m.kind === "decide"));
});

test("the rendered spec quotes the record verbatim and never invents a threshold", () => {
  const r = rec(decided);
  const md = renderOrchestrator(graph, r, buildOrchestratorSpec(graph, r, IM));
  assert.match(md, /"a rule the developer stated"/);
  assert.match(md, /`ENEQ3` BULL \(line 60\): Recipients:/);
  assert.doesNotMatch(md, /50,?000/);
});

test("the bulletin shows the legacy email template; with FA a stub, its FAP line would always report not done", () => {
  const s = buildOrchestratorSpec(graph, rec(decided), IM);
  const b = s.detail.built.find(e => e.id === "SIDE.Bulletin");
  assert.equal(b.template.subject, "NEW EQUIPMENT: ENTRY #|1|");
  assert.deepEqual(b.templateNotes.map(n => n.slice(0, 5)), ["`|2|`", "`|4|`", "`|5|`", "`|7|`"]);
  assert.match(b.templateNotes[1], /`\|4\|`: the request carries the pointer's IEN, not its name — until a name lookup is wired, the email shows the IEN/);
  const md = renderOrchestrator(graph, rec(decided), s);
  assert.match(md, /Subject: `NEW EQUIPMENT: ENTRY #\|1\|`/);
  assert.match(md, /⚠ `\|7\|` reports the outcome of FA document to Austin, which is a stub in this build — it would always report that step as not done/);
  assert.match(md, /⚠ `\|2\|`: no operator identity reaches the pipeline yet/);
  const md0 = renderOrchestrator(graph, rec(), buildOrchestratorSpec(graph, rec(), IM));
  assert.match(md0, /⚠ `\|7\|` reports the outcome of FA document to Austin, which is not built in this phase/);
});
