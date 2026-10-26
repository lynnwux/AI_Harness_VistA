"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { runPreflight, formatReport } = require("../lib/preflight");

const ENV = {
  VADEMO_URL: "http://vademo", VADEMO_USER: "u", VADEMO_PASSWORD: "fake-vademo-pass-123",
  IRIS_AI_HUB_URL: "http://localhost:9092", IRIS_AI_HUB_USER: "u", IRIS_AI_HUB_PASSWORD: "fake-hub-pass-456",
  INTERCLAW_SCRIPTS: "C:/interclaw/scripts", AWS_BEARER_TOKEN_BEDROCK: "fake-bedrock-tok-789",
};
const idle = { state: "idle" };
// A world where everything is ready; each test breaks one thing.
function world(over = {}) {
  const statuses = { "/api/build/status": { state: "done" }, "/api/build/production/status": idle, "/api/build/ai/status": idle, "/api/restore/status": idle, "/api/demo/reset/status": { state: "done" }, ...(over.statuses || {}) };
  const fetchImpl = async url => {
    if (over.workbenchDown && url.startsWith("http://localhost:8899")) throw new Error("connect ECONNREFUSED");
    if (url.endsWith("/api/specs")) return { ok: true, status: 200, json: async () => ({ stage: { layer: "api", step: "build" } }) };
    const key = Object.keys(statuses).find(k => url.endsWith(k));
    if (key) return { ok: true, status: 200, json: async () => statuses[key] };
    if (url.startsWith(ENV.IRIS_AI_HUB_URL)) { if (over.hubDown) throw new Error("connect ECONNREFUSED"); return { ok: true, status: 200 }; }
    throw new Error("unexpected url " + url);
  };
  const spawnSyncImpl = (cmd, args) => {
    const a = args.join(" ");
    if (a.startsWith("info")) return over.dockerDown ? { status: 1, stderr: "open //./pipe/dockerDesktopLinuxEngine: The system cannot find the file specified." } : { status: 0, stdout: "27.3.1" };
    if (a.startsWith("inspect")) return { status: 0, stdout: over.container || "running healthy" };
    if (a.startsWith("exec")) return over.irisDown ? { status: 1, stderr: "Error: No such container" } : { status: 0, stdout: "PREFLIGHT:ok\n" };
    throw new Error("unexpected command " + cmd + " " + a);
  };
  const vademo = () => ({ query: async () => { if (over.vademo404) throw new Error("query error: VADEMO answered HTTP 404 (not JSON)"); return [{ n: 305 }]; } });
  return { env: { ...ENV, ...(over.env || {}) }, fetchImpl, spawnSyncImpl, vademoImpl: vademo, fileExists: () => !over.noIrisPy };
}
const byName = rs => Object.fromEntries(rs.map(r => [r.name, r]));

test("everything ready: every check passes and the report says READY", async () => {
  const rs = await runPreflight(world());
  assert.deepEqual(rs.filter(r => r.status !== "pass").map(r => r.name), []);
  assert.equal(byName(rs)["VADEMO (VistA)"].detail, "VISTA-DIEGO answers — 305 records in file 6914");
  assert.match(formatReport(rs), /READY — nothing blocks a reset or a build/);
});

test("Docker Desktop not running: Docker, the container and IRIS fail, with the fix", async () => {
  const rs = byName(await runPreflight(world({ dockerDown: true })));
  assert.equal(rs["Docker"].status, "fail");
  assert.match(rs["Docker"].fix, /Start Docker Desktop/);
  assert.equal(rs["iris-ai-hub container"].status, "skip");
  assert.equal(rs["IRIS session"].status, "skip");
});

test("VADEMO's Atelier answering 404 fails with the path setting named", async () => {
  const r = byName(await runPreflight(world({ vademo404: true })))["VADEMO (VistA)"];
  assert.equal(r.status, "fail");
  assert.match(r.fix, /VADEMO_ATELIER_PATH/);
  assert.match(r.fix, /\/irishealth\/api\/atelier/);
});

test("a build or reset still running blocks: 'wait for it or stop it'", async () => {
  const r = byName(await runPreflight(world({ statuses: { "/api/build/production/status": { state: "building", step: "Compiling" } } })))["Nothing running"];
  assert.equal(r.status, "fail");
  assert.match(r.detail, /production build is building/);
});

test("the workbench server down fails, and the run check is skipped rather than guessed", async () => {
  const rs = byName(await runPreflight(world({ workbenchDown: true })));
  assert.equal(rs["Workbench server"].status, "fail");
  assert.match(rs["Workbench server"].fix, /npm start/);
  assert.equal(rs["Nothing running"].status, "skip");
});

test("missing settings fail; a missing Bedrock token only warns; an unhealthy container fails", async () => {
  const rs = byName(await runPreflight(world({ env: { VADEMO_PASSWORD: "", AWS_BEARER_TOKEN_BEDROCK: "" }, noIrisPy: true, container: "running unhealthy" })));
  assert.equal(rs["Settings (agent/.env)"].status, "fail");
  assert.match(rs["Settings (agent/.env)"].detail, /VADEMO_PASSWORD/);
  assert.match(rs["Settings (agent/.env)"].detail, /iris\.py/);
  assert.equal(rs["Bedrock token"].status, "warn");
  // running but unhealthy (IRIS in alert state) only warns: the IRIS session check decides
  assert.equal(rs["iris-ai-hub container"].status, "warn");
  assert.match(rs["iris-ai-hub container"].fix, /alert/);
  assert.equal(rs["IRIS session"].status, "pass");
  assert.match(formatReport(Object.values(rs)), /NOT READY — \d+ problems?/);
});

test("a stopped container fails and skips the IRIS session", async () => {
  const rs = byName(await runPreflight(world({ container: "exited" })));
  assert.equal(rs["iris-ai-hub container"].status, "fail");
  assert.equal(rs["IRIS session"].status, "skip");
});

test("the report never prints a secret", async () => {
  const w = world({ vademo404: true });
  const text = formatReport(await runPreflight(w));
  for (const k of ["VADEMO_PASSWORD", "IRIS_AI_HUB_PASSWORD", "AWS_BEARER_TOKEN_BEDROCK"]) assert.ok(!text.includes(w.env[k]), k);
});
