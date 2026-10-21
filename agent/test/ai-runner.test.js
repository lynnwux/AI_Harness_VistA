"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { graph, rec } = require("./helpers");
const { generate, writeSpecs } = require("../lib/specs");

const { readAiSpec, aiSettingsScript } = require("../ai-runner");

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
