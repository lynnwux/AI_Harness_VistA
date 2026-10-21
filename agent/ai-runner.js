"use strict";
// The AI-layer build: reads the AI spec, generates the EquipmentAI classes, pushes and compiles them into
// iris-ai-hub, configures IRIS settings and credentials, and creates the /equipmentai web app.
// Host and all secrets come only from the environment (agent/.env, git-ignored).
// Task 7 will add the chat-app build step; Task 8 will add verification and mark the layer built+verified.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { DEFAULT_PATHS, loadInputs, inputHashes } = require("./lib/specs");
const { aiClasses, PKG, WEB_APP, CREDENTIALS, GUARD_CASES } = require("./lib/ai-hub");
const { serverEntry, docPath, redact, irisSession, irisScript } = require("./lib/iris-deploy");
const { DEFAULT_REGION, DEFAULT_MODEL_ID } = require("./lib/bedrock");
const { chatAppFiles } = require("./lib/chat-app");
const { buildAngularApp } = require("./lib/angular-build");
const { DEFAULT_COMPONENT_FILES } = require("./lib/angular-app");

const STATUS_FILE  = path.join(__dirname, "ai-status.json");
const CONFIG_FILE  = path.join(__dirname, "interclaw-servers.json");
const SERVER       = "iris-ai-hub";
const CHAT_OUT     = path.join(__dirname, "..", "prototype", "chat");
const CHAT_HREF    = "/prototype/chat/";

// Default real chat-app build: scaffold → generate → compile → publish to outDir.
// Uses a fresh temp workspace so it never writes under agent/_build or collides with build-runner.js.
async function _defaultBuildChatApp(questions, outDir) {
  const tmpWork = fs.mkdtempSync(path.join(os.tmpdir(), "eqchat-"));
  try {
    await buildAngularApp({
      workRoot:    tmpWork,
      name:        "eqchat",
      files:       chatAppFiles({ questions, title: "Equipment inventory assistant" }),
      removeFiles: DEFAULT_COMPONENT_FILES,
      baseHref:    CHAT_HREF,
      outDir,
      // no log — progress goes nowhere in the background runner
    });
  } finally {
    try { fs.rmSync(tmpWork, { recursive: true, force: true }); } catch (_) {}
  }
}

// The fixed Atelier SQL path that the AI layer uses for VistA queries (same as server.js ATELIER_QUERY).
const VADEMO_PATH = "/api/atelier/v1/VISTA-DIEGO/action/query";

