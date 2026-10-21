"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { graph, rec } = require("./helpers");
const { generate, writeSpecs } = require("../lib/specs");

const { readAiSpec, aiSettingsScript, checkSettingsMarkers, main, STATUS_FILE } = require("../ai-runner");

const INVENTORY_PATH = path.join(__dirname, "..", "..", "capability-graph", "inventory-fields.json");
const inventory = JSON.parse(fs.readFileSync(INVENTORY_PATH, "utf8"));

function setupAiSpecs(record) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "air-"));
  const im = {
    api: [{ id: "read:lookup", endpoint: "GET /lookup/{file}" }],
    orchestrator: { built: true, verified: true },
    ai: { built: false, verified: false },
  };
  const paths = {
    graph: path.join(dir, "graph.json"),
    decisions: path.join(dir, "decisions.json"),
    implemented: path.join(dir, "implemented.json"),
    inventory: path.join(dir, "inventory.json"),
    specsDir: path.join(dir, "specs"),
  };
  fs.writeFileSync(paths.graph, JSON.stringify(graph));
  fs.writeFileSync(paths.decisions, JSON.stringify(record));
  fs.writeFileSync(paths.implemented, JSON.stringify(im));
  fs.writeFileSync(paths.inventory, JSON.stringify(inventory));
  writeSpecs(paths.specsDir, generate({ graph, record, implemented: im, inventory }), { graph, record, implemented: im, inventory });
  return paths;
}

test("readAiSpec refuses an incomplete AI spec", () => {
  const paths = setupAiSpecs(rec({}));
  assert.throws(() => readAiSpec(paths), /not complete/);
});

test("readAiSpec refuses a stale AI spec", () => {
  const paths = setupAiSpecs(rec({}));
  // Change the decisions file without regenerating the spec — staleness check fires first
  const d = JSON.parse(fs.readFileSync(paths.decisions, "utf8"));
  d.dec = d.dec || {};
  d.dec["OQ.WorkOrderPolicy"] = "Required input";
  fs.writeFileSync(paths.decisions, JSON.stringify(d));
  assert.throws(() => readAiSpec(paths), /stale/);
});

test("aiSettingsScript uses the read-only credentials when given", () => {
  const s = aiSettingsScript({
    VADEMO_URL: "http://vademo:80",
    VADEMO_READ_USER: "reader",
    VADEMO_READ_PASSWORD: "rpass",
    AWS_BEARER_TOKEN_BEDROCK: "tok",
  });
  const setCredLine = s.split("\n").find(l => l.includes("EquipmentAIVademo"));
  assert.ok(setCredLine, "a SetCredential line for EquipmentAIVademo must exist");
  assert.match(setCredLine, /SetCredential/);
  assert.ok(setCredLine.includes("reader"), "uses the read-only user");
  // password appears only in that SetCredential call
  const rpLines = s.split("\n").filter(l => l.includes("rpass"));
  assert.ok(rpLines.length > 0, "read-only password must appear in the script");
  assert.ok(rpLines.every(l => l.includes("SetCredential")), "read-only password must only be inside SetCredential");
});

test("aiSettingsScript falls back to VADEMO_USER and VADEMO_PASSWORD", () => {
  const s = aiSettingsScript({
    VADEMO_URL: "http://vademo:80",
    VADEMO_USER: "mainuser",
    VADEMO_PASSWORD: "mainpass",
    AWS_BEARER_TOKEN_BEDROCK: "tok",
  });
  assert.match(s, /SetCredential.*mainuser/);
  const pwdLines = s.split("\n").filter(l => l.includes("mainpass"));
  assert.ok(pwdLines.length > 0, "password must appear in the script");
  assert.ok(pwdLines.every(l => l.includes("SetCredential")), "password must only be inside SetCredential");
});

