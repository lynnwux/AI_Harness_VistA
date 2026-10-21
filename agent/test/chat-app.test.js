"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { chatAppFiles } = require("../lib/chat-app");

// ── chatAppFiles ─────────────────────────────────────────────────────────────

const QUESTIONS = [
  { id: "AIQ.AgingOutFY",           wording: "What equipment ages out in FY2031?" },
  { id: "AIQ.HighValueNoContract",  wording: "What high-value equipment lacks a contract?" },
];

test("chatAppFiles returns the four Angular source files", () => {
  const files = chatAppFiles({ questions: QUESTIONS });
  const keys = Object.keys(files).sort();
  assert.deepEqual(keys, ["src/app/app.ts", "src/index.html", "src/main.ts", "src/styles.css"]);
});

test("chatAppFiles: each question wording appears in the app", () => {
  const files = chatAppFiles({ questions: QUESTIONS });
  const app = files["src/app/app.ts"];
  for (const q of QUESTIONS) {
    assert.ok(app.includes(q.wording), `wording "${q.wording}" must appear in app.ts`);
  }
});

test("chatAppFiles: each question's /ai/quick/<id> URL appears", () => {
  const files = chatAppFiles({ questions: QUESTIONS });
  const app = files["src/app/app.ts"];
  for (const q of QUESTIONS) {
    assert.ok(
      app.includes("/ai/quick/" + q.id),
      `/ai/quick/${q.id} must appear in app.ts (embedded in QUESTIONS JSON)`
    );
  }
});

test("chatAppFiles: /ai/chat call appears", () => {
  const files = chatAppFiles({ questions: QUESTIONS });
  const app = files["src/app/app.ts"];
  assert.ok(app.includes("/ai/chat"), "/ai/chat must appear in app.ts");
});

test("chatAppFiles: truncation text (first 200 of N, refine) appears", () => {
  const files = chatAppFiles({ questions: QUESTIONS });
  const app = files["src/app/app.ts"];
  assert.ok(app.includes("200"),
    "truncation row cap (200) must appear in app.ts");
  assert.ok(app.includes("refine"),
    "truncation message must include 'refine' (\"refine the question to see the rest\")");
});

test("chatAppFiles: 'SQL used' collapsible section appears", () => {
  const files = chatAppFiles({ questions: QUESTIONS });
  const app = files["src/app/app.ts"];
  assert.ok(app.includes("SQL used"), "'SQL used' label must appear in app.ts");
});

test("chatAppFiles: header title 'Equipment inventory assistant' appears", () => {
  const files = chatAppFiles({ questions: QUESTIONS });
  const app = files["src/app/app.ts"];
  assert.ok(app.includes("Equipment inventory assistant"), "header title must appear in app.ts");
});

test("chatAppFiles: session id uses crypto.randomUUID()", () => {
  const files = chatAppFiles({ questions: QUESTIONS });
  const app = files["src/app/app.ts"];
  assert.ok(app.includes("randomUUID"), "sessionId must come from crypto.randomUUID()");
});

test("chatAppFiles: reply and error bound with safe text binding, not innerHTML", () => {
  const files = chatAppFiles({ questions: QUESTIONS });
  const app = files["src/app/app.ts"];
  // reply must be rendered somewhere
  assert.ok(app.includes("reply"), "reply must be referenced in app.ts");
  // [innerHTML] must not be used on server-supplied text fields
  const lines = app.split("\n");
  const dangerous = lines.filter(l =>
    l.includes("[innerHTML]") && (l.includes("reply") || l.includes("error") || l.includes("ans."))
  );
  assert.equal(dangerous.length, 0,
    "must not use [innerHTML] for server reply/error text — Angular default text binding is safe");
});

test("chatAppFiles: no localhost:9092 or credentials in any file", () => {
  const files = chatAppFiles({ questions: QUESTIONS });
  for (const [name, content] of Object.entries(files)) {
    assert.ok(!content.includes("localhost:9092"),
      `${name} must not contain localhost:9092`);
    assert.ok(!content.toLowerCase().includes("password"),
      `${name} must not contain 'password'`);
    assert.ok(!content.toLowerCase().includes("credential"),
      `${name} must not contain 'credential'`);
  }
});

