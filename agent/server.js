"use strict";
const express = require("express");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { runAgent } = require("./lib/bedrock");
const { defaultDecisions, getState, findNode, label } = require("./lib/tools");
const { loadRecord, saveRecord, diffRecords } = require("./lib/record");
const { DEFAULT_PATHS, generate, writeSpecs, stage } = require("./lib/specs");
const { groundedTurn } = require("./lib/grounding");

const ROOT = path.join(__dirname, "..");                 // repo root (serves capability-graph/, workbench-demo.html, …)
const PORT = process.env.PORT || 8899;
const readJson = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { return fallback; } };

// spawnImpl and statusFiles let tests run the build routes without starting a runner or touching agent/ files.
function createApp({ paths = DEFAULT_PATHS, runAgentImpl = runAgent, spawnImpl = spawn, statusFiles = {} } = {}) {
  let graph = JSON.parse(fs.readFileSync(paths.graph, "utf8"));
  const inventory = readJson(paths.inventory || DEFAULT_PATHS.inventory, null);   // the discovery file (null when missing)
  let notice = null;
  const onCorrupt = bak => { notice = `decisions.json could not be read, so the workbench started from the default decisions. The unreadable file was backed up as ${path.basename(bak)} — nothing in it is lost.`; };
  const state = { record: loadRecord(paths.decisions, () => defaultDecisions(graph), { onCorrupt }), specs: null, md: null, stage: null, specsError: null, notice: null };
  state.notice = notice;
  // the file is the single truth builds read: write it when missing, or when it was unreadable (now backed up)
  if (!fs.existsSync(paths.decisions) || state.notice) saveRecord(paths.decisions, state.record);
  const implemented = () => readJson(paths.implemented, { api: [], orchestrator: { built: false, verified: false }, ai: { built: false, verified: false } });
  const labelOf = id => { const n = findNode(graph, id); return n ? label(n) : id; };
  const restore = snap => { for (const k of Object.keys(state.record)) delete state.record[k]; Object.assign(state.record, JSON.parse(JSON.stringify(snap))); };
  // one chat turn or build at a time, so each turn's diff, prompt and history see only its own changes
  let queue = Promise.resolve();
  const serially = fn => { const p = queue.then(fn); queue = p.catch(() => {}); return p; };

  // Regenerate all three layer specs from the three input files. On failure the last good specs stay.
  function regenerate() {
    try {
      graph = JSON.parse(fs.readFileSync(paths.graph, "utf8"));
      const inputs = { graph, record: state.record, implemented: implemented(), inventory };
      const specs = generate(inputs);
      state.md = writeSpecs(paths.specsDir, specs, inputs);
      state.specs = specs;
      state.stage = stage(specs, inputs.implemented);
      state.specsError = null;
      return {};
    } catch (e) {
      state.specsError = String(e.message || e);
      return { error: state.specsError };
    }
  }

  function systemPrompt() {
    const st = getState(graph, state.record, { implemented: implemented(), inventory });
    const isAiStage = st.stage && st.stage.layer === "ai";
    return [
      "You are the Decide-stage GUIDE for the VistA Service Enablement Workbench.",
      "You lead a human, one decision at a time, through turning a legacy VistA capability into three layer specs that drive the builds: API (Phase 1 — REST service on VistA + Angular app), Orchestrator (Phase 2 — IRIS Interoperability production), AI (Phase 3 — AI Hub). The specs render live on the right, one tab per layer.",
      "",
      "DEPENDENCIES POINT ONE WAY. A decision in a higher layer never changes a lower layer. The API layer is legacy discovery plus a REST service proposal, and it is built and verified. Form feedback is an API-layer decision (setDisposition Include/Omit); tell the user to click 🔨 Build on the API tab to regenerate the app. If an orchestrator decision needs something the API layer does not provide, report it as an UNMET NEED that requires Phase 1 work — never treat it as satisfied.",
      "",
      "THIS PRODUCTION IS BUILT STUB-FIRST. The mandatory side effects are real operations; every other decided side effect is a stub — a Business Operation registered in the production, not wired — that carries the decision and its legacy evidence. Wiring a stub (field bindings, target details, Phase 1 services) is LATER work, listed under each stub in the spec: do not ask for it now unless the developer raises it.",
      "",
      isAiStage
        ? "AI LAYER — quick-access question design. The production is built and verified; now walk the AI missing list one question at a time. For each question in order: (1) ASK keep/drop — should this question appear on the AI quick-access page? Record immediately with setQuickQuestion(id, keep). (2) If keeping: show the template's defaultWording and ASK whether to confirm it or supply a custom wording — record with setQuickQuestion(id, wording). (3) For each param in sequence: show its evidence lines and its options/codes from getState().ai.questions[].params, then ASK the developer to supply the value — never propose a value yourself, including never citing values from any earlier prototype — record with setQuickQuestion(id, params). Move to the next item only after the current one is fully recorded. When getState().ai shows all questions configured (configured === total), say the AI spec is complete and ready for 🔨 Build AI on the AI tab (the button is on the AI tab)."
        : "WORK FROM THE MISSING LIST, one item at a time. The current stage and the next item are below. Order: decide the open questions → confirm the details of each real operation → when nothing is missing, say the orchestrator spec is complete and ready for the production build. Never start or offer the AI layer until the production has been built and verified.",
      "",
      "For each open question explain the three resolution modes before asking, because they produce different architecture once its stub is wired:",
      "  · 'Business rule' = the orchestrator decides automatically from data, no prompt at entry time. Needs a stated rule — a condition on the item's data, in the developer's own words.",
      "  · 'Required input' = the operator is asked at entry time. The front-end prompt is Phase 1 work, listed as later work for its stub.",
      "  · 'Defer' = the developer is not deciding yet: the stub carries the developer's reason instead of a rule. It NEVER blocks the build. Record the reason as the policy.",
      "",
      "LEGACY-FIRST, THEN MODERNIZE — the core loop for every item (an open question, or a detail of a real operation). Do NOT open with a menu and do NOT treat keeping the legacy as the default:",
      "  1. SHOW what the legacy actually does — quote the evidence (getState → sideEffects[].evidence, or the node's meta.evidence) and state its determinacy.",
      "  2. EXPLAIN it in plain language, decomposing compound conditions into parts that can be judged separately.",
      "  3. ASK how the developer wants to modernize each part — keep, change, relocate to another layer, or drop — with a recommendation and reasoning.",
      "  4. RECORD the outcome with the tools, naming which parts changed and which were preserved. Flag clearly when a choice departs from the legacy.",
      "READ INTENT AS POLICY: when the legacy code expresses intent — a default answer that performs the action, a flag raised for the non-compliant case, DD text stating a rule, a path to catch up later — present it as the legacy POLICY, which most likely carries over, and recommend carrying it over. A human override is an exception path; the decision is how to treat the override, not whether the policy exists. Never describe a default-YES step as optional.",
      "EVIDENCE IS PER ITEM. Describe an item's legacy behaviour ONLY from that item's own evidence: call explainOption or explainMapping (or getState) for that node id and quote what it returns. Never borrow a condition, routine, field, threshold or outcome from another item — not as an example, an analogy, or a 'similar case'. If an item's evidence says something is not coded, say exactly that. To illustrate the method, stay abstract: no real fields, routines or conditions.",
      "Never present any outcome as already decided, never bring in a condition, threshold, or decision the developer has not stated in THIS conversation, and never move a condition between rules unless the developer says so.",
      "Tooling limit to be honest about: rule dispositions are only Preserve/Inline/Drop, so a 'modernized' rule has no exact disposition. Record the closest one AND state the modification in words.",
      "",
      "NOTIFICATIONS (a real operation): show the legacy message template verbatim (getState → sideEffects[].template — subject, body, placeholders) and the defaults this build uses (sideEffects[].target, keys listed in sideEffects[].defaults: sent as an email from IRIS with that template as its content, dry-run until enabled), raise every ⚠ note in sideEffects[].templateNotes, then ask where to send it. Record the answer with setTarget (recipients); record channel or content only if the developer changes them. The mail server and its login are Management Portal settings — never ask for them.",
      "FIELD BINDINGS and TARGET DETAILS for a stub are later work — only if the developer asks: list candidate fields from getState.requestContract with their DD names and record with bindRuleTerms; record target details with setTarget, which never changes the disposition. To make a side effect an external integration, first setDisposition(id,'Integration'). Never ask for or record passwords, tokens, or other secrets — those are Management Portal settings.",
      `MANDATORY in the production (discovery: the legacy calls these unconditionally): ${st.mandatory.join(", ") || "none"}. Never offer Drop or Defer for these and never ask the operator about them; the developer decides only HOW each is implemented.`,
      "",
      "STATUS AND SUMMARIES COME FROM THE RECORD, NOT FROM MEMORY. Before you summarise decisions or claim any status, call getState and report only what it returns; restate a recorded policy verbatim. If a tool result says something is still blocking or refused, say so. If what is recorded differs from what the developer told you, point out the difference and ask them to correct it.",
      "",
      "How to present each item: lead with one bold line naming it; one plain sentence on why it is a decision; only the relevant options, each one line, with a short recommendation; then ask. Keep it to a few lines and strictly one item at a time. Expand only if asked (explainOption / explainMapping).",
      "",
      "Rules:",
      "- Ground every answer in the capability graph and the tools; never invent routines, fields, or rules.",
      "- Disposition→target: Business Operation = an Ens.BusinessOperation; Event = async publish; Integration = external system call; Inline = folded into the orchestrator; Drop = not carried forward.",
      "- Be concise. Cite node ids only when useful. Flag risky choices (e.g. dropping a coded rule).",
      "",
      "Current capability: " + st.capability,
      "Current stage: " + JSON.stringify(st.stage),
      "Missing items: " + JSON.stringify(st.missing),
      "Stubs in this build (registered, not wired): " + (st.sideEffects.filter(e => e.stub).map(e => e.name).join(", ") || "none yet"),
      "Needs from lower layers: " + JSON.stringify(st.needs),
      "Elements & current decisions: " + JSON.stringify(st.summary),
      "Currently blocking open questions: " + JSON.stringify(st.blocking),
      isAiStage ? "AI questions: " + JSON.stringify(st.ai) : null,
    ].filter(Boolean).join("\n");
  }

  const app = express();
  app.use(express.json({ limit: "1mb" }));

  app.get("/api/state", (_req, res) => res.json({ workflow: graph.workflow, decisions: state.record, state: getState(graph, state.record, { implemented: implemented(), inventory }) }));
  app.get("/api/decisions", (_req, res) => res.json(state.record));

  app.get("/api/specs", (_req, res) => {
    if (!state.specs) return res.status(500).json({ error: state.specsError || "specs not generated", notice: state.notice });
    const layer = l => ({ md: state.md[l], complete: state.specs[l].complete, missing: state.specs[l].missing, needs: state.specs[l].needs, owns: state.specs[l].owns });
    res.json({ error: state.specsError, notice: state.notice, stage: state.stage, layers: { api: layer("api"), orchestrator: layer("orchestrator"), ai: layer("ai") } });
  });

  const UNDONE = "The record changes your previous draft made were undone. With the tools, re-apply only what the developer asked for in their message.";
  app.post("/api/agent/chat", (req, res) => serially(async () => {
    const { message, history } = req.body || {};
    if (!message) return res.status(400).json({ error: "message required" });
    const before = JSON.parse(JSON.stringify(state.record));
    let out = null, err = null;
    try {
      const ctx = { graph, decisions: state.record, implemented: implemented(), system: systemPrompt(), inventory };
      const next = state.stage && state.stage.next;   // the item being worked on, before tools change it
      const currentId = next ? next.id || next.for || null : null;
      // tools mutate state.record in place; a draft the guardrail rejects has its record changes undone before the retry
      let attempt = 0;
      const run = (t, h) => {
        if (attempt++ === 0) return runAgentImpl(t, h, ctx);
        restore(before);
        return runAgentImpl(t + "\n" + UNDONE, h, ctx);
      };
      // the check judges against the record as it was before this turn, never against what the draft just wrote
      out = await groundedTurn({ run, message: String(message), history: history || [], graph, record: before, currentId, inventory });
    } catch (e) { err = String(e.message || e); }
    try { saveRecord(paths.decisions, state.record); }
    catch (e) {
      restore(before); regenerate();   // memory stays equal to the file the builds read
      return res.status(500).json({ error: `the decisions record could not be saved, so nothing was recorded: ${e.message || e}`, recorded: [] });
    }
    const g = regenerate();
    const recorded = diffRecords(before, state.record, labelOf);
    if (err) return res.status(500).json({ error: err, recorded });
    res.json({ reply: out.reply, toolTrace: out.toolTrace, recorded, grounding: out.grounding, evidence: out.evidence, specsError: g.error || null });
  }).catch(e => { if (!res.headersSent) res.status(500).json({ error: String(e.message || e) }); }));

  registerVistaRoutes(app);
  registerBuildRoutes(app, regenerate, serially);
  const runners = { spawnImpl, productionStatus: statusFiles.production || PRODUCTION_STATUS, aiStatus: statusFiles.ai || AI_STATUS_FILE };
  registerProductionRoutes(app, regenerate, serially, () => state.specs, runners);
  registerAiRoutes(app, regenerate, serially, () => state.specs, () => state.stage, runners);
  registerAiProxyRoutes(app);
  app.use(express.static(ROOT));

  regenerate();
  return { app, state, regenerate, systemPrompt };
}

