"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");

test("the teardown script names only the harness's own things", () => {
  const { irisTeardownScript } = require("../lib/teardown");
  const s = irisTeardownScript();
  // Harness packages
  assert.match(s, /DeletePackage\("EquipmentEntry"/);
  assert.match(s, /DeletePackage\("EquipmentAI"/);
  // All three credentials
  assert.match(s, /EquipmentEntryBulletinSMTP/);
  assert.match(s, /EquipmentAIVademo/);
  assert.match(s, /EquipmentAIBedrock/);
  // Harness web apps
  assert.match(s, /\/equipmententry/);
  assert.match(s, /\/equipmentai/);
  // AI config global
  assert.match(s, /\^EquipmentAI\.Config/);
  // Must NOT purge every production's messages or delete framework packages
  assert.doesNotMatch(s, /DeletePackage\("Ens/);
  assert.doesNotMatch(s, /Purge\(/);
});

test("parseIrisTeardown treats absent as removed", () => {
  const { parseIrisTeardown } = require("../lib/teardown");

  // All markers with absent/0/not-running → every outcome is "absent"
  // ("AICONFIG:0" is an artificial parser case — the real script always writes "killed")
  const allAbsent = [
    "STOP:not running",
    "MESSAGES:0",
    "EVENTLOG:0",
    "SETTINGS:0",
    "AISESSIONS:0",
    "AICONFIG:0",
    "PKG:EquipmentEntry:absent",
    "PKG:EquipmentAI:absent",
    "CRED:EquipmentEntryBulletinSMTP:absent",
    "CRED:EquipmentAIVademo:absent",
    "CRED:EquipmentAIBedrock:absent",
    "WEBAPP:/equipmententry:absent",
    "WEBAPP:/equipmentai:absent",
  ].join("\n");
  const result = parseIrisTeardown(allAbsent);
  assert.ok(Array.isArray(result) && result.length > 0, "must return a non-empty array");
  const notAbsent = result.filter(r => r.outcome !== "absent");
  assert.deepEqual(notAbsent, [], `expected all absent; got: ${JSON.stringify(notAbsent)}`);

  // Empty output → every item "failed: no answer from IRIS"
  const noAnswer = parseIrisTeardown("");
  const notFailed = noAnswer.filter(r => r.outcome !== "failed: no answer from IRIS");
  assert.deepEqual(notFailed, [], `expected all no-answer; got: ${JSON.stringify(notFailed)}`);

  // WEBAPP:/equipmentai:ERROR #921 → that item "failed: ERROR #921"
  const errOut = "WEBAPP:/equipmentai:ERROR #921\n";
  const res = parseIrisTeardown(errOut);
  const webappAi = res.find(r => r.item === "WEBAPP:/equipmentai");
  assert.ok(webappAi, "WEBAPP:/equipmentai must be in the result");
  assert.equal(webappAi.outcome, "failed: ERROR #921");
});

test("the production and AI scripts update an existing web app", () => {
  const { sessionScript } = require("../production-runner");
  const { aiSettingsScript, checkSettingsMarkers } = require("../ai-runner");

  // sessionScript must contain the Modify branch
  const ss = sessionScript("INTEROP");
  assert.match(ss, /Security\.Applications\)\.Modify\(/);
  assert.match(ss, /WEBAPP:updated/);

  // aiSettingsScript must contain the Modify branch
  const as = aiSettingsScript({
    VADEMO_URL: "http://h:80",
    VADEMO_USER: "u",
    VADEMO_PASSWORD: "p",
    AWS_BEARER_TOKEN_BEDROCK: "t",
  });
  assert.match(as, /Security\.Applications\)\.Modify\(/);
  assert.match(as, /WEBAPP:updated/);

  // checkSettingsMarkers accepts "updated" as a valid WEBAPP outcome
  const out = "WEBAPP:updated\nCONFIG:set\nVADEMO:stored\nBEDROCK:stored\nSESSIONS:cleared 0\n";
  assert.deepEqual(checkSettingsMarkers(out), []);
});

test("the teardown script's SQL uses SQL quotes inside ObjectScript strings", () => {
  const { irisTeardownScript } = require("../lib/teardown");
  const s = irisTeardownScript();
  const execLines = s.split("\n").filter(l => l.includes("%ExecDirect("));
  assert.ok(execLines.length > 0, "must have at least one %ExecDirect line");

  // All three single-quoted SQL literals must appear across the ExecDirect lines
  const allExec = execLines.join("\n");
  assert.match(allExec, /'EquipmentEntry\.'/, "single-quoted package prefix 'EquipmentEntry.' must appear");
  assert.match(allExec, /'EquipmentAI\.'/, "single-quoted package prefix 'EquipmentAI.' must appear");
  assert.match(allExec, /'EquipmentEntry\.Production'/, "single-quoted production name must appear");

  // Even number of double-quote characters on every ExecDirect line → no ObjectScript string terminated early
  for (const line of execLines) {
    const dqCount = (line.match(/"/g) || []).length;
    assert.equal(dqCount % 2, 0, `odd double-quote count (${dqCount}) — ObjectScript string broken: ${line}`);
  }
});

test("localTeardown removes leftovers and keeps the known-good copies", () => {
  const fs = require("fs"), os = require("os"), path = require("path");
  const { localTeardown } = require("../lib/teardown");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ltd-"));
  const at = (...p) => path.join(root, ...p);
  const put = (...p) => { const f = at(...p); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, "x"); return f; };
  try {
    const agentDir = at("agent"), repoRoot = at("repo"), knownGoodRoot = at("agent", "_known-good"), tmpDir = at("tmp");
    const statusFiles = Object.fromEntries(["build", "production", "ai", "restore", "teardown"].map(k => [k, put("agent", `${k}-status.json`)]));
    const gone = [
      put("repo", "prototype", "build", "index.html"), put("repo", "prototype", "chat", "index.html"),
      put("agent", "_build", "run-1", "src", "main.ts"), put("agent", "_build", "loose.txt"),
      put("agent", "_production", "run-1", "a.cls"), put("agent", "_production", "ai-run-2", "b.cls"),
      put("agent", "_known-good", "api.new-12-34", "meta.json"), put("agent", "_known-good", "orchestrator.old-5-6", "meta.json"), put("agent", "_known-good", "ai.old-7-8"),
      put("tmp", "eqchat-abc", "index.html"), put("tmp", "eqchat-def"),
      put("agent", "decisions.json.tmp"), put("agent", "interclaw-servers.json"),
      ...Object.values(statusFiles),
    ];
    const backups = [1, 2, 3, 4, 5, 6, 7].map(d => put("agent", `decisions.backup-2026100${d}-120000.json`));
    // siblings not on the list, one in each touched directory — all must survive
    const kept = [
      put("agent", "_known-good", "api", "meta.json"), put("agent", "_known-good", "orchestrator", "meta.json"), put("agent", "_known-good", "notes.txt"), put("agent", "_known-good", "apix.new-1"),
      put("repo", "prototype", "index.html"), put("agent", "server.js"), put("agent", "decisions.json"), put("agent", "decisions.corrupt-20261001-120000.json"),
      put("tmp", "other-dir", "keep.txt"), put("tmp", "xeqchat-1"),
    ];
    const results = localTeardown({ agentDir, repoRoot, knownGoodRoot, statusFiles, decisionsFile: at("agent", "decisions.json"), tmpDir });
    assert.deepEqual(results.filter(r => r.outcome !== "removed"), [], JSON.stringify(results));
    for (const f of gone) assert.ok(!fs.existsSync(f), "still there: " + path.relative(root, f));
    for (const f of kept) assert.ok(fs.existsSync(f), "removed by mistake: " + path.relative(root, f));
    assert.ok(fs.existsSync(at("agent", "_build")) && fs.existsSync(at("agent", "_production")), "only the workspace contents are removed");
    assert.deepEqual(backups.filter(f => fs.existsSync(f)).map(f => path.basename(f)), backups.slice(2).map(f => path.basename(f)), "the 5 newest backups stay");
    // a second run over a clean tree: everything absent, nothing failed, the known-good copies still there
    const again = localTeardown({ agentDir, repoRoot, knownGoodRoot, statusFiles, decisionsFile: at("agent", "decisions.json"), tmpDir });
    assert.ok(again.length > 0 && again.every(r => r.outcome === "absent"), JSON.stringify(again));
    for (const f of kept) assert.ok(fs.existsSync(f), path.relative(root, f));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("localTeardown removes the decisions save's temp file beside the decisions file", () => {
  const fs = require("fs"), os = require("os"), path = require("path");
  const { localTeardown } = require("../lib/teardown");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ltd-"));
  try {
    const dataDir = path.join(root, "data"), agentDir = path.join(root, "agent");
    fs.mkdirSync(dataDir); fs.mkdirSync(agentDir);
    fs.writeFileSync(path.join(dataDir, "decisions.json"), "{}"); fs.writeFileSync(path.join(dataDir, "decisions.json.tmp"), "{");
    const r = localTeardown({ agentDir, repoRoot: root, knownGoodRoot: path.join(agentDir, "_known-good"), decisionsFile: path.join(dataDir, "decisions.json"), tmpDir: path.join(root, "tmp") });
    assert.deepEqual(r.find(x => x.item === "decisions.json.tmp"), { item: "decisions.json.tmp", outcome: "removed" });
    assert.ok(!fs.existsSync(path.join(dataDir, "decisions.json.tmp")));
    assert.ok(fs.existsSync(path.join(dataDir, "decisions.json")));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("no terminal-session script uses a macro (direct mode does not expand $$$)", () => {
  const { irisTeardownScript } = require("../lib/teardown");
  const { sessionScript, bulletinSettingsScript } = require("../production-runner");
  const { aiSettingsScript } = require("../ai-runner");
  const smtp = { host: "mail", port: 25, from: "a@b", user: "u", password: "p" };
  const scripts = {
    irisTeardownScript: irisTeardownScript(),
    sessionScript: sessionScript("INTEROP", smtp),
    bulletinSettingsScript: bulletinSettingsScript("INTEROP", smtp),
    aiSettingsScript: aiSettingsScript({ VADEMO_URL: "http://h:80", VADEMO_USER: "u", VADEMO_PASSWORD: "p", AWS_BEARER_TOKEN_BEDROCK: "t" }),
  };
  for (const [name, s] of Object.entries(scripts)) assert.doesNotMatch(s, /\$\$\$/, `${name} contains a $$$ macro`);
  assert.match(scripts.irisTeardownScript, /\$system\.Status\.IsOK\(sc\)/);
});

test("the teardown's SQL lines report an SQL error and count rows", () => {
  const { irisTeardownScript } = require("../lib/teardown");
  const lines = irisTeardownScript().split("\n");
  for (const key of ["MESSAGES", "EVENTLOG", "SETTINGS"]) {
    const l = lines.find(x => x.includes(`write "${key}:`));
    assert.ok(l, `${key} line present`);
    assert.match(l, new RegExp(`if st\.%SQLCODE<0 \{ write "${key}:ERROR ",st\.%Message,! \} else \{ write "${key}:",st\.%ROWCOUNT,! \}`), `${key} checks %SQLCODE<0 and writes %ROWCOUNT`);
    assert.doesNotMatch(l, /write "[A-Z]+:",st\.%SQLCODE/, `${key} must not write %SQLCODE as its count`);
  }
});

test("the teardown stops the production only when it is ours and running, suspended or troubled", () => {
  const { irisTeardownScript } = require("../lib/teardown");
  const l = irisTeardownScript().split("\n").find(x => x.includes('"STOP:'));
  assert.match(l, /\$get\(pn\)="EquipmentEntry\.Production"/);
  assert.match(l, /\(\$get\(ps\)=1\)!\(\$get\(ps\)=3\)!\(\$get\(ps\)=4\)/, "states 1, 3, 4 only (2 = stopped)");
  assert.match(l, /StopProduction\(10,1\) if \$system\.Status\.IsOK\(sc\) \{ do ##class\(Ens\.Director\)\.CleanProduction\(\)/, "CleanProduction only after a real stop");
});
