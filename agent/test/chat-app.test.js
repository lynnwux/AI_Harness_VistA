"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { chatAppFiles } = require("../lib/chat-app");
const { GUARD_CASES } = require("../lib/ai-hub");

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

test("chatAppFiles: truncation text shows the row cap and 'refine' without implying a known total", () => {
  const files = chatAppFiles({ questions: QUESTIONS });
  const app = files["src/app/app.ts"];
  // Row cap value (200) must appear as the component property value
  assert.ok(app.includes("200"),
    "truncation row cap value (200) must appear in app.ts");
  // Must say there are more rows without claiming a total
  assert.ok(app.includes("there are more"),
    "truncation message must say 'there are more' (not 'first 200 of N' which implies a known total)");
  assert.ok(app.includes("refine"),
    "truncation message must include 'refine'");
  // Must NOT use rowCount (the server's capped count = 200, would always read "first 200 of 200")
  // The rowCap component property is used instead
  assert.ok(!app.includes("ans.rowCount"),
    "template must not use ans.rowCount in the truncation notice — it equals the cap, not the real total");
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
    entryForm: { built: true },
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
const REAL_KNOWN_GOOD   = path.join(__dirname, "..", "_known-good");
const beforeKnownGood   = fs.existsSync(REAL_KNOWN_GOOD);

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
    const fakeBuildChat  = async (questions, outDir) => { capturedQuestions = questions; fs.mkdirSync(outDir, { recursive: true }); fs.writeFileSync(path.join(outDir, "index.html"), "chat"); };

    // Minimal success fake for the Task-8 verification step (no real HTTP calls).
    const FAKE_ROWS = [{ IEN: "1", NAME: "Ventilator" }, { IEN: "2", NAME: "Pump" }];
    const fakeFetch = async (url, opts) => {
      const body = JSON.parse((opts && opts.body) || "{}");
      if (/\/equipmentai\/quick\//.test(url)) {
        return { ok: true, json: () => Promise.resolve({ reply: "2 results", tool: "RunQuery", sql: "", columns: ["IEN","NAME"], rows: FAKE_ROWS, rowCount: 2, truncated: false }) };
      }
      if (/\/equipmentai\/chat/.test(url)) {
        return { ok: true, json: () => Promise.resolve({ reply: "We have 295 pieces of equipment.", tool: "RunQuery", sql: "", columns: ["n"], rows: [{ n: 295 }], rowCount: 1, truncated: false }) };
      }
      if (/\/equipmentai\/guard/.test(url)) {
        const gc = GUARD_CASES.find(c => c.sql === body.sql);
        return { ok: true, json: () => Promise.resolve({ ok: gc ? gc.allowed : false, reason: gc && !gc.allowed ? "blocked" : "" }) };
      }
      if (/\/api\/atelier\//.test(url)) {
        const sql = (body.query || "").trim();
        if (/^SELECT\s+COUNT\(\*\)\s+AS\s+n\s+FROM/i.test(sql)) {
          return { ok: true, json: () => Promise.resolve({ result: { content: [{ n: 295 }] }, status: { errors: [] } }) };
        }
        return { ok: true, json: () => Promise.resolve({ result: { content: FAKE_ROWS }, status: { errors: [] } }) };
      }
      throw new Error("Unexpected URL in chat-app test fakeFetch: " + url);
    };

    await main(paths, {
      _irisSession:   fakeSession,
      _irisScript:    fakeIrisScript,
      _statusFile:    fakeStatus,
      _configFile:    fakeConfig,
      _productionDir: fakeProdDir,
      _buildChatApp:  fakeBuildChat,
      _chatOut:       path.join(fakeProdDir, "chat-out"),
      _knownGoodRoot: path.join(fakeProdDir, "known-good"),
      _fetch:         fakeFetch,
    });

    const status = JSON.parse(fs.readFileSync(fakeStatus, "utf8"));
    assert.equal(status.state, "done",
      "state must be 'done' when all steps succeed");
    assert.match(status.step, /Deployed/,
      "step must say Deployed");

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
  if (!beforeKnownGood) assert.ok(!fs.existsSync(REAL_KNOWN_GOOD), "agent/_known-good/ must not be created by tests — main() must use the injected _knownGoodRoot");
  if (!beforeChatExists) {
    assert.ok(!fs.existsSync(REAL_CHAT_DIR),
      "prototype/chat/ must not be created by tests — _buildChatApp must use injected path");
  }
});

// ── Final review C1: rows are objects keyed by column ─────────────────────────
// A tiny render of the results table's template: each *ngFor must iterate an array (NgFor throws NG02200 on a
// plain object), and each cell's expression is evaluated against a sample row shaped like Atelier's
// result.content — one object per row, keyed by column.
function renderResultTable(app, ans) {
  const tbody = /<tbody>([\s\S]*?)<\/tbody>/.exec(app);
  assert.ok(tbody, "the results table has a tbody");
  const m = /^<tr \*ngFor="let (\w+) of ([\w.]+)"><td \*ngFor="let (\w+) of ([\w.]+)">\{\{([^}]+)\}\}<\/td><\/tr>$/.exec(tbody[1].trim());
  assert.ok(m, "tbody is one row loop with one cell loop: " + tbody[1].trim());
  const [, rowVar, rowsExpr, cellVar, cellsExpr, cellExpr] = m;
  const evalIn = (expr, scope) => new Function(...Object.keys(scope), "return (" + expr + ");")(...Object.values(scope));
  const rows = evalIn(rowsExpr, { ans });
  assert.ok(Array.isArray(rows), `${rowsExpr} must be an array for *ngFor`);
  return rows.map(r => {
    const cells = evalIn(cellsExpr, { ans, [rowVar]: r });
    assert.ok(Array.isArray(cells), `${cellsExpr} must be an array for *ngFor (NgFor cannot iterate a row object)`);
    return cells.map(c => String(evalIn(cellExpr, { ans, [rowVar]: r, [cellVar]: c })));
  });
}

test("chatAppFiles: the results table indexes each row object by column, in the columns' order", () => {
  const app = chatAppFiles({ questions: QUESTIONS })["src/app/app.ts"];
  const ans = { columns: ["IEN", "MFGR__EQUIPMENT_NAME", "EQUIPMENT_CATEGORY_NAME"],
                rows: [{ EQUIPMENT_CATEGORY_NAME: "BEDS", IEN: "12", MFGR__EQUIPMENT_NAME: "BED, ELECTRIC" },
                       { IEN: "13", MFGR__EQUIPMENT_NAME: "PUMP", EQUIPMENT_CATEGORY_NAME: "INFUSION" }] };
  assert.deepEqual(renderResultTable(app, ans), [["12", "BED, ELECTRIC", "BEDS"], ["13", "PUMP", "INFUSION"]]);
  assert.match(app, /<th \*ngFor="let c of ans\.columns">\{\{c\}\}<\/th>/, "the header row lists the columns");
});
