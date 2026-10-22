"use strict";
// Generates the IRIS teardown script (removes only the harness's own fixed names) and
// parses its stdout into per-item outcomes.  Task 9 adds localTeardown() to this file.

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
    // STOP — only when GetProductionStatus names EquipmentEntry.Production
    `try { do ##class(Ens.Director).GetProductionStatus(.pn,.ps) if pn=${osq(prod)} { set sc=##class(Ens.Director).StopProduction(10,1) if $$$ISOK(sc) { do ##class(Ens.Director).CleanProduction() write "STOP:stopped",! } else { write "STOP:ERROR ",$system.Status.GetErrorText(sc),! } } else { write "STOP:not running",! } } catch e { write "STOP:ERROR ",e.DisplayString(),! }`,
    // MESSAGES — delete message header rows for both packages (SQL single-quotes inside OS double-quoted string)
    `try { set st=##class(%SQL.Statement).%ExecDirect(,"DELETE FROM Ens.MessageHeader WHERE MessageBodyClassName %STARTSWITH '${prodPfx}' OR MessageBodyClassName %STARTSWITH '${aiPfx}'") write "MESSAGES:",st.%ROWCOUNT,! } catch e { write "MESSAGES:ERROR ",e.DisplayString(),! }`,
    // EVENTLOG — delete event log rows for both packages
    `try { set st=##class(%SQL.Statement).%ExecDirect(,"DELETE FROM Ens_Util.Log WHERE SourceClass %STARTSWITH '${prodPfx}' OR SourceClass %STARTSWITH '${aiPfx}'") write "EVENTLOG:",st.%ROWCOUNT,! } catch e { write "EVENTLOG:ERROR ",e.DisplayString(),! }`,
    // SETTINGS — delete production default settings; SQLCODE 0 = success
    `try { set st=##class(%SQL.Statement).%ExecDirect(,"DELETE FROM Ens_Config.DefaultSettings WHERE ProductionName='${prod}'") write "SETTINGS:",st.%SQLCODE,! } catch e { write "SETTINGS:ERROR ",e.DisplayString(),! }`,
    // AISESSIONS — delete stored AI agent sessions (same loop as aiSettingsScript)
    `try { set n=0,k="" for { set k=$order(^${AI_PKG}.Sessions(k)) quit:k=""  set id=$get(^${AI_PKG}.Sessions(k)) do:id'="" ##class(%AI.Agent.Session).%DeleteId(id) set n=n+1 } kill ^${AI_PKG}.Sessions write "AISESSIONS:",n,! } catch e { write "AISESSIONS:ERROR ",e.DisplayString(),! }`,
    // AICONFIG — kill the AI config global unconditionally
    `kill ^${AI_PKG}.Config write "AICONFIG:killed",!`,
    // PKG:EquipmentEntry — absent when no class in ^oddDEF starts with the package prefix
    `try { set tP=${osq(prodPfx)} set k=$order(^oddDEF(tP)) if $extract(k,1,$length(tP))'=tP { write "PKG:${PROD_PKG}:absent",! } else { set sc=$System.OBJ.DeletePackage(${osq(PROD_PKG)},"/deleteextent") write "PKG:${PROD_PKG}:",$select($$$ISOK(sc):"ok",1:"ERROR "_$system.Status.GetErrorText(sc)),! } } catch e { write "PKG:${PROD_PKG}:ERROR ",e.DisplayString(),! }`,
    // PKG:EquipmentAI — same
    `try { set tP=${osq(aiPfx)} set k=$order(^oddDEF(tP)) if $extract(k,1,$length(tP))'=tP { write "PKG:${AI_PKG}:absent",! } else { set sc=$System.OBJ.DeletePackage(${osq(AI_PKG)},"/deleteextent") write "PKG:${AI_PKG}:",$select($$$ISOK(sc):"ok",1:"ERROR "_$system.Status.GetErrorText(sc)),! } } catch e { write "PKG:${AI_PKG}:ERROR ",e.DisplayString(),! }`,
    // CRED — delete each credential if it exists
    ...[credId, CREDENTIALS.vademo, CREDENTIALS.bedrock].map(id =>
      `try { if ##class(Ens.Config.Credentials).%ExistsId(${osq(id)}) { set sc=##class(Ens.Config.Credentials).%DeleteId(${osq(id)}) write "CRED:${id}:",$select($$$ISOK(sc):"deleted",1:"ERROR "_$system.Status.GetErrorText(sc)),! } else { write "CRED:${id}:absent",! } } catch e { write "CRED:${id}:ERROR ",e.DisplayString(),! }`
    ),
    // Switch to %SYS for Security.Applications management
    `zn "%SYS"`,
    // WEBAPP — delete each web app if it exists
    ...[PROD_APP, AI_APP].map(app =>
      `try { if ##class(Security.Applications).Exists(${osq(app)}) { set sc=##class(Security.Applications).Delete(${osq(app)}) write "WEBAPP:${app}:",$select(sc=1:"deleted",1:"ERROR "_$system.Status.GetErrorText(sc)),! } else { write "WEBAPP:${app}:absent",! } } catch e { write "WEBAPP:${app}:ERROR ",e.DisplayString(),! }`
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
  const said   = key => { const m = new RegExp(`^${escRe(key)}:(.*)$`, "m").exec(stdout || ""); return m ? m[1].trim() : null; };
  const outcome = val => {
    if (val == null)                        return "failed: no answer from IRIS";
    if (val === "absent" || val === "not running" || val === "0") return "absent";
    if (val.startsWith("ERROR "))           return "failed: " + val;
    return "removed";
  };
  return items.map(item => ({ item, outcome: outcome(said(item)) }));
}

module.exports = { irisTeardownScript, parseIrisTeardown };
