"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { graph, rec } = require("./helpers");
const { syncNotes, ungroundedChanges, revertChanges, READ_ONLY_MSG } = require("../lib/record-sync");
const { diffRecords } = require("../lib/record");

test("#5 a refused recording is reported verbatim under the reply", () => {
  const notes = syncNotes({ reply: "All set.", recorded: [], toolTrace: [
    { name: "setQuickQuestion", input: { id: "AIQ.HighValueNoContract" }, result: { ok: false, message: "refused: threshold must be ≥ 0" } },
    { name: "getState", input: {}, result: { stage: {} } },
  ] });
  assert.ok(notes.some(n => n.text === "⚠ Not recorded: setQuickQuestion AIQ.HighValueNoContract — refused: threshold must be ≥ 0"), JSON.stringify(notes));
});

test("#4 a reply that claims a recording when nothing changed gets 'Nothing was recorded'", () => {
  for (const reply of ["Done — I've recorded Required input for the work order.", "Recorded. The policy is now set.", "I have updated the wording.", "**Saved** the recipients."]) {
    const notes = syncNotes({ reply, recorded: [], toolTrace: [] });
    assert.ok(notes.some(n => n.check === "claim-without-change"), reply);
  }
});

test("#4 no false alarm: questions, plans and 'not recorded yet' are not claims; a claim with a change is fine", () => {
  for (const reply of ["What would you like me to record?", "Nothing is recorded yet for this item.", "Should I record Required input now?", "I'll record it once you confirm."]) {
    assert.deepEqual(syncNotes({ reply, recorded: [], toolTrace: [] }), [], reply);
  }
  assert.deepEqual(syncNotes({ reply: "Recorded.", recorded: [{ id: "OQ.WorkOrderPolicy" }], toolTrace: [] }), []);
});

test("the retry's own read-only refusals are internal and never reported", () => {
  const notes = syncNotes({ reply: "Here is the corrected reply.", recorded: [], toolTrace: [{ name: "resolveOpenQuestion", input: { id: "OQ.X" }, result: { ok: false, message: READ_ONLY_MSG } }] });
  assert.deepEqual(notes, []);
});

test("#3 a recorded value with a threshold found in neither the developer's words, the old value nor the item's evidence is ungrounded", () => {
  const before = rec();
  const after = rec({ dec: { "OQ.WorkOrderPolicy": "Business rule" }, oqPolicy: { "OQ.WorkOrderPolicy": "create one when the value is above $88,888" } });
  const changes = diffRecords(before, after);
  const bad = ungroundedChanges({ changes, before, graph, userMessage: "make it a business rule: create one for expensive items" });
  assert.deepEqual(bad.map(c => [c.id, c.field, c.thresholds]), [["OQ.WorkOrderPolicy", "oqPolicy", ["$88,888"]]]);
  // the same value is fine when the developer said the amount
  assert.deepEqual(ungroundedChanges({ changes, before, graph, userMessage: "create one when the value is above $88,888" }), []);
});

test("revertChanges puts back exactly the listed leaves and nothing else", () => {
  const before = rec();
  const after = rec({ dec: { "OQ.WorkOrderPolicy": "Business rule" }, oqPolicy: { "OQ.WorkOrderPolicy": "above $88,888" } });
  const bad = diffRecords(before, after).filter(c => c.field === "oqPolicy");
  revertChanges(after, before, bad);
  assert.equal(after.dec["OQ.WorkOrderPolicy"], "Business rule", "the disposition stays");
  assert.equal(after.oqPolicy["OQ.WorkOrderPolicy"], undefined, "the ungrounded policy is gone");
});

test("#11 a change to an item the turn wasn't about is pointed out (a side effect of the asked item is not)", () => {
  const { unaskedChanges } = require("../lib/record-sync");
  const before = rec();
  const after = rec({ dec: { "OQ.FAConfirmation": "Business rule" }, oqPolicy: { "OQ.FAConfirmation": "report capitalized items", "OQ.PMEnrollmentPolicy": "enroll when value > $50,000" }, scope: { "SIDE.FinancialAsset": "Build now" } });
  const changes = diffRecords(before, after);
  const extra = unaskedChanges({ changes, askedIds: ["OQ.FAConfirmation"], graph });
  assert.deepEqual(extra.map(c => c.id), ["OQ.PMEnrollmentPolicy"]);
  assert.deepEqual(unaskedChanges({ changes, askedIds: ["OQ.FAConfirmation", "OQ.PMEnrollmentPolicy"], graph }), []);
});

test("a recorded value's threshold matches by amount too", () => {
  const before = rec();
  const after = rec({ oqPolicy: { "OQ.PMEnrollmentPolicy": "enroll when value > $50,000" } });
  assert.deepEqual(ungroundedChanges({ changes: diffRecords(before, after), before, graph, userMessage: "business rule when the value is >$50000" }), []);
});

test("a claim is not contradicted when a recording tool succeeded, even if the value was already set", () => {
  const notes = syncNotes({ reply: "Done. Now the third parameter.", recorded: [], toolTrace: [{ name: "setQuickQuestion", input: { id: "AIQ.HighValueNoContract" }, result: { ok: true } }] });
  assert.deepEqual(notes, []);
});
