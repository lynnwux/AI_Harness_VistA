"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { graph, rec, IM } = require("./helpers");
const { generate } = require("../lib/specs");
const {
  COLUMN, TEST_VALUES, STORED_YESNO,
  runIdOf, testSerial, fmDate, operatorFields,
  pickPointers, testRecord, expectedRow, compareRow, verifyWritePath,
} = require("../lib/api-verify");

const inputs = (record, implemented = IM) => ({ graph, record, implemented });

test("fmDate converts ISO to FileMan", () => {
  assert.equal(fmDate("2000-01-01"), "3000101");
  assert.equal(fmDate("2026-10-22"), "3261022");
});

test("the test record covers every included operator field with a unique serial", () => {
  const spec = generate(inputs(rec())).api;
  const runId = runIdOf(new Date("2026-10-22T15:30:00Z"));
  // build fake pointers for every pointer field
  const flds = operatorFields(spec);
  const fakePointers = Object.fromEntries(flds.filter(f => f.table).map(f => [f.k, "1"]));
  const payload = testRecord(spec, fakePointers, runId);
  assert.deepEqual(Object.keys(payload).sort(), Object.keys(COLUMN).sort());
  assert.equal(payload.serial, "HT-20261022153000");
});

test("omitted fields are neither posted nor compared", async () => {
  const omittedSpec = generate(inputs(rec({ dec: { "FLD.model": "Omit", "FLD.fund": "Omit" } }))).api;
  const flds = operatorFields(omittedSpec);
  const queriedTables = [];
  const fakeClient = {
    async query(sql) { const m = /FROM VISTA\.(\S+)/.exec(sql); if (m) queriedTables.push(m[1]); return [{ ien: "1" }]; },
    async rest() { return { status: 200, json: {} }; },
  };
  const pointers = await pickPointers(fakeClient, flds);
  const runId = "20261022000000";
  const payload = testRecord(omittedSpec, pointers, runId);
  const expRow = expectedRow(payload);

  assert.ok(!Object.keys(payload).includes("model"), "payload should not have model");
  assert.ok(!Object.keys(payload).includes("fund"), "payload should not have fund");
  assert.ok(!Object.keys(expRow).includes("MODEL"), "expectedRow should not have MODEL");
  assert.ok(!Object.keys(expRow).includes("FUND"), "expectedRow should not have FUND");
  assert.ok(!queriedTables.includes("NX_FUND6914_6"), "pickPointers should not query NX_FUND6914_6");
});

test("expectedRow maps form values to storage", () => {
  const spec = generate(inputs(rec())).api;
  const flds = operatorFields(spec);
  const pointers = Object.fromEntries(flds.filter(f => f.table).map(f => [f.k, "42"]));
  const payload = testRecord(spec, pointers, "20261022153000");
  const row = expectedRow(payload);

  assert.equal(row.JCAHO, "Y");                   // STORED_YESNO.jcaho.YES
  assert.equal(row.LOCKOUT_REQUIRED, "1");         // STORED_YESNO.lockoutRequired.YES
  assert.equal(row.ACQUISITION_DATE, "3000101");   // fmDate("2000-01-01")
  assert.equal(row.MANUFACTURER, "42");            // pointer → String
  assert.equal(row.ORIGINAL_ASSET_VALUE, "1");     // number → String
});

test("verifyWritePath posts, reads back and passes", async () => {
  const spec = generate(inputs(rec())).api;
  const runId = "20261022153000";
  // pre-compute the expected stored row so the fake query can return it
  const flds = operatorFields(spec);
  const fakePointers = Object.fromEntries(flds.filter(f => f.table).map(f => [f.k, "99"]));
  const payload = testRecord(spec, fakePointers, runId);
  const storedRow = expectedRow(payload);

  const restCalls = [];
  const client = {
    async query(sql) {
      if (/EQUIPMENT_INV_6914/.test(sql)) return [{ ...storedRow }];
      return [{ ien: "99" }];
    },
    async rest(method, p, body) {
      restCalls.push({ method, p });
      if (method === "GET" && p === "/NextIEN") return { status: 200, json: { status: "OK", ien: 12345 } };
      if (method === "POST") return { status: 200, json: { status: "OK", equipmentIEN: 12345, lifecycleStatus: "created" } };
      return { status: 200, json: {} };
    },
  };
  const result = await verifyWritePath(client, spec, { runId });
  assert.equal(result.ien, 12345);
  assert.equal(result.serial, "HT-20261022153000");
  assert.ok(!restCalls.some(c => c.method === "DELETE"), "must not DELETE the record");
});

test("verifyWritePath names every mismatch", async () => {
  const spec = generate(inputs(rec())).api;
  const runId = "20261022153000";
  const flds = operatorFields(spec);
  const fakePointers = Object.fromEntries(flds.filter(f => f.table).map(f => [f.k, "99"]));
  const payload = testRecord(spec, fakePointers, runId);
  const storedRow = { ...expectedRow(payload), MODEL: "" }; // MODEL is wrong

  const client = {
    async query(sql) {
      if (/EQUIPMENT_INV_6914/.test(sql)) return [{ ...storedRow }];
      return [{ ien: "99" }];
    },
    async rest(method, p) {
      if (method === "GET" && p === "/NextIEN") return { status: 200, json: { status: "OK", ien: 12345 } };
      if (method === "POST") return { status: 200, json: { status: "OK", equipmentIEN: 12345, lifecycleStatus: "created" } };
      return { status: 200, json: {} };
    },
  };
  await assert.rejects(
    () => verifyWritePath(client, spec, { runId }),
    /MODEL expected TEST-MODEL, stored /,
  );
});
