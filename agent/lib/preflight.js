"use strict";
// Preflight: is everything a reset or a build depends on up and reachable? One check per dependency, each
// pass | warn | fail | skip (skip = an earlier check it depends on failed), with the fix for a failure.
// Every remote call is injected so tests never touch the workbench, Docker, IRIS or VADEMO.
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { SERVER } = require("./iris-deploy");
const { vademoFromEnv, atelierBase } = require("./vademo");

const LIVE = ["starting", "building", "restoring", "tearing down"];
const RUNS = [["/api/build/status", "API build"], ["/api/build/production/status", "production build"], ["/api/build/ai/status", "AI build"],
  ["/api/restore/status", "restore"], ["/api/demo/reset/status", "demo reset"]];
const REQUIRED = ["VADEMO_URL", "VADEMO_USER", "VADEMO_PASSWORD", "IRIS_AI_HUB_URL", "IRIS_AI_HUB_USER", "IRIS_AI_HUB_PASSWORD", "INTERCLAW_SCRIPTS"];

const pass = (name, detail) => ({ name, status: "pass", detail });
const warn = (name, detail, fix) => ({ name, status: "warn", detail, fix });
const fail = (name, detail, fix) => ({ name, status: "fail", detail, fix });
const skip = (name, detail) => ({ name, status: "skip", detail });
const firstLine = t => String(t || "").trim().split(/\r?\n/)[0].slice(0, 200);

