"use strict";
// The remote half of a demo reset: removes the harness's REST service from VADEMO and the production and AI layer
// from IRIS — fixed names only (lib/rest-service.js, lib/teardown.js). Started by POST /api/demo/reset (server.js);
// one side failing doesn't stop the other, and the run ends "done" only if every item was removed or already absent.
const fs = require("fs");
const path = require("path");
const { vademoFromEnv } = require("./lib/vademo");
const { REST_WEB_APP, REST_TEARDOWN_CLASSES, removeRestService } = require("./lib/rest-service");
const { irisTeardownScript, parseIrisTeardown } = require("./lib/teardown");
const { SERVER, redact, irisSession } = require("./lib/iris-deploy");
const { watchParent } = require("./lib/runner-control");

const STATUS_FILE = path.join(__dirname, "teardown-status.json");
const SECRET_KEYS = ["IRIS_AI_HUB_PASSWORD", "VADEMO_PASSWORD", "VADEMO_READ_PASSWORD", "AWS_BEARER_TOKEN_BEDROCK", "BULLETIN_SMTP_PASSWORD"];
// every item of a side, so a side that could not be reached at all still names what it could not remove
const VADEMO_ITEMS = [`web app ${REST_WEB_APP}`, ...REST_TEARDOWN_CLASSES.map(c => `class ${c}`)];

async function teardownAll({ statusFile = STATUS_FILE, env = process.env, vademoImpl = () => vademoFromEnv(env), irisSessionImpl = irisSession } = {}) {
  const secrets = SECRET_KEYS.map(k => env[k]).filter(Boolean);
  const hide = t => redact(String(t), secrets);
  // the server seeds the status file with the reset's local results; they count toward done/error like the rest
  const seeded = (() => { try { return (JSON.parse(fs.readFileSync(statusFile, "utf8")).results || []).filter(r => r.where === "local"); } catch (_) { return []; } })();
  const status = { state: "tearing down", step: "", log: [], results: [], error: null, startedAt: new Date().toISOString() };
  const save = () => fs.writeFileSync(statusFile, JSON.stringify(status, null, 2));
  const note = s => { status.log.push(hide(s)); save(); };
  const record = (where, rows) => { for (const r of rows) { const outcome = hide(r.outcome); status.results.push({ where, item: r.item, outcome }); note(`  ${outcome.startsWith("failed") ? "✗" : "✅"} ${r.item} — ${outcome}`); } };
  save();
  if (seeded.length) { status.step = "Removed the local leftovers"; note("▶ " + status.step); record("local", seeded); }

  status.step = "Removing the REST service from VADEMO"; note("▶ " + status.step);
  try { record("VADEMO", await removeRestService(vademoImpl())); }
  catch (e) { record("VADEMO", VADEMO_ITEMS.map(item => ({ item, outcome: "failed: " + (e.message || e) }))); }

  status.step = "Removing the production and the AI layer from IRIS"; note("▶ " + status.step);
  try { record("IRIS", parseIrisTeardown(irisSessionImpl(SERVER, irisTeardownScript(), { secrets }))); }
  catch (e) { record("IRIS", parseIrisTeardown("").map(r => ({ item: r.item, outcome: "failed: " + (e.message || e) }))); }

  const failed = status.results.filter(r => r.outcome.startsWith("failed"));
  status.state = failed.length ? "error" : "done";
  status.error = failed.length ? "could not remove: " + failed.map(r => `${r.where} ${r.item} (${r.outcome})`).join("; ") : null;
  status.step = failed.length ? "Teardown finished with failures" : "Teardown finished";
  note((failed.length ? "✗ " : "✅ ") + status.step);
  return status;
}

if (require.main === module) { watchParent(); teardownAll().then(s => { if (s.state !== "done") process.exitCode = 1; }, e => { console.error(String(e.message || e)); process.exitCode = 1; }); }

module.exports = { teardownAll, STATUS_FILE };
