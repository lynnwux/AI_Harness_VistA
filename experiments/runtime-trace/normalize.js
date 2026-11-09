"use strict";
// Builds runtime-trace.json and trace-rendering.txt from the saved ReadFile rows in raw/<run>/.
//   node experiments/runtime-trace/normalize.js
const fs = require("fs");
const path = require("path");

const dir = __dirname;
const RUNS = [
  { id: "NewInventoryEntry-runtime-001", folder: "run1", pid: 15424, startedAtUTC: "2026-11-09T15:24:43.409Z", stoppedAtUTC: "2026-11-09T15:34:48.574Z", stoppedBy: "StopPID",
    startedFrom: "programmer prompt; user then ran D ^XUP and option ENINVNEW", userInputs: { serial: "10100", "14 ASSET VALUE": "50001", "20 FUNCTIONAL CLASS": "PC", "Create an Incoming Inspection Work Order": "YES" } },
  { id: "NewInventoryEntry-runtime-002", folder: "run2", pid: 15424, startedAtUTC: "2026-11-09T15:38:28.298Z", stoppedAtUTC: "2026-11-09T15:42:22Z (approx., process HALT)", stoppedBy: "process HALT",
    startedFrom: "Equipment menu (no sign-on)", userInputs: { serial: "10101", "14 ASSET VALUE": "50001 (reported by the user; not stored — see stateEvidence)", "20 FUNCTIONAL CLASS": "PC", "Create an Incoming Inspection Work Order": "NO" } },
  { id: "SelfTest-control-001", folder: "selftest", pid: 22380, startedAtUTC: "2026-11-09T15:43:18.520Z", stoppedAtUTC: "2026-11-09T15:43:40.974Z", stoppedBy: "process HALT",
    startedFrom: "background job started by the probe: 40 × $$GET1^DIQ(6914,487,5) and $D(^ENG(6914,\"FC\")) over 20 s" },
];

const rtnOf = lr => (lr || "").includes("^") ? lr.split("^").pop() : "";
const tagOf = lr => { const m = /^([A-Z%][A-Z0-9]*)?\+?(\d*)\^/.exec(lr || ""); return m ? (m[1] || "") + (m[2] ? "+" + m[2] : "") : ""; };
const rootOf = g => { const m = /^\^(\|\|)?([%A-Za-z][A-Za-z0-9.]*)/.exec(g || ""); return m ? "^" + (m[1] || "") + m[2] : ""; };

function tempClass(root) {
  if (root.startsWith("^||")) return "process-private";
  if (["^TMP", "^XTMP", "^UTILITY", "^CacheTemp", "^IRIS.Temp", "^mtemp"].includes(root)) return "temporary";
  return null;
}

