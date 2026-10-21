"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { normalize, loadRecord, saveRecord, diffRecords } = require("../lib/record");

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "rec-"));

test("normalize moves the legacy integration map into targets and fills every section", () => {
  const r = normalize({ dec: { a: 1 }, integration: { "SIDE.PMSchedule": { system: "Jira" } } });
  assert.deepEqual(r, { dec: { a: 1 }, oqPolicy: {}, scope: {}, targets: { "SIDE.PMSchedule": { system: "Jira" } }, ruleBindings: {}, aiQuestions: {} });
});

test("loadRecord falls back when the file is missing", () => {
  const r = loadRecord(path.join(tmp(), "missing.json"), () => ({ dec: { x: "Defer" } }));
  assert.equal(r.dec.x, "Defer");
  assert.deepEqual(r.targets, {});
});

test("loadRecord backs up an unreadable record before falling back", () => {
  const dir = tmp(); const f = path.join(dir, "decisions.json");
  fs.writeFileSync(f, "{not json");
  const r = loadRecord(f, () => ({ dec: { x: "Defer" } }));
  assert.equal(r.dec.x, "Defer");
  const bak = fs.readdirSync(dir).find(n => /^decisions\.corrupt-.*\.json$/.test(n));
  assert.ok(bak, "backup file written");
  assert.equal(fs.readFileSync(path.join(dir, bak), "utf8"), "{not json");
});

test("saveRecord replaces the file atomically and leaves no temp file", () => {
  const dir = tmp(); const f = path.join(dir, "decisions.json");
  fs.writeFileSync(f, "{\"dec\":{}}");
  saveRecord(f, normalize({ dec: { y: "Include" } }));
  assert.equal(JSON.parse(fs.readFileSync(f, "utf8")).dec.y, "Include");
  assert.deepEqual(fs.readdirSync(dir), ["decisions.json"]);
});

test("diffRecords lists exactly what changed, per field and per target key", () => {
  const before = normalize({ dec: { "OQ.A": "Defer", "SIDE.B": "Event" }, targets: { "SIDE.B": { via: "iris" } } });
  const after = normalize({
    dec: { "OQ.A": "Business rule", "SIDE.B": "Event" }, oqPolicy: { "OQ.A": "rule text" },
    targets: { "SIDE.B": { via: "iris", channel: "email" } }, ruleBindings: { "OQ.A": { cost: "12" } },
  });
  assert.deepEqual(diffRecords(before, after, id => "L:" + id), [
    { id: "OQ.A", label: "L:OQ.A", field: "dec", before: "Defer", after: "Business rule" },
    { id: "OQ.A", label: "L:OQ.A", field: "oqPolicy", before: null, after: "rule text" },
    { id: "OQ.A", label: "L:OQ.A", field: "ruleBindings.cost", before: null, after: "12" },
    { id: "SIDE.B", label: "L:SIDE.B", field: "targets.channel", before: null, after: "email" },
  ]);
  assert.deepEqual(diffRecords(after, after), []);
});

test("diffRecords shows an empty binding map as an explicit change", () => {
  const d = diffRecords(normalize({}), normalize({ ruleBindings: { "OQ.A": {} } }));
  assert.deepEqual(d, [{ id: "OQ.A", label: "OQ.A", field: "ruleBindings.(none)", before: null, after: "(none)" }]);
});

test("diffRecords reports aiQuestions.keep, aiQuestions.wording, aiQuestions.params.<key> per id", () => {
  const before = normalize({});
  const after  = normalize({ aiQuestions: { "AIQ.HighValueNoContract": { keep: true, wording: "High-value check", params: { threshold: 50000, valueColumn: "TOTAL_ASSET_VALUE" } } } });
  const diffs  = diffRecords(before, after, id => "L:" + id);
  // keep change
  assert.ok(diffs.some(d => d.id === "AIQ.HighValueNoContract" && d.field === "aiQuestions.keep" && d.after === true), "keep diff present");
  // wording change
  assert.ok(diffs.some(d => d.id === "AIQ.HighValueNoContract" && d.field === "aiQuestions.wording"), "wording diff present");
  // params.threshold change
  assert.ok(diffs.some(d => d.id === "AIQ.HighValueNoContract" && d.field === "aiQuestions.params.threshold" && d.after === 50000), "params.threshold diff present");
  // params.valueColumn change
  assert.ok(diffs.some(d => d.id === "AIQ.HighValueNoContract" && d.field === "aiQuestions.params.valueColumn"), "params.valueColumn diff present");
});