test("chatAppFiles: works with zero questions (only chat path)", () => {
  const files = chatAppFiles({ questions: [] });
  assert.ok(files["src/app/app.ts"], "must generate app.ts even with no questions");
  assert.ok(files["src/app/app.ts"].includes("/ai/chat"),
    "chat endpoint must still be present with no quick-access questions");
});

// ── ai-runner integration: _buildChatApp ────────────────────────────────────

const { generate, writeSpecs } = require("../lib/specs");
const { graph, rec }           = require("./helpers");
const { main, STATUS_FILE }    = require("../ai-runner");

const INVENTORY_PATH = path.join(__dirname, "..", "..", "capability-graph", "inventory-fields.json");
const inventory = JSON.parse(fs.readFileSync(INVENTORY_PATH, "utf8"));

const allKept = {
  "AIQ.AgingOutFY":             { keep: true, wording: "Ages out?",   params: { fiscalYear: 2031, capitalizedMeans: "INVESTMENT_CATEGORY = 1", useStatuses: ["ALL"] } },
  "AIQ.HighValueNoContract":    { keep: true, wording: "High value?", params: { threshold: 50000, valueColumn: "TOTAL_ASSET_VALUE", useStatuses: ["ALL"] } },
  "AIQ.JCAHOPendingInspection": { keep: true, wording: "JCAHO?",      params: { workOrderStatusColumn: "STATUS", workOrderStatuses: ["ALL"], useStatuses: ["ALL"] } },
  "AIQ.CapitalPlanningTotals":  { keep: true, wording: "Totals?",     params: { useStatuses: ["ALL"], valueColumns: ["TOTAL_ASSET_VALUE"], groupBy: "none" } },
};

function setupCompleteAiSpecs() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chat-air-"));
  const im = {
    api: [{ id: "read:lookup", endpoint: "GET /lookup/{file}" }],
    orchestrator: { built: true, verified: true },
    ai: { built: false, verified: false },
  };
  const paths = {
    graph:      path.join(dir, "graph.json"),
    decisions:  path.join(dir, "decisions.json"),
    implemented:path.join(dir, "implemented.json"),
    inventory:  path.join(dir, "inventory.json"),
    specsDir:   path.join(dir, "specs"),
  };
  const r = rec({});
  r.aiQuestions = allKept;
  fs.writeFileSync(paths.graph,       JSON.stringify(graph));
  fs.writeFileSync(paths.decisions,   JSON.stringify(r));
  fs.writeFileSync(paths.implemented, JSON.stringify(im));
  fs.writeFileSync(paths.inventory,   JSON.stringify(inventory));
  writeSpecs(paths.specsDir, generate({ graph, record: r, implemented: im, inventory }), { graph, record: r, implemented: im, inventory });
  return { paths, dir };
}

// Snapshot of real agent paths BEFORE any main() test modifies them.
const REAL_STATUS_FILE   = STATUS_FILE;
const beforeStatusExists  = fs.existsSync(REAL_STATUS_FILE);
const beforeStatusContent = beforeStatusExists ? fs.readFileSync(REAL_STATUS_FILE, "utf8") : null;

const REAL_CHAT_DIR     = path.join(__dirname, "..", "..", "prototype", "chat");
const beforeChatExists  = fs.existsSync(REAL_CHAT_DIR);

