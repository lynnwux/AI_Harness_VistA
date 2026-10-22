"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { saveKnownGood } = require("../lib/known-good");
const { restoreAll, STATUS_FILE } = require("../restore-runner");

const tmp = p => fs.mkdtempSync(path.join(os.tmpdir(), p));
const files = (dir, map) => { for (const [f, t] of Object.entries(map)) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), t); } return dir; };
const ENV = {
  IRIS_AI_HUB_URL: "http://localhost:9999", IRIS_AI_HUB_USER: "u", IRIS_AI_HUB_PASSWORD: "fake-hub-pass-789",
  VADEMO_URL: "http://vademo:80", VADEMO_USER: "v", VADEMO_PASSWORD: "fake-vademo-pass-123", AWS_BEARER_TOKEN_BEDROCK: "fake-bedrock-tok-456",
};

function world({ copies = ["api", "orchestrator", "ai"], compileErrorFor = null } = {}) {
  const root = tmp("kgr-"), out = tmp("kgo-"), scripts = tmp("kgs-");
  fs.mkdirSync(path.join(scripts, "lib")); fs.writeFileSync(path.join(scripts, "lib", "iris.py"), "# fake");
  const sources = [];
  if (copies.includes("api")) saveKnownGood("api", { dirs: { site: files(tmp("s-"), { "index.html": "form v1" }) } }, root);
  if (copies.includes("orchestrator")) saveKnownGood("orchestrator", { dirs: { classes: files(tmp("s-"), { "EquipmentEntry.Production.cls": "x", "EquipmentEntry.BS.RegisterService.cls": "y" }) }, meta: { container: "iris-ai-hub", namespace: "INTEROP" } }, root);
  if (copies.includes("ai")) saveKnownGood("ai", { dirs: { classes: files(tmp("s-"), { "EquipmentAI.Agent.cls": "a" }), chat: files(tmp("s-"), { "index.html": "chat v1" }) }, meta: { container: "iris-ai-hub", namespace: "INTEROP" } }, root);
  const calls = [];
  const irisScriptImpl = () => (method, p, extra = []) => {
    calls.push(`${method} ${p}`);
    if (method === "POST" && /compile/.test(p)) {
      const names = JSON.parse(extra[extra.indexOf("--body") + 1]);
      return { console: compileErrorFor && names.some(n => n.startsWith(compileErrorFor)) ? ["ERROR #5002: fake-hub-pass-789 broke"] : [] };
    }
    return "ok";
  };
  const sessions = [];
  const irisSessionImpl = (container, script) => {
    sessions.push(script);
    return /StartProduction/.test(script) ? "WEBAPP:exists\nSTART:ok\nSTATE:EquipmentEntry.Production:1\n" : "WEBAPP:exists\nCONFIG:set\nVADEMO:stored\nBEDROCK:stored\nSESSIONS:cleared 0\n";
  };
  const opts = { root, statusFile: path.join(out, "restore-status.json"), configFile: path.join(out, "servers.json"),
                 apiOut: path.join(out, "build"), chatOut: path.join(out, "chat"), env: { ...ENV, INTERCLAW_SCRIPTS: scripts }, irisScriptImpl, irisSessionImpl };
  return { opts, calls, sessions, cleanup: () => [root, out, scripts].forEach(d => fs.rmSync(d, { recursive: true, force: true })) };
}

test("restore last good puts back all three deliverables from their copies", async () => {
  const w = world();
  try {
    const s = await restoreAll(w.opts);
    assert.equal(s.state, "done", s.error);
    assert.deepEqual(s.results.map(r => [r.layer, r.outcome]), [["api", "restored"], ["orchestrator", "restored"], ["ai", "restored"]]);
    assert.equal(fs.readFileSync(path.join(w.opts.apiOut, "index.html"), "utf8"), "form v1");
    assert.equal(fs.readFileSync(path.join(w.opts.chatOut, "index.html"), "utf8"), "chat v1");
    assert.ok(w.calls.includes("PUT /v2/INTEROP/doc/EquipmentEntry.Production.cls?ignoreConflict=1"));
    assert.ok(w.calls.includes("PUT /v2/INTEROP/doc/EquipmentAI.Agent.cls?ignoreConflict=1"));
    assert.ok(w.sessions.some(x => /StartProduction\("EquipmentEntry\.Production"\)/.test(x)), "the production is restarted");
    assert.ok(w.sessions.some(x => /kill \^EquipmentAI\.Sessions/.test(x)), "the AI settings are re-applied and conversations cleared");
    assert.deepEqual(JSON.parse(fs.readFileSync(w.opts.statusFile, "utf8")).results.length, 3);
  } finally { w.cleanup(); }
});

test("a deliverable with no good copy yet is reported, not an error", async () => {
  const w = world({ copies: ["api"] });
  try {
    const s = await restoreAll(w.opts);
    assert.equal(s.state, "done");
    assert.deepEqual(s.results.map(r => r.outcome), ["restored", "no good copy yet", "no good copy yet"]);
    assert.equal(w.calls.length, 0, "IRIS is not touched when there is nothing to restore there");
  } finally { w.cleanup(); }
});

test("one deliverable failing doesn't stop the others; the failure is named and no secret is shown", async () => {
  const w = world({ compileErrorFor: "EquipmentEntry" });
  try {
    const s = await restoreAll(w.opts);
    assert.equal(s.state, "error");
    const orch = s.results.find(r => r.layer === "orchestrator");
    assert.match(orch.outcome, /^failed: .*compile/);
    assert.equal(s.results.find(r => r.layer === "ai").outcome, "restored");
    assert.equal(s.results.find(r => r.layer === "api").outcome, "restored");
    assert.doesNotMatch(fs.readFileSync(w.opts.statusFile, "utf8"), /fake-hub-pass-789|fake-vademo-pass-123|fake-bedrock-tok-456/);
  } finally { w.cleanup(); }
});

test("the real status file path is agent/restore-status.json (git-ignored)", () => {
  assert.equal(path.basename(STATUS_FILE), "restore-status.json");
});
