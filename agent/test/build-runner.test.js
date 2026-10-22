"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { graph } = require("./helpers");
const { generate, writeSpecs, designHash } = require("../lib/specs");
const { PHASE1_SERVICES, emptyImplemented, builtApi } = require("../lib/implemented");
const { REST_CLASSES } = require("../lib/rest-service");
const { operatorFields, testRecord, expectedRow, runIdOf } = require("../lib/api-verify");
const { readKnownGood } = require("../lib/known-good");
const { main, buildConfig, angularFiles, STATUS_FILE } = require("../build-runner");

const FIXED_DATE = new Date("2026-10-22T15:30:00Z");
const FIXED_RUN_ID = runIdOf(FIXED_DATE);
const POINTER_IEN = "99";
const EMPTY_RECORD = { dec: {}, oqPolicy: {}, scope: {}, targets: {}, ruleBindings: {}, aiQuestions: {} };

// Write a real api.json with an empty record so loadInputs(paths) with no decisions.json matches.
// implVal must match what will be in paths.implemented when the build runs the stale check.
function writeRealApi(specsDir, implVal = emptyImplemented()) {
  const inputs = { graph, record: EMPTY_RECORD, implemented: implVal };
  writeSpecs(specsDir, generate(inputs), inputs);
  return JSON.parse(fs.readFileSync(path.join(specsDir, "api.json"), "utf8"));
}

// Pre-compute the expected stored SQL row for the spec (all pointers = POINTER_IEN)
function precomputeStoredRow(apiSpec) {
  const flds = operatorFields(apiSpec);
  const ptrs = Object.fromEntries(flds.filter(f => f.table).map(f => [f.k, POINTER_IEN]));
  return expectedRow(testRecord(apiSpec, ptrs, FIXED_RUN_ID));
}

// Fake vademo: covers deployRestService + verifyWritePath
function fakeVademo({ failDeploy = false, failVerify = false, storedRow = {}, deployResult = "created", echoPasswordOnFail = "" } = {}) {
  const calls = [];
  return {
    calls,
    async putClass(n) { calls.push("put:" + n); if (failDeploy) throw new Error(echoPasswordOnFail ? "failed: " + echoPasswordOnFail : "compile failed"); },
    async compile() { if (failDeploy) throw new Error(echoPasswordOnFail ? "failed: " + echoPasswordOnFail : "compile failed"); },
    async query(sql) {
      calls.push("query");
      if (/CreateWebApp/.test(sql)) return [{ r: deployResult + ": /Harness/Equipment" }];
      if (/EQUIPMENT_INV_6914/.test(sql)) return [failVerify ? {} : storedRow];
      return [{ ien: POINTER_IEN }];  // pointer tables
    },
    async rest(method, p) {
      calls.push(method + " " + p);
      if (method === "GET" && p === "/NextIEN") return { status: 200, json: { status: "OK", ien: 1234 } };
      if (method === "POST") return { status: 200, json: { status: "OK", equipmentIEN: 1234 } };
      return { status: 200, json: {} };
    },
  };
}

// Fake Angular build: writes index.html to outDir and fires all four phase callbacks
async function fakeBuildApp({ outDir, onPhase } = {}) {
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "index.html"), "<html/>");
  if (onPhase) { ["scaffold", "generate", "build", "publish"].forEach(p => onPhase(p)); }
}

// Prepare a temp dir with graph copy, specsDir with real api.json, and implemented.json.
// The api.json is generated with the same implemented value so the stale check passes.
function setupCtx(opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "br-"));
  const implVal = opts.impl || emptyImplemented();
  const specsDir = path.join(dir, "specs");
  const apiSpec = writeRealApi(specsDir, implVal);
  const implPath = path.join(dir, "implemented.json");
  fs.writeFileSync(implPath, JSON.stringify(implVal));
  const graphCopy = path.join(dir, "graph.json");
  fs.copyFileSync(path.join(__dirname, "..", "..", "capability-graph", "new-inventory-entry.json"), graphCopy);
  const paths = { graph: graphCopy, decisions: path.join(dir, "decisions.json"), implemented: implPath, specsDir };
  const outDir = path.join(dir, "out");
  const workRoot = path.join(dir, "work");
  const knownGoodRoot = path.join(dir, "known-good");
  const statusFile = path.join(dir, "status.json");
  return { dir, paths, outDir, workRoot, knownGoodRoot, statusFile, apiSpec, storedRow: precomputeStoredRow(apiSpec) };
}