test("main() calls _buildChatApp with the spec's questions and ends Deployed — not yet verified", async () => {
  const { paths, dir: tmpSetup } = setupCompleteAiSpecs();

  const scriptsDir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-scripts-"));
  fs.mkdirSync(path.join(scriptsDir, "lib"), { recursive: true });
  fs.writeFileSync(path.join(scriptsDir, "lib", "iris.py"), "# fake");

  const tmpDir      = fs.mkdtempSync(path.join(os.tmpdir(), "chat-main-"));
  const fakeStatus  = path.join(tmpDir, "ai-status.json");
  const fakeConfig  = path.join(tmpDir, "interclaw-servers.json");
  const fakeProdDir = path.join(tmpDir, "_production");

  const envKeys = ["IRIS_AI_HUB_URL", "IRIS_AI_HUB_USER", "IRIS_AI_HUB_PASSWORD",
                   "INTERCLAW_SCRIPTS", "VADEMO_URL", "VADEMO_USER", "VADEMO_PASSWORD",
                   "AWS_BEARER_TOKEN_BEDROCK", "BEDROCK_MODEL_ID"];
  const savedEnv      = Object.fromEntries(envKeys.map(k => [k, process.env[k]]));
  const savedExitCode = process.exitCode;

  Object.assign(process.env, {
    IRIS_AI_HUB_URL:          "http://localhost:9999",
    IRIS_AI_HUB_USER:         "testuser",
    IRIS_AI_HUB_PASSWORD:     "fake-hub-pass-789",
    INTERCLAW_SCRIPTS:        scriptsDir,
    VADEMO_URL:               "http://vademo:80",
    VADEMO_USER:              "vademo-reader",
    VADEMO_PASSWORD:          "fake-vademo-pass-123",
    AWS_BEARER_TOKEN_BEDROCK: "fake-bedrock-tok-456",
    BEDROCK_MODEL_ID:         "us.anthropic.example-v1:0",
  });

  let capturedQuestions = null;

  try {
    const fakeIrisScript = () => method => method === "POST" ? { console: [] } : "ok";
    const fakeSession    = () => "WEBAPP:exists\nCONFIG:set\nVADEMO:stored\nBEDROCK:stored\n";
    const fakeBuildChat  = async (questions, _outDir) => { capturedQuestions = questions; };

    await main(paths, {
      _irisSession:   fakeSession,
      _irisScript:    fakeIrisScript,
      _statusFile:    fakeStatus,
      _configFile:    fakeConfig,
      _productionDir: fakeProdDir,
      _buildChatApp:  fakeBuildChat,
    });

    const status = JSON.parse(fs.readFileSync(fakeStatus, "utf8"));
    assert.equal(status.state, "done",
      "state must be 'done' when all steps succeed");
    assert.match(status.step, /Deployed — not yet verified/,
      "step must contain 'Deployed — not yet verified'");

    // _buildChatApp must have been called with the spec's questions
    assert.ok(capturedQuestions !== null,
      "_buildChatApp must have been called");
    assert.ok(Array.isArray(capturedQuestions),
      "questions passed to _buildChatApp must be an array");
    assert.ok(capturedQuestions.length > 0,
      "_buildChatApp must receive the spec's kept questions (not an empty list)");
    assert.ok(capturedQuestions.every(q => q.id && q.wording),
      "each question must carry an id and a wording");

    // The status must reference the chat app's address
    const logText  = status.log.join("\n");
    const hasUrl   = logText.includes("/prototype/chat/") ||
                     String(status.chatUrl || "").includes("/prototype/chat/");
    assert.ok(hasUrl,
      "status must reference the chat app address /prototype/chat/ (in log or chatUrl)");

  } finally {
    process.exitCode = savedExitCode;
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(tmpDir,      { recursive: true, force: true });
    fs.rmSync(scriptsDir,  { recursive: true, force: true });
    fs.rmSync(tmpSetup,    { recursive: true, force: true });
  }
});

test("guard: chat-app tests do not write to agent/ai-status.json or prototype/chat/", () => {
  // Confirms the main() test above used injected temp paths and left real paths untouched.
  if (beforeStatusContent === null) {
    assert.ok(!fs.existsSync(REAL_STATUS_FILE),
      "agent/ai-status.json must not exist after tests — main() must use injected _statusFile path");
  } else {
    assert.equal(
      fs.readFileSync(REAL_STATUS_FILE, "utf8"), beforeStatusContent,
      "agent/ai-status.json must be unchanged after tests — main() must use injected _statusFile path"
    );
  }
  if (!beforeChatExists) {
    assert.ok(!fs.existsSync(REAL_CHAT_DIR),
      "prototype/chat/ must not be created by tests — _buildChatApp must use injected path");
  }
});
