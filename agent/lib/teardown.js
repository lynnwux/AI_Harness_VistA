"use strict";
// Generates the IRIS teardown script (removes only the harness's own fixed names), parses its stdout into
// per-item outcomes, and removes what a cycle leaves behind locally (localTeardown).
const fs = require("fs");
const os = require("os");
const path = require("path");
const { LAYERS } = require("./known-good");
const { PKG: PROD_PKG, WEB_APP: PROD_APP } = require("./production");
const { PKG: AI_PKG, WEB_APP: AI_APP, CREDENTIALS } = require("./ai-hub");

// Lazy: production-runner.js is not a lib file; load it at call time to avoid circular load order.
const getCredId = () => require("../production-runner").CREDENTIAL_ID;

const osq = s => '"' + String(s == null ? "" : s).replace(/"/g, '""') + '"';
const escRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Builds the ObjectScript session script for a full IRIS teardown.
// Every step writes its own marker line even when it fails; no single failure stops the rest.
function irisTeardownScript() {
  const prod    = `${PROD_PKG}.Production`;
  const credId  = getCredId();
  const prodPfx = PROD_PKG + ".";
  const aiPfx   = AI_PKG + ".";

  return [
    `zn "INTEROP"`,
    // STOP — only when GetProductionStatus names EquipmentEntry.Production in state 1/3/4 (running/suspended/troubled; 2 = stopped)
    `try { do ##class(Ens.Director).GetProductionStatus(.pn,.ps) if ($get(pn)=${osq(prod)})&&(($get(ps)=1)!($get(ps)=3)!($get(ps)=4)) { set sc=##class(Ens.Director).StopProduction(10,1) if $system.Status.IsOK(sc) { do ##class(Ens.Director).CleanProduction() write !,"STOP:stopped",! } else { write !,"STOP:ERROR ",$system.Status.GetErrorText(sc),! } } else { write !,"STOP:not running",! } } catch e { write !,"STOP:ERROR ",e.DisplayString(),! }`,
    // MESSAGES — delete message header rows for both packages (SQL single-quotes inside OS double-quoted string).
    // %ExecDirect does not throw on an SQL error: a negative %SQLCODE is reported, otherwise the row count.
    `try { set st=##class(%SQL.Statement).%ExecDirect(,"DELETE FROM Ens.MessageHeader WHERE MessageBodyClassName %STARTSWITH '${prodPfx}' OR MessageBodyClassName %STARTSWITH '${aiPfx}'") if st.%SQLCODE<0 { write !,"MESSAGES:ERROR ",st.%Message,! } else { write !,"MESSAGES:",st.%ROWCOUNT,! } } catch e { write !,"MESSAGES:ERROR ",e.DisplayString(),! }`,
    // EVENTLOG — delete event log rows for both packages
    `try { set st=##class(%SQL.Statement).%ExecDirect(,"DELETE FROM Ens_Util.Log WHERE SourceClass %STARTSWITH '${prodPfx}' OR SourceClass %STARTSWITH '${aiPfx}'") if st.%SQLCODE<0 { write !,"EVENTLOG:ERROR ",st.%Message,! } else { write !,"EVENTLOG:",st.%ROWCOUNT,! } } catch e { write !,"EVENTLOG:ERROR ",e.DisplayString(),! }`,
    // SETTINGS — delete production default settings
    `try { set st=##class(%SQL.Statement).%ExecDirect(,"DELETE FROM Ens_Config.DefaultSettings WHERE ProductionName='${prod}'") if st.%SQLCODE<0 { write !,"SETTINGS:ERROR ",st.%Message,! } else { write !,"SETTINGS:",st.%ROWCOUNT,! } } catch e { write !,"SETTINGS:ERROR ",e.DisplayString(),! }`,
    // AISESSIONS — delete stored AI agent sessions (same loop as aiSettingsScript)
    `try { set n=0,k="" for { set k=$order(^${AI_PKG}.Sessions(k)) quit:k=""  set id=$get(^${AI_PKG}.Sessions(k)) do:id'="" ##class(%AI.Agent.Session).%DeleteId(id) set n=n+1 } kill ^${AI_PKG}.Sessions write !,"AISESSIONS:",n,! } catch e { write !,"AISESSIONS:ERROR ",e.DisplayString(),! }`,
    // AICONFIG — kill the AI config global unconditionally
    `kill ^${AI_PKG}.Config write !,"AICONFIG:killed",!`,
    // PKG:EquipmentEntry — absent when no class in ^oddDEF starts with the package prefix; displaylog=0 suppresses per-class output so the marker lands on its own line
    `try { set tP=${osq(prodPfx)} set k=$order(^oddDEF(tP)) if $extract(k,1,$length(tP))'=tP { write !,"PKG:${PROD_PKG}:absent",! } else { set sc=$System.OBJ.DeletePackage(${osq(PROD_PKG)},"/deleteextent/displaylog=0") write !,"PKG:${PROD_PKG}:",$select($system.Status.IsOK(sc):"ok",1:"ERROR "_$system.Status.GetErrorText(sc)),! } } catch e { write !,"PKG:${PROD_PKG}:ERROR ",e.DisplayString(),! }`,
    // PKG:EquipmentAI — same
    `try { set tP=${osq(aiPfx)} set k=$order(^oddDEF(tP)) if $extract(k,1,$length(tP))'=tP { write !,"PKG:${AI_PKG}:absent",! } else { set sc=$System.OBJ.DeletePackage(${osq(AI_PKG)},"/deleteextent/displaylog=0") write !,"PKG:${AI_PKG}:",$select($system.Status.IsOK(sc):"ok",1:"ERROR "_$system.Status.GetErrorText(sc)),! } } catch e { write !,"PKG:${AI_PKG}:ERROR ",e.DisplayString(),! }`,
    // CRED — delete each credential if it exists
    ...[credId, CREDENTIALS.vademo, CREDENTIALS.bedrock].map(id =>
      `try { if ##class(Ens.Config.Credentials).%ExistsId(${osq(id)}) { set sc=##class(Ens.Config.Credentials).%DeleteId(${osq(id)}) write !,"CRED:${id}:",$select($system.Status.IsOK(sc):"deleted",1:"ERROR "_$system.Status.GetErrorText(sc)),! } else { write !,"CRED:${id}:absent",! } } catch e { write !,"CRED:${id}:ERROR ",e.DisplayString(),! }`
    ),
    // Switch to %SYS for Security.Applications management
    `zn "%SYS"`,
    // WEBAPP — delete each web app if it exists
    ...[PROD_APP, AI_APP].map(app =>
      `try { if ##class(Security.Applications).Exists(${osq(app)}) { set sc=##class(Security.Applications).Delete(${osq(app)}) write !,"WEBAPP:${app}:",$select(sc=1:"deleted",1:"ERROR "_$system.Status.GetErrorText(sc)),! } else { write !,"WEBAPP:${app}:absent",! } } catch e { write !,"WEBAPP:${app}:ERROR ",e.DisplayString(),! }`
    ),
    `halt`,
    "",
  ].join("\n");
}

// Parse the stdout of irisTeardownScript() into per-item outcomes.
// Missing marker → "failed: no answer from IRIS"; absent/not running/0 → "absent";
// ERROR … → "failed: ERROR …"; otherwise → "removed".
function parseIrisTeardown(stdout) {
  const credId = getCredId();
  const items = [
    "STOP", "MESSAGES", "EVENTLOG", "SETTINGS", "AISESSIONS", "AICONFIG",
    `PKG:${PROD_PKG}`, `PKG:${AI_PKG}`,
    `CRED:${credId}`, `CRED:${CREDENTIALS.vademo}`, `CRED:${CREDENTIALS.bedrock}`,
    `WEBAPP:${PROD_APP}`, `WEBAPP:${AI_APP}`,
  ];
  const said   = key => { const m = new RegExp(`(?:^|[^A-Za-z0-9_])${escRe(key)}:(.*)$`, "m").exec(stdout || ""); return m ? m[1].trim() : null; };
  const outcome = val => {
    if (val == null)                        return "failed: no answer from IRIS";
    if (val === "absent" || val === "not running" || val === "0") return "absent";
    if (val.startsWith("ERROR "))           return "failed: " + val;
    return "removed";
  };
  return items.map(item => ({ item, outcome: outcome(said(item)) }));
}

// Remove one fixed path; never throws. lstat, so a dangling link still counts as present.
function removePath(p, item) {
  try { fs.lstatSync(p); } catch (_) { return { item, outcome: "absent" }; }
  try { fs.rmSync(p, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); return { item, outcome: "removed" }; }
  catch (e) { return { item, outcome: "failed: " + (e.message || e) }; }
}
// Remove the entries of dir (not dir itself) whose name passes `match`; one "absent" item when there are none.
function removeEntries(dir, label, match, pattern) {
  let names = [];
  try { names = fs.readdirSync(dir).filter(match).sort(); } catch (e) { if (e.code !== "ENOENT") return [{ item: `${label}/${pattern}`, outcome: "failed: " + (e.message || e) }]; }
  return names.length ? names.map(n => removePath(path.join(dir, n), `${label}/${n}`)) : [{ item: `${label}/${pattern}`, outcome: "absent" }];
}

// The local half of a demo reset: removes only fixed paths and fixed name patterns — never a known-good copy,
// never decisions.json or a decisions.corrupt-* file. Each item is attempted; never throws.
function localTeardown({ agentDir, repoRoot, knownGoodRoot, statusFiles = {}, decisionsFile, tmpDir = os.tmpdir(), keepBackups = 5 }) {
  const debris = new RegExp(`^(${LAYERS.join("|")})\\.(new|old)-.+$`);   // half-swapped copies, never <layer> itself
  const backupDir = path.dirname(decisionsFile);
  const backups = (() => { try { return fs.readdirSync(backupDir).filter(n => /^decisions\.backup-.+\.json$/.test(n)).sort(); } catch (_) { return []; } })();
  const prune = backups.slice(0, Math.max(0, backups.length - keepBackups));
  return [
    removePath(path.join(repoRoot, "prototype", "build"), "prototype/build"),
    removePath(path.join(repoRoot, "prototype", "chat"), "prototype/chat"),
    ...Object.values(statusFiles).map(f => removePath(f, path.basename(f))),
    ...removeEntries(path.join(agentDir, "_build"), "_build", () => true, "*"),
    ...removeEntries(path.join(agentDir, "_production"), "_production", () => true, "*"),
    ...removeEntries(knownGoodRoot, path.basename(knownGoodRoot), n => debris.test(n), "<layer>.new-*, <layer>.old-*"),
    ...removeEntries(tmpDir, "%TEMP%", n => n.startsWith("eqchat-"), "eqchat-*"),
    removePath(decisionsFile + ".tmp", path.basename(decisionsFile) + ".tmp"),   // the save's temp file (lib/record.js)
    removePath(path.join(agentDir, "interclaw-servers.json"), "interclaw-servers.json"),
    ...(prune.length ? prune.map(n => removePath(path.join(backupDir, n), n)) : [{ item: `decisions backups beyond the newest ${keepBackups}`, outcome: "absent" }]),
  ];
}

module.exports = { irisTeardownScript, parseIrisTeardown, localTeardown };