test("aiSettingsScript: VADEMO password and Bedrock token appear only inside SetCredential calls", () => {
  const vpass = 'vdemo-p@ss"quote!';
  const btoken = "br-tok-secret";
  const s = aiSettingsScript({
    VADEMO_URL: "http://h:80",
    VADEMO_USER: "u",
    VADEMO_PASSWORD: vpass,
    AWS_BEARER_TOKEN_BEDROCK: btoken,
  });
  // The password and token appear quoted (doubled quotes) so check for the unquoted-doubled form
  for (const secret of [vpass.replace(/"/g, '""'), btoken]) {
    const lines = s.split("\n").filter(l => l.includes(secret));
    assert.ok(lines.length > 0, `"${secret}" must appear in the script`);
    assert.ok(lines.every(l => l.includes("SetCredential")), `"${secret}" must only be inside SetCredential`);
  }
});

test("aiSettingsScript sets bedrockRegion from AWS_DEFAULT_REGION with a default of us-east-1", () => {
  const s1 = aiSettingsScript({
    VADEMO_URL: "http://h:80",
    VADEMO_USER: "u",
    VADEMO_PASSWORD: "p",
    AWS_BEARER_TOKEN_BEDROCK: "t",
    AWS_DEFAULT_REGION: "eu-west-1",
  });
  assert.match(s1, /bedrockRegion.*eu-west-1/);
  const s2 = aiSettingsScript({
    VADEMO_URL: "http://h:80",
    VADEMO_USER: "u",
    VADEMO_PASSWORD: "p",
    AWS_BEARER_TOKEN_BEDROCK: "t",
  });
  assert.match(s2, /bedrockRegion.*us-east-1/);
});

test("aiSettingsScript prefers VADEMO_URL_FROM_IRIS over VADEMO_URL and sets vademoPath to the fixed Atelier path", () => {
  const s = aiSettingsScript({
    VADEMO_URL: "http://not-this-one:80",
    VADEMO_URL_FROM_IRIS: "http://iris-vademo:8080",
    VADEMO_USER: "u",
    VADEMO_PASSWORD: "p",
    AWS_BEARER_TOKEN_BEDROCK: "t",
  });
  assert.match(s, /vademoServer.*iris-vademo/);
  assert.match(s, /vademoPort.*8080/);
  assert.match(s, /vademoPath.*\/api\/atelier\/v1\/VISTA-DIEGO\/action\/query/);
});

test("aiSettingsScript creates the /equipmentai web app if missing", () => {
  const s = aiSettingsScript({
    VADEMO_URL: "http://h:80",
    VADEMO_USER: "u",
    VADEMO_PASSWORD: "p",
    AWS_BEARER_TOKEN_BEDROCK: "t",
  });
  assert.match(s, /Security\.Applications.*Exists.*\/equipmentai/);
  assert.match(s, /EquipmentAI\.REST\.Dispatch/);
  assert.match(s, /AutheEnabled.*32/);
});

// ── checkSettingsMarkers ──────────────────────────────────────────────────────
test("checkSettingsMarkers returns [] when all markers are present with success values", () => {
  const ok = "WEBAPP:exists\nCONFIG:set\nVADEMO:stored\nBEDROCK:stored\n";
  assert.deepEqual(checkSettingsMarkers(ok), []);
  const ok2 = "WEBAPP:created\nCONFIG:set\nVADEMO:stored\nBEDROCK:stored\n";
  assert.deepEqual(checkSettingsMarkers(ok2), []);
});

test("checkSettingsMarkers names every missing or failed marker", () => {
  // All markers absent (empty output — e.g. container missing or IRIS down)
  const empty = "";
  const problems = checkSettingsMarkers(empty);
  assert.equal(problems.length, 4);
  assert.ok(problems.some(p => /WEBAPP/.test(p)));
  assert.ok(problems.some(p => /CONFIG/.test(p)));
  assert.ok(problems.some(p => /VADEMO/.test(p)));
  assert.ok(problems.some(p => /BEDROCK/.test(p)));

  // Only VADEMO missing
  const noVademo = "WEBAPP:exists\nCONFIG:set\nBEDROCK:stored\n";
  const p2 = checkSettingsMarkers(noVademo);
  assert.equal(p2.length, 1);
  assert.match(p2[0], /VADEMO/);

  // BEDROCK failed with an error text (not "stored")
  const badBedrock = "WEBAPP:exists\nCONFIG:set\nVADEMO:stored\nBEDROCK:some IRIS error\n";
  const p3 = checkSettingsMarkers(badBedrock);
  assert.equal(p3.length, 1);
  assert.match(p3[0], /BEDROCK/);
});

// ── main() integration with injected session ──────────────────────────────────
// Complete aiQuestions configuration (all 4 questions kept with valid params).
const allKept = {
  "AIQ.AgingOutFY":           { keep: true, wording: "Ages out?",     params: { fiscalYear: 2031, capitalizedMeans: "INVESTMENT_CATEGORY = 1", useStatuses: ["ALL"] } },
  "AIQ.HighValueNoContract":  { keep: true, wording: "High value?",   params: { threshold: 50000, valueColumn: "TOTAL_ASSET_VALUE", useStatuses: ["ALL"] } },
  "AIQ.JCAHOPendingInspection": { keep: true, wording: "JCAHO?",      params: { workOrderStatusColumn: "STATUS", workOrderStatuses: ["ALL"], useStatuses: ["ALL"] } },
  "AIQ.CapitalPlanningTotals":{ keep: true, wording: "Totals?",       params: { useStatuses: ["ALL"], valueColumns: ["TOTAL_ASSET_VALUE"], groupBy: "none" } },
};

function setupCompleteAiSpecs() {
  const r = rec({});
  r.aiQuestions = allKept;
  return setupAiSpecs(r);
}

test("main() settings step fails and names a missing marker when irisSession output is incomplete", async () => {
  const paths = setupCompleteAiSpecs();

  // Create a minimal fake INTERCLAW_SCRIPTS directory with lib/iris.py present
  const scriptsDir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-scripts-"));
  fs.mkdirSync(path.join(scriptsDir, "lib"), { recursive: true });
  fs.writeFileSync(path.join(scriptsDir, "lib", "iris.py"), "# fake");

  // Save and override the env vars main() reads
  const envKeys = ["IRIS_AI_HUB_URL", "IRIS_AI_HUB_USER", "IRIS_AI_HUB_PASSWORD",
                   "INTERCLAW_SCRIPTS", "VADEMO_URL", "VADEMO_USER", "VADEMO_PASSWORD",
                   "AWS_BEARER_TOKEN_BEDROCK", "BEDROCK_MODEL_ID"];
  const savedEnv = Object.fromEntries(envKeys.map(k => [k, process.env[k]]));
  const savedExitCode = process.exitCode;
  Object.assign(process.env, {
    IRIS_AI_HUB_URL: "http://localhost:9999",
    IRIS_AI_HUB_USER: "testuser",
    IRIS_AI_HUB_PASSWORD: "testpass",
    INTERCLAW_SCRIPTS: scriptsDir,
    VADEMO_URL: "http://vademo:80",
    VADEMO_USER: "u",
    VADEMO_PASSWORD: "p",
    AWS_BEARER_TOKEN_BEDROCK: "tok",
    BEDROCK_MODEL_ID: "us.anthropic.example-v1:0",
  });

  try {
    // Fake iris.py: push = ok, compile = no errors
    const fakeIrisScript = () => (method) => method === "POST" ? { console: [] } : "ok";
    // Fake session: output is missing VADEMO (simulates container issues)
    const fakeSession = () => "WEBAPP:exists\nCONFIG:set\nBEDROCK:stored\n";

    await main(paths, { _irisSession: fakeSession, _irisScript: fakeIrisScript });

    const status = JSON.parse(fs.readFileSync(STATUS_FILE, "utf8"));
    assert.equal(status.state, "error", "state must be error when a marker is missing");
    assert.match(status.error, /VADEMO/, "error must name the missing VADEMO marker");
  } finally {
    process.exitCode = savedExitCode;
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});
