"use strict";
// Shared helpers for deploying classes to IRIS: interclaw server config, Atelier path helper,
// the iris.py script factory, a docker-exec session helper, and a secrets redactor.
// Used by both production-runner.js and ai-runner.js.

const path = require("path");
const { spawnSync } = require("child_process");

// The IRIS container / interclaw server name shared by the production and AI builds.
const SERVER = "iris-ai-hub";

// Build the interclaw-servers.json entry from the hub's URL.
function serverEntry(url) {
  if (!url) throw new Error("IRIS_AI_HUB_URL is not set — add it to agent/.env (see agent/.env.example)");
  const u = new URL(url);
  const scheme = u.protocol.replace(":", "");
  const port = Number(u.port) || (scheme === "https" ? 443 : 80);
  return { default: SERVER, "intersystems.servers": { [SERVER]: { webServer: { scheme, host: u.hostname, port, pathPrefix: u.pathname.replace(/\/+$/, "") } } } };
}

// Atelier answers 409 when a PUT would overwrite an existing class; the generated classes are meant to replace it.
const docPath = (namespace, name) => `/v2/${namespace}/doc/${name}?ignoreConflict=1`;

// Replace every secret from secrets[] with *** in text (falsy secrets are skipped).
function redact(text, secrets = []) {
  let result = String(text);
  for (const s of secrets) {
    if (s) result = result.split(String(s)).join("***");
  }
  return result;
}

// The output of a failed command, safe for an error message: lines echoing a credential call are dropped,
// every secret is redacted, and only then is the text cut — so a secret straddling the cut leaves no prefix.
function failureText(r, secrets = []) {
  const text = String(r.stderr || r.stdout || "").split(/\r?\n/).filter(l => !/SetCredential|Credentials/.test(l)).join("\n");
  return redact(text, secrets).trim().slice(0, 600);
}

// Run iris session IRIS in the container with the given script on stdin; return stdout.
// Throws on OS error (docker binary missing) or non-zero exit (container missing, IRIS down, auth refused).
// Live-confirmed 2026-10-20: successful halt → exit 0; missing container → exit 1, stderr "No such container".
// secrets: values the script carries (passwords, tokens) — redacted from the thrown message before it is cut.
function irisSession(container, script, { secrets = [], spawnSyncImpl = spawnSync } = {}) {
  const r = spawnSyncImpl("docker", ["exec", "-i", container, "iris", "session", "IRIS"], { input: script, encoding: "utf8", timeout: 180000 });
  if (r.error) throw new Error(redact(`could not run docker: ${r.error.message}`, secrets));
  if (r.status !== 0) throw new Error(`iris session failed (exit ${r.status}): ${failureText(r, secrets)}`);
  return r.stdout || "";
}

// Returns a function that calls iris.py with the given server and config file.
// env must include INTERCLAW_SCRIPTS, IRIS_USERNAME and IRIS_PASSWORD.
// The IRIS password in env (and any extra secrets) is redacted from every error message.
function irisScript(env, server, configFile, { secrets = [], spawnSyncImpl = spawnSync } = {}) {
  const scripts = (env.INTERCLAW_SCRIPTS || "").trim();
  const hide = [env.IRIS_PASSWORD, ...secrets];
  return (method, p, extra = []) => {
    const r = spawnSyncImpl("python", [path.join(scripts, "lib", "iris.py"), "--server", server, "--config", configFile, method, p, ...extra], { env, encoding: "utf8", timeout: 180000 });
    if (r.error) throw new Error(redact(`could not run the interclaw script: ${r.error.message}`, hide));
    if (r.status !== 0) throw new Error(`${method} ${p} failed: ${failureText(r, hide)}`);
    try { return JSON.parse(r.stdout); } catch (e) { return r.stdout; }
  };
}

module.exports = { SERVER, serverEntry, docPath, redact, irisSession, irisScript };
