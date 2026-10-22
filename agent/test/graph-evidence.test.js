"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { PHASE1_SERVICES } = require("../lib/implemented");

const graph = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "capability-graph", "new-inventory-entry.json"), "utf8"));
const c = graph.capabilities[0];

test("every side effect carries a target kind and source-cited legacy evidence", () => {
  for (const se of c.sideEffects) {
    assert.ok(["vistaWrite", "notification", "external"].includes(se.targetKind), se.id + " targetKind");
    assert.ok(Array.isArray(se.legacyEvidence) && se.legacyEvidence.length > 0, se.id + " evidence");
    for (const e of se.legacyEvidence) assert.ok(e.routine && e.line && e.says, se.id + " evidence entry");
  }
});

test("side effects that write VistA files declare the file", () => {
  const w = Object.fromEntries(c.sideEffects.filter(s => s.writes).map(s => [s.id, String(s.writes.file)]));
  assert.deepEqual(w, { "SIDE.WorkOrder": "6920", "SIDE.PMSchedule": "6914.04", "SIDE.FinancialAsset": "6915.2" });
});

test("no legacy evidence mentions a dollar threshold", () => {
  assert.doesNotMatch(JSON.stringify(c.sideEffects), /50,?000/);
});

test("the serial guidance states the canonical key as ASKSER builds it", () => {
  const serial = c.data.find(d => d.id === "FLD.serial");
  assert.match(serial.legacyInput, /one trailing space appended, cut to 30 characters/);
  assert.doesNotMatch(serial.legacyInput, /UPPERCASE/);
});

test("discovery marks only the bulletin as called unconditionally, citing the call sites", () => {
  const inv = Object.fromEntries(c.sideEffects.map(s => [s.id, s.legacyInvocation]));
  assert.deepEqual(inv, { "SIDE.WorkOrder": "conditional", "SIDE.PMSchedule": "conditional", "SIDE.FinancialAsset": "conditional", "SIDE.Bulletin": "unconditional" });
  const b = c.sideEffects.find(s => s.id === "SIDE.Bulletin");
  assert.ok(b.legacyEvidence.some(e => e.routine === "ENEQ1" && /D BULL\^ENEQ3/.test(e.says)));
  assert.ok(b.legacyEvidence.some(e => e.routine === "ENEQ3" && /EQMAS/.test(e.line)));
});

test("the bulletin carries the legacy message template from BULLETIN file 3.6", () => {
  const t = c.sideEffects.find(s => s.id === "SIDE.Bulletin").messageTemplate;
  assert.equal(t.subject, "NEW EQUIPMENT: ENTRY #|1|");
  assert.equal(t.sender, "AEMS/MERS");
  assert.equal(t.body.length, 9);
  assert.equal(t.body[8], "|7|");
  assert.deepEqual(t.params.map(p => p.n), [1, 2, 3, 4, 5, 6, 7]);
  assert.equal(t.params.find(p => p.n === 7).dependsOn, "SIDE.FinancialAsset");
  assert.equal(t.params.find(p => p.n === 2).dependsOn, "operatorIdentity");
  assert.match(t.recipients, /CLICKAAH/);
});

test("each bulletin placeholder says where its value comes from, so the production can fill it", () => {
  const p = n => c.sideEffects.find(s => s.id === "SIDE.Bulletin").messageTemplate.params.find(x => x.n === n);
  assert.equal(p(1).source, "ien");
  assert.equal(p(2).source, "operatorIdentity");
  assert.deepEqual([p(3).field, p(4).field, p(5).field, p(6).field], ["3", "6", "21", "60"]);
  assert.deepEqual([p(4).pointer, p(5).pointer], [true, true]);
  assert.deepEqual(p(7).capitalizedNX, [{ field: "7", equals: "NX" }, { field: "34", equals: "1" }]);
  assert.deepEqual(p(7).text, { capitalized: "Item is capitalized NX.", notCapitalized: "Item is NOT capitalized NX.", reported: "It was reported to FAP.", notReported: "It was NOT reported to FAP." });
});

test("the implemented-services file has the expected shape", () => {
  // Phase 1 service ids live in the module, not the file (which starts empty after a reset)
  assert.deepEqual(PHASE1_SERVICES.map(s => s.id), ["write:6914", "read:next-ien", "read:lookup"]);
  const im = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "implemented.json"), "utf8"));
  assert.equal(typeof im.orchestrator.built, "boolean");   // the production build sets these
  assert.equal(typeof im.orchestrator.verified, "boolean");
});