const readJson = f => JSON.parse(fs.readFileSync(f, "utf8"));
const osq = s => '"' + String(s == null ? "" : s).replace(/"/g, '""') + '"';

// Read and validate the AI spec from paths.specsDir/ai.json; throw if stale or not complete.
function readAiSpec(paths = DEFAULT_PATHS) {
  const aiSpec = readJson(path.join(paths.specsDir, "ai.json"));
  const inputs = loadInputs(paths);
  const want = JSON.stringify(inputHashes("ai", inputs));
  const got  = JSON.stringify(aiSpec.inputs);
  if (want !== got) {
    throw new Error("the AI spec is stale — it no longer matches the decisions record; reload the Decide page and build again");
  }
  if (!aiSpec.complete) throw new Error("the AI spec is not complete — finish its missing items in the Decide chat first");
  return { ai: aiSpec, inventory: inputs.inventory };
}

// Generate the ObjectScript session script that writes the AI-layer settings and stores the credentials.
// Secrets (VADEMO password, Bedrock token) appear only inside SetCredential(…) calls — never on a command
// line, a log line, a status file or an error message.
function aiSettingsScript(env) {
  const urlStr = ((env.VADEMO_URL_FROM_IRIS || env.VADEMO_URL) || "").replace(/\/+$/, "");
  if (!urlStr) throw new Error("VADEMO_URL_FROM_IRIS or VADEMO_URL is not set — add it to agent/.env");
  const u = new URL(urlStr);
  const vademoServer = u.hostname;
  const vademoPort   = u.port || (u.protocol === "https:" ? "443" : "80");
  const region = ((env.AWS_DEFAULT_REGION || DEFAULT_REGION) || "").trim() || DEFAULT_REGION;

  // Use the read-only login when provided, else fall back to the main login.
  const vuser = (env.VADEMO_READ_USER  || env.VADEMO_USER  || "").trim();
  const vpass =  env.VADEMO_READ_PASSWORD != null ? String(env.VADEMO_READ_PASSWORD)
               : String(env.VADEMO_PASSWORD || "");
  const btoken = String(env.AWS_BEARER_TOKEN_BEDROCK || "");

  const ns       = "INTEROP";   // AI classes always live in INTEROP (global constraint)
  const dispatch = `${PKG}.REST.Dispatch`;

  return [
    `zn "%SYS"`,
    `if '##class(Security.Applications).Exists(${osq(WEB_APP)}) { set p("NameSpace")=${osq(ns)},p("DispatchClass")=${osq(dispatch)},p("AutheEnabled")=32,p("Enabled")=1 set sc=##class(Security.Applications).Create(${osq(WEB_APP)},.p) write "WEBAPP:",$select(sc=1:"created",1:$system.Status.GetErrorText(sc)),! } else { write "WEBAPP:exists",! }`,
    `zn ${osq(ns)}`,
    `set ^${PKG}.Config("vademoServer")=${osq(vademoServer)}`,
    `set ^${PKG}.Config("vademoPort")=${osq(vademoPort)}`,
    `set ^${PKG}.Config("vademoPath")=${osq(VADEMO_PATH)}`,
    `set ^${PKG}.Config("bedrockRegion")=${osq(region)}`,
    `write "CONFIG:set",!`,
    // Secrets live only in the SetCredential calls below — never in a log line or status file.
    `set sc=##class(Ens.Config.Credentials).SetCredential(${osq(CREDENTIALS.vademo)},${osq(vuser)},${osq(vpass)},1) write "VADEMO:",$select(sc=1:"stored",1:$system.Status.GetErrorText(sc)),!`,
    `set sc=##class(Ens.Config.Credentials).SetCredential(${osq(CREDENTIALS.bedrock)},"",${osq(btoken)},1) write "BEDROCK:",$select(sc=1:"stored",1:$system.Status.GetErrorText(sc)),!`,
    `halt`,
    "",
  ].join("\n");
}

// ── Task 8 pure functions ──────────────────────────────────────────────────────────────────────────

// Canonical string for a row object: sorted keys, values as trimmed strings (null/"" both become "").
function normalizeRow(row) {
  if (!row || typeof row !== "object") return String(row == null ? "" : row).trim();
  return Object.keys(row).sort().map(k => {
    const v = row[k];
    return k + "=" + String(v == null ? "" : v).trim();
  }).join("\x00");
}

// Order-insensitive row comparison; values compared as trimmed strings.
function sameRows(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  if (a.length !== b.length) return false;
  const na = a.map(normalizeRow).sort();
  const nb = b.map(normalizeRow).sort();
  return na.every((v, i) => v === nb[i]);
}

// For a single-row/single-column result whose value is numeric, return that number; otherwise rowCount.
function countFrom(result) {
  if (!result) return null;
  const rows = result.rows || [];
  const cols = result.columns || [];
  if (rows.length === 1 && cols.length === 1) {
    const v = rows[0][cols[0]];
    const trimmed = String(v == null ? "" : v).trim();
    const n = Number(trimmed);
    if (trimmed !== "" && !isNaN(n)) return n;
  }
  return typeof result.rowCount === "number" ? result.rowCount : null;
}

// Does reply contain n (integer) with or without thousands-separator commas, as a whole number?
// "We have 1,295 items" matches 1295; "12950" does not match 1295.
function countInReply(reply, n) {
  const s = String(Math.round(Number(n)));
  let pat = "";
  for (let i = 0; i < s.length; i++) {
    if (i > 0 && (s.length - i) % 3 === 0) pat += ",?";
    pat += s[i];
  }
  return new RegExp("(?<!\\d)" + pat + "(?!\\d)").test(reply);
}

// Evaluate all three verification axes. Returns { ok, problems }.
// quick[]: { id, chatbot (full result obj with rows/rowCount/truncated), direct (rows array) }
// count:   { result (chatbot full result), reply (string), reference (number) } — null to skip
// guard[]: { sql, allowed (bool), got (bool) }
// Comparison rules (ruling 4):
//   Not truncated: compare as sets with sameRows (order-insensitive).
//   Truncated:     compare chatbot.rowCount <= direct.length + subset check (each chatbot row in direct).
function judgeAi({ quick = [], count = null, guard = [] }) {
  const problems = [];

  for (const q of quick) {
    const chatbotRows = (q.chatbot && q.chatbot.rows) || [];
    const directRows  = q.direct || [];
    const truncated   = !!(q.chatbot && q.chatbot.truncated);
    let ok;
    if (!truncated) {
      ok = sameRows(chatbotRows, directRows);
    } else {
      // Truncated path: all 200 chatbot rows must be present in the full direct result.
      const directNorm  = new Set(directRows.map(normalizeRow));
      const allPresent  = chatbotRows.every(r => directNorm.has(normalizeRow(r)));
      ok = chatbotRows.length <= directRows.length && allPresent;
    }
    if (!ok) {
      const cb = truncated
        ? `${(q.chatbot && q.chatbot.rowCount) || chatbotRows.length} rows (truncated)`
        : `${chatbotRows.length} rows`;
      problems.push(`question ${q.id}: chatbot returned ${cb}, VistA returned ${directRows.length} rows`);
    }
  }

  if (count) {
    const n         = count.reference;
    const chatCount = countFrom(count.result);
    const replyOk   = n != null && countInReply(count.reply || "", n);
    const countOk   = replyOk || (chatCount != null && n != null && String(chatCount).trim() === String(n).trim());
    if (!countOk) {
      problems.push(`count mismatch: chatbot="${String(count.reply || "").trim().slice(0, 80)}", VistA=${n}`);
    }
  }

  for (const g of guard) {
    if (g.got !== g.allowed) {
      problems.push(`guard case "${String(g.sql).slice(0, 60)}": expected allowed=${g.allowed}, got ${g.got}`);
    }
  }

  return { ok: problems.length === 0, problems };
}

// Check that every expected marker line came back with its success value.
// Returns an array of problem descriptions (empty when all is well).
// This is the primary guard against a silent false-success when the container is missing,
// IRIS is down, or auth is refused — marker lines will be absent or show error text.
function checkSettingsMarkers(irisOut) {
  const said = k => ((irisOut || "").match(new RegExp(`^${k}:(.*)$`, "m")) || [])[1];
  const problems = [];
  const webapp = said("WEBAPP");
  if (webapp !== "created" && webapp !== "exists")
    problems.push(`WEBAPP: expected "created" or "exists", got "${webapp || "(missing)"}"`);
  const config = said("CONFIG");
  if (config !== "set")
    problems.push(`CONFIG: expected "set", got "${config || "(missing)"}"`);
  const vademo = said("VADEMO");
  if (vademo !== "stored")
    problems.push(`VADEMO credential: expected "stored", got "${vademo || "(missing)"}"`);
  const bedrock = said("BEDROCK");
  if (bedrock !== "stored")
    problems.push(`BEDROCK credential: expected "stored", got "${bedrock || "(missing)"}"`);
  return problems;
}

// _deps allows test injection of irisSession, irisScript, output paths, and the chat-app build so
// tests never write to the real agent/ paths or prototype/chat/.
async function main(paths = DEFAULT_PATHS, _deps = {}) {
  const {
    _irisSession:   sessionFn      = irisSession,
    _irisScript:    scriptFn       = irisScript,
    _statusFile:    statusFile     = STATUS_FILE,
    _configFile:    configFile     = CONFIG_FILE,
    _productionDir: productionDir  = path.join(__dirname, "_production"),
    _buildChatApp:  buildChatApp   = _defaultBuildChatApp,
    _fetch:         fetchFn        = (typeof fetch === "function" ? fetch : null),
  } = _deps;

  const status = { state: "building", step: "", log: [], error: null, startedAt: new Date().toISOString() };
  const save  = () => fs.writeFileSync(statusFile, JSON.stringify(status, null, 2));
  const step  = s => { status.step = s; status.log.push("▶ " + s); save(); };
  const note  = s => { status.log.push("  " + s); save(); };

  // Secrets collected here; used only for redacting logs/errors — never written to status or logs directly.
  const secrets = [];
  const safeNote = s => note(redact(s, secrets));

  try {
    step("Reading the AI spec");
    const { ai, inventory } = readAiSpec(paths);
    const d = ai.detail;

    const { IRIS_AI_HUB_URL: url, IRIS_AI_HUB_USER: user, IRIS_AI_HUB_PASSWORD: pass } = process.env;
    const { INTERCLAW_SCRIPTS: scripts } = process.env;

    // Collect secrets for redaction BEFORE any error that might mention them.
    const vuser  = (process.env.VADEMO_READ_USER || process.env.VADEMO_USER || "").trim();
    const vpass  = process.env.VADEMO_READ_PASSWORD != null ? process.env.VADEMO_READ_PASSWORD
                 : (process.env.VADEMO_PASSWORD || "");
    const btoken = process.env.AWS_BEARER_TOKEN_BEDROCK || "";
    if (vpass)  secrets.push(vpass);
    if (btoken) secrets.push(btoken);
    if (pass)   secrets.push(pass);

    if (!url)         throw new Error("IRIS_AI_HUB_URL is not set — add it to agent/.env");
    if (!user || !pass) throw new Error("IRIS_AI_HUB_USER and IRIS_AI_HUB_PASSWORD are not set — add them to agent/.env");
    if (!scripts || !fs.existsSync(path.join(scripts, "lib", "iris.py"))) {
      throw new Error("INTERCLAW_SCRIPTS must point at the interclaw skill's scripts folder (agent/.env)");
    }

    const entry = serverEntry(url);
    fs.writeFileSync(configFile, JSON.stringify(entry, null, 2) + "\n");

    step("Generating the AI classes from the spec");
    const model   = process.env.BEDROCK_MODEL_ID || DEFAULT_MODEL_ID;
    const classes = aiClasses({ ai, inventory, model });
    const dir = path.join(productionDir, "ai-run-" + new Date().toISOString().replace(/[:.]/g, "-"));
    fs.mkdirSync(dir, { recursive: true });
    for (const c of classes) fs.writeFileSync(path.join(dir, c.name), c.text);
    note(`${classes.length} classes written to ${path.relative(__dirname, dir)}`);

    const env  = { ...process.env, IRIS_USERNAME: user, IRIS_PASSWORD: pass };
    const iris = scriptFn(env, SERVER, configFile);

    step(`Pushing the AI classes to ${d.container}, namespace ${d.namespace}`);
    for (const c of classes) {
      iris("PUT", docPath(d.namespace, c.name), ["--input", path.join(dir, c.name)]);
      note("pushed " + c.name);
    }

    step("Compiling");
    const out = iris("POST", `/v2/${d.namespace}/action/compile?flags=cuk`, ["--body", JSON.stringify(classes.map(c => c.name))]);
    const consoleLines = [].concat((out && out.console) || []);
    const errors = consoleLines.filter(l => /ERROR/.test(l));
    if (errors.length) throw new Error(redact("compile errors:\n" + errors.join("\n"), secrets));
    note("compiled with no errors");

    step(`Configuring IRIS settings and creating the ${WEB_APP} web app`);
    const script  = aiSettingsScript(process.env);
    const irisOut = sessionFn(d.container, script);

    // Primary guard: verify every marker line came back with its success value.
    // A missing container, IRIS outage or auth failure leaves the output empty or garbled,
    // so the absence of a marker is always caught here — independently of the exit code.
    const settingsProblems = checkSettingsMarkers(irisOut);
    if (settingsProblems.length) {
      throw new Error("IRIS settings step failed — " + settingsProblems.join("; "));
    }

    // Log only the non-secret summary lines; never log irisOut directly (it echoes the SetCredential calls).
    const said = k => ((irisOut || "").match(new RegExp(`^${k}:(.*)$`, "m")) || [])[1];
    safeNote(`web app: ${said("WEBAPP")} · config: ${said("CONFIG")} · vademo: ${said("VADEMO")} · bedrock: ${said("BEDROCK")}`);

    // ── Task 7: build the chat app ──────────────────────────────────────────
    step("Building the chat app");
    await buildChatApp(d.questions, CHAT_OUT);
    note("chat app built → " + CHAT_HREF);

    // ── Task 8: verify the chatbot against VistA ─────────────────────────────────
    step("Verifying the chatbot against VistA");

    if (!fetchFn) throw new Error("fetch is not available — Node 18+ required for verification");

    const vademoUrl = (process.env.VADEMO_URL || "").replace(/\/+$/, "");
    if (!vademoUrl) throw new Error("VADEMO_URL is not set — add it to agent/.env");

    const hubBase   = (url || "").replace(/\/+$/, "");
    const hubAuth   = "Basic " + Buffer.from(`${user}:${pass}`).toString("base64");
    const atAuth    = "Basic " + Buffer.from(`${vuser}:${vpass}`).toString("base64");
    const atUrl     = vademoUrl + VADEMO_PATH;

    // POST to the hub; redact any secrets that might appear in error text.
    async function hubPost(p, body) {
      const r = await fetchFn(hubBase + p, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": hubAuth },
        body: JSON.stringify(body),
      });
      return r.json();
    }

    // POST direct SQL to VADEMO's Atelier endpoint; return content rows (array).
    async function directQuery(sql) {
      const r    = await fetchFn(atUrl, {
        method:  "POST",
        headers: { "Content-Type": "application/json", "Authorization": atAuth },
        body:    JSON.stringify({ query: sql }),
      });
      const data = await r.json();
      if (data.status && data.status.errors && data.status.errors.length) {
        throw new Error(redact("VistA error: " + (data.status.errors[0].error || "unknown"), secrets));
      }
      return (data.result && data.result.content) || [];
    }

    // 1. Quick questions: for each kept question, compare chatbot vs direct.
    const sessionId = "verify-" + Date.now();
    const quickInput = [];
    for (const q of d.questions) {
      const qId      = q.id.replace(/^AIQ\./, "");
      const chatbot  = await hubPost(`/equipmentai/quick/${encodeURIComponent(qId)}`, { sessionId });
      const direct   = await directQuery(q.sql);
      quickInput.push({ id: q.id, chatbot, direct });
      const cb = chatbot.truncated ? `${chatbot.rowCount} rows (truncated)` : `${chatbot.rowCount} rows`;
      safeNote(`quick ${q.id}: chatbot=${cb}, vista=${direct.length} rows`);
    }

    // 2. Count check: ask chat "How many pieces of equipment do we have?" — one retry on failure.
    const countQ      = "How many pieces of equipment do we have?";
    const countRefSQL = "SELECT COUNT(*) AS n FROM VISTA.EQUIPMENT_INV_6914";
    let countChat     = await hubPost("/equipmentai/chat", { sessionId: "verify-count-" + Date.now(), message: countQ });
    const countDirect = await directQuery(countRefSQL);
    const countRef    = countFrom({ rows: countDirect, rowCount: countDirect.length,
                                    columns: countDirect.length ? Object.keys(countDirect[0]) : [] });
    const countOkFirst = countRef != null && (
      countInReply(countChat.reply || "", countRef) ||
      String(countFrom(countChat)).trim() === String(countRef).trim()
    );
    if (!countOkFirst) {
      // one retry with a fresh session
      const retryChat = await hubPost("/equipmentai/chat", { sessionId: "verify-retry-" + Date.now(), message: countQ });
      const retryOk   = countRef != null && (
        countInReply(retryChat.reply || "", countRef) ||
        String(countFrom(retryChat)).trim() === String(countRef).trim()
      );
      if (retryOk) countChat = retryChat;
    }

    // 3. Guard cases: replay every GUARD_CASES entry through /guard.
    const guardInput = [];
    for (const gc of GUARD_CASES) {
      const resp = await hubPost("/equipmentai/guard", { sql: gc.sql });
      guardInput.push({ sql: gc.sql, allowed: gc.allowed, got: resp.ok === true });
    }

    // Build status.verification (short human-readable entries).
    const verificationRows = [];
    for (const q of quickInput) {
      const chatbotRows = (q.chatbot && q.chatbot.rows) || [];
      const truncated   = !!(q.chatbot && q.chatbot.truncated);
      const cb   = truncated ? `${(q.chatbot.rowCount || chatbotRows.length)} rows (truncated)` : `${chatbotRows.length} rows`;
      const vista = `${q.direct.length} rows`;
      const ok   = truncated
        ? (chatbotRows.length <= q.direct.length && chatbotRows.every(r => { const dn = new Set(q.direct.map(normalizeRow)); return dn.has(normalizeRow(r)); }))
        : sameRows(chatbotRows, q.direct);
      verificationRows.push({ question: q.id, chatbot: cb, vista, ok });
    }
    // Count entry
    const countOk = countRef != null && (
      countInReply(countChat.reply || "", countRef) ||
      String(countFrom(countChat)).trim() === String(countRef).trim()
    );
    verificationRows.push({
      question: "count",
      chatbot:  redact(String(countChat.reply || "(no reply)").slice(0, 80), secrets),
      vista:    `${countRef}`,
      ok:       countOk,
    });
    // Guard summary entry
    const guardFail = guardInput.filter(g => g.got !== g.allowed).length;
    verificationRows.push({ question: "guard", chatbot: `${GUARD_CASES.length - guardFail}/${GUARD_CASES.length} passed`, vista: "expected", ok: guardFail === 0 });

    status.verification = verificationRows;
    save();

    const judgeResult = judgeAi({
      quick:  quickInput,
      count:  { result: countChat, reply: countChat.reply || "", reference: countRef },
      guard:  guardInput,
    });

    if (!judgeResult.ok) {
      throw new Error("verification failed:\n" + judgeResult.problems.map(p => "  • " + p).join("\n"));
    }

    // Write implemented.ai — only on success (ruling 2).
    const implData = JSON.parse(fs.readFileSync(paths.implemented, "utf8"));
    implData.ai = { built: true, verified: true, verifiedAt: new Date().toISOString() };
    fs.writeFileSync(paths.implemented, JSON.stringify(implData, null, 2) + "\n");
    note("implemented.ai marked verified");

    status.state   = "done";
    status.step    = "Deployed and verified";
    status.chatUrl = CHAT_HREF;
    status.log.push("✅ Deployed and verified · chat: " + CHAT_HREF);
    save();

  } catch (e) {
    status.state = "error";
    status.error = redact(String(e.message || e), secrets);
    status.log.push("✗ " + status.error);
    save();
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = { readAiSpec, aiSettingsScript, checkSettingsMarkers, main, STATUS_FILE,
                   sameRows, countFrom, countInReply, judgeAi };
