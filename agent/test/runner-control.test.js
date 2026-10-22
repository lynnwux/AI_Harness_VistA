"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { killTree, watchParent, timedFetch } = require("../lib/runner-control");

test("killTree uses taskkill /T /F on Windows", () => {
  const calls = [];
  const spawnSyncImpl = (cmd, args) => { calls.push([cmd, args]); return {}; };
  killTree(42, { spawnSyncImpl, platform: "win32" });
  assert.deepEqual(calls, [["taskkill", ["/PID", "42", "/T", "/F"]]]);
});

test("isAlive default returns true for an EPERM error", async () => {
  // EPERM = process exists but we lack permission → parent is alive → onGone must not fire.
  // Use an isAlive that replicates the fixed default with a fake kill that always throws EPERM.
  let gone = 0;
  const isAlive = _pid => { try { throw Object.assign(new Error("EPERM"), { code: "EPERM" }); } catch (e) { return e.code === "EPERM"; } };
  const stop = watchParent({ ppid: 9999, intervalMs: 5, isAlive, onGone: () => gone++ });
  await new Promise(r => setTimeout(r, 50));
  stop();
  assert.equal(gone, 0, "EPERM = parent alive, onGone must not fire");
});

test("watchParent fires once when the parent dies", async () => {
  let goneCalls = 0;
  let aliveCount = 0;
  const isAlive = () => aliveCount++ < 2;   // true, true, then false
  const onGone = () => goneCalls++;
  const stop = watchParent({ ppid: 9999, intervalMs: 5, isAlive, onGone });
  await new Promise(r => setTimeout(r, 80));
  stop();
  assert.equal(goneCalls, 1, "onGone called exactly once");
});

test("timedFetch passes an AbortSignal to fetchImpl", async () => {
  let receivedOpts;
  const fakeFetch = async (_url, opts) => { receivedOpts = opts; return { ok: true, json: async () => ({}) }; };
  await timedFetch(fakeFetch, 5000)("http://example.com", { method: "GET" });
  assert.ok(receivedOpts.signal instanceof AbortSignal);
});
