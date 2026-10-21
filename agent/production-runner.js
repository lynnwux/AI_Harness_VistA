"use strict";
// The production build: reads the orchestrator spec, generates the production's classes, deploys them to IRIS
// with the interclaw scripts, restarts the production and verifies it with one dry-run request.
// Host and login come only from the environment (agent/.env, git-ignored).
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { DEFAULT_PATHS, loadInputs, inputHashes } = require("./lib/specs");
const { productionClasses, PKG, WEB_APP, BULLETIN } = require("./lib/production");

const SERVER = "iris-ai-hub";
const STATUS_FILE = path.join(__dirname, "production-status.json");
const CONFIG_FILE = path.join(__dirname, "interclaw-servers.json");
const readJson = f => JSON.parse(fs.readFileSync(f, "utf8"));

function readSpecs(paths = DEFAULT_PATHS) {
  const orchestrator = readJson(path.join(paths.specsDir, "orchestrator.json"));
  const api = readJson(path.join(paths.specsDir, "api.json"));
  const inputs = loadInputs(paths);
  for (const [layer, spec] of [["orchestrator", orchestrator], ["api", api]]) {
    if (JSON.stringify(spec.inputs) !== JSON.stringify(inputHashes(layer, inputs))) {
      throw new Error(`the ${layer} spec is stale — it no longer matches the decisions record; reload the Decide page and build again`);
    }
  }
  if (!orchestrator.complete) throw new Error("the orchestrator spec is not complete — finish its missing items in the Decide chat first");
  return { orchestrator, api };
}

function serverEntry(url) {
  if (!url) throw new Error("IRIS_AI_HUB_URL is not set — add it to agent/.env (see agent/.env.example)");
  const u = new URL(url);
  const scheme = u.protocol.replace(":", "");
  const port = Number(u.port) || (scheme === "https" ? 443 : 80);
  return { default: SERVER, "intersystems.servers": { [SERVER]: { webServer: { scheme, host: u.hostname, port, pathPrefix: u.pathname.replace(/\/+$/, "") } } } };
}

// A capitalized NX test item, keyed by the form's own keys, so the bulletin's |7| branch is exercised.
// Every text value says TEST and every date is 2000-01-01, so it cannot pass for real equipment. Lookup fields
// are left out: a made-up record number would point at a real record or at nothing.
const TEST_ITEM = {
  "3": "TEST ITEM - NOT REAL", "4": "TEST-MODEL", "5": "TEST-0001",
  "7": "NX", "20.1": "O", "13": "2000-01-01", "31.5": 1, "14": "2000-01-01",
  "20": "1", "9": "NO", "53": "1", "60": "TEST", "25": "TEST-00001", "19.5": "NO", "19.6": 0,
  "26": "WORKBENCH-TEST", "23": "2000-01-01", "27": "NO",
  "33": "NO", "34": "1", "35": "TEST", "64": "3299",
};
function samplePayload(api) {
  const keyOf = Object.fromEntries(api.detail.pages.flatMap(p => p.fields).map(f => [String(f.fno), f.k]));
  const values = TEST_ITEM;
  return Object.fromEntries(Object.entries(values).filter(([f]) => keyOf[f]).map(([f, v]) => [keyOf[f], v]));
}

function judge(result, stubNames, bulletin = "dry-run") {
  const r = result || {}, o = r.outcomes || {}, stubs = o.stubs || {}, problems = [];
  if (r.status !== "DRY-RUN" || o.vistaWrite !== "DRY-RUN") problems.push(`the VistA write was not dry-run (status ${r.status}, vistaWrite ${o.vistaWrite})`);
  if (o.bulletin !== bulletin) problems.push(`the bulletin should have been ${bulletin} but was ${o.bulletin}`);
  for (const n of stubNames) if (stubs[n] !== "stub - not wired") problems.push(`stub "${n}" did not stay unwired (${stubs[n]})`);
  return { ok: problems.length === 0, problems };
}

// The bulletin's mail server, from agent/.env. None configured → the bulletin stays dry-run.
function smtpSettings(env) {
  const host = (env.BULLETIN_SMTP_HOST || "").trim();
  if (!host) return null;
  const from = (env.BULLETIN_SMTP_FROM || "").trim();
  if (!from) throw new Error("BULLETIN_SMTP_FROM is not set — the bulletin needs a sender address (agent/.env)");
  return { host, port: Number(env.BULLETIN_SMTP_PORT) || 25, from, user: env.BULLETIN_SMTP_USER || null, password: env.BULLETIN_SMTP_PASSWORD || null };
}