function normalize(run) {
  const rows = JSON.parse(fs.readFileSync(path.join(dir, "raw", run.folder, `iristrace_${run.pid}.rows.json`), "utf8"));
  const raw = fs.readFileSync(path.join(dir, "raw", run.folder, `iristrace_${run.pid}.raw.txt`), "utf8").trim().split("\n");
  const routines = new Map(), roots = new Set(), refs = [], calls = [], stack = [], args = [];
  const seen = (r, how) => { if (!r) return; if (!routines.has(r)) routines.set(r, new Set()); routines.get(r).add(how); };
  let t0 = null, tFirst = null, tLast = null;
  for (const r of rows) {
    const t = r.tOffsetUs === "" ? null : Number(r.tOffsetUs);
    if (r.event === "START") t0 = t;
    if (t != null && r.event !== "START") { tFirst ??= t; tLast = t; }
    const rel = t != null && t0 != null ? +((t - t0) / 1e6).toFixed(6) : null;
    if (r.event === "STACK") { const m = /- (.+?) \+\d+$/.exec(r.text); stack.push(r.text); if (m) seen(rtnOf(m[1]), "stack-at-start"); continue; }
    if (r.event === "ARG") { args.push({ afterCallAt: calls.length ? calls[calls.length - 1].at : null, text: r.text }); continue; }
    if (r.event === "RtnLoad") seen(rtnOf(r.lineAndRoutine), Number(r.count) ? "RtnLoad" : "return-into");
    if (r.event === "CALL") { seen(rtnOf(r.lineAndRoutine), "CALL-site"); calls.push({ tSec: rel, at: r.lineAndRoutine || "(direct mode)", level: r.level, srcLine: r.srcLine.trim() }); }
    if (r.event === "QUIT") seen(rtnOf(r.lineAndRoutine), "QUIT");
    if (r.event === "GloRef") {
      const root = rootOf(r.globalRef); roots.add(root);
      refs.push({ tSec: rel, routine: rtnOf(r.lineAndRoutine) || "(direct mode / routine load)", line: r.lineAndRoutine || null, reference: r.globalRef,
        root, srcLine: r.srcLine.trim() || null, database: r.globalLoc || null, evidenceType: "runtime" });
    }
  }
  const last = raw[raw.length - 1] || "";
  const ending = /^(STOP|HALT)/.test(last) ? last.split(",")[0] : "none (file ends mid-record: " + JSON.stringify(last) + ")";
  return {
    scenario: run.id, pid: run.pid, namespace: "VISTA-DIEGO", events: ["RtnLoad", "GloRef"],
    startedAtUTC: run.startedAtUTC, stoppedAtUTC: run.stoppedAtUTC, stoppedBy: run.stoppedBy, startedFrom: run.startedFrom,
    traceFile: `C:\\InterSystems\\IRISHealth\\mgr\\Temp\\harness-runtime-trace\\iristrace_${run.pid}.txt (deleted after copy)`,
    localCopies: { raw: `raw/${run.folder}/iristrace_${run.pid}.raw.txt`, rows: `raw/${run.folder}/iristrace_${run.pid}.rows.json` },
    userInputs: run.userInputs,
    coverage: {
      rawRecords: raw.length, parsedRows: rows.length, fileEnding: ending,
      eventSpanSec: tFirst != null && t0 != null ? +((tLast - t0) / 1e6).toFixed(3) : 0,
      gloRefEvents: refs.length, callEvents: calls.length,
      note: "The trace stopped recording events shortly after it began; see NOTES.md (operational observations).",
    },
    stackAtStart: stack,
    routinesObserved: [...routines.keys()].sort(),
    routineEvidence: Object.fromEntries([...routines].map(([k, v]) => [k, [...v]])),
    globalRootsObserved: [...roots].sort(),
    globalReferences: refs,
    calls,
    stringArguments: args,
    temporaryStructuresObserved: refs.filter(x => tempClass(x.root)).map(x => ({ name: x.reference, kind: tempClass(x.root), routine: x.routine })),
  };
}

const runs = RUNS.map(normalize);
const out = {
  experiment: "runtime-trace",
  generatedAt: new Date().toISOString(),
  instance: "VADEMO — IRIS for Windows (x86-64) 2026.1 (Build 233U), namespace VISTA-DIEGO",
  evidenceTypes: { runtime: "what the trace recorded as executing / referenced", state: "what VistA holds afterwards, read independently by SQL and $Data" },
  runs,
  stateEvidence: JSON.parse(fs.readFileSync(path.join(dir, "state-evidence.json"), "utf8")),
};
fs.writeFileSync(path.join(dir, "runtime-trace.json"), JSON.stringify(out, null, 2) + "\n");

// Human-readable rendering in the style of %SYS.Trace.Display (time offset, indented by stack level).
let txt = "";
for (const run of RUNS) {
  const rows = JSON.parse(fs.readFileSync(path.join(dir, "raw", run.folder, `iristrace_${run.pid}.rows.json`), "utf8"));
  txt += `=== ${run.id} — PID ${run.pid} — started ${run.startedAtUTC} — ${run.startedFrom}\n`;
  let t0 = null;
  for (const r of rows) {
    if (r.event === "START") t0 = Number(r.tOffsetUs);
    const t = r.tOffsetUs === "" ? "" : ((Number(r.tOffsetUs) - t0) / 1e6).toFixed(6);
    const lvl = Math.max(0, Math.min(20, Number(r.level) || 0));
    let line = (t ? t + ":" : "").padEnd(14) + " ".repeat(lvl * 2) + r.event;
    if (r.text) line += " " + r.text;
    if (r.lineAndRoutine) line += (r.event === "RtnLoad" ? " " : " at ") + r.lineAndRoutine + (r.event === "RtnLoad" && !Number(r.count) ? " (return into)" : "");
    if (r.globalRef) line += ", " + r.globalRef;
    txt += line + "\n";
    if (r.srcLine && r.srcLine.trim()) txt += " ".repeat(14 + lvl * 2) + "src:  " + r.srcLine.trim() + "\n";
  }
  txt += "\n";
}
fs.writeFileSync(path.join(dir, "trace-rendering.txt"), txt);
console.log(runs.map(r => `${r.scenario}: ${r.coverage.rawRecords} records, ${r.routinesObserved.length} routines, ${r.globalReferences.length} grefs, ending ${r.coverage.fileEnding}`).join("\n"));
