"use strict";
// The AI-layer build: reads the AI spec, generates the EquipmentAI classes, pushes and compiles them into
// iris-ai-hub, configures IRIS settings and credentials, creates the /equipmentai web app, builds the chat app,
// verifies the chatbot against direct VADEMO queries and marks the layer built and verified in implemented.json.
// Host and all secrets come only from the environment (agent/.env, git-ignored).

const fs = require("fs");
const os = require("os");
const path = require("path");
const { DEFAULT_PATHS, loadInputs, inputHashes } = require("./lib/specs");
const { aiClasses, PKG, WEB_APP, CREDENTIALS, GUARD_CASES } = require("./lib/ai-hub");
const { serverEntry, docPath, redact, irisSession, irisScript } = require("./lib/iris-deploy");
const { DEFAULT_REGION, DEFAULT_MODEL_ID } = require("./lib/bedrock");
const { saveKnownGood, KNOWN_GOOD_ROOT } = require("./lib/known-good");
const { chatAppFiles } = require("./lib/chat-app");
const { buildAngularApp } = require("./lib/angular-build");
const { DEFAULT_COMPONENT_FILES } = require("./lib/angular-app");
const { watchParent, sweepWorkspaces, timedFetch } = require("./lib/runner-control");

const STATUS_FILE  = path.join(__dirname, "ai-status.json");
const CONFIG_FILE  = path.join(__dirname, "interclaw-servers.json");
const SERVER       = "iris-ai-hub";
const CHAT_OUT     = path.join(__dirname, "..", "prototype", "chat");
const CHAT_HREF    = "/prototype/chat/";

