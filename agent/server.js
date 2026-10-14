"use strict";
const express = require("express");
const fs = require("fs");
const path = require("path");
const { runAgent } = require("./lib/bedrock");
const { defaultDecisions, getState } = require("./lib/tools");
const { groundedTurn } = require("./lib/grounding");

const ROOT = path.join(__dirname, "..");                 // repo root (serves capability-graph/, workbench-demo.html, …)
const GRAPH_PATH = path.join(ROOT, "capability-graph", "new-inventory-entry.json");
const STORE_PATH = path.join(__dirname, "decisions.json");
const PORT = process.env.PORT || 8899;

const graph = JSON.parse(fs.readFileSync(GRAPH_PATH, "utf8"));

// decisions store (file-persisted, single session for the MVP)
let decisions;
try { decisions = JSON.parse(fs.readFileSync(STORE_PATH, "utf8")); }
catch { decisions = defaultDecisions(graph); }
function saveStore() { fs.writeFileSync(STORE_PATH, JSON.stringify(decisions, null, 2)); }

function systemPrompt() {
  const st = getState(graph, decisions);
  return [
    "You are the Decide-stage GUIDE for the VistA Service Enablement Workbench.",
    "You lead a human, one decision at a time, through turning a legacy VistA capability graph into a build spec for AI coding agents (Angular + REST + IRIS Interop + IRIS AI Hub). The spec renders live on the right as you apply decisions.",
    "",
    "Build in THREE PHASES. **PHASE 1 IS DONE** — do not re-litigate it unless the user raises it.",
    "PHASE 1 — Angular front end + REST write to VistA: BUILT AND VERIFIED. The app is published at /prototype/build/ and an end-to-end write to VADEMO file 6914 was confirmed — pointers, sub-file pointers (FUND/BOC/SGL), set-of-codes, dates, numerics and bounded text all file correctly. If the user gives form feedback, treat it as a Phase-1 change (setDisposition Include/Omit) and tell them to click '🔨 Build from spec' to regenerate. Otherwise LEAVE PHASE 1 ALONE.",
    "PHASE 2 — IRIS Interop production: **THIS IS THE CURRENT FOCUS.** Phase 2 is blocked until its OPEN QUESTIONS are resolved. Which ones are still open is listed under 'Currently blocking open questions' below — never assume. Lead the user through the open ones ONE AT A TIME via resolveOpenQuestion: OQ.WorkOrderPolicy (create an incoming inspection work order?), OQ.PMEnrollmentPolicy (enroll the item in the PM program?), OQ.FAConfirmation (send the FA document to Austin once eligible?).",
    "For EACH open question explain the three resolution modes in plain language before asking, because they produce different architecture:",
    "  · 'Business rule' = the orchestrator decides automatically from data, no human prompt at entry time. Needs a stated rule — a condition on the item's data, in the developer's own words. Fastest for the clerk; encodes policy in the BP.",
    "  · 'Required input' = the operator is asked at entry time and their answer drives it. Adds a form control on the confirmation page. Keeps the human in the loop per item.",
    "  · 'Defer' = not built in this phase: the production gets a stub operation that is registered but never called. It NEVER blocks Phase 2. Record it with resolveOpenQuestion mode 'Defer' and policy = the developer's reason.",
    "Note what the legacy routine actually did, recommend a mode with reasoning, and capture the developer's policy statement in their own words when they choose 'Business rule' or 'Required input'.",
    "STATUS AND SUMMARIES COME FROM THE RECORD, NOT FROM MEMORY. Before you summarise decisions or claim any status, call getState and report only what it returns; restate a recorded policy verbatim. If a tool result says something is still blocking, say so — never announce Phase 2 as unblocked unless getState's blocking list is empty. If what is recorded differs from what the developer told you, point out the difference and ask them to correct it.",
    "PHASE 3 — AI Hub tool, on top of Phase 2. Do not start or offer it until the Phase 2 production has been built and verified — resolving the open questions alone is not enough.",
    "Drive it proactively but ONE decision at a time. After each step, confirm exactly what changed in the spec and ask the next.",
    "",
    "LEGACY-FIRST, THEN MODERNIZE — this is the core loop of the workbench. For any rule, validation, or side effect, do NOT open with a disposition menu and do NOT treat 'Preserve' as a default. Instead, in this order:",
    "  1. SHOW what the legacy code actually does — quote the evidence from the graph (the MUMPS line in meta.evidence) and state its determinacy/confidence.",
    "  2. EXPLAIN it in plain language, decomposing a compound condition into its individual parts so each can be judged separately.",
    "  3. ASK how the developer wants to modernize it — which parts to keep as-is, change, relocate to a different layer, or drop. Offer a recommendation with reasoning.",
    "  4. RECORD the outcome, naming explicitly which parts changed and which were preserved.",
    "EVIDENCE IS PER ITEM. Describe an item's legacy behaviour ONLY from that item's own evidence: call explainOption or explainMapping (or getState) for that node id and quote what it returns. Never borrow a condition, routine, field, threshold or outcome from another item — not as an example, an analogy, or a 'similar case'. If an item's evidence says something is not coded, say exactly that. To illustrate the method, stay abstract: no real fields, routines or conditions.",
    "Never present any outcome as already decided, never bring in a condition, threshold, or decision the developer has not stated in THIS conversation, and never move a condition between rules unless the developer says so.",
    "Flag clearly when a choice DEPARTS from the legacy behaviour, so the provenance trail stays trustworthy. A modernization is a decision with a rationale, never a quiet edit.",
    "Current tooling limit to be honest about: rule dispositions are only Preserve/Inline/Drop, so a 'modernized' rule (some conditions kept, others changed or relocated) has no exact disposition. Record the closest one AND state the modification in words so the record is not misleading.",
    "",
    "How to present each decision (explain well, but don't overwhelm):",
    "- Lead with the decision in one bold-able line so it is clearly flagged (e.g. '① Incoming inspection work order').",
    "- One plain-language sentence of WHY it is a decision (what the legacy does / doesn't decide).",
    "- List only the relevant options, each with a ≤1-line description; give a short recommendation.",
    "- Then ask. Keep the whole message to a few lines. NEVER dump all decisions at once — strictly one at a time.",
    "- If the user asks 'why' or for more, expand with explainOption / explainMapping; otherwise stay brief.",
    "",
    "Feedback loop after a build: once the user has clicked Build and inspected the prototype, treat their feedback as decision changes — apply via the tools, confirm exactly what changed in the spec, and remind them they can click 🔨 Build again to regenerate. Keep iterating until they're satisfied.",
    "",
    "Rules:",
    "- Ground every answer in the capability graph and the tools; never invent routines, fields, or rules.",
    "- Disposition→target: Business Operation = an Ens.BusinessOperation; Event = async publish; Integration = external system call (needs a target); Inline = folded into the BP; Drop = not carried forward. Open questions must be Resolved or they BLOCK the build.",
    "- SIDE.Bulletin (the new-equipment MailMan bulletin) fires unconditionally in the legacy and is MANDATORY in the IRIS production — never offer Drop or Defer for it, and never ask the operator. The developer decides only HOW it is implemented (disposition, channel, recipients), not WHETHER.",
    "- Ask ONE decision at a time. Be concise. Cite node ids only when useful. Flag risky choices (e.g. dropping a coded rule).",
    "",
    "Current capability: " + st.capability,
    "Elements & current decisions: " + JSON.stringify(st.summary),
    "Currently blocking open questions: " + JSON.stringify(st.blocking),
  ].join("\n");
}