async function runPreflight({ env = process.env, fetchImpl = fetch, spawnSyncImpl = spawnSync, vademoImpl = () => vademoFromEnv(env), fileExists = fs.existsSync } = {}) {
  const get = (url, ms = 10000) => fetchImpl(url, { signal: AbortSignal.timeout(ms) });
  const run = (args, input) => spawnSyncImpl("docker", args, { input, encoding: "utf8", timeout: 60000, windowsHide: true });
  const out = [];

  const missing = REQUIRED.filter(k => !String(env[k] || "").trim());
  const scripts = String(env.INTERCLAW_SCRIPTS || "").trim();
  if (scripts && !fileExists(path.join(scripts, "lib", "iris.py"))) missing.push("INTERCLAW_SCRIPTS (no lib/iris.py there)");
  out.push(missing.length ? fail("Settings (agent/.env)", "missing: " + missing.join(", "), "add them to agent/.env (see agent/.env.example)") : pass("Settings (agent/.env)", "all required settings present"));
  out.push(String(env.AWS_BEARER_TOKEN_BEDROCK || "").trim() ? pass("Bedrock token", "set") : warn("Bedrock token", "AWS_BEARER_TOKEN_BEDROCK is not set", "needed for the Decide chat and 🔨 Build AI — add it to agent/.env"));

  // the workbench server, and whether anything is mid-run
  const base = `http://localhost:${env.PORT || 8899}`;
  let up = false;
  try {
    const r = await get(base + "/api/specs");
    const st = (await r.json()).stage || {};
    up = true; out.push(pass("Workbench server", `${base} answers — stage ${st.layer}/${st.step}`));
  } catch (e) { out.push(fail("Workbench server", `${base} does not answer (${firstLine(e.message)})`, "start it: cd agent && npm start")); }
  if (!up) out.push(skip("Nothing running", "needs the workbench server"));
  else {
    const busy = [];
    for (const [p, what] of RUNS) {
      try { const s = await (await get(base + p)).json(); if (LIVE.includes(s.state)) busy.push(`${what} is ${s.state}${s.step ? " (" + s.step + ")" : ""}`); } catch (e) { /* an unreadable status is reported by its own page */ }
    }
    out.push(busy.length ? fail("Nothing running", busy.join("; "), "wait for it to finish, or stop it from the Decide page") : pass("Nothing running", "no build, restore or reset in progress"));
  }

  // Docker → the iris-ai-hub container → an IRIS session
  const d = run(["info", "--format", "{{.ServerVersion}}"]);
  const dockerUp = d.status === 0;
  out.push(dockerUp ? pass("Docker", "engine " + firstLine(d.stdout)) : fail("Docker", firstLine(d.stderr || d.stdout || (d.error && d.error.message)), "Start Docker Desktop, wait until it says Engine running"));
  let containerUp = false;
  if (!dockerUp) out.push(skip(`${SERVER} container`, "needs Docker"));
  else {
    const c = run(["inspect", "-f", "{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}", SERVER]);
    const state = firstLine(c.stdout);
    containerUp = c.status === 0 && /^running\b/.test(state);
    // "unhealthy" here means IRIS is in alert state, not down — the IRIS session check below decides
    if (containerUp && /unhealthy/.test(state)) out.push(warn(`${SERVER} container`, state, "IRIS is in alert state (iris qlist) — usually expired root certificates in IRIS's trust store (see messages.log); it does not block a reset or a build when the IRIS session answers"));
    else out.push(containerUp ? pass(`${SERVER} container`, state) : fail(`${SERVER} container`, c.status === 0 ? state : firstLine(c.stderr), `start it in Docker Desktop (or: docker start ${SERVER}) and wait until it is running`));
  }
  if (!containerUp) out.push(skip("IRIS session", `needs the ${SERVER} container`));
  else {
    const s = run(["exec", "-i", SERVER, "iris", "session", "IRIS"], 'write "PREFLIGHT:ok",!\nhalt\n');
    out.push(/PREFLIGHT:ok/.test(s.stdout || "") ? pass("IRIS session", "iris session IRIS answers") : fail("IRIS session", firstLine(s.stderr || s.stdout), `IRIS inside ${SERVER} is not answering — restart the container`));
  }

  // the AI hub's web port (the builds' Atelier calls and the chat app go through it)
  const hub = String(env.IRIS_AI_HUB_URL || "").replace(/\/+$/, "");
  if (!hub) out.push(skip("AI hub web", "IRIS_AI_HUB_URL is not set"));
  else {
    try { const r = await get(hub + "/csp/sys/UtilHome.csp"); out.push(r.status < 500 ? pass("AI hub web", `${hub} answers (HTTP ${r.status})`) : fail("AI hub web", `${hub} answered HTTP ${r.status}`, `restart the ${SERVER} container`)); }
    catch (e) { out.push(fail("AI hub web", `${hub} does not answer (${firstLine(e.message)})`, `start the ${SERVER} container; check IRIS_AI_HUB_URL in agent/.env`)); }
  }

  // VADEMO: the VistA namespace through Atelier — the call every Phase 1 build, reset and lookup makes
  try {
    const rows = await vademoImpl().query("SELECT COUNT(*) AS n FROM VISTA.EQUIPMENT_INV_6914");
    out.push(pass("VADEMO (VistA)", `VISTA-DIEGO answers — ${rows[0] && rows[0].n} records in file 6914`));
  } catch (e) {
    out.push(fail("VADEMO (VistA)", firstLine(e.message), `check that VADEMO is up and reachable; Atelier is read at ${atelierBase(env)} — if VADEMO's routing moved, set VADEMO_ATELIER_PATH in agent/.env (default /irishealth/api/atelier)`));
  }
  return out;
}

const MARK = { pass: "✅", warn: "⚠ ", fail: "✗ ", skip: "– " };
function formatReport(results) {
  const lines = results.map(r => `${MARK[r.status]} ${r.name.padEnd(24)} ${r.detail}${r.fix && r.status !== "pass" ? `\n     → ${r.fix}` : ""}`);
  const problems = results.filter(r => r.status === "fail").length;
  lines.push("", problems ? `NOT READY — ${problems} problem${problems === 1 ? "" : "s"} to fix before a reset or a build.` : "READY — nothing blocks a reset or a build.");
  return lines.join("\n");
}

module.exports = { runPreflight, formatReport };
