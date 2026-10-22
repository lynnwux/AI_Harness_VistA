"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { teardownAll, STATUS_FILE } = require("../teardown-runner");
const { irisTeardownScript, parseIrisTeardown } = require("../lib/teardown");
const { REST_TEARDOWN_CLASSES } = require("../lib/rest-service");

const ENV = { IRIS_AI_HUB_PASSWORD: "fake-hub-pass-789", VADEMO_PASSWORD: "fake-vademo-pass-123" };
const IRIS_ALL_ABSENT = parseIrisTeardown("").map(r => r.item + ":absent").join("\n") + "\n";
const VADEMO_ITEMS = ["web app /Harness/Equipment", ...REST_TEARDOWN_CLASSES.map(c => "class " + c)];
// a VADEMO where nothing of the harness exists any more
const emptyVademo = () => ({ putClass: async () => {}, compile: async () => {}, query: async () => [{ r: "absent: /Harness/Equipment" }], deleteClass: async () => "absent" });

function world() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tdr-"));
  return { statusFile: path.join(dir, "teardown-status.json"), cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test("the teardown status file is agent/teardown-status.json", () => {
  assert.equal(STATUS_FILE, path.join(__dirname, "..", "teardown-status.json"));
});

test("teardown with VADEMO down still tears down IRIS and reports both", async () => {
  const w = world();
  const sessions = [];
  try {
    const s = await teardownAll({
      statusFile: w.statusFile, env: ENV,
      vademoImpl: () => { throw new Error("VADEMO connection not configured — set VADEMO_URL, VADEMO_USER and VADEMO_PASSWORD (see agent/.env.example)"); },
      irisSessionImpl: (container, script, opts) => { sessions.push({ container, script, opts }); return IRIS_ALL_ABSENT; },
    });
    const vademo = s.results.filter(r => r.where === "VADEMO");
    assert.deepEqual(vademo.map(r => r.item), VADEMO_ITEMS);
    assert.ok(vademo.every(r => /^failed: VADEMO connection not configured/.test(r.outcome)), JSON.stringify(vademo));
    assert.equal(sessions.length, 1, "the IRIS script still ran");
    assert.equal(sessions[0].container, "iris-ai-hub");
    assert.equal(sessions[0].script, irisTeardownScript());
    assert.ok(s.results.filter(r => r.where === "IRIS").every(r => r.outcome === "absent"));
    assert.equal(s.state, "error");
    for (const item of VADEMO_ITEMS) assert.ok(s.error.includes(item), item);
    assert.deepEqual(JSON.parse(fs.readFileSync(w.statusFile, "utf8")), s, "the status file holds the final status");
  } finally { w.cleanup(); }
});

test("an IRIS failure is one failed result per IRIS item, with no secret anywhere", async () => {
  const w = world();
  try {
    const s = await teardownAll({
      statusFile: w.statusFile, env: ENV, vademoImpl: emptyVademo,
      irisSessionImpl: () => { throw new Error("iris session failed (exit 1): login fake-hub-pass-789 refused"); },
    });
    const iris = s.results.filter(r => r.where === "IRIS");
    assert.deepEqual(iris.map(r => r.item), parseIrisTeardown("").map(r => r.item));
    assert.ok(iris.every(r => r.outcome === "failed: iris session failed (exit 1): login *** refused"), JSON.stringify(iris));
    assert.ok(s.results.filter(r => r.where === "VADEMO").every(r => r.outcome === "absent"));
    assert.equal(s.state, "error");
    assert.ok(!fs.readFileSync(w.statusFile, "utf8").includes("fake-hub-pass-789"));
  } finally { w.cleanup(); }
});

test("teardown of an empty world is done", async () => {
  const w = world();
  try {
    const s = await teardownAll({ statusFile: w.statusFile, env: ENV, vademoImpl: emptyVademo, irisSessionImpl: () => IRIS_ALL_ABSENT });
    assert.equal(s.state, "done", s.error);
    assert.equal(s.error, null);
    assert.deepEqual(s.results.filter(r => r.where === "VADEMO").map(r => r.item), VADEMO_ITEMS);
    assert.ok(s.results.every(r => r.outcome === "absent"), JSON.stringify(s.results));
    assert.ok(s.log.some(l => l.includes("✅")));
  } finally { w.cleanup(); }
});