const app = express();
app.use(express.json({ limit: "1mb" }));

app.get("/api/state", (_req, res) => res.json({ workflow: graph.workflow, decisions, state: getState(graph, decisions) }));
app.get("/api/decisions", (_req, res) => res.json(decisions));
app.put("/api/decisions", (req, res) => {
  if (req.body && req.body.dec) { decisions = { dec: req.body.dec, oqPolicy: req.body.oqPolicy || {}, scope: req.body.scope || {}, integration: req.body.integration || {} }; saveStore(); }
  res.json(decisions);
});
app.post("/api/decisions/reset", (_req, res) => { decisions = defaultDecisions(graph); saveStore(); res.json(decisions); });

app.post("/api/agent/chat", async (req, res) => {
  const { message, history } = req.body || {};
  if (!message) return res.status(400).json({ error: "message required" });
  try {
    const ctx = { graph, decisions, system: systemPrompt() };
    const currentId = getState(graph, decisions).blocking[0] || null;   // the item being worked on, before tools change it
    // grounding guardrail: a reply that borrows another item's evidence (or invents a threshold) is retried once
    const out = await groundedTurn({ run: (text, h) => runAgent(text, h, ctx), message: String(message), history: history || [], graph, record: decisions, currentId });
    saveStore(); // ctx.decisions === decisions (mutated in place by tools)
    res.json({ reply: out.reply, toolTrace: out.toolTrace, decisions, grounding: out.grounding });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// ── Dev proxy to the real Harness REST data service on VADEMO ────────────────
// The backend is Harness.Equipment.REST (fileman2class CRUD → ^ENG(6914)).
// Browser → this node dev-server (same origin) → VADEMO REST with basic auth,
// matching the Vista_Equipment proxy.conf.json pattern (creds stay server-side).
// Host and credentials come only from the environment (agent/.env, git-ignored).
const VADEMO_URL = (process.env.VADEMO_URL || "").replace(/\/+$/, "");
const VAUTH = process.env.VADEMO_USER ? "Basic " + Buffer.from(process.env.VADEMO_USER + ":" + (process.env.VADEMO_PASSWORD || "")).toString("base64") : "";
function vademo(p) {
  if (!VADEMO_URL || !VAUTH) throw new Error("VADEMO connection not configured — set VADEMO_URL, VADEMO_USER and VADEMO_PASSWORD (see agent/.env.example)");
  return VADEMO_URL + p;
}
const HARNESS = "/irishealth/Harness/Equipment";

app.get("/equipment/next-ien", async (_req, res) => {
  try {
    const r = await fetch(vademo(HARNESS + "/NextIEN"), { headers: { Authorization: VAUTH } });
    res.json(await r.json());
  } catch (e) { res.status(502).json({ status: "error", message: String(e.message || e) }); }
});
app.post("/equipment", async (req, res) => {
  try {
    const r = await fetch(vademo(HARNESS + "/Equipment6914"), { method: "POST", headers: { "Content-Type": "application/json", Authorization: VAUTH }, body: JSON.stringify(req.body || {}) });
    res.status(r.status).json(await r.json());
  } catch (e) { res.status(502).json({ status: "ERROR", error: String(e.message || e) }); }
});
app.get("/equipment/:ien", async (req, res) => {
  try {
    const r = await fetch(vademo(HARNESS + "/Equipment6914/" + encodeURIComponent(req.params.ien)), { headers: { Authorization: VAUTH } });
    res.status(r.status).json(await r.json());
  } catch (e) { res.status(502).json({ status: "error", message: String(e.message || e) }); }
});
app.delete("/equipment/:ien", async (req, res) => {
  try {
    const r = await fetch(vademo(HARNESS + "/Equipment6914/" + encodeURIComponent(req.params.ien)), { method: "DELETE", headers: { Authorization: VAUTH } });
    res.status(r.status).json(await r.json());
  } catch (e) { res.status(502).json({ status: "error", message: String(e.message || e) }); }
});

// Complete pointer-file lists, pulled live from VADEMO and cached. Registry maps
// each lookup file → its table + candidate display column(s). val defaults to IEN.
const ATELIER_QUERY = "/api/atelier/v1/VISTA-DIEGO/action/query";
const LOOKUP = {
  MANUFACTURER_LIST_FILE6912: { table: "MANUFACTURER_LIST_FILE6912", disp: ["MFGS_FULL_LENGTH_NAME", "MFGDIV"] },
  EQUIPMENT_CATEGORY6911:      { table: "EQUIPMENT_CATEGORY6911",      disp: ["NAME"] },
  CATEGORY_STOCK_NUMBER6917:   { table: "CATEGORY_STOCK_NUMBER6917",   disp: ["NAME"] },
  VENDOR440:                   { table: "VENDOR440",                   disp: ["NAME"] },
  // Room number is already unique AND already embeds the building ("304-110" = room 304, bldg 110),
  // so appending BUILDING_NUMBER would just repeat it. FUNCTION_NAME is the useful descriptor —
  // combine skips blanks, so sparsely-populated rows degrade cleanly to the bare room number.
  ENG_SPACE6928:               { table: "ENG_SPACE6928", disp: ["ROOM_NUMBER", "FUNCTION_NAME"], combine: true },
  BUDGET_OBJECT_CODE420_2:     { table: "BUDGET_OBJECT_CODE420_2",     disp: ["NAME"] },
  EQUIPMENT_INV_6914:          { table: "EQUIPMENT_INV_6914", val: "ENTRY_NUMBER", disp: ["MFGR__EQUIPMENT_NAME", "SERIAL_"] },
  // small lookups (previously embedded in-spec) — needed now that the build fetches them via /lookup.
  // FUND/BOC/SGL point INTO 6914 sub-files: the 6914 field stores the sub-file IEN, so value=IEN
  // (display = the code, which is what a user recognizes). SERVICE is a plain file-49 pointer (value=IEN).
  SERVICESECTION49:            { table: "SERVICESECTION49", disp: ["NAME"] },
  // These three are coded reference sets — the bare code (AMAF, 3110, 1750) is meaningless to a
  // clerk, so combine code + its description: "4014 — Canteen Service".
  NX_FUND6914_6:               { table: "NX_FUND6914_6", disp: ["NX_FUND_CODE", "BRIEF_DESCRIPTION"], combine: true },
  NX_BOC6914_4:                { table: "NX_BOC6914_4",  disp: ["CAPITALIZED_BUDGET_OBJECT_CODE", "BOC_TITLE"], combine: true },
  NX_SGL6914_3:                { table: "NX_SGL6914_3",  disp: ["ACCOUNT", "ACCOUNT_DESCRIPTION"], combine: true },
};
const listCache = {};
async function atelierQuery(sql) {
  const r = await fetch(vademo(ATELIER_QUERY), { method: "POST", headers: { "Content-Type": "application/json", Authorization: VAUTH }, body: JSON.stringify({ query: sql }) });
  const j = await r.json();
  if (j.status && j.status.errors && j.status.errors.length) throw new Error(j.status.errors[0].error);
  return (j.result && j.result.content) || [];
}
async function fullList(file) {
  if (listCache[file]) return listCache[file];
  const cfg = LOOKUP[file]; if (!cfg) return null;
  const val = cfg.val || "IEN";
  const cols = cfg.disp.map((c, i) => `${c} AS c${i}`).join(", ");
  const rows = await atelierQuery(`SELECT ${val} AS ien, ${cols} FROM VISTA.${cfg.table}`);
  const list = rows.map(r => {
    // non-empty values of the disp columns, in order
    const vals = cfg.disp.map((_, i) => r["c" + i]).filter(v => v != null && String(v).trim()).map(v => String(v).trim());
    // combine → "CODE — Description" (coded reference sets); otherwise fallback → first non-empty
    let disp = cfg.combine ? vals.join(" — ") : (vals[0] || "");
    if (!disp) disp = "IEN " + r.ien;
    return { ien: r.ien, display: disp };
  });
  listCache[file] = list;
  return list;
}
app.get("/lookup/:file", async (req, res) => {
  const q = String(req.query.q || "").toUpperCase();
  const all = req.query.all === "1";
  let list;
  try { list = await fullList(req.params.file); } catch (e) { return res.status(502).json({ error: String(e.message || e) }); }
  if (!list) return res.json({ items: [], total: 0 });
  const total = list.length;
  let out = q ? list.filter(x => x.display.toUpperCase().includes(q)) : list;
  // all=1 → full list (used on rail open + small-select load); otherwise cap at 25 for type-ahead
  if (!all) out = out.slice(0, 25);
  res.json({ items: out, total });
});

// ── Build: run the REAL naive build as an async job (scaffold + npm install +
// ng build → publish to /prototype/build/). POST /api/build starts it and returns
// immediately; the UI polls GET /api/build/status for live progress. build-runner.js
// does the work (minutes). Only one build at a time.
const { spawn } = require("child_process");
const STATUS_FILE = path.join(__dirname, "build-status.json");
let buildProc = null;
app.post("/api/build", (req, res) => {
  try {
    if (buildProc) return res.json({ started: false, running: true, note: "a build is already running" });
    fs.writeFileSync(path.join(__dirname, "build-decisions.json"), JSON.stringify(req.body || {}));
    fs.writeFileSync(STATUS_FILE, JSON.stringify({ state: "starting", step: "queued", log: ["▶ queued"], url: null, error: null, startedAt: new Date().toISOString() }, null, 2));
    buildProc = spawn(process.execPath, [path.join(__dirname, "build-runner.js"), path.join(__dirname, "build-decisions.json")], { cwd: __dirname, detached: true, stdio: "ignore" });
    buildProc.on("exit", (code) => {
      buildProc = null;
      // Safety net: if the runner died without writing a terminal state (crash / kill),
      // mark the status errored so the UI poll ends and the Build button re-enables —
      // always ready for the next press. A clean done/error is left untouched.
      try {
        const s = JSON.parse(fs.readFileSync(STATUS_FILE, "utf8"));
        if (s.state !== "done" && s.state !== "error" && s.state !== "cancelled") {
          s.state = "error"; s.error = "build process exited unexpectedly (code " + code + ")"; s.etaSec = 0;
          (s.log = s.log || []).push("✗ build process exited unexpectedly (code " + code + ")");
          fs.writeFileSync(STATUS_FILE, JSON.stringify(s, null, 2));
        }
      } catch (e) { /* no status file yet — nothing to reconcile */ }
    });
    buildProc.unref();
    res.json({ started: true, statusUrl: "/api/build/status" });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});
app.get("/api/build/status", (_req, res) => {
  try { res.json(JSON.parse(fs.readFileSync(STATUS_FILE, "utf8"))); }
  catch (e) { res.json({ state: "idle", step: "", log: [], url: null }); }
});
// Cancel a running build and get the environment ready for the next press. Kills the
// whole process tree (npm/ng grandchildren) — buildProc.kill() alone leaves them running.
// Marks status "cancelled" BEFORE killing so the exit guard doesn't relabel it "error".
// The next build's "Preparing workspace" step wipes _build, so no extra cleanup needed here.
app.post("/api/build/cancel", (req, res) => {
  const markCancelled = () => {
    try {
      const s = JSON.parse(fs.readFileSync(STATUS_FILE, "utf8"));
      if (s.state === "building" || s.state === "starting") {
        s.state = "cancelled"; s.step = "Cancelled by user"; s.etaSec = 0;
        (s.log = s.log || []).push("⏹ cancelled by user");
        fs.writeFileSync(STATUS_FILE, JSON.stringify(s, null, 2));
      }
    } catch (e) { /* no status file — nothing to mark */ }
  };
  if (!buildProc) { markCancelled(); return res.json({ cancelled: false, running: false, note: "no build running" }); }
  markCancelled();
  const pid = buildProc.pid;
  try {
    if (process.platform === "win32") spawn("taskkill", ["/PID", String(pid), "/T", "/F"]);
    else { try { process.kill(-pid, "SIGKILL"); } catch (e) { try { buildProc.kill("SIGKILL"); } catch (e2) {} } }
  } catch (e) { return res.status(500).json({ cancelled: false, error: String(e.message || e) }); }
  res.json({ cancelled: true });
});

app.use(express.static(ROOT));

app.listen(PORT, "127.0.0.1", () => {
  console.log(`VistA SE Workbench agent on http://localhost:${PORT}`);
  console.log(`Open  http://localhost:${PORT}/capability-graph/decide.html`);
  console.log(`Prototype  http://localhost:${PORT}/prototype/`);
});
