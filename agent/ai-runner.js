"use strict";
// The AI-layer build: reads the AI spec, generates the EquipmentAI classes, pushes and compiles them into
// iris-ai-hub, configures IRIS settings and credentials, and creates the /equipmentai web app.
// Host and all secrets come only from the environment (agent/.env, git-ignored).
// Task 7 will add the chat-app build step; Task 8 will add verification and mark the layer built+verified.

const fs = require("fs");
const path = require("path");
const { DEFAULT_PATHS, loadInputs, inputHashes } = require("./lib/specs");
const { aiClasses, PKG, WEB_APP, CREDENTIALS } = require("./lib/ai-hub");
const { serverEntry, docPath, redact, irisSession, irisScript } = require("./lib/iris-deploy");
const { DEFAULT_REGION, DEFAULT_MODEL_ID } = require("./lib/bedrock");

const STATUS_FILE = path.join(__dirname, "ai-status.json");
const CONFIG_FILE = path.join(__dirname, "interclaw-servers.json");
const SERVER = "iris-ai-hub";

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

// _deps allows test injection of irisSession and irisScript without running real docker/python.
async function main(paths = DEFAULT_PATHS, _deps = {}) {
  const {
    _irisSession: sessionFn = irisSession,
    _irisScript:  scriptFn  = irisScript,
  } = _deps;

  const status = { state: "building", step: "", log: [], error: null, startedAt: new Date().toISOString() };
  const save  = () => fs.writeFileSync(STATUS_FILE, JSON.stringify(status, null, 2));
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
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(entry, null, 2) + "\n");

    step("Generating the AI classes from the spec");
    const model   = process.env.BEDROCK_MODEL_ID || DEFAULT_MODEL_ID;
    const classes = aiClasses({ ai, inventory, model });
    const dir = path.join(__dirname, "_production", "ai-run-" + new Date().toISOString().replace(/[:.]/g, "-"));
    fs.mkdirSync(dir, { recursive: true });
    for (const c of classes) fs.writeFileSync(path.join(dir, c.name), c.text);
    note(`${classes.length} classes written to ${path.relative(__dirname, dir)}`);

    const env  = { ...process.env, IRIS_USERNAME: user, IRIS_PASSWORD: pass };
    const iris = scriptFn(env, SERVER, CONFIG_FILE);

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

    // ── Task 7: build chat app ── leave a clear place for the next task ──
    // step("Building the chat app") — Task 7 will add this step

    // ── Task 8: verify and mark implemented ── do NOT write implemented.ai here ──
    // (verify the /guard endpoint and run the GUARD_CASES — Task 8)

    status.state = "done";
    status.step  = "Deployed — not yet verified";
    status.log.push("✅ " + status.step);
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

module.exports = { readAiSpec, aiSettingsScript, checkSettingsMarkers, main, STATUS_FILE };