function registerVistaRoutes(app) {
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
}

// ── Build: run the REAL naive build as an async job (scaffold + npm install +
// ng build → publish to /prototype/build/). POST /api/build starts it and returns
// immediately; the UI polls GET /api/build/status for live progress. build-runner.js
// does the work (minutes). Only one build at a time.
const STATUS_FILE = path.join(__dirname, "build-status.json");
let buildProc = null;

function registerBuildRoutes(app, regenerate, serially) {
  // queued behind any chat turn in flight, so the build reads the record that turn saved
  app.post("/api/build", (_req, res) => serially(() => {
    try {
      if (buildProc) return res.json({ started: false, running: true, note: "a build is already running" });
      const g = regenerate();   // the build always reads the latest specs; it ignores any request body
      if (g.error) return res.status(500).json({ started: false, error: "spec generation failed: " + g.error });
      fs.writeFileSync(STATUS_FILE, JSON.stringify({ state: "starting", step: "queued", log: ["▶ queued"], url: null, error: null, startedAt: new Date().toISOString() }, null, 2));
      buildProc = spawn(process.execPath, [path.join(__dirname, "build-runner.js")], { cwd: __dirname, detached: true, stdio: "ignore" });
      buildProc.on("exit", (code) => {
        buildProc = null;
        // Safety net: if the runner died without writing a terminal state (crash / kill),
        // mark the status errored so the UI poll ends and the Build button re-enables.
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
  }));
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
}

const { STATUS_FILE: PRODUCTION_STATUS } = require("./production-runner");
// The production build and the AI build both read-modify-write implemented.json, so they never run together.
let productionProc = null;
let aiProc = null;

// Mark a status file errored when its runner died without writing a terminal state.
function reconcileExit(statusFile, what, code) {
  try {
    const s = JSON.parse(fs.readFileSync(statusFile, "utf8"));
    if (s.state !== "done" && s.state !== "error") {
      s.state = "error"; s.error = `${what} exited unexpectedly (code ${code})`;
      (s.log = s.log || []).push("✗ " + s.error);
      fs.writeFileSync(statusFile, JSON.stringify(s, null, 2));
    }
  } catch (e) { /* no status file — nothing to reconcile */ }
}

function registerProductionRoutes(app, regenerate, serially, specs, { spawnImpl = spawn, productionStatus = PRODUCTION_STATUS } = {}) {
  app.post("/api/build/production", (_req, res) => serially(() => {
    if (productionProc) return res.json({ started: false, running: true, note: "a production build is already running" });
    if (aiProc) return res.status(409).json({ started: false, error: "the AI build is running — wait for it to finish, then build the production" });
    const g = regenerate();
    if (g.error) return res.status(500).json({ started: false, error: "spec generation failed: " + g.error });
    const o = specs().orchestrator;
    if (!o.complete) return res.status(409).json({ started: false, error: "the orchestrator spec is not complete — finish its missing items in the Decide chat first", missing: o.missing.map(m => m.what) });
    fs.writeFileSync(productionStatus, JSON.stringify({ state: "starting", step: "queued", log: ["▶ queued"], error: null, startedAt: new Date().toISOString() }, null, 2));
    const proc = productionProc = spawnImpl(process.execPath, [path.join(__dirname, "production-runner.js")], { cwd: __dirname, stdio: "ignore", windowsHide: true });
    proc.on("exit", code => {
      if (productionProc === proc) productionProc = null;
      reconcileExit(productionStatus, "the production build", code);
      serially(() => regenerate());   // implemented.json may now say built + verified
    });
    res.json({ started: true, statusUrl: "/api/build/production/status" });
  }));
  app.get("/api/build/production/status", (_req, res) => {
    try { res.json(JSON.parse(fs.readFileSync(productionStatus, "utf8"))); }
    catch (e) { res.json({ state: "idle", step: "", log: [] }); }
  });
}

const { STATUS_FILE: AI_STATUS_FILE } = require("./ai-runner");
function registerAiRoutes(app, regenerate, serially, specs, stageOf, { spawnImpl = spawn, aiStatus = AI_STATUS_FILE } = {}) {
  app.post("/api/build/ai", (_req, res) => serially(() => {
    if (aiProc) return res.json({ started: false, running: true, note: "an AI build is already running" });
    if (productionProc) return res.status(409).json({ started: false, error: "the production build is running — wait for it to finish, then build the AI layer" });
    const g = regenerate();
    if (g.error) return res.status(500).json({ started: false, error: "spec generation failed: " + g.error });
    // The spec's offer rule: the AI layer is offered only once the orchestrator is built and verified.
    const st = stageOf();
    if (!st || st.layer !== "ai") return res.status(409).json({ started: false, error: "the AI layer is offered only once the orchestrator is built and verified — finish and build the orchestrator first", stage: st || null });
    const a = specs() && specs().ai;
    if (!a || !a.complete) return res.status(409).json({ started: false, error: "the AI spec is not complete — finish its missing items in the Decide chat first", missing: (a && a.missing || []).map(m => m.what) });
    fs.writeFileSync(aiStatus, JSON.stringify({ state: "starting", step: "queued", log: ["▶ queued"], error: null, startedAt: new Date().toISOString() }, null, 2));
    const proc = aiProc = spawnImpl(process.execPath, [path.join(__dirname, "ai-runner.js")], { cwd: __dirname, stdio: "ignore", windowsHide: true });
    proc.on("exit", code => {
      if (aiProc === proc) aiProc = null;
      reconcileExit(aiStatus, "the AI build", code);
      serially(() => regenerate());   // implemented.json may now say built + verified
    });
    res.json({ started: true, statusUrl: "/api/build/ai/status" });
  }));
  app.get("/api/build/ai/status", (_req, res) => {
    try { res.json(JSON.parse(fs.readFileSync(aiStatus, "utf8"))); }
    catch (e) { res.json({ state: "idle", step: "", log: [] }); }
  });
}

function registerAiProxyRoutes(app) {
  // Proxy POST /ai/chat and POST /ai/quick/:id → the AI hub's /equipmentai REST front door.
  // IRIS basic auth comes from the environment (same credentials as the build).
  // On a missing setting → 502 naming the setting; on a network error → 502 with the message; on an answer that
  // is not JSON (an IRIS login or not-found page) → 502 saying so.
  const HUB_URL  = (process.env.IRIS_AI_HUB_URL || "").replace(/\/+$/, "");
  const HUB_AUTH = process.env.IRIS_AI_HUB_USER
    ? "Basic " + Buffer.from(process.env.IRIS_AI_HUB_USER + ":" + (process.env.IRIS_AI_HUB_PASSWORD || "")).toString("base64")
    : "";

  function aiHub(p) {
    if (!HUB_URL)  throw new Error("IRIS_AI_HUB_URL is not configured — add it to agent/.env");
    if (!HUB_AUTH) throw new Error("IRIS_AI_HUB_USER is not configured — add it to agent/.env");
    return HUB_URL + "/equipmentai" + p;
  }

  async function forward(res, p, body) {
    try {
      const r = await fetch(aiHub(p), { method: "POST", headers: { "Content-Type": "application/json", Authorization: HUB_AUTH }, body: JSON.stringify(body || {}) });
      const text = await r.text();
      let data;
      try { data = JSON.parse(text); } catch (_e) {
        return res.status(502).json({ error: `IRIS answered HTTP ${r.status} (not JSON) — has the AI layer been built? Press 🔨 Build AI on the Decide page's AI tab.` });
      }
      res.status(r.status).json(data);
    } catch (e) { res.status(502).json({ error: String(e.message || e) }); }
  }

  app.post("/ai/chat", (req, res) => forward(res, "/chat", req.body));
  app.post("/ai/quick/:id", (req, res) => forward(res, "/quick/" + encodeURIComponent(req.params.id), req.body));
}

if (require.main === module) {
  const { app } = createApp();
  app.listen(PORT, "127.0.0.1", () => {
    console.log(`VistA SE Workbench agent on http://localhost:${PORT}`);
    console.log(`Open  http://localhost:${PORT}/capability-graph/decide.html`);
    console.log(`Prototype  http://localhost:${PORT}/prototype/`);
  });
}

module.exports = { createApp };
