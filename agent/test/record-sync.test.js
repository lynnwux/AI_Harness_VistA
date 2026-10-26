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