// Default real chat-app build: scaffold → generate → compile → publish to outDir.
// Uses a fresh temp workspace so it never writes under agent/_build or collides with build-runner.js.
// log receives every command and output line, so a scaffold or compile failure shows its output in the status.
async function _defaultBuildChatApp(questions, outDir, log) {
  const tmpWork = fs.mkdtempSync(path.join(os.tmpdir(), "eqchat-"));
  try {
    await buildAngularApp({
      workRoot:    tmpWork,
      name:        "eqchat",
      files:       chatAppFiles({ questions, title: "Equipment inventory assistant" }),
      removeFiles: DEFAULT_COMPONENT_FILES,
      baseHref:    CHAT_HREF,
      outDir,
      log,
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

// The VADEMO login the AI layer uses, chosen as a pair: the read-only login when VADEMO_READ_USER is set
// (then VADEMO_READ_PASSWORD is required), otherwise VADEMO_USER / VADEMO_PASSWORD. Never a mix of the two.
function vademoLogin(env) {
  const readUser = String(env.VADEMO_READ_USER || "").trim();
  if (readUser) {
    const readPass = env.VADEMO_READ_PASSWORD == null ? "" : String(env.VADEMO_READ_PASSWORD);
    if (!readPass) throw new Error("VADEMO_READ_USER is set but VADEMO_READ_PASSWORD is not — set both in agent/.env, or remove VADEMO_READ_USER to use VADEMO_USER");
    return { user: readUser, password: readPass, readOnly: true };
  }
  const user = String(env.VADEMO_USER || "").trim();
  if (!user) throw new Error("VADEMO_READ_USER or VADEMO_USER is not set — add it to agent/.env");
  return { user, password: String(env.VADEMO_PASSWORD || ""), readOnly: false };
}

// The Bedrock bearer token the chatbot uses; the build stops at the start when it is missing.
function bedrockToken(env) {
  const t = String(env.AWS_BEARER_TOKEN_BEDROCK || "").trim();
  if (!t) throw new Error("AWS_BEARER_TOKEN_BEDROCK is not set — add the Bedrock bearer token to agent/.env, then press 🔨 Build AI again");
  return t;
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

  const { user: vuser, password: vpass } = vademoLogin(env);
  const btoken = bedrockToken(env);

  const ns       = "INTEROP";   // AI classes always live in INTEROP (global constraint)
  const dispatch = `${PKG}.REST.Dispatch`;

  return [
    `zn "%SYS"`,
    `if '##class(Security.Applications).Exists(${osq(WEB_APP)}) { set p("NameSpace")=${osq(ns)},p("DispatchClass")=${osq(dispatch)},p("AutheEnabled")=32,p("Enabled")=1 set sc=##class(Security.Applications).Create(${osq(WEB_APP)},.p) write "WEBAPP:",$select(sc=1:"created",1:$system.Status.GetErrorText(sc)),! } else { set p("NameSpace")=${osq(ns)},p("DispatchClass")=${osq(dispatch)},p("AutheEnabled")=32,p("Enabled")=1 set sc=##class(Security.Applications).Modify(${osq(WEB_APP)},.p) if sc=1 { write "WEBAPP:updated",! } else { write "WEBAPP:ERROR ",$system.Status.GetErrorText(sc),! } }`,
    `zn ${osq(ns)}`,
    `set ^${PKG}.Config("vademoServer")=${osq(vademoServer)}`,
    `set ^${PKG}.Config("vademoPort")=${osq(vademoPort)}`,
    `set ^${PKG}.Config("vademoPath")=${osq(VADEMO_PATH)}`,
    `set ^${PKG}.Config("bedrockRegion")=${osq(region)}`,
    `write "CONFIG:set",!`,
    // Secrets live only in the SetCredential calls below — never in a log line or status file.
    `set sc=##class(Ens.Config.Credentials).SetCredential(${osq(CREDENTIALS.vademo)},${osq(vuser)},${osq(vpass)},1) write "VADEMO:",$select(sc=1:"stored",1:$system.Status.GetErrorText(sc)),!`,
    `set sc=##class(Ens.Config.Credentials).SetCredential(${osq(CREDENTIALS.bedrock)},"",${osq(btoken)},1) write "BEDROCK:",$select(sc=1:"stored",1:$system.Status.GetErrorText(sc)),!`,
    // a stored session keeps the agent settings it was created with, so a new build starts every conversation fresh
    `set n=0,k="" for { set k=$order(^${PKG}.Sessions(k)) quit:k=""  set id=$get(^${PKG}.Sessions(k)) do:id'="" ##class(%AI.Agent.Session).%DeleteId(id) set n=n+1 } kill ^${PKG}.Sessions write "SESSIONS:cleared ",n,!`,
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

// Does the reply contain n as a standalone whole number?
// Uses tokenization: extract every number token (digit groups with optional thousands-separator commas).
// A token with a decimal part (digit(s) after ".") is skipped — it is not a whole number.
// A trailing sentence period (e.g. "holds 295." → 295) is NOT a decimal: the regex only captures
// "." when followed by digits, so a bare trailing "." is not consumed by the decimal group.
// Pass iff the reference n equals one of the extracted tokens.
// Guards against NaN and negative n (returns false).
// Examples: "1,295" → 1295 (matches 1295, not 295); "295,000" → 295000 (not 295);
//           "ratio 3.295" → decimal, skip (not 295); "holds 295." → 295 (matches 295).
function countInReply(reply, n) {
  const num = Number(n);
  if (!isFinite(num) || num < 0) return false;
  const target = Math.round(num);
  // Find all number-like tokens: digit groups with optional thousands-separator commas,
  // optionally followed by a decimal part "." + one or more digits.
  const re = /(\d[\d,]*)(?:\.(\d+))?/g;
  let m;
  while ((m = re.exec(reply)) !== null) {
    if (m[2] !== undefined) continue;        // has decimal digits after "." → skip
    const normalized = m[1].replace(/,/g, "");
    if (!/^\d+$/.test(normalized)) continue; // safety: reject tokens with stray chars
    if (parseInt(normalized, 10) === target) return true;
  }
  return false;
}

const COUNT_QUESTION = "How many pieces of equipment do we have?";
// asked in one session, so the second and third turns reload the stored conversation
const CONVERSATION_TURNS = [COUNT_QUESTION, "Which equipment category has the most items?", "How many items are in that category?"];
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const cell = v => String(v == null ? "" : v).trim();

// A result as the finish table shows it: the value of a single-value result, the values of a one-row result
// (totals), otherwise the row count — "first N rows (truncated)" when the chatbot's list was cut at the cap.
function describeRows(rows, { truncated = false } = {}) {
  if (!Array.isArray(rows)) return "no rows";
  if (truncated) return `first ${plural(rows.length, "row")} (truncated)`;
  if (rows.length === 1 && rows[0] && typeof rows[0] === "object") {
    const entries = Object.entries(rows[0]);
    if (entries.length === 1) return cell(entries[0][1]);
    const values = entries.map(([k, v]) => `${k} ${cell(v)}`).join(" · ");
    const totals = entries.every(([, v]) => cell(v) === "" || !isNaN(Number(cell(v))));   // a row of totals
    const text = totals ? values : `1 row: ${values}`;
    return text.length > 160 ? text.slice(0, 159) + "…" : text;
  }
  return plural(rows.length, "row");
}

// Evaluate all three verification axes. Returns { ok, problems, items }.
// quick[]: { id, wording?, chatbot (full result obj with rows/rowCount/truncated/error?), direct (rows array) }
// count:   { result (chatbot full result), reply (string), reference (number) } — null to skip
// guard[]: { sql, allowed (bool), got (bool), error? (string) }
// rowCap:  the row cap the AI build uses (default 200)
//
// Comparison rules (ruling 4):
//   Not truncated: compare as sets with sameRows (order-insensitive, trimmed strings).
//   Truncated:     chatbotRows.length must equal rowCap; direct.length must exceed rowCap;
//                  multiset subset check (chatbot rows appear in direct with multiplicity — sorted merge).
// Count rule: BOTH countFrom(result) === reference AND countInReply(reply, reference) must hold;
//             a chatbot.error on the count result fails it.
// items is the status.verification array (single source of truth — not duplicated in main()).
function judgeAi({ quick = [], count = null, guard = [], conversation = [], rowCap = 200 }) {
  const problems = [];
  const items = [];

  for (const q of quick) {
    const asked = q.wording || q.id;
    // N3: any present, non-null error value (including "" and 0) is a real error.
    const chatHasError = q.chatbot != null && q.chatbot.error != null;
    if (chatHasError) {
      const chatErrMsg = String(q.chatbot.error || "(empty)").slice(0, 60);
      problems.push(`question ${q.id}: chatbot error — ${chatErrMsg}`);
      items.push({ question: asked, chatbot: `error: ${chatErrMsg}`, vista: describeRows(q.direct || []), ok: false });
      continue;
    }
    if (!Array.isArray(q.chatbot && q.chatbot.rows)) {
      problems.push(`question ${q.id}: chatbot result has no rows array`);
      items.push({ question: asked, chatbot: "no rows array", vista: describeRows(q.direct || []), ok: false });
      continue;
    }
    const chatbotRows = q.chatbot.rows;
    const directRows  = q.direct || [];
    const truncated   = !!(q.chatbot.truncated);
    let ok;
    if (!truncated) {
      ok = sameRows(chatbotRows, directRows);
    } else {
      // Strict truncated path:
      // 1. chatbotRows.length must equal rowCap (it really hit the cap)
      // 2. directRows.length must exceed rowCap (VistA really has more rows)
      // 3. Multiset subset: every chatbot row appears at least as often in direct (sorted-merge).
      if (chatbotRows.length !== rowCap || directRows.length <= rowCap) {
        ok = false;
      } else {
        const chatSorted   = chatbotRows.map(normalizeRow).sort();
        const directSorted = directRows.map(normalizeRow).sort();
        let di = 0;
        ok = chatSorted.every(nr => {
          while (di < directSorted.length && directSorted[di] < nr) di++;
          return di < directSorted.length && directSorted[di++] === nr;
        });
      }
    }
    const cb    = describeRows(chatbotRows, { truncated });
    const vista = describeRows(directRows);
    if (!ok) problems.push(`question ${q.id}: chatbot returned ${cb}, VistA returned ${vista}`);
    items.push({ question: asked, chatbot: cb, vista, ok });
  }

  if (count) {
    const n = count.reference;
    // N3: any present, non-null error value on the count result is a real error.
    const chatHasError = count.result != null && count.result.error != null;
    if (chatHasError) {
      const chatErrMsg = String(count.result.error || "(empty)").slice(0, 60);
      problems.push(`count: chatbot error — ${chatErrMsg}`);
      items.push({ question: count.question || COUNT_QUESTION, chatbot: `error: ${chatErrMsg}`, vista: `${n}`, ok: false });
    } else {
      // Require BOTH: countFrom(result) matches reference AND countInReply(reply, reference).
      const chatCount  = countFrom(count.result);
      const countMatch = chatCount != null && n != null && String(chatCount).trim() === String(n).trim();
      const replyOk    = n != null && countInReply(count.reply || "", n);
      const countOk    = countMatch && replyOk;
      const chatDesc   = String(count.reply || "").trim().slice(0, 80);
      if (!countOk) problems.push(`count mismatch: chatbot="${chatDesc}", VistA=${n}`);
      items.push({ question: count.question || COUNT_QUESTION, chatbot: chatDesc, vista: `${n}`, ok: countOk });
    }
  }

  for (const g of guard) {
    // N3: any present, non-null error value is a real error (including "").
    if (g.error != null) {
      problems.push(`guard case "${String(g.sql).slice(0, 60)}": HTTP error — ${g.error || "(empty)"}`);
    } else if (g.got !== g.allowed) {
      problems.push(`guard case "${String(g.sql).slice(0, 60)}": expected allowed=${g.allowed}, got ${g.got}`);
    }
  }
  if (guard.length) {
    const guardFail = guard.filter(g => g.error != null || g.got !== g.allowed).length;
    items.push({ question: "The read-only guard (general SQL)", chatbot: `${guard.length - guardFail} of ${guard.length} cases as expected`, vista: `${guard.length} cases`, ok: guardFail === 0 });
  }

  // A multi-turn conversation in one session: a reloaded session must keep working (it once lost max_tokens).
  if (conversation.length) {
    let answered = 0;
    conversation.forEach((turn, i) => {
      if (turn.error != null) problems.push(`conversation turn ${i + 1}: chatbot error — ${turn.error || "(empty)"}`);
      else if (!String(turn.reply || "").trim()) problems.push(`conversation turn ${i + 1}: no reply`);
      else answered++;
    });
    items.push({ question: `A ${conversation.length}-turn conversation in one session`, chatbot: `${answered} of ${conversation.length} turns answered`, vista: "—", ok: answered === conversation.length });
  }

  return { ok: problems.length === 0, problems, items };
}

// Check that every expected marker line came back with its success value.
// Returns an array of problem descriptions (empty when all is well).
// This is the primary guard against a silent false-success when the container is missing,
// IRIS is down, or auth is refused — marker lines will be absent or show error text.
function checkSettingsMarkers(irisOut) {
  const said = k => ((irisOut || "").match(new RegExp(`^${k}:(.*)$`, "m")) || [])[1];
  const problems = [];
  const webapp = said("WEBAPP");
  if (webapp !== "created" && webapp !== "updated" && webapp !== "exists")
    problems.push(`WEBAPP: expected "created", "updated", or "exists", got "${webapp || "(missing)"}"`);
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
    _chatOut:       chatOut        = CHAT_OUT,
    _knownGoodRoot: knownGoodRoot  = KNOWN_GOOD_ROOT,
    _buildChatApp:  buildChatApp   = _defaultBuildChatApp,
    _fetch:         fetchFn        = (typeof fetch === "function" ? timedFetch(fetch, 120000) : null),
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
    for (const k of ["VADEMO_PASSWORD", "VADEMO_READ_PASSWORD", "AWS_BEARER_TOKEN_BEDROCK", "IRIS_AI_HUB_PASSWORD"]) {
      const v = process.env[k];
      if (v) secrets.push(v);
      if (v && v.trim() && v.trim() !== v) secrets.push(v.trim());
    }

    // The logins and the token are checked before anything is pushed: a missing one stops the build here.
    const { user: vuser, password: vpass } = vademoLogin(process.env);
    bedrockToken(process.env);

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
    sweepWorkspaces(productionDir, { keep: [dir] });
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
    const irisOut = sessionFn(d.container, script, { secrets });

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
    await buildChatApp(d.questions, chatOut, safeNote);
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

    // POST to the hub; throws on non-2xx.
    async function hubPost(p, body) {
      const r = await fetchFn(hubBase + p, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": hubAuth },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error(redact(`hub request ${p} failed: HTTP ${r.status}`, secrets));
      return r.json();
    }

    // POST direct SQL to VADEMO's Atelier endpoint; throws on non-2xx or SQL error.
    async function directQuery(sql) {
      const r = await fetchFn(atUrl, {
        method:  "POST",
        headers: { "Content-Type": "application/json", "Authorization": atAuth },
        body:    JSON.stringify({ query: sql }),
      });
      if (!r.ok) throw new Error(redact(`VADEMO request failed: HTTP ${r.status}`, secrets));
      const data = await r.json();
      if (data.status && data.status.errors && data.status.errors.length) {
        throw new Error(redact("VistA error: " + (data.status.errors[0].error || "unknown"), secrets));
      }
      return (data.result && data.result.content) || [];
    }

    // 1. Quick questions: each uses a fresh session; compare chatbot vs direct.
    const quickInput = [];
    for (let qi = 0; qi < d.questions.length; qi++) {
      const q       = d.questions[qi];
      const qId     = q.id.replace(/^AIQ\./, "");
      const qSessId = "verify-q-" + Date.now() + "-" + qi;
      const chatbot = await hubPost(`/equipmentai/quick/${encodeURIComponent(qId)}`, { sessionId: qSessId });
      const direct  = await directQuery(q.sql);
      quickInput.push({ id: q.id, wording: q.wording, chatbot, direct });
      const cb = (chatbot.truncated) ? `${chatbot.rowCount} rows (truncated)` : `${(chatbot.rows || []).length} rows`;
      safeNote(`quick ${q.id}: chatbot=${cb}, vista=${direct.length} rows`);
    }

    // 2. Count check: ask chat "How many pieces of equipment do we have?" — one retry on failure.
    //    The direct reference must be exactly one row with one numeric value, otherwise throw.
    const countQ      = COUNT_QUESTION;
    const countRefSQL = "SELECT COUNT(*) AS n FROM VISTA.EQUIPMENT_INV_6914";
    let countChat     = await hubPost("/equipmentai/chat", { sessionId: "verify-count-" + Date.now(), message: countQ });
    const countDirect = await directQuery(countRefSQL);
    if (countDirect.length !== 1) throw new Error(`COUNT(*) reference returned ${countDirect.length} rows; expected exactly 1`);
    const countRefKeys = Object.keys(countDirect[0]);
    if (countRefKeys.length !== 1) throw new Error(`COUNT(*) reference row has ${countRefKeys.length} columns; expected exactly 1`);
    const countRefNum = Number(String(countDirect[0][countRefKeys[0]]).trim());
    if (isNaN(countRefNum)) throw new Error("COUNT(*) reference value is not numeric");
    const countRef = countRefNum;

    // Helper: is a count result OK? Requires BOTH: countFrom matches AND countInReply matches.
    // N3: use == null check (not truthy) so a falsy error like "" still fails.
    const countResultOk = chat =>
      chat.error == null &&
      String(countFrom(chat)).trim() === String(countRef).trim() &&
      countInReply(chat.reply || "", countRef);

    if (!countResultOk(countChat)) {
      // One retry with a fresh session.
      const retryChat = await hubPost("/equipmentai/chat", { sessionId: "verify-retry-" + Date.now(), message: countQ });
      if (countResultOk(retryChat)) countChat = retryChat;
    }

    // 2b. A three-turn conversation in one session — each later turn reloads the stored conversation.
    const convId = "verify-conversation-" + Date.now();
    const conversation = [];
    for (const message of CONVERSATION_TURNS) {
      try {
        const turn = await hubPost("/equipmentai/chat", { sessionId: convId, message });
        conversation.push({ reply: turn.reply, error: turn.error == null ? undefined : redact(String(turn.error), secrets) });
      } catch (e) {
        conversation.push({ error: redact(String(e.message || e), secrets) || "request failed" });
      }
    }

    // 3. Guard cases: replay every GUARD_CASES entry through /guard; capture HTTP errors as error entries.
    const guardInput = [];
    for (const gc of GUARD_CASES) {
      let guardEntry;
      try {
        const r = await fetchFn(hubBase + "/equipmentai/guard", {
          method:  "POST",
          headers: { "Content-Type": "application/json", "Authorization": hubAuth },
          body:    JSON.stringify({ sql: gc.sql }),
        });
        if (!r.ok) {
          guardEntry = { sql: gc.sql, allowed: gc.allowed, got: false, error: `HTTP ${r.status}` };
        } else {
          const resp = await r.json();
          if (typeof resp.ok !== "boolean") {
            guardEntry = { sql: gc.sql, allowed: gc.allowed, got: false, error: "response.ok is not a boolean" };
          } else if (!resp.ok && !resp.reason) {
            guardEntry = { sql: gc.sql, allowed: gc.allowed, got: false, error: "rejected without a reason" };
          } else {
            guardEntry = { sql: gc.sql, allowed: gc.allowed, got: resp.ok };
          }
        }
      } catch (e) {
        // N3: never store an empty error string — use a fixed fallback so judgeAi sees a non-null error.
        const errMsg = redact(e.message, secrets) || "request failed";
        guardEntry = { sql: gc.sql, allowed: gc.allowed, got: false, error: errMsg };
      }
      guardInput.push(guardEntry);
    }

    // Judge — judgeAi is the single source of truth; items becomes status.verification.
    const judgeResult = judgeAi({
      quick:  quickInput,
      count:  { question: countQ, result: countChat, reply: redact(countChat.reply || "", secrets), reference: countRef },
      guard:  guardInput,
      conversation,
      rowCap: 200,
    });

    status.verification = judgeResult.items;
    save();

    if (!judgeResult.ok) {
      throw new Error("verification failed:\n" + judgeResult.problems.map(p => "  • " + p).join("\n"));
    }

    // Write implemented.ai — only on success (ruling 2).
    const implData = JSON.parse(fs.readFileSync(paths.implemented, "utf8"));
    implData.ai = { built: true, verified: true, verifiedAt: new Date().toISOString() };
    fs.writeFileSync(paths.implemented, JSON.stringify(implData, null, 2) + "\n");
    note("implemented.ai marked verified");
    saveKnownGood("ai", { dirs: { classes: dir, chat: chatOut }, meta: { container: d.container, namespace: d.namespace, classes: classes.map(c => c.name) } }, knownGoodRoot);
    note("saved as the known-good AI layer (restore last good)");

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

if (require.main === module) { watchParent(); main(); }

module.exports = { readAiSpec, aiSettingsScript, checkSettingsMarkers, main, STATUS_FILE,
                   sameRows, countFrom, countInReply, judgeAi, describeRows, vademoLogin, bedrockToken, _defaultBuildChatApp };
