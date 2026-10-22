"use strict";
// "restore last good": puts back the last known-good copy of each deliverable — the Angular entry form, the IRIS
// production and the AI layer. Logins and hosts come from agent/.env now, never from a copy. Started by the
// Decide chat (server.js); one deliverable failing doesn't stop the others.
const fs = require("fs");
const path = require("path");
const { LAYERS, KNOWN_GOOD_ROOT, readKnownGood } = require("./lib/known-good");
const { SERVER, serverEntry, docPath, redact, irisSession, irisScript } = require("./lib/iris-deploy");
const { sessionScript, smtpSettings } = require("./production-runner");
const { aiSettingsScript, checkSettingsMarkers } = require("./ai-runner");

const { watchParent } = require("./lib/runner-control");
const STATUS_FILE = path.join(__dirname, "restore-status.json");
const ROOT = path.join(__dirname, "..");
const SECRET_KEYS = ["IRIS_AI_HUB_PASSWORD", "VADEMO_PASSWORD", "VADEMO_READ_PASSWORD", "AWS_BEARER_TOKEN_BEDROCK", "BULLETIN_SMTP_PASSWORD"];

function replaceDir(src, dest) {
  fs.rmSync(dest, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  fs.cpSync(src, dest, { recursive: true });
}

// Upload and compile a copy's classes; returns their names.
function pushClasses(kg, iris) {
  const ns = kg.meta.namespace;
  const names = fs.readdirSync(kg.dirs.classes).filter(f => f.endsWith(".cls")).sort();
  if (!names.length) throw new Error("the copy holds no classes");
  for (const n of names) iris("PUT", docPath(ns, n), ["--input", path.join(kg.dirs.classes, n)]);
  const out = iris("POST", `/v2/${ns}/action/compile?flags=cuk`, ["--body", JSON.stringify(names)]);
  const errors = [].concat((out && out.console) || []).filter(l => /ERROR/.test(l));
  if (errors.length) throw new Error("compile errors: " + errors.join(" | "));
  return names;
}

async function restoreAll({
  root = KNOWN_GOOD_ROOT, statusFile = STATUS_FILE, configFile = path.join(__dirname, "interclaw-servers.json"),
  apiOut = path.join(ROOT, "prototype", "build"), chatOut = path.join(ROOT, "prototype", "chat"),
  env = process.env, irisScriptImpl = irisScript, irisSessionImpl = irisSession,
} = {}) {
  const secrets = SECRET_KEYS.map(k => env[k]).filter(Boolean);
  const hide = t => redact(String(t), secrets);
  const status = { state: "restoring", step: "", log: [], results: [], error: null, startedAt: new Date().toISOString() };
  const save = () => fs.writeFileSync(statusFile, JSON.stringify(status, null, 2));
  const note = s => { status.log.push(hide(s)); save(); };
  save();

  // IRIS access is set up only when a copy needs it.
  let iris = null;
  const irisFor = () => {
    if (iris) return iris;
    const { IRIS_AI_HUB_URL: url, IRIS_AI_HUB_USER: user, IRIS_AI_HUB_PASSWORD: pass, INTERCLAW_SCRIPTS: scripts } = env;
    if (!user || !pass) throw new Error("IRIS_AI_HUB_USER and IRIS_AI_HUB_PASSWORD are not set — add them to agent/.env");
    if (!scripts || !fs.existsSync(path.join(scripts, "lib", "iris.py"))) throw new Error("INTERCLAW_SCRIPTS must point at the interclaw skill's scripts folder (agent/.env)");
    fs.writeFileSync(configFile, JSON.stringify(serverEntry(url), null, 2) + "\n");
    iris = irisScriptImpl({ ...env, IRIS_USERNAME: user, IRIS_PASSWORD: pass }, SERVER, configFile, { secrets });
    return iris;
  };

  const restore = {
    api: kg => { replaceDir(kg.dirs.site, apiOut); note("  entry form files copied back to /prototype/build/"); },
    orchestrator: kg => {
      const names = pushClasses(kg, irisFor());
      note(`  ${names.length} production classes uploaded and compiled`);
      const out = irisSessionImpl(kg.meta.container, sessionScript(kg.meta.namespace, smtpSettings(env)), { secrets });
      const said = k => ((out || "").match(new RegExp(`^${k}:(.*)$`, "m")) || [])[1];
      if (said("START") !== "ok" || !/:1\s*$/.test(said("STATE") || "")) throw new Error(`the production did not start (start: ${said("START") || "?"}, state: ${said("STATE") || "?"})`);
      note("  production restarted and running");
    },
    ai: kg => {
      const names = pushClasses(kg, irisFor());
      note(`  ${names.length} AI classes uploaded and compiled`);
      const problems = checkSettingsMarkers(irisSessionImpl(kg.meta.container, aiSettingsScript(env), { secrets }));
      if (problems.length) throw new Error("IRIS settings step failed — " + problems.join("; "));
      note("  AI settings re-applied from agent/.env; stored conversations cleared");
      replaceDir(kg.dirs.chat, chatOut);
      note("  chat app copied back to /prototype/chat/");
    },
  };

  for (const layer of LAYERS) {
    status.step = `Restoring ${layer}`; note("▶ " + status.step);
    const kg = readKnownGood(layer, root);
    if (!kg) { status.results.push({ layer, outcome: "no good copy yet" }); note("  no good copy yet"); continue; }
    try {
      await restore[layer](kg);
      status.results.push({ layer, outcome: "restored", savedAt: kg.meta.savedAt });
    } catch (e) {
      status.results.push({ layer, outcome: "failed: " + hide(e.message || e), savedAt: kg.meta.savedAt });
      note("  ✗ " + (e.message || e));
    }
  }
  const failed = status.results.filter(r => r.outcome.startsWith("failed"));
  status.state = failed.length ? "error" : "done";
  status.error = failed.length ? failed.map(r => `${r.layer}: ${r.outcome}`).join("; ") : null;
  status.step = failed.length ? "Restore finished with failures" : "Restore finished";
  note((failed.length ? "✗ " : "✅ ") + status.step);
  return status;
}

if (require.main === module) { watchParent(); restoreAll().then(s => { if (s.state !== "done") process.exitCode = 1; }, e => { console.error(String(e.message || e)); process.exitCode = 1; }); }

module.exports = { restoreAll, STATUS_FILE };