const CREDENTIAL_ID = "EquipmentEntryBulletinSMTP";
const osq = s => '"' + String(s).replace(/"/g, '""') + '"';

// Written into IRIS as System Default Settings (and a stored login), so no host or password is in the classes.
function bulletinSettingsScript(namespace, smtp) {
  const prod = `${PKG}.Production`;
  const L = [`set st=##class(%SQL.Statement).%ExecDirect(,"DELETE FROM Ens_Config.DefaultSettings WHERE ProductionName='${prod}'") write "SETTINGS:cleared",!`];
  if (!smtp) return L.join("\n");
  const settings = [["SMTPServer", smtp.host], ["SMTPPort", String(smtp.port)], ["From", smtp.from]];
  if (smtp.user) {
    L.push(`set sc=##class(Ens.Config.Credentials).SetCredential(${osq(CREDENTIAL_ID)},${osq(smtp.user)},${osq(smtp.password || "")},1) write "LOGIN:",$select(sc=1:"stored",1:$system.Status.GetErrorText(sc)),!`);
    settings.push(["Credentials", CREDENTIAL_ID]);
  }
  for (const [name, value] of settings) {
    L.push(`set st=##class(%SQL.Statement).%ExecDirect(,"INSERT INTO Ens_Config.DefaultSettings (ProductionName,ItemName,HostClassName,SettingName,SettingValue,Deployable) VALUES (?,?,?,?,?,1)",${osq(prod)},${osq(BULLETIN)},${osq(`${PKG}.BO.NewEquipmentBulletinOperation`)},${osq(name)},${osq(value)}) write "SETTING:${name}:",st.%SQLCODE,!`);
  }
  return L.join("\n");
}

// This build's bulletin among the mail catcher's messages: same subject, every recipient, sent after the build began.
function findDelivered(messages, { subject, recipients, since }) {
  const want = String(recipients || "").split(/[,;]/).map(r => r.trim().toLowerCase()).filter(Boolean);
  return (messages || []).find(m => {
    const to = (m.To || []).map(t => String(t.Address).toLowerCase());
    return (!subject || m.Subject === subject) && new Date(m.Created) >= new Date(since) && want.every(r => to.includes(r));
  }) || null;
}

// Atelier answers 409 when a PUT would overwrite an existing class; the generated classes are meant to replace it.
const docPath = (namespace, name) => `/v2/${namespace}/doc/${name}?ignoreConflict=1`;

// The Management Portal page that shows the production, under the namespace's default web app.
function portalUrl(base, app) {
  const a = String(app || "").trim().replace(/\/+$/, "");
  return a ? `${base.replace(/\/+$/, "")}${a}/EnsPortal.ProductionConfig.zen?PRODUCTION=${PKG}.Production` : null;
}

// Web app and production restart, run inside the container's IRIS terminal (OS authentication).
function sessionScript(namespace, smtp = null) {
  const prod = `${PKG}.Production`, dispatch = `${PKG}.REST.Dispatch`;
  return [
    `zn "%SYS"`,
    `if '##class(Security.Applications).Exists("${WEB_APP}") { set p("NameSpace")="${namespace}",p("DispatchClass")="${dispatch}",p("AutheEnabled")=32,p("Enabled")=1 set sc=##class(Security.Applications).Create("${WEB_APP}",.p) write "WEBAPP:",$select(sc=1:"created",1:$system.Status.GetErrorText(sc)),! } else { write "WEBAPP:exists",! }`,
    `zn "${namespace}"`,
    `set sc=##class(Ens.Director).StopProduction(10,1)`,
    bulletinSettingsScript(namespace, smtp),
    `do ##class(Ens.Director).GetProductionStatus(.n,.st) if st'=2 do ##class(Ens.Director).CleanProduction()`,
    `set sc=##class(Ens.Director).StartProduction("${prod}") write "START:",$select(sc=1:"ok",1:$system.Status.GetErrorText(sc)),!`,
    `do ##class(Ens.Director).GetProductionStatus(.n,.st) write "STATE:",n,":",st,!`,
    `write "PORTAL:",$system.CSP.GetDefaultApp("${namespace}"),!`,
    `halt`,
    "",
  ].join("\n");
}

async function main(paths = DEFAULT_PATHS) {
  const status = { state: "building", step: "", log: [], error: null, startedAt: new Date().toISOString(), result: null, bulletin: null };
  const save = () => fs.writeFileSync(STATUS_FILE, JSON.stringify(status, null, 2));
  const step = s => { status.step = s; status.log.push("▶ " + s); save(); };
  const note = s => { status.log.push("  " + s); save(); };
  try {
    step("Reading the orchestrator spec");
    const specs = readSpecs(paths);
    const d = specs.orchestrator.detail;
    const { IRIS_AI_HUB_URL: url, IRIS_AI_HUB_USER: user, IRIS_AI_HUB_PASSWORD: pass, INTERCLAW_SCRIPTS: scripts } = process.env;
    const entry = serverEntry(url);
    if (!user || !pass) throw new Error("IRIS_AI_HUB_USER and IRIS_AI_HUB_PASSWORD are not set — add them to agent/.env");
    if (!scripts || !fs.existsSync(path.join(scripts, "lib", "iris.py"))) throw new Error("INTERCLAW_SCRIPTS must point at the interclaw skill's scripts folder (agent/.env)");
    const smtp = smtpSettings(process.env), bulletinOutcome = smtp ? "sent" : "dry-run";
    const redact = t => (smtp && smtp.password ? String(t).split(smtp.password).join("***") : String(t));

    step("Generating the production's classes from the spec");
    note(smtp ? `the bulletin sends for real through ${smtp.host}:${smtp.port}; the VistA write stays dry-run` : "no mail server configured (BULLETIN_SMTP_HOST) — the bulletin stays dry-run");
    const classes = productionClasses(specs, { bulletinLive: !!smtp });
    const dir = path.join(__dirname, "_production", "run-" + new Date().toISOString().replace(/[:.]/g, "-"));
    fs.mkdirSync(dir, { recursive: true });
    for (const c of classes) fs.writeFileSync(path.join(dir, c.name), c.text);
    note(`${classes.length} classes written to ${path.relative(__dirname, dir)}`);
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(entry, null, 2) + "\n");

    const env = { ...process.env, IRIS_USERNAME: user, IRIS_PASSWORD: pass };
    const iris = (method, p, extra) => {
      const r = spawnSync("python", [path.join(scripts, "lib", "iris.py"), "--server", SERVER, "--config", CONFIG_FILE, method, p, ...extra], { env, encoding: "utf8", timeout: 180000 });
      if (r.error) throw new Error(`could not run the interclaw script: ${r.error.message}`);
      if (r.status !== 0) throw new Error(`${method} ${p} failed: ${(r.stderr || r.stdout || "").trim().slice(0, 600)}`);
      try { return JSON.parse(r.stdout); } catch (e) { return r.stdout; }
    };

    step(`Pushing the classes to ${d.container}, namespace ${d.namespace}`);
    for (const c of classes) { iris("PUT", docPath(d.namespace, c.name), ["--input", path.join(dir, c.name)]); note("pushed " + c.name); }

    step("Compiling");
    const out = iris("POST", `/v2/${d.namespace}/action/compile?flags=cuk`, ["--body", JSON.stringify(classes.map(c => c.name))]);
    const consoleLines = [].concat((out && out.console) || []);
    const errors = consoleLines.filter(l => /ERROR/.test(l));
    if (errors.length) throw new Error("compile errors:\n" + errors.join("\n"));
    note("compiled with no errors");

    step(`Ensuring the ${WEB_APP} web app and restarting ${PKG}.Production (stops whatever production runs in ${d.namespace})`);
    const s = spawnSync("docker", ["exec", "-i", d.container, "iris", "session", "IRIS"], { input: sessionScript(d.namespace, smtp), encoding: "utf8", timeout: 180000 });
    if (s.error) throw new Error(`could not run docker: ${s.error.message}`);
    const said = k => ((s.stdout || "").match(new RegExp(`^${k}:(.*)$`, "m")) || [])[1];
    note(`web app: ${said("WEBAPP") || "?"} · start: ${said("START") || "?"} · state: ${said("STATE") || "?"}`);
    if (smtp) {
      const failed = [...(s.stdout || "").matchAll(/^SETTING:(\w+):(-?\d+)/gm)].filter(m => m[2] !== "0").map(m => `${m[1]} (SQLCODE ${m[2]})`);
      const login = said("LOGIN");
      if (failed.length || (smtp.user && login !== "stored")) throw new Error("could not store the bulletin's mail settings in IRIS: " + redact([...failed, login || ""].join(" ")));
      note(`mail settings stored as IRIS default settings${smtp.user ? " with a stored login" : ""}`);
    }
    if (said("START") !== "ok" || !/:1\s*$/.test(said("STATE") || "")) throw new Error("the production did not start:\n" + redact((s.stdout || s.stderr || "").trim().slice(-800)));
    status.portalUrl = portalUrl(url, said("PORTAL")); save();
    note("in IRIS: " + (status.portalUrl || "the namespace has no default web app — open the Management Portal and switch to " + d.namespace));

    step("Verifying with one dry-run request");
    const base = url.replace(/\/+$/, "");
    const resp = await fetch(`${base}${WEB_APP}/equipment`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Basic " + Buffer.from(`${user}:${pass}`).toString("base64") },
      body: JSON.stringify(samplePayload(specs.api)),
    });
    const text = await resp.text();
    let result; try { result = JSON.parse(text); } catch (e) { throw new Error(`the front door answered HTTP ${resp.status}: ${text.slice(0, 300)}`); }
    status.result = result;
    const verdict = judge(result, d.stubs.map(e => e.name), bulletinOutcome);
    if (!verdict.ok) throw new Error("verification failed: " + verdict.problems.join("; "));
    note(`write DRY-RUN · bulletin ${bulletinOutcome} · every stub stayed unwired`);

    try {
      const q = iris("POST", `/v2/${d.namespace}/action/query`, ["--unwrap", "--body", JSON.stringify({ query: `SELECT TOP 1 Recipients, Subject, Body FROM ${PKG}_Msg.BulletinResponse ORDER BY ID DESC` })]);
      status.bulletin = Array.isArray(q) ? q[0] || null : null;
    } catch (e) { note("could not read back the composed bulletin: " + e.message); }

    const catcher = (process.env.MAILPIT_URL || "").replace(/\/+$/, "");
    if (smtp && catcher) {
      step("Checking the mail catcher for the bulletin");
      const recipients = d.built.find(e => e.id === "SIDE.Bulletin").target.recipients;
      const since = new Date(Date.parse(status.startedAt) - 60000).toISOString();   // allow for container clock drift
      let found = null;
      for (let i = 0; i < 10 && !found; i++) {
        if (i) await new Promise(r => setTimeout(r, 1000));
        const list = await (await fetch(`${catcher}/api/v1/messages?limit=50`)).json();
        found = findDelivered(list.messages, { subject: status.bulletin && status.bulletin.Subject, recipients, since });
      }
      if (!found) throw new Error(`the bulletin reported sent, but it did not arrive in the mail catcher (${catcher}) for ${recipients}`);
      status.mail = { id: found.ID, subject: found.Subject, to: found.To.map(t => t.Address), link: `${catcher}/view/${found.ID}` };
      note(`delivered: "${found.Subject}" to ${status.mail.to.join(", ")}`);
    }

    const im = readJson(paths.implemented);
    im.orchestrator = { built: true, verified: true, production: `${PKG}.Production`, namespace: d.namespace, mode: smtp ? "VistA write dry-run, bulletin live" : "dry-run", verifiedAt: new Date().toISOString() };
    fs.writeFileSync(paths.implemented, JSON.stringify(im, null, 2) + "\n");

    status.state = "done"; status.step = smtp ? "Production running and verified — the bulletin was sent" : "Production running and verified (dry-run)";
    status.log.push("✅ " + status.step); save();
  } catch (e) {
    status.state = "error"; status.error = String(e.message || e);
    const pw = process.env.BULLETIN_SMTP_PASSWORD;
    if (pw) status.error = status.error.split(pw).join("***");
    status.log.push("✗ " + status.error); save();
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = { readSpecs, serverEntry, samplePayload, judge, sessionScript, portalUrl, docPath, smtpSettings, bulletinSettingsScript, findDelivered, STATUS_FILE };
