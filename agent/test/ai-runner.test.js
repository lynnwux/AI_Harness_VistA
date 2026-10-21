"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { graph, rec } = require("./helpers");
const { generate, writeSpecs } = require("../lib/specs");
const { GUARD_CASES } = require("../lib/ai-hub");

const { readAiSpec, aiSettingsScript, checkSettingsMarkers, main, STATUS_FILE,
        sameRows, countFrom, countInReply, judgeAi } = require("../ai-runner");

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
  return { paths, dir };
}

test("readAiSpec refuses an incomplete AI spec", () => {
  const { paths, dir } = setupAiSpecs(rec({}));
  try { assert.throws(() => readAiSpec(paths), /not complete/); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("readAiSpec refuses a stale AI spec", () => {
  const { paths, dir } = setupAiSpecs(rec({}));
  try {
    // Change the decisions file without regenerating the spec — staleness check fires first
    const d = JSON.parse(fs.readFileSync(paths.decisions, "utf8"));
    d.dec = d.dec || {};
    d.dec["OQ.WorkOrderPolicy"] = "Required input";
    fs.writeFileSync(paths.decisions, JSON.stringify(d));
    assert.throws(() => readAiSpec(paths), /stale/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
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
  return setupAiSpecs(r); // returns { paths, dir }
}

// Capture the real agent/ paths state before any main() test runs — used by the guard test below.
const REAL_STATUS_FILE      = STATUS_FILE;
const REAL_IMPLEMENTED_FILE = path.join(__dirname, "..", "implemented.json");
const REAL_PROD_DIR         = path.join(__dirname, "..", "_production");
const beforeStatusExists  = fs.existsSync(REAL_STATUS_FILE);
const beforeStatusContent = beforeStatusExists ? fs.readFileSync(REAL_STATUS_FILE, "utf8") : null;
const beforeImplExists    = fs.existsSync(REAL_IMPLEMENTED_FILE);
const beforeImplContent   = beforeImplExists ? fs.readFileSync(REAL_IMPLEMENTED_FILE, "utf8") : null;
const beforeProdEntries   = fs.existsSync(REAL_PROD_DIR)
  ? new Set(fs.readdirSync(REAL_PROD_DIR))
  : new Set();

test("main() settings step fails and names a missing marker when irisSession output is incomplete", async () => {
  const { paths, dir: specsTmpDir } = setupCompleteAiSpecs();

  // Create a minimal fake INTERCLAW_SCRIPTS directory with lib/iris.py present
  const scriptsDir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-scripts-"));
  fs.mkdirSync(path.join(scriptsDir, "lib"), { recursive: true });
  fs.writeFileSync(path.join(scriptsDir, "lib", "iris.py"), "# fake");

  // Use a temp dir for every path main() writes to — avoids polluting agent/ paths.
  const tmpDir       = fs.mkdtempSync(path.join(os.tmpdir(), "air-main-"));
  const fakeStatus   = path.join(tmpDir, "ai-status.json");
  const fakeConfig   = path.join(tmpDir, "interclaw-servers.json");
  const fakeProdDir  = path.join(tmpDir, "_production");

  // Use realistic multi-character fake secrets so redact() does not mangle the
  // error message text we are about to assert.
  const envKeys = ["IRIS_AI_HUB_URL", "IRIS_AI_HUB_USER", "IRIS_AI_HUB_PASSWORD",
                   "INTERCLAW_SCRIPTS", "VADEMO_URL", "VADEMO_USER", "VADEMO_PASSWORD",
                   "AWS_BEARER_TOKEN_BEDROCK", "BEDROCK_MODEL_ID"];
  const savedEnv     = Object.fromEntries(envKeys.map(k => [k, process.env[k]]));
  const savedExitCode = process.exitCode;
  Object.assign(process.env, {
    IRIS_AI_HUB_URL:           "http://localhost:9999",
    IRIS_AI_HUB_USER:          "testuser",
    IRIS_AI_HUB_PASSWORD:      "fake-hub-pass-789",
    INTERCLAW_SCRIPTS:         scriptsDir,
    VADEMO_URL:                "http://vademo:80",
    VADEMO_USER:               "vademo-reader",
    VADEMO_PASSWORD:           "fake-vademo-pass-123",
    AWS_BEARER_TOKEN_BEDROCK:  "fake-bedrock-tok-456",
    BEDROCK_MODEL_ID:          "us.anthropic.example-v1:0",
  });

  try {
    // Fake iris.py: push succeeds (returns "ok"), compile returns no errors
    const fakeIrisScript = () => (method) => method === "POST" ? { console: [] } : "ok";
    // Fake session: output is missing the VADEMO line (simulates a container outage)
    const fakeSession = () => "WEBAPP:exists\nCONFIG:set\nBEDROCK:stored\n";

    await main(paths, {
      _irisSession:   fakeSession,
      _irisScript:    fakeIrisScript,
      _statusFile:    fakeStatus,
      _configFile:    fakeConfig,
      _productionDir: fakeProdDir,
    });

    const status = JSON.parse(fs.readFileSync(fakeStatus, "utf8"));
    assert.equal(status.state, "error", "state must be error when a marker is missing");
    assert.match(
      status.error,
      /IRIS settings step failed — VADEMO credential: expected "stored", got "\(missing\)"/,
      `error must carry the full IRIS settings failure message naming VADEMO; got: ${status.error}`
    );
  } finally {
    process.exitCode = savedExitCode;
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(tmpDir,       { recursive: true, force: true });
    fs.rmSync(scriptsDir,   { recursive: true, force: true });
    fs.rmSync(specsTmpDir,  { recursive: true, force: true });
  }
});

// ── sameRows ──────────────────────────────────────────────────────────────────

test("sameRows: same rows in different order are equal", () => {
  const a = [{ ien: "1", name: "A" }, { ien: "2", name: "B" }];
  const b = [{ ien: "2", name: "B" }, { ien: "1", name: "A" }];
  assert.ok(sameRows(a, b));
});

test("sameRows: different rows are not equal", () => {
  const a = [{ ien: "1" }];
  const b = [{ ien: "2" }];
  assert.ok(!sameRows(a, b));
});

test("sameRows: different row counts are not equal", () => {
  assert.ok(!sameRows([{ ien: "1" }], []));
  assert.ok(!sameRows([], [{ ien: "1" }]));
});

test("sameRows: numeric and string values are compared as trimmed strings", () => {
  // Both sides should match whether the value is number 1 or string "1"
  assert.ok(sameRows([{ ien: 1, v: " 42 " }], [{ ien: "1", v: "42" }]));
});

test("sameRows: null and empty string are both treated as empty", () => {
  assert.ok(sameRows([{ v: null }], [{ v: "" }]));
  assert.ok(sameRows([{ v: "" }], [{ v: null }]));
});

test("sameRows: empty arrays are equal", () => {
  assert.ok(sameRows([], []));
});

test("sameRows: non-arrays return false", () => {
  assert.ok(!sameRows(null, []));
  assert.ok(!sameRows([], null));
});

// ── countFrom ─────────────────────────────────────────────────────────────────

test("countFrom: single row, single numeric column returns that value", () => {
  assert.equal(countFrom({ rows: [{ n: 295 }], columns: ["n"], rowCount: 1 }), 295);
});

test("countFrom: single row, single string numeric column returns that value", () => {
  assert.equal(countFrom({ rows: [{ N: "  42  " }], columns: ["N"], rowCount: 1 }), 42);
});

test("countFrom: single row, non-numeric value returns rowCount", () => {
  assert.equal(countFrom({ rows: [{ name: "Alice" }], columns: ["name"], rowCount: 1 }), 1);
});

test("countFrom: multiple rows returns rowCount", () => {
  assert.equal(countFrom({ rows: [{ n: 1 }, { n: 2 }], columns: ["n"], rowCount: 2 }), 2);
});

test("countFrom: no rows returns rowCount (0)", () => {
  assert.equal(countFrom({ rows: [], columns: [], rowCount: 0 }), 0);
});

test("countFrom: null result returns null", () => {
  assert.equal(countFrom(null), null);
});

// ── countInReply ──────────────────────────────────────────────────────────────

test("countInReply: matches with thousands-separator comma", () => {
  assert.ok(countInReply("We have 1,295 items", 1295));
});

test("countInReply: matches without comma", () => {
  assert.ok(countInReply("1295 pieces of equipment", 1295));
});

test("countInReply: does not match a different number", () => {
  assert.ok(!countInReply("12950", 1295));
});

test("countInReply: does not match a number that is a prefix", () => {
  // "1295" is in "12950" but with a digit after — must not match
  assert.ok(!countInReply("12950 items", 1295));
});

test("countInReply: matches 295 without commas", () => {
  assert.ok(countInReply("We have 295 pieces of equipment.", 295));
});

test("countInReply: matches a million with separators", () => {
  assert.ok(countInReply("Total: 1,000,000 records", 1000000));
  assert.ok(countInReply("Total: 1000000 records", 1000000));
});

// ── tokenization-specific countInReply tests (C2/N1 — round 2) ───────────────

test("countInReply: sentence-ending period is not a decimal ('holds 295.' matches 295)", () => {
  // N1 breakage: current regex (?!\d|\.) prevents matching "295." because "." follows.
  assert.ok(countInReply("The inventory holds 295.", 295), "'295.' must match 295");
});

test("countInReply: comma-number followed by sentence period ('1,295.' matches 1295)", () => {
  assert.ok(countInReply("We have 1,295.", 1295), "'1,295.' must match 1295");
});

test("countInReply: '1,295' does NOT match 295 (tokenizes to 1295)", () => {
  // C2: current regex matches the '295' substring inside '1,295' — tokenization must reject this.
  assert.ok(!countInReply("We have 1,295 items", 295), "'1,295' tokenizes to 1295, must not match 295");
});

test("countInReply: '295,000' does NOT match 295", () => {
  // C2: current regex matches '295' inside '295,000' — tokenization must reject this.
  assert.ok(!countInReply("We have 295,000 items", 295), "'295,000' tokenizes to 295000, must not match 295");
});

test("countInReply: 'ratio 3.295' does NOT match 295 (decimal token)", () => {
  // C2: current regex matches '295' after '.' in '3.295' because lookbehind only guards digits.
  assert.ok(!countInReply("ratio 3.295", 295), "'3.295' is a decimal, must not match 295");
});

// ── judgeAi ───────────────────────────────────────────────────────────────────

test("judgeAi: all correct → ok=true, no problems", () => {
  const rows = [{ ien: "1" }];
  const result = judgeAi({
    quick: [{ id: "AIQ.Test", chatbot: { rows, rowCount: 1, truncated: false }, direct: [{ ien: "1" }] }],
    count: { result: { rows: [{ n: 295 }], columns: ["n"], rowCount: 1 }, reply: "We have 295 items.", reference: 295 },
    guard: [{ sql: "SELECT 1", allowed: true, got: true }],
  });
  assert.ok(result.ok);
  assert.deepEqual(result.problems, []);
});

test("judgeAi: one mismatched quick question → one problem", () => {
  const result = judgeAi({
    quick: [
      { id: "AIQ.Good", chatbot: { rows: [{ ien: "1" }], rowCount: 1, truncated: false }, direct: [{ ien: "1" }] },
      { id: "AIQ.Bad",  chatbot: { rows: [{ ien: "2" }], rowCount: 1, truncated: false }, direct: [] },
    ],
    count: { result: { rows: [{ n: 5 }], columns: ["n"], rowCount: 1 }, reply: "5 items", reference: 5 },
    guard: [],
  });
  assert.ok(!result.ok);
  assert.equal(result.problems.length, 1);
  assert.match(result.problems[0], /AIQ\.Bad/);
});

test("judgeAi: count mismatch → one problem", () => {
  const result = judgeAi({
    quick: [],
    count: { result: { rows: [{ n: 99 }], columns: ["n"], rowCount: 1 }, reply: "We have 99 items", reference: 100 },
    guard: [],
  });
  assert.ok(!result.ok);
  assert.equal(result.problems.length, 1);
  assert.match(result.problems[0], /count mismatch/);
});

test("judgeAi: count requires BOTH — reply-only (countFrom=0, reference=295, reply mentions 295) fails", () => {
  // BOTH required: countFrom=0 ≠ 295, so this must fail even though the reply mentions 295.
  const result = judgeAi({
    quick: [],
    count: { result: { rows: [], columns: [], rowCount: 0 }, reply: "We have 295 items.", reference: 295 },
    guard: [],
  });
  assert.ok(!result.ok, "countFrom=0 ≠ reference=295 → fail even though reply matches");
  assert.ok(result.problems.some(p => /count mismatch/.test(p)));
});

test("judgeAi: guard mismatches → one problem per failing case", () => {
  const result = judgeAi({
    quick: [],
    count: null,
    guard: [
      { sql: "SELECT 1", allowed: true,  got: true  },   // pass
      { sql: "DELETE 1", allowed: false, got: true  },   // fail (should be rejected)
      { sql: "DROP 1",   allowed: false, got: false },   // pass
    ],
  });
  assert.ok(!result.ok);
  assert.equal(result.problems.length, 1);
  assert.match(result.problems[0], /DELETE 1/);
});

test("judgeAi: truncated quick result — all chatbot rows in direct (rowCap-aware)", () => {
  const CAP = 3;
  const chatbotRows = [{ ien: "1" }, { ien: "2" }, { ien: "3" }]; // length === CAP
  const directRows  = [{ ien: "1" }, { ien: "2" }, { ien: "3" }, { ien: "4" }]; // > CAP
  const result = judgeAi({
    quick: [{ id: "AIQ.Big", chatbot: { rows: chatbotRows, rowCount: CAP, truncated: true }, direct: directRows }],
    count: null, guard: [], rowCap: CAP,
  });
  assert.ok(result.ok, "chatbot rows are a subset of direct and counts are correct → ok");
});

test("judgeAi: truncated quick result — subset fails if chatbot row not in direct", () => {
  const CAP = 3;
  const chatbotRows = [{ ien: "1" }, { ien: "2" }, { ien: "99" }]; // ien=99 not in direct
  const directRows  = [{ ien: "1" }, { ien: "2" }, { ien: "3" }, { ien: "4" }]; // > CAP
  const result = judgeAi({
    quick: [{ id: "AIQ.Big", chatbot: { rows: chatbotRows, rowCount: CAP, truncated: true }, direct: directRows }],
    count: null, guard: [], rowCap: CAP,
  });
  assert.ok(!result.ok, "ien=99 is not in direct rows → fail");
  assert.equal(result.problems.length, 1);
});

// ── Finding 1: chatbot error must fail ────────────────────────────────────────

test("judgeAi: chatbot.error property → problem (never passes as a match)", () => {
  // Probe from Finding 1
  const result = judgeAi({
    quick: [{ id: "AIQ.Test", chatbot: { error: "VistA unreachable", rows: [], rowCount: 0, truncated: false }, direct: [] }],
    count: null, guard: [],
  });
  assert.ok(!result.ok, "chatbot.error must fail the question");
  assert.ok(result.problems.some(p => /chatbot error/.test(p)), `problem must mention 'chatbot error'; got: ${result.problems}`);
});

test("judgeAi: chatbot rows not an array → problem", () => {
  const result = judgeAi({
    quick: [{ id: "AIQ.Test", chatbot: { rows: null, rowCount: 0, truncated: false }, direct: [] }],
    count: null, guard: [],
  });
  assert.ok(!result.ok);
});

test("judgeAi: count with chatbot error → problem (empty direct rows (reference=0) must not pass)", () => {
  // Probe: count:{result:{error:"x",rows:[],rowCount:0},reply:"",reference:0} → ok:true BEFORE fix
  const result = judgeAi({
    quick: [],
    count: { result: { error: "x", rows: [], rowCount: 0, columns: [] }, reply: "", reference: 0 },
    guard: [],
  });
  assert.ok(!result.ok, "chatbot error on count must fail");
});

// ── Finding 2: count requires BOTH replyOk AND countMatch ─────────────────────

test("countInReply: does not match a decimal like 295.7", () => {
  assert.ok(!countInReply("We have 295.7 items", 295), "295.7 must not match 295");
});

test("countInReply: guards against NaN/negative n", () => {
  assert.ok(!countInReply("NaN items", NaN));
  assert.ok(!countInReply("-295 items", -295));
});

test("judgeAi: count requires BOTH replyOk AND countMatch — reply-only match fails", () => {
  // Reply says "295" but rows say {n:300}: countFrom=300 ≠ 295 → should fail (BOTH required)
  const result = judgeAi({
    quick: [],
    count: { result: { rows: [{ n: 300 }], columns: ["n"], rowCount: 1 }, reply: "We have 295 pieces.", reference: 295 },
    guard: [],
  });
  assert.ok(!result.ok, "replyOk=true but countFrom mismatch → must fail with BOTH required");
  assert.match(result.problems[0], /count mismatch/);
});

test("judgeAi: count requires BOTH replyOk AND countMatch — rows-only match fails", () => {
  // Rows say {n:295} matching reference but reply says "300 items": replyOk=false → fail
  const result = judgeAi({
    quick: [],
    count: { result: { rows: [{ n: 295 }], columns: ["n"], rowCount: 1 }, reply: "We have 300 pieces.", reference: 295 },
    guard: [],
  });
  assert.ok(!result.ok, "countFrom matches but reply mismatch → must fail with BOTH required");
  assert.match(result.problems[0], /count mismatch/);
});

// ── Finding 3: truncation strict checks ───────────────────────────────────────

test("judgeAi: truncated — chatbotRows.length !== rowCap → fail", () => {
  const CAP = 200;
  const chatbotRows = [{ ien: "1" }, { ien: "2" }]; // 2 ≠ 200
  const directRows  = Array.from({ length: 201 }, (_, i) => ({ ien: String(i) }));
  const result = judgeAi({
    quick: [{ id: "AIQ.Big", chatbot: { rows: chatbotRows, rowCount: 2, truncated: true }, direct: directRows }],
    count: null, guard: [], rowCap: CAP,
  });
  assert.ok(!result.ok, "chatbotRows.length=2 ≠ rowCap=200 → fail");
});

test("judgeAi: truncated — direct.length ≤ rowCap → fail (chatbot shouldn't be truncated)", () => {
  const CAP = 200;
  const chatbotRows = Array.from({ length: 200 }, (_, i) => ({ ien: String(i) }));
  const directRows  = Array.from({ length: 150 }, (_, i) => ({ ien: String(i) }));
  const result = judgeAi({
    quick: [{ id: "AIQ.Big", chatbot: { rows: chatbotRows, rowCount: 200, truncated: true }, direct: directRows }],
    count: null, guard: [], rowCap: CAP,
  });
  assert.ok(!result.ok, "direct.length=150 ≤ rowCap=200 with truncated=true → fail");
});

test("judgeAi: truncated — duplicate chatbot rows fool Set but fail multiset check", () => {
  // chatbot: ien=1 appears twice; direct: ien=1 appears once only
  const CAP = 3;
  const chatbotRows = [{ ien: "1" }, { ien: "1" }, { ien: "2" }]; // ien=1 duplicated
  const directRows  = [{ ien: "1" }, { ien: "2" }, { ien: "3" }, { ien: "4" }]; // ien=1 once
  const result = judgeAi({
    quick: [{ id: "AIQ.Big", chatbot: { rows: chatbotRows, rowCount: CAP, truncated: true }, direct: directRows }],
    count: null, guard: [], rowCap: CAP,
  });
  assert.ok(!result.ok, "ien=1 twice in chatbot but once in direct → multiset fail");
});

// ── Finding 4: guard HTTP errors ──────────────────────────────────────────────

test("judgeAi: guard entry with error field → problem (fails the run)", () => {
  const result = judgeAi({
    quick: [],
    count: null,
    guard: [
      { sql: "SELECT 1", allowed: true, got: true },
      { sql: "FAIL", allowed: false, error: "HTTP 400" },
    ],
  });
  assert.ok(!result.ok, "guard entry with error must fail");
  assert.ok(result.problems.some(p => /HTTP 400/.test(p)), `expected HTTP 400 in problems; got: ${result.problems}`);
});

// ── N1: reply ending with sentence period must pass through judgeAi ───────────

test("judgeAi: count reply ending with sentence period ('The inventory holds 295.') → ok", () => {
  // N1 breakage: round-1 (?!\.) lookahead breaks "295." — judgeAi must accept it.
  const result = judgeAi({
    quick: [],
    count: { result: { rows: [{ n: 295 }], columns: ["n"], rowCount: 1 }, reply: "The inventory holds 295.", reference: 295 },
    guard: [],
  });
  assert.ok(result.ok, "reply ending with sentence period must pass; got problems: " + result.problems);
});

// ── N3: falsy errors (empty string, 0) must be treated as errors ──────────────

test("judgeAi: chatbot.error='' (empty string) → problem", () => {
  // Probe: current code uses `&& q.chatbot.error` (truthy), so "" silently passes.
  const result = judgeAi({
    quick: [{ id: "AIQ.Test", chatbot: { error: "", rows: [], rowCount: 0, truncated: false }, direct: [] }],
    count: null, guard: [],
  });
  assert.ok(!result.ok, "empty-string error must fail the question");
});

test("judgeAi: count result.error='' (empty string) → problem", () => {
  // count reference=0, rows=[], error="" — must fail (not treated as no-error).
  const result = judgeAi({
    quick: [],
    count: { result: { error: "", rows: [], rowCount: 0, columns: [] }, reply: "0 pieces.", reference: 0 },
    guard: [],
  });
  assert.ok(!result.ok, "empty-string error on count result must fail");
});

test("judgeAi: guard entry error='' (empty string) → problem", () => {
  // Probe: current code uses `if (g.error)` which is falsy for "".
  const result = judgeAi({
    quick: [],
    count: null,
    guard: [{ sql: "SELECT 1", allowed: false, got: false, error: "" }],
  });
  assert.ok(!result.ok, "empty-string error on guard entry must fail");
});

// ── Finding 7: additional main() failure tests ────────────────────────────────

// main() verification step ────────────────────────────────────────────────────

// Real non-empty rows shared by chatbot quick and direct Atelier for the success case.
// Both sides return identical rows so sameRows() passes.
const FAKE_QUICK_ROWS = [{ IEN: "1", MFGR__EQUIPMENT_NAME: "Monitor A" }, { IEN: "2", MFGR__EQUIPMENT_NAME: "Bed B" }];

function makeVerifyFetch({ failQuestionId = null, chatbotError = false, vademoHttpError = false, countReplyWrong = false, guardMismatch = false } = {}) {
  return async (url, opts) => {
    const body = JSON.parse((opts && opts.body) || "{}");

    if (/\/equipmentai\/quick\//.test(url)) {
      const id = url.split("/equipmentai/quick/").pop().split("?")[0];
      if (chatbotError) {
        return { ok: true, json: () => Promise.resolve({ error: "VistA could not be reached", rows: [], rowCount: 0, truncated: false }) };
      }
      if (failQuestionId && id === failQuestionId) {
        // Different rows from direct — clear mismatch
        return { ok: true, json: () => Promise.resolve({ reply: "OK", tool: id, sql: "", columns: ["IEN"], rows: [{ IEN: "999" }], rowCount: 1, truncated: false }) };
      }
      return { ok: true, json: () => Promise.resolve({ reply: "OK", tool: id, sql: "", columns: Object.keys(FAKE_QUICK_ROWS[0]), rows: FAKE_QUICK_ROWS, rowCount: FAKE_QUICK_ROWS.length, truncated: false }) };
    }

    if (/\/equipmentai\/chat/.test(url)) {
      if (countReplyWrong) {
        return { ok: true, json: () => Promise.resolve({ reply: "We have 300 pieces of equipment.", tool: "RunQuery", sql: "", columns: ["n"], rows: [{ n: 300 }], rowCount: 1, truncated: false }) };
      }
      return { ok: true, json: () => Promise.resolve({ reply: "We have 295 pieces of equipment.", tool: "RunQuery", sql: "", columns: ["n"], rows: [{ n: 295 }], rowCount: 1, truncated: false }) };
    }

    if (/\/equipmentai\/guard/.test(url)) {
      if (guardMismatch) {
        // Return the WRONG ok for every case to force a failure
        const gc = GUARD_CASES.find(c => c.sql === body.sql);
        const ok = gc ? !gc.allowed : true; // deliberately inverted
        return { ok: true, json: () => Promise.resolve({ ok, reason: ok ? "" : "rejected" }) };
      }
      const gc = GUARD_CASES.find(c => c.sql === body.sql);
      const ok = gc ? gc.allowed : false;
      return { ok: true, json: () => Promise.resolve({ ok, reason: ok ? "" : "rejected" }) };
    }

    if (/\/api\/atelier\//.test(url)) {
      if (vademoHttpError) {
        return { ok: false, status: 500, json: () => Promise.resolve({ error: "Internal Server Error" }) };
      }
      const sql = (body.query || "").trim();
      if (/^SELECT\s+COUNT\(\*\)\s+AS\s+n\s+FROM/i.test(sql)) {
        return { ok: true, json: () => Promise.resolve({ result: { content: [{ n: 295 }] }, status: { errors: [] } }) };
      }
      // Quick question direct: return same rows as chatbot
      return { ok: true, json: () => Promise.resolve({ result: { content: FAKE_QUICK_ROWS }, status: { errors: [] } }) };
    }

    throw new Error("Unexpected URL in makeVerifyFetch: " + url);
  };
}

function makeVerifyMainDeps(paths, overrides = {}) {
  const tmpDir     = fs.mkdtempSync(path.join(os.tmpdir(), "air-verify-"));
  const fakeStatus = path.join(tmpDir, "ai-status.json");
  const fakeConfig = path.join(tmpDir, "interclaw-servers.json");
  const fakeProd   = path.join(tmpDir, "_production");

  const scriptsDir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-scripts-v-"));
  fs.mkdirSync(path.join(scriptsDir, "lib"), { recursive: true });
  fs.writeFileSync(path.join(scriptsDir, "lib", "iris.py"), "# fake");

  return {
    tmpDir, scriptsDir,
    deps: {
      _irisSession:   () => "WEBAPP:exists\nCONFIG:set\nVADEMO:stored\nBEDROCK:stored\n",
      _irisScript:    () => (method) => method === "POST" ? { console: [] } : "ok",
      _buildChatApp:  async () => {},
      _statusFile:    fakeStatus,
      _configFile:    fakeConfig,
      _productionDir: fakeProd,
      _fetch:         overrides._fetch || makeVerifyFetch(),
    },
    scriptsDir,
    envKeys: ["IRIS_AI_HUB_URL", "IRIS_AI_HUB_USER", "IRIS_AI_HUB_PASSWORD",
               "INTERCLAW_SCRIPTS", "VADEMO_URL", "VADEMO_USER", "VADEMO_PASSWORD",
               "AWS_BEARER_TOKEN_BEDROCK", "BEDROCK_MODEL_ID"],
    envVals: {
      IRIS_AI_HUB_URL:          "http://localhost:9999",
      IRIS_AI_HUB_USER:         "testuser",
      IRIS_AI_HUB_PASSWORD:     "fake-hub-pass-789",
      INTERCLAW_SCRIPTS:        scriptsDir,
      VADEMO_URL:               "http://vademo:80",
      VADEMO_USER:              "vademo-reader",
      VADEMO_PASSWORD:          "fake-vademo-pass-123",
      AWS_BEARER_TOKEN_BEDROCK: "fake-bedrock-tok-456",
      BEDROCK_MODEL_ID:         "us.anthropic.example-v1:0",
    },
  };
}

// Run main() with a temp spec dir + temp output dir; reads all results BEFORE cleanup.
// Returns { status, implContent } — files are deleted in the finally block.
async function runMain(pathsObj, fetchOverride) {
  const { paths, dir: specsDir } = pathsObj;
  const { tmpDir, scriptsDir, deps, envKeys, envVals } = makeVerifyMainDeps(paths,
    fetchOverride ? { _fetch: fetchOverride } : {});
  const savedEnv      = Object.fromEntries(envKeys.map(k => [k, process.env[k]]));
  const savedExitCode = process.exitCode;
  Object.assign(process.env, envVals);
  try {
    await main(paths, deps);
    // Read all results BEFORE cleanup so callers don't depend on deleted files.
    const statusFile = deps._statusFile;
    const status     = fs.existsSync(statusFile) ? JSON.parse(fs.readFileSync(statusFile, "utf8")) : null;
    const implContent = fs.existsSync(paths.implemented) ? fs.readFileSync(paths.implemented, "utf8") : null;
    return { status, implContent };
  } finally {
    process.exitCode = savedExitCode;
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    fs.rmSync(tmpDir,       { recursive: true, force: true });
    fs.rmSync(scriptsDir,   { recursive: true, force: true });
    fs.rmSync(specsDir,     { recursive: true, force: true });
  }
}

test("main() verification: success writes implemented.ai verified=true and status.verification", async () => {
  const pathsObj = setupCompleteAiSpecs();
  const { status, implContent } = await runMain(pathsObj, makeVerifyFetch());

  assert.equal(status.state, "done", `expected state=done; error: ${status.error}`);
  assert.ok(Array.isArray(status.verification), "status must have a verification array");
  assert.ok(status.verification.length > 0, "verification must have at least one entry");
  assert.ok(status.verification.every(e => "question" in e && "chatbot" in e && "vista" in e && "ok" in e),
    "each verification entry must have question, chatbot, vista, ok");

  const impl = JSON.parse(implContent);
  assert.ok(impl.ai, "implemented.json must have an ai key");
  assert.equal(impl.ai.built, true);
  assert.equal(impl.ai.verified, true);
  assert.ok(impl.ai.verifiedAt, "verifiedAt must be set");
});

test("main() verification: row mismatch → error, implemented.json content unchanged", async () => {
  const pathsObj = setupCompleteAiSpecs();
  // Capture the initial implemented.json content before runMain deletes the spec dir
  const implBefore = fs.readFileSync(pathsObj.paths.implemented, "utf8");
  // Read the first question id before runMain
  const d = JSON.parse(fs.readFileSync(path.join(pathsObj.paths.specsDir, "ai.json"), "utf8"));
  const firstId = d.detail.questions[0].id.replace(/^AIQ\./, "");

  const { status, implContent } = await runMain(pathsObj, makeVerifyFetch({ failQuestionId: firstId }));

  assert.equal(status.state, "error", `expected error state; got: ${status.state}`);
  assert.ok(status.error, "must have an error message");
  // implemented.json must be byte-identical to pre-run state on failure
  assert.equal(implContent, implBefore,
    "implemented.json must be byte-identical to pre-run state on failure");
});

test("main() verification: chatbot error response → error state", async () => {
  const { status } = await runMain(setupCompleteAiSpecs(), makeVerifyFetch({ chatbotError: true }));
  assert.equal(status.state, "error", `expected error for chatbot error; got: ${status.state}`);
});

test("main() verification: VADEMO HTTP error → error state", async () => {
  const { status } = await runMain(setupCompleteAiSpecs(), makeVerifyFetch({ vademoHttpError: true }));
  assert.equal(status.state, "error", `expected error for VADEMO HTTP error; got: ${status.state}`);
});

test("main() verification: count reply mismatch → error state", async () => {
  const { status } = await runMain(setupCompleteAiSpecs(), makeVerifyFetch({ countReplyWrong: true }));
  assert.equal(status.state, "error", `expected error for count mismatch; got: ${status.state}`);
});

test("main() verification: guard mismatch → error state", async () => {
  const { status } = await runMain(setupCompleteAiSpecs(), makeVerifyFetch({ guardMismatch: true }));
  assert.equal(status.state, "error", `expected error for guard mismatch; got: ${status.state}`);
});

// ── I7a: count retry — first call fails, second passes → overall success ───────

test("main() verification: count retry — first try fails, second passes → ok=true", async () => {
  let chatCallCount = 0;
  const successFetch = makeVerifyFetch();
  const retryFetch = async (url, opts) => {
    if (/\/equipmentai\/chat/.test(url)) {
      chatCallCount++;
      if (chatCallCount === 1) {
        // First try: wrong count (n=0, reply has no number) — triggers retry
        return { ok: true, json: () => Promise.resolve({ reply: "I don't know.", tool: "RunQuery", sql: "", columns: ["n"], rows: [{ n: 0 }], rowCount: 1, truncated: false }) };
      }
      // Retry: correct answer
      return { ok: true, json: () => Promise.resolve({ reply: "We have 295 pieces of equipment.", tool: "RunQuery", sql: "", columns: ["n"], rows: [{ n: 295 }], rowCount: 1, truncated: false }) };
    }
    return successFetch(url, opts);
  };
  const { status } = await runMain(setupCompleteAiSpecs(), retryFetch);
  assert.equal(status.state, "done", `expected done after retry; error: ${status && status.error}`);
  assert.equal(chatCallCount, 2, "should have made exactly 2 chat calls (first fail + retry)");
});

// ── I7b: hub (IRIS) HTTP error through main() → run fails with error named ────

test("main() verification: hub HTTP error on /equipmentai/quick → error state", async () => {
  const successFetch = makeVerifyFetch();
  const hubErrorFetch = async (url, opts) => {
    if (/\/equipmentai\/quick\//.test(url)) {
      // Simulate IRIS returning 503
      return { ok: false, status: 503, json: () => Promise.resolve({}) };
    }
    return successFetch(url, opts);
  };
  const { status } = await runMain(setupCompleteAiSpecs(), hubErrorFetch);
  assert.equal(status.state, "error", `expected error for hub HTTP 503; got: ${status && status.state}`);
  assert.ok(status.error, "must have an error message");
});

// ── Guard: untouched-files assertion — must run AFTER all main() tests ─────────────────────────
test("guard: all main() tests left agent/ai-status.json and agent/implemented.json untouched", () => {
  if (beforeStatusContent === null) {
    assert.ok(!fs.existsSync(REAL_STATUS_FILE),
      "agent/ai-status.json must not exist after tests — main() must use the injected _statusFile path");
  } else {
    assert.equal(fs.readFileSync(REAL_STATUS_FILE, "utf8"), beforeStatusContent,
      "agent/ai-status.json must be unchanged after tests — main() must use the injected _statusFile path");
  }

  if (beforeImplContent === null) {
    assert.ok(!fs.existsSync(REAL_IMPLEMENTED_FILE),
      "agent/implemented.json must not exist after tests — main() must use paths.implemented (injected temp path)");
  } else {
    assert.equal(fs.readFileSync(REAL_IMPLEMENTED_FILE, "utf8"), beforeImplContent,
      "agent/implemented.json must be unchanged after tests — main() must use paths.implemented (injected temp path)");
  }

  const afterProdEntries = fs.existsSync(REAL_PROD_DIR) ? new Set(fs.readdirSync(REAL_PROD_DIR)) : new Set();
  const newEntries = [...afterProdEntries].filter(e => !beforeProdEntries.has(e));
  assert.deepEqual(newEntries, [],
    "no new entries must appear in agent/_production/ after tests — main() must use the injected _productionDir path");
});

// ── Final review I6: one helper picks the VADEMO login as a pair ───────────────
const { vademoLogin } = require("../ai-runner");
test("vademoLogin: the read-only pair only when VADEMO_READ_USER is set, else the main pair — never a mix", () => {
  const main = { VADEMO_USER: "main", VADEMO_PASSWORD: "mainpass" };
  assert.deepEqual(vademoLogin({ ...main, VADEMO_READ_USER: "ro", VADEMO_READ_PASSWORD: "ropass" }), { user: "ro", password: "ropass", readOnly: true });
  assert.deepEqual(vademoLogin(main), { user: "main", password: "mainpass", readOnly: false });
  // a read password without a read user is ignored; an empty read password never replaces the main one
  assert.deepEqual(vademoLogin({ ...main, VADEMO_READ_PASSWORD: "ropass" }), { user: "main", password: "mainpass", readOnly: false });
  assert.deepEqual(vademoLogin({ ...main, VADEMO_READ_PASSWORD: "" }), { user: "main", password: "mainpass", readOnly: false });
  assert.deepEqual(vademoLogin({ ...main, VADEMO_READ_USER: "", VADEMO_READ_PASSWORD: "" }), { user: "main", password: "mainpass", readOnly: false });
  assert.deepEqual(vademoLogin({ ...main, VADEMO_READ_USER: "   " }), { user: "main", password: "mainpass", readOnly: false });
  // a read user without its password is an error, never (read user, main password)
  assert.throws(() => vademoLogin({ ...main, VADEMO_READ_USER: "ro" }), /VADEMO_READ_USER is set but VADEMO_READ_PASSWORD is not/);
  assert.throws(() => vademoLogin({ ...main, VADEMO_READ_USER: "ro", VADEMO_READ_PASSWORD: "" }), /VADEMO_READ_PASSWORD/);
  assert.throws(() => vademoLogin({}), /VADEMO_USER/);
});

test("aiSettingsScript stores the pair vademoLogin picks, and refuses a read user without its password", () => {
  const base = { VADEMO_URL: "http://h:80", VADEMO_USER: "mainuser", VADEMO_PASSWORD: "mainpass", AWS_BEARER_TOKEN_BEDROCK: "tok" };
  assert.throws(() => aiSettingsScript({ ...base, VADEMO_READ_USER: "ro" }), /VADEMO_READ_PASSWORD/);
  const s = aiSettingsScript({ ...base, VADEMO_READ_PASSWORD: "" });
  const cred = s.split("\n").find(l => l.includes("EquipmentAIVademo"));
  assert.match(cred, /"mainuser","mainpass"/);
});

// ── Final review M5: no Bedrock token stops the build at the start ─────────────
test("aiSettingsScript refuses an empty Bedrock token, naming the setting", () => {
  const base = { VADEMO_URL: "http://h:80", VADEMO_USER: "u", VADEMO_PASSWORD: "p" };
  assert.throws(() => aiSettingsScript(base), /AWS_BEARER_TOKEN_BEDROCK/);
  assert.throws(() => aiSettingsScript({ ...base, AWS_BEARER_TOKEN_BEDROCK: "  " }), /AWS_BEARER_TOKEN_BEDROCK/);
});

test("main() with no AWS_BEARER_TOKEN_BEDROCK fails before pushing anything, naming the setting", async () => {
  const pathsObj = setupCompleteAiSpecs();
  const { tmpDir, scriptsDir, deps, envKeys, envVals } = makeVerifyMainDeps(pathsObj.paths);
  const savedEnv = Object.fromEntries(envKeys.map(k => [k, process.env[k]]));
  const savedExitCode = process.exitCode;
  let pushed = 0;
  Object.assign(process.env, envVals);
  delete process.env.AWS_BEARER_TOKEN_BEDROCK;
  try {
    await main(pathsObj.paths, { ...deps, _irisScript: () => () => { pushed++; return "ok"; } });
    const status = JSON.parse(fs.readFileSync(deps._statusFile, "utf8"));
    assert.equal(status.state, "error");
    assert.match(status.error, /AWS_BEARER_TOKEN_BEDROCK is not set/);
    assert.equal(pushed, 0, "nothing was pushed to IRIS");
  } finally {
    process.exitCode = savedExitCode;
    for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    fs.rmSync(tmpDir, { recursive: true, force: true }); fs.rmSync(scriptsDir, { recursive: true, force: true }); fs.rmSync(pathsObj.dir, { recursive: true, force: true });
  }
});

// ── Final review M1 + trivial: secrets reach the session helper; the chat build's output reaches the log ──
test("main() hands irisSession the secrets to redact, and the chat-app build its log", async () => {
  const pathsObj = setupCompleteAiSpecs();
  let sessionOpts = null;
  const { status } = await runMainWith(pathsObj, {
    _irisSession: (_c, _s, opts) => { sessionOpts = opts; return "WEBAPP:exists\nCONFIG:set\nVADEMO:stored\nBEDROCK:stored\n"; },
    _buildChatApp: async (_q, _out, log) => { log("$ npx -y @angular/cli@20 new eqchat"); log("npm ERR! code E404 fake-bedrock-tok-456"); throw new Error("npx exited 1"); },
  });
  assert.ok(sessionOpts && Array.isArray(sessionOpts.secrets), "irisSession receives { secrets }");
  for (const s of ["fake-vademo-pass-123", "fake-bedrock-tok-456", "fake-hub-pass-789"]) assert.ok(sessionOpts.secrets.includes(s), s);
  assert.equal(status.state, "error");
  const log = status.log.join("\n");
  assert.match(log, /npm ERR! code E404/, "the scaffold's output shows in the build log");
  assert.ok(!log.includes("fake-bedrock-tok-456"), "and is redacted");
});

// runMain with extra dependency overrides (used by the final-review tests above).
async function runMainWith(pathsObj, overrides) {
  const { paths, dir: specsDir } = pathsObj;
  const { tmpDir, scriptsDir, deps, envKeys, envVals } = makeVerifyMainDeps(paths);
  const savedEnv = Object.fromEntries(envKeys.map(k => [k, process.env[k]]));
  const savedExitCode = process.exitCode;
  Object.assign(process.env, envVals);
  try {
    await main(paths, { ...deps, ...overrides });
    const status = fs.existsSync(deps._statusFile) ? JSON.parse(fs.readFileSync(deps._statusFile, "utf8")) : null;
    const implContent = fs.existsSync(paths.implemented) ? fs.readFileSync(paths.implemented, "utf8") : null;
    return { status, implContent };
  } finally {
    process.exitCode = savedExitCode;
    for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    fs.rmSync(tmpDir, { recursive: true, force: true }); fs.rmSync(scriptsDir, { recursive: true, force: true }); fs.rmSync(specsDir, { recursive: true, force: true });
  }
}

// ── Final review M2: the finish table shows each question's wording and readable answers ──
test("judgeAi items: the question's wording, the single value of a one-row result, and correctly pluralized row counts", () => {
  const totals = [{ TOTAL_COUNT: "295", SUM_TOTAL_ASSET_VALUE: "1234567.5", CAPITALIZED_COUNT: "40" }];
  const one = [{ IEN: "7", MFGR__EQUIPMENT_NAME: "BED, ELECTRIC" }];
  const twelve = Array.from({ length: 12 }, (_, i) => ({ IEN: String(i) }));
  const r = judgeAi({
    quick: [
      { id: "AIQ.CapitalPlanningTotals", wording: "What are the capital-planning totals?", chatbot: { rows: totals, columns: Object.keys(totals[0]), rowCount: 1, truncated: false }, direct: totals },
      { id: "AIQ.AgingOutFY", wording: "Which items age out in FY2030?", chatbot: { rows: one, columns: ["IEN", "MFGR__EQUIPMENT_NAME"], rowCount: 1, truncated: false }, direct: one },
      { id: "AIQ.HighValueNoContract", wording: "High value, no contract?", chatbot: { rows: twelve, columns: ["IEN"], rowCount: 12, truncated: false }, direct: twelve },
      { id: "AIQ.JCAHOPendingInspection", chatbot: { rows: [], columns: [], rowCount: 0, truncated: false }, direct: [] },
    ],
    count: { result: { rows: [{ n: 295 }], columns: ["n"], rowCount: 1 }, reply: "We have 295 pieces of equipment.", reference: 295 },
    guard: [{ sql: "SELECT 1", allowed: true, got: true }],
  });
  assert.ok(r.ok, r.problems.join("; "));
  const [t, a, h, j, c, g] = r.items;
  assert.equal(t.question, "What are the capital-planning totals?");
  assert.equal(t.chatbot, "TOTAL_COUNT 295 · SUM_TOTAL_ASSET_VALUE 1234567.5 · CAPITALIZED_COUNT 40");
  assert.equal(t.vista, t.chatbot);
  assert.equal(a.question, "Which items age out in FY2030?");
  assert.equal(a.chatbot, "1 row: IEN 7 · MFGR__EQUIPMENT_NAME BED, ELECTRIC");
  assert.equal(h.chatbot, "12 rows");
  assert.equal(h.vista, "12 rows");
  assert.equal(j.question, "AIQ.JCAHOPendingInspection", "falls back to the id when there is no wording");
  assert.equal(j.chatbot, "0 rows");
  assert.equal(c.question, "How many pieces of equipment do we have?");
  assert.equal(c.vista, "295");
  assert.match(g.question, /guard/i);
  for (const i of r.items) assert.doesNotMatch(`${i.chatbot} ${i.vista}`, /\b1 rows\b/);
});

test("judgeAi items: a single-value result shows the value; a truncated one says only the first rows were shown", () => {
  const capped = Array.from({ length: 3 }, (_, i) => ({ IEN: String(i) }));
  const r = judgeAi({
    quick: [
      { id: "AIQ.A", wording: "Count?", chatbot: { rows: [{ N: "42" }], columns: ["N"], rowCount: 1, truncated: false }, direct: [{ N: "42" }] },
      { id: "AIQ.B", wording: "List?", chatbot: { rows: capped, columns: ["IEN"], rowCount: 3, truncated: true }, direct: [...capped, { IEN: "9" }] },
    ],
    rowCap: 3,
  });
  assert.ok(r.ok, r.problems.join("; "));
  assert.equal(r.items[0].chatbot, "42");
  assert.equal(r.items[1].chatbot, "first 3 rows (truncated)");
  assert.equal(r.items[1].vista, "4 rows");
});

test("main() passes each question's wording to the finish table", async () => {
  const { status } = await runMainWith(setupCompleteAiSpecs(), {});
  assert.equal(status.state, "done", status.error);
  const qs = status.verification.map(v => v.question);
  for (const w of ["Ages out?", "High value?", "JCAHO?", "Totals?", "How many pieces of equipment do we have?"]) assert.ok(qs.includes(w), w);
  assert.ok(!qs.some(q => /^AIQ\./.test(q)), "no template ids");
});
