"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { rec, se } = require("./helpers");
const R = require("../lib/rules");

test("an untouched question blocks; a recorded Defer reason does not; an empty policy blocks", () => {
  assert.equal(R.isBlocking(rec(), "OQ.PMEnrollmentPolicy"), true);
  assert.equal(R.isBlocking(rec({ oqPolicy: { "OQ.PMEnrollmentPolicy": "Deferred — later phase" } }), "OQ.PMEnrollmentPolicy"), false);
  assert.equal(R.isBlocking(rec({ dec: { "OQ.WorkOrderPolicy": "Business rule" }, oqPolicy: { "OQ.WorkOrderPolicy": "  " } }), "OQ.WorkOrderPolicy"), true);
});

test("a side effect is built only once its gating question is decided with a non-Defer mode", () => {
  assert.equal(R.isBuilt(se("SIDE.WorkOrder"), rec()), false);
  assert.equal(R.isBuilt(se("SIDE.WorkOrder"), rec({ dec: { "OQ.WorkOrderPolicy": "Business rule" }, oqPolicy: { "OQ.WorkOrderPolicy": "always" } })), true);
  assert.equal(R.isBuilt(se("SIDE.WorkOrder"), rec({ oqPolicy: { "OQ.WorkOrderPolicy": "later" } })), false);
});

test("the mandatory bulletin is always built unless dropped", () => {
  assert.equal(R.isBuilt(se("SIDE.Bulletin"), rec({ scope: { "SIDE.Bulletin": "Defer" } })), true);
  assert.equal(R.isBuilt(se("SIDE.Bulletin"), rec({ dec: { "SIDE.Bulletin": "Drop" } })), false);
});

test("target keys follow the graph's targetKind, or the external set when the disposition is Integration", () => {
  assert.deepEqual(R.requiredTargetKeys(se("SIDE.Bulletin"), rec()), ["via", "channel", "recipients", "content"]);
  assert.deepEqual(R.requiredTargetKeys(se("SIDE.WorkOrder"), rec()), ["via", "writePath", "fields", "operatorValues"]);
  const asIntegration = rec({ dec: { "SIDE.PMSchedule": "Integration" } });
  assert.deepEqual(R.requiredTargetKeys(se("SIDE.PMSchedule"), asIntegration), ["via", "system", "endpoint", "trigger", "mapping"]);
  assert.ok(R.allowedTargetKeys(se("SIDE.PMSchedule"), asIntegration).includes("settings"));
  assert.equal(R.describeKey(se("SIDE.Bulletin"), rec(), "via"), "where the work is performed (vista | iris | external)");
});