// ── backward-compat: existing exports must still exist ─────────────────────
test("buildConfig and angularFiles are still exported", () => {
  assert.equal(typeof buildConfig, "function");
  assert.equal(typeof angularFiles, "function");
  assert.equal(typeof STATUS_FILE, "string");
  assert.ok(STATUS_FILE.endsWith("build-status.json"));
});

// ── main() tests ────────────────────────────────────────────────────────────

test("a successful Phase 1 build deploys, verifies, publishes, then records", async () => {
  const ctx = setupCtx();
  const vademo = fakeVademo({ storedRow: ctx.storedRow });
  const st = await main({
    paths: ctx.paths, statusFile: ctx.statusFile, outDir: ctx.outDir,
    workRoot: ctx.workRoot, knownGoodRoot: ctx.knownGoodRoot,
    vademo, buildApp: fakeBuildApp, now: () => FIXED_DATE,
  });

  assert.equal(st.state, "done", "state should be done; error=" + (st.error || ""));
  assert.equal(st.url, "/prototype/build/");

  // implemented.json: api deep-equals builtApi with verifiedRecord and builtFrom
  const im = JSON.parse(fs.readFileSync(ctx.paths.implemented, "utf8"));
  const expApi = builtApi(PHASE1_SERVICES, {
    verifiedRecord: { ien: 1234, serial: "HT-" + FIXED_RUN_ID, at: FIXED_DATE.toISOString() },
    builtFrom: designHash(ctx.apiSpec),
  });
  assert.equal(im.api.built, expApi.built);
  assert.equal(im.api.verified, expApi.verified);
  assert.deepEqual(im.api.services, expApi.services);
  assert.equal(im.api.verifiedRecord.ien, expApi.verifiedRecord.ien);
  assert.equal(im.api.verifiedRecord.serial, expApi.verifiedRecord.serial);
  assert.match(im.api.verifiedRecord.at, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(im.api.builtFrom, expApi.builtFrom);

  // orchestrator / ai entries untouched (still emptyImplemented defaults)
  assert.deepEqual(im.orchestrator, emptyImplemented().orchestrator);
  assert.deepEqual(im.ai, emptyImplemented().ai);

  // known-good: dirs site and rest exist; rest has the three REST_CLASSES files
  const kg = readKnownGood("api", ctx.knownGoodRoot);
  assert.ok(kg, "known-good entry must be saved");
  assert.ok(fs.existsSync(path.join(kg.dirs.site, "index.html")), "site/index.html must exist");
  for (const cls of REST_CLASSES)
    assert.ok(fs.existsSync(path.join(kg.dirs.rest, cls)), "known-good/rest/" + cls);

  // verification rows in status
  const v = st.verification;
  assert.ok(Array.isArray(v) && v.length >= 5, "at least 5 verification rows");
  assert.ok(v.some(r => r.check === "REST service deployed"), JSON.stringify(v));
  assert.ok(v.some(r => /web app \/Harness\/Equipment/.test(r.check)), JSON.stringify(v));
  assert.ok(v.some(r => r.check === "GET next IEN"), JSON.stringify(v));
  assert.ok(v.some(r => /POST test record/.test(r.check)), JSON.stringify(v));
  assert.ok(v.some(r => /read back .+ fields over SQL/.test(r.check)), JSON.stringify(v));

  fs.rmSync(ctx.dir, { recursive: true, force: true });
});

test("the REST service fails before the Angular build starts", async () => {
  const ctx = setupCtx();
  let buildCalled = false;
  const badBuildApp = async () => { buildCalled = true; };
  const vademo = fakeVademo({ failDeploy: true });

  const st = await main({
    paths: ctx.paths, statusFile: ctx.statusFile, outDir: ctx.outDir,
    workRoot: ctx.workRoot, knownGoodRoot: ctx.knownGoodRoot,
    vademo, buildApp: badBuildApp, now: () => FIXED_DATE,
  });

  assert.equal(st.state, "error");
  assert.equal(buildCalled, false, "Angular build must not start when deploy fails");
  const im = JSON.parse(fs.readFileSync(ctx.paths.implemented, "utf8"));
  assert.equal(im.api.built, false, "implemented.api.built must be false after deploy failure");

  fs.rmSync(ctx.dir, { recursive: true, force: true });
});

test("a failed rebuild clears built", async () => {
  // start with api: builtApi() already in implemented.json
  const ctx = setupCtx({ impl: { api: builtApi(), orchestrator: { built: false, verified: false }, ai: { built: false, verified: false } } });
  const vademo = fakeVademo({ failVerify: true });

  const st = await main({
    paths: ctx.paths, statusFile: ctx.statusFile, outDir: ctx.outDir,
    workRoot: ctx.workRoot, knownGoodRoot: ctx.knownGoodRoot,
    vademo, buildApp: fakeBuildApp, now: () => FIXED_DATE,
  });

  assert.equal(st.state, "error");
  const im = JSON.parse(fs.readFileSync(ctx.paths.implemented, "utf8"));
  assert.deepEqual(im.api, emptyImplemented().api, "implemented.api must match emptyImplemented().api after a failed rebuild");

  fs.rmSync(ctx.dir, { recursive: true, force: true });
});

test("a stale spec changes nothing", async () => {
  const ctx = setupCtx();
  // tamper api.json so its inputs hash no longer matches current inputs
  const apiJsonPath = path.join(ctx.paths.specsDir, "api.json");
  const tampered = JSON.parse(fs.readFileSync(apiJsonPath, "utf8"));
  tampered.inputs.graph = "tampered-hash-000";
  fs.writeFileSync(apiJsonPath, JSON.stringify(tampered));

  const implBefore = fs.readFileSync(ctx.paths.implemented, "utf8");
  let vademoWasCalled = false;
  const vademo = {
    putClass: async () => { vademoWasCalled = true; },
    compile: async () => {}, query: async () => [], rest: async () => ({}),
  };

  const st = await main({
    paths: ctx.paths, statusFile: ctx.statusFile, outDir: ctx.outDir,
    workRoot: ctx.workRoot, knownGoodRoot: ctx.knownGoodRoot,
    vademo, buildApp: fakeBuildApp, now: () => FIXED_DATE,
  });

  assert.equal(st.state, "error");
  assert.match(st.error, /stale/);
  assert.equal(fs.readFileSync(ctx.paths.implemented, "utf8"), implBefore, "implemented.json must be byte-identical after a stale error");
  assert.equal(vademoWasCalled, false, "VADEMO must not be called when the spec is stale");

  fs.rmSync(ctx.dir, { recursive: true, force: true });
});

test("nothing secret in the status", async () => {
  const ctx = setupCtx();
  const password = "fake-vademo-pass-123";
  const vademo = fakeVademo({ failDeploy: true, echoPasswordOnFail: password });

  await main({
    paths: ctx.paths, statusFile: ctx.statusFile, outDir: ctx.outDir,
    workRoot: ctx.workRoot, knownGoodRoot: ctx.knownGoodRoot,
    env: { VADEMO_URL: "http://fake", VADEMO_USER: "user", VADEMO_PASSWORD: password },
    vademo, buildApp: fakeBuildApp, now: () => FIXED_DATE,
  });

  const statusText = fs.readFileSync(ctx.statusFile, "utf8");
  assert.ok(!statusText.includes(password), "password must not appear anywhere in the status file");

  fs.rmSync(ctx.dir, { recursive: true, force: true });
});
