"use strict";
// Grounded tools for the Decide agent. Pure functions over (graph, decisions record).
// No Bedrock dependency here — unit-testable on their own.
const { normalize } = require("./record");
const { cap: C, isBlocking, isMandatory, allowedTargetKeys, VIA } = require("./rules");
const { generate, stage } = require("./specs");
const { requestContract } = require("./specs/api");
const { TEMPLATES, validateParams, sqlFor, validateOne } = require("./ai-templates");
const { emptyImplemented, apiRecord } = require("./implemented");

const CAT_OPTS = {
  oq:   ["Business rule", "Required input", "Defer"],
  rule: ["Preserve", "Inline", "Drop"],
  beh:  ["Business Operation", "Event", "Integration", "Inline", "Drop"],
  data: ["Include", "Omit"],
  sec:  ["Require (auth)", "Note", "Drop"],
  dep:  ["Platform (reuse)", "Reimplement", "Integration"],
};

const OPTION_SEMANTICS = {
  "Business Operation": { artifact: "an Ens.BusinessOperation in the IRIS production", when: "a synchronous, reliable step with its own retry/queue", risk: "" },
  "Event":              { artifact: "an async published event (fire-and-forget)", when: "a notification/side-effect that need not block the command", risk: "consumers are decoupled; delivery/ordering is best-effort" },
  "Inline":             { artifact: "code folded into the orchestrator BP", when: "a small step not worth its own operation", risk: "no independent retry or observability" },
  "Drop":               { artifact: "nothing — not carried forward", when: "legacy-only behavior with no modern need", risk: "⚠ dropping a coded rule/validation loses fidelity" },
  "Preserve":           { artifact: "kept as a business rule / validation in the service", when: "a coded rule that must still hold", risk: "" },
  "Include":            { artifact: "a field in the REST request/response contract", when: "the API needs this field", risk: "" },
  "Omit":               { artifact: "excluded from the API contract", when: "an internal/irrelevant field", risk: "⚠ omitting a field the workflow writes may break fidelity" },
  "Require (auth)":     { artifact: "a required role/scope on the REST endpoint", when: "legacy gated this by a security key", risk: "" },
  "Note":               { artifact: "documented, not enforced", when: "informational policy only", risk: "" },
  "Platform (reuse)":   { artifact: "reuse of the IRIS/FileMan platform primitive", when: "a Kernel/FileMan utility dependency", risk: "" },
  "Reimplement":        { artifact: "a reimplementation of the dependency in the target", when: "application logic worth rebuilding", risk: "" },
  "Integration":        { artifact: "an external integration/operation", when: "it calls another package or system", risk: "" },
  "Business rule":      { artifact: "a coded Ens.Rule.Definition", when: "the resolved policy is deterministic", risk: "" },
  "Required input":     { artifact: "a required REST request parameter", when: "the decision should be made per-request by the caller", risk: "" },
  "Defer":              { artifact: "a stub Business Operation for the gated side effect — registered in the production, not wired", when: "the policy is not yet known; the recorded reason is the decision", risk: "the gated side effect does not run until it is revisited; it never blocks the build" },
};

function categoryOf(graph, id) {
  const c = C(graph);
  if ((c.openQuestions || []).some(x => x.id === id)) return "oq";
  if ((c.businessRules || []).some(x => x.id === id)) return "rule";
  if ((c.sideEffects || []).some(x => x.id === id)) return "beh";
  if ((c.data || []).some(x => x.id === id)) return "data";
  if ((c.security || []).some(x => x.id === id)) return "sec";
  if ((c.dependencies || []).some(x => x.id === id)) return "dep";
  return null;
}

function findNode(graph, id) {
  const c = C(graph);
  for (const key of ["openQuestions", "businessRules", "sideEffects", "data", "security", "dependencies"]) {
    const n = (c[key] || []).find(x => x.id === id);
    if (n) return n;
  }
  if (c.entryPoint && c.entryPoint.id === id) return c.entryPoint;
  return null;
}

function defaultDecisions(graph) {
  const c = C(graph), dec = {};
  (c.openQuestions || []).forEach(q => dec[q.id] = "Defer");
  (c.businessRules || []).forEach(r => dec[r.id] = "Preserve");
  (c.sideEffects || []).forEach(s => dec[s.id] = s.id === "SIDE.Bulletin" ? "Event" : "Business Operation");
  (c.data || []).filter(d => d.kind === "field" || d.kind === "crossReference").forEach(d => dec[d.id] = "Include");
  (c.security || []).forEach(s => dec[s.id] = "Require (auth)");
  (c.dependencies || []).forEach(d => dec[d.id] = /FileMan|DIC|DIE|DIQ|DIR|XLFSTR|ENUTL|ENJ/.test(d.target || d.id) ? "Platform (reuse)" : "Integration");
  return { dec, oqPolicy: {}, scope: {}, targets: {}, ruleBindings: {} };
}

function label(node) {
  return node.decisionPoint || node.name || node.key || node.target || node.global || (node.index ? "xref " + node.index : node.id);
}

// ---- tool handlers ----

function invCodesFor(inventory, table, column) {
  if (!inventory) return [];
  const tblObj = (inventory.tables || {})[table];
  if (!tblObj) return [];
  const colObj = (tblObj.columns || []).find(c => c.column === column);
  return (colObj && colObj.codes) ? colObj.codes : [];
}

function invEvidenceFor(inventory, table, column) {
  if (!inventory) return [];
  return (inventory.evidence || {})[`${table}.${column}`] || [];
}

// The chat's view of the AI layer. Its missing items come from the AI spec itself, so the two can never disagree.
function buildAiState(record, inventory, aiSpec) {
  const questions = TEMPLATES.map(t => {
    const recEntry  = (record.aiQuestions || {})[t.id] || null;
    const recParams = recEntry ? (recEntry.params || {}) : {};
    const missing = ((aiSpec && aiSpec.missing) || []).filter(m => m.id === t.id).map(({ kind, key, what }) => ({ kind, key, what }));

    // Build param descriptors for the UI: key, describe, options|codes, evidence.
    const paramDescs = t.params.map(p => {
      const desc = { key: p.key, describe: p.describe };
      if (p.type === "enum" || p.type === "enumSet") {
        desc.options = p.options;
      } else if (p.type === "codes") {
        // workOrderStatuses column depends on the sibling workOrderStatusColumn param.
        const col = p.key === "workOrderStatuses" && recParams.workOrderStatusColumn
          ? recParams.workOrderStatusColumn
          : p.column;
        if (col) {
          desc.codes    = invCodesFor(inventory, p.table || "EQUIPMENT_INV_6914", col).map(([c, l]) => `${c}: ${l}`);
          desc.evidence = invEvidenceFor(inventory, p.table || "EQUIPMENT_INV_6914", col);
        } else {
          desc.codes = []; desc.evidence = [];
        }
      } else if (p.type === "year") {
        desc.options = ["integer 1990–2100"];
      } else if (p.type === "money") {
        desc.options = ["number ≥ 0"];
      }
      return desc;
    });

    // SQL preview: whenever the recorded params are all present and valid — it helps while the rest is still being decided.
    let sqlPreview = null;
    if (inventory) {
      try {
        const v = validateParams(t, recParams, inventory);
        if (v.ok) sqlPreview = sqlFor(t, recParams, inventory);
      } catch (_e) { /* params not yet fully valid */ }
    }

    return { id: t.id, defaultWording: t.defaultWording, recorded: recEntry, params: paramDescs, missing, sqlPreview };
  });

  const kept = questions.filter(q => q.recorded && q.recorded.keep === true).length;
  const configured = questions.filter(q => q.recorded && q.recorded.keep === true && q.missing.length === 0).length;
  const missing = ((aiSpec && aiSpec.missing) || []).length;
  return { questions, stage: { total: TEMPLATES.length, kept, configured, missing, complete: !!(aiSpec && aiSpec.complete) } };
}

function getState(graph, decisions, extra = {}) {
  const c = C(graph);
  const record = normalize(decisions);
  const implemented = extra.implemented || emptyImplemented();
  const cats = { oq: c.openQuestions, rule: c.businessRules, beh: c.sideEffects, sec: c.security, dep: c.dependencies };
  const summary = {};
  for (const [k, arr] of Object.entries(cats)) {
    summary[k] = (arr || []).map(n => ({ id: n.id, label: label(n), decision: record.dec[n.id] || "(unset)" }));
  }
  const specs = generate({ graph, record, implemented, inventory: extra.inventory || null });
  const o = specs.orchestrator;
  const st = stage(specs, implemented);
  const done = l => ({ built: !!(implemented[l] && implemented[l].built), verified: !!(implemented[l] && implemented[l].verified) });
  const api = apiRecord(implemented);
  return {
    capability: c.name, summary,
    blocking: (c.openQuestions || []).filter(q => isBlocking(record, q.id)).map(q => q.id),
    resolutions: Object.fromEntries((c.openQuestions || []).map(q => [q.id, { mode: record.dec[q.id], policy: record.oqPolicy[q.id] || null, bindings: record.ruleBindings[q.id] === undefined ? null : record.ruleBindings[q.id] }])),
    sideEffects: [...o.detail.built.map(e => ({ ...e, built: true })), ...o.detail.stubs.map(e => ({ ...e, built: false })), ...o.detail.notBuilt.map(e => ({ ...e, built: false }))],
    missing: o.missing, needs: o.needs,
    requestContract: specs.api.request,
    mandatory: (c.sideEffects || []).filter(isMandatory).map(s => s.id),
    stage: st,
    // whether each layer is built, straight from implemented.json — a side effect's built:false above means a stub
    builds: { api: { built: api.built, verified: api.verified, outOfDate: !!st.apiOutOfDate }, orchestrator: done("orchestrator"), ai: done("ai") },
    ai: buildAiState(record, extra.inventory || null, specs.ai),
  };
}

function explainOption(graph, id, option) {
  const cat = categoryOf(graph, id);
  if (!cat) return { error: `unknown node ${id}` };
  const node = findNode(graph, id);
  const s = OPTION_SEMANTICS[option];
  if (!s) return { error: `unknown option ${option}` };
  const applies = CAT_OPTS[cat].includes(option);
  return {
    node: label(node), category: cat, option, appliesToThisElement: applies,
    producesInTarget: s.artifact, whenToUse: s.when, risk: s.risk || "(no special risk)",
    validOptionsHere: CAT_OPTS[cat],
    evidence: (node.meta && node.meta.evidence) || [],
  };
}

function explainMapping(graph, id) {
  const cat = categoryOf(graph, id);
  const node = findNode(graph, id);
  if (!node) return { error: `unknown node ${id}` };
  const layers = [];
  if (cat === "data") {
    if (node.kind === "field") layers.push("REST request/response field", "FileMan-mapped field on VISTA.EQUIPMENTINV6914 → ^ENG(6914)");
    if (node.kind === "crossReference") layers.push("a GET query filter (REST)", `the ${node.index} index on ^ENG(6914)`);
  } else if (cat === "beh") {
    layers.push("IRIS Production: a Business Operation or Event (per disposition)");
    if (node.writes) layers.push(`a REST data service that writes FileMan file ${node.writes.file} (proposed in the API spec)`, `FileMan file ${node.writes.file}`);
  } else if (cat === "rule") {
    layers.push("a business rule / validation asserted in the command handler");
  } else if (cat === "oq") {
    layers.push("once RESOLVED → a coded rule or a required REST input; until then it BLOCKS the build");
  } else if (cat === "sec") {
    layers.push("REST auth: a required role/scope");
  } else if (cat === "dep") {
    layers.push("platform reuse, reimplementation, or an external integration (per disposition)");
  }
  return {
    node: label(node), category: cat,
    mapsThroughLayers: layers,
    determinacy: node.determinacy || null,
    openQuestion: node.openQuestion || null,
    evidence: (node.meta && node.meta.evidence) || [],
  };
}

// Credentials are never recorded — they are Management Portal settings.
const SECRET = [
  /\b(password|passwd|pwd|pass|secret|token|api[_-]?key|bearer|authorization)\s*[:=]/i,
  /\/\/[^\s/:@]+:[^\s/@]+@/,              // user:password@host in a URL
  /\bbearer\s+[\w.~+/-]{8,}/i,            // a bearer token
  /\beyJ[\w-]{5,}\.[\w-]{5,}/,            // a JWT
];
const looksSecret = v => SECRET.some(re => re.test(String(v)));
const SECRET_MSG = what => `refused: ${what} looks like it contains a credential. Credentials are never recorded — they are Management Portal settings.`;

const MANDATORY_MSG = id => `${id} is mandatory in the production — the legacy calls it unconditionally (discovery). Only how it is implemented is decided here.`;

function setDisposition(graph, decisions, id, option) {
  const cat = categoryOf(graph, id);
  if (!cat) return { ok: false, message: `unknown node ${id}` };
  if (cat === "oq") return { ok: false, message: `${id} is an open question — use resolveOpenQuestion instead` };
  if (!CAT_OPTS[cat].includes(option)) return { ok: false, message: `option "${option}" invalid for ${id}; valid: ${CAT_OPTS[cat].join(", ")}` };
  if (option === "Drop" && cat === "beh" && isMandatory(findNode(graph, id))) return { ok: false, message: `refused: ${MANDATORY_MSG(id)}` };
  decisions.dec[id] = option;
  return { ok: true, message: `${id} → ${option}` };
}

function resolveOpenQuestion(graph, decisions, id, mode, policy) {
  if (categoryOf(graph, id) !== "oq") return { ok: false, message: `${id} is not an open question` };
  if (!CAT_OPTS.oq.includes(mode)) return { ok: false, message: `mode must be one of ${CAT_OPTS.oq.join(", ")}` };
  const text = String(policy || "").trim() || (mode === "Defer" ? "Deferred — not built in this phase; revisit later." : "");
  if (looksSecret(text)) return { ok: false, message: SECRET_MSG("the policy") };
  // bindings were made for the old wording — a changed resolution must be re-bound
  if (decisions.dec[id] !== mode || decisions.oqPolicy[id] !== text) delete decisions.ruleBindings[id];
  decisions.dec[id] = mode;
  decisions.oqPolicy[id] = text;
  (C(graph).sideEffects || []).filter(s => s.openQuestion === id).forEach(s => { decisions.scope[s.id] = mode === "Defer" ? "Defer" : "Build now"; });
  return { ok: true, message: `${id} → ${mode}${text ? " (resolved)" : " (still blocking — needs policy text)"}` };
}

function setBuildScope(graph, decisions, id, phase) {
  if (categoryOf(graph, id) !== "beh") return { ok: false, message: `${id} is not a side effect; build scope applies to behaviors/side effects` };
  if (!["Build now", "Defer"].includes(phase)) return { ok: false, message: `phase must be "Build now" or "Defer"` };
  if (phase === "Defer" && isMandatory(findNode(graph, id))) return { ok: false, message: `refused: ${MANDATORY_MSG(id)}` };
  decisions.scope[id] = phase;
  return { ok: true, message: `${id} build scope → ${phase}` };
}

function setTarget(graph, decisions, id, details) {
  const se = (C(graph).sideEffects || []).find(s => s.id === id);
  if (!se) return { ok: false, message: `${id} is not a side effect` };
  const allowed = allowedTargetKeys(se, decisions);
  const given = Object.entries(details || {}).filter(([, v]) => v != null && String(v).trim() !== "");
  const bad = given.map(([k]) => k).filter(k => !allowed.includes(k));
  if (bad.length) return { ok: false, message: `not a target detail for ${id}: ${bad.join(", ")}. Allowed: ${allowed.join(", ")}. Credentials are never recorded.` };
  const leaked = given.filter(([, v]) => looksSecret(v));
  if (leaked.length) return { ok: false, message: SECRET_MSG(leaked.map(([k]) => k).join(", ")) };
  const via = given.find(([k]) => k === "via");
  if (via && !VIA.includes(String(via[1]).trim())) return { ok: false, message: `via must be one of ${VIA.join(", ")}` };
  decisions.targets[id] = Object.assign({}, decisions.targets[id] || {}, Object.fromEntries(given.map(([k, v]) => [k, String(v).trim()])));
  return { ok: true, message: `${id} target details recorded (${given.map(([k]) => k).join(", ")}); disposition unchanged: ${decisions.dec[id]}` };
}

function bindRuleTerms(graph, decisions, id, bindings) {
  if (categoryOf(graph, id) !== "oq") return { ok: false, message: `${id} is not an open question` };
  if (isBlocking(decisions, id) || decisions.dec[id] === "Defer") return { ok: false, message: `${id} has no resolved rule to bind — decide it first` };
  const fields = new Map(requestContract(graph, decisions).map(f => [f.field, f.name]));
  const entries = Object.entries(bindings || {}).map(([w, f]) => [w, String(f).trim()]);
  if (entries.some(([w]) => looksSecret(w))) return { ok: false, message: SECRET_MSG("a policy word") };
  const bad = entries.filter(([, f]) => !fields.has(f));
  if (bad.length) return { ok: false, message: `not in the API request contract: ${bad.map(([w, f]) => `${w} → ${f}`).join(", ")}. A word with no field in the contract is an unmet need — report it, don't bind it.` };
  decisions.ruleBindings[id] = Object.fromEntries(entries);
  return { ok: true, message: entries.length ? `${id} bindings: ${entries.map(([w, f]) => `${w} → fld ${f} ${fields.get(f)}`).join("; ")}` : `${id}: recorded that the policy uses no data words` };
}

function setQuickQuestion(decisions, id, keep, wording, params, inventory) {
  const t = TEMPLATES.find(t => t.id === id);
  if (!t) return { ok: false, message: `unknown quick-access question id "${id}"; valid ids: ${TEMPLATES.map(t => t.id).join(", ")}` };
  if (wording !== undefined && wording !== null) {
    if (looksSecret(wording)) return { ok: false, message: SECRET_MSG("the wording") };
  }
  if (params !== undefined && params !== null) {
    // Merge existing recorded params with this call's params so cross-param
    // validation (e.g. workOrderStatuses needing workOrderStatusColumn) works
    // across separate one-param-at-a-time calls.
    const existingParams = ((decisions.aiQuestions || {})[id] || {}).params || {};
    const mergedParams   = { ...existingParams, ...params };
    const paramMap = new Map(t.params.map(p => [p.key, p]));
    const errors = [];
    for (const [key, value] of Object.entries(params)) {
      if (!paramMap.has(key)) { errors.push(`unknown param "${key}" for ${id}; valid: ${t.params.map(p => p.key).join(", ")}`); continue; }
      const errs = validateOne(paramMap.get(key), value, mergedParams, inventory);
      errors.push(...errs);
    }
    if (errors.length) return { ok: false, message: errors.join("; ") };
  }
  // Merge into the record.
  if (!decisions.aiQuestions) decisions.aiQuestions = {};
  if (!decisions.aiQuestions[id]) decisions.aiQuestions[id] = {};
  const entry = decisions.aiQuestions[id];
  if (keep !== undefined && keep !== null)       entry.keep    = Boolean(keep);
  if (wording !== undefined && wording !== null) entry.wording = String(wording);
  let extraMsg = "";
  if (params !== undefined && params !== null) {
    if (!entry.params) entry.params = {};
    // For JCAHOPendingInspection: if workOrderStatusColumn is being changed to a
    // different value, the previously recorded workOrderStatuses are no longer valid
    // (they were validated against the old column's codes) — drop them so the chat
    // knows to ask again.
    if (id === "AIQ.JCAHOPendingInspection" && params.workOrderStatusColumn !== undefined) {
      const prevCol = entry.params.workOrderStatusColumn;
      if (prevCol && prevCol !== params.workOrderStatusColumn && entry.params.workOrderStatuses !== undefined) {
        delete entry.params.workOrderStatuses;
        extraMsg = `; workOrderStatuses cleared because workOrderStatusColumn changed from ${prevCol} to ${params.workOrderStatusColumn} — please re-record workOrderStatuses for the new column`;
      }
    }
    Object.assign(entry.params, params);
  }
  return { ok: true, message: `${id} updated${extraMsg}` };
}

const TARGET_PROPS = { via: { type: "string", description: "where the work is performed: vista | iris | external" } };
for (const k of ["writePath", "fields", "operatorValues", "channel", "recipients", "content", "system", "endpoint", "trigger", "mapping", "settings"]) TARGET_PROPS[k] = { type: "string" };

const TOOL_SPECS = [
  { toolSpec: { name: "getState", description: "The RECORDED state — the only source of truth for summaries and status. Returns every disposition, which open questions block, each question's recorded resolution (mode, policy, field bindings), every side effect (built or not, mandatory, gating question, legacy evidence, recorded target details, reason if not built), the missing list, needs from lower layers, the API request contract, mandatory items, the current stage, and builds — whether each layer (api, orchestrator, ai) is built and verified, from the record (the only source for whether a layer is built; a side effect with built:false is a stub or outside this build, not an unbuilt production).", inputSchema: { json: { type: "object", properties: {} } } } },
  { toolSpec: { name: "explainOption", description: "Explain what a disposition option means for a specific element: the IRIS artifact it produces, when to use it, and its risk.", inputSchema: { json: { type: "object", properties: { nodeId: { type: "string" }, option: { type: "string" } }, required: ["nodeId", "option"] } } } },
  { toolSpec: { name: "explainMapping", description: "Explain how a legacy element maps through the target layers (AI Hub / IRIS Production / REST / FileMan).", inputSchema: { json: { type: "object", properties: { nodeId: { type: "string" } }, required: ["nodeId"] } } } },
  { toolSpec: { name: "setDisposition", description: "Apply a disposition to an element (rule/behavior/data/security/dependency). Not for open questions. Drop is refused for mandatory items.", inputSchema: { json: { type: "object", properties: { nodeId: { type: "string" }, option: { type: "string" } }, required: ["nodeId", "option"] } } } },
  { toolSpec: { name: "resolveOpenQuestion", description: "Resolve an open question: mode is 'Business rule', 'Required input', or 'Defer'; policy is the developer's statement in their own words (for Defer, their reason). The side effect the question gates moves into this build (Business rule / Required input) or out of it (Defer). Changing a resolution clears its field bindings.", inputSchema: { json: { type: "object", properties: { id: { type: "string" }, mode: { type: "string" }, policy: { type: "string" } }, required: ["id", "mode"] } } } },
  { toolSpec: { name: "setBuildScope", description: "Set whether a side effect is built in this phase: 'Build now' or 'Defer'. Defer is refused for mandatory items.", inputSchema: { json: { type: "object", properties: { nodeId: { type: "string" }, phase: { type: "string" } }, required: ["nodeId", "phase"] } } } },
  { toolSpec: { name: "setTarget", description: "Record target details for a built side effect so the production can be built. Never changes the disposition. Accepts via plus only the keys for that side effect's kind (vistaWrite: writePath, fields, operatorValues; notification: channel, recipients, content; Integration disposition: system, endpoint, trigger, mapping, settings). Never pass credentials or tokens.", inputSchema: { json: { type: "object", properties: { nodeId: { type: "string" }, ...TARGET_PROPS }, required: ["nodeId"] } } } },
  { toolSpec: { name: "bindRuleTerms", description: "Bind the data words in a resolved open question's policy to DD field numbers from the API request contract (getState.requestContract). Pass {} if the policy uses no data. A word with no field in the contract is an unmet need — report it instead of binding.", inputSchema: { json: { type: "object", properties: { id: { type: "string" }, bindings: { type: "object", description: "map of policy word → DD field number from getState.requestContract, shaped {\"<word in the policy>\": \"<field number>\"}" } }, required: ["id", "bindings"] } } } },
  { toolSpec: { name: "setQuickQuestion", description: "Set whether to keep a quick-access AI question and/or record its wording and SQL parameters. Merges into any previously recorded values. Refuses unknown ids, unknown or invalid param keys and values (message lists valid options/codes), and wording that looks like a credential.", inputSchema: { json: { type: "object", properties: { id: { type: "string", description: "AIQ template id (AIQ.AgingOutFY, AIQ.HighValueNoContract, AIQ.JCAHOPendingInspection, AIQ.CapitalPlanningTotals)" }, keep: { type: "boolean", description: "Whether to include this question on the AI quick-access page" }, wording: { type: "string", description: "Custom question wording shown to the user; defaults to the template's defaultWording" }, params: { type: "object", description: "Parameter values for this question — see getState.ai.questions for valid keys and options" } }, required: ["id"] } } } },
];

// Refused in Phase 1: orchestrator/AI decisions are gated on the API being built and verified.
const PHASE1_ONLY_MSG = "refused: Phase 1 is not built yet — orchestrator and AI decisions open after the Phase 1 build. Press 🔨 Build on the API tab first; form fields (Include/Omit) can be decided now.";

// Returns true when the tool changes orchestrator/AI state (not a data-field setDisposition or a read-only call).
const phase1Gated = (name, input, graph) =>
  ["resolveOpenQuestion", "setBuildScope", "setTarget", "bindRuleTerms", "setQuickQuestion"].includes(name) ||
  (name === "setDisposition" && categoryOf(graph, input && input.nodeId) !== "data");

function runTool(name, input, ctx) {
  const { graph, decisions } = ctx;
  if (phase1Gated(name, input, graph)) {
    const im = ctx.implemented || emptyImplemented();
    const st = stage(generate({ graph, record: normalize(decisions), implemented: im, inventory: ctx.inventory || null }), im);
    if (st.layer === "api") return { ok: false, message: PHASE1_ONLY_MSG };
  }
  switch (name) {
    case "getState": return getState(graph, decisions, ctx);
    case "explainOption": return explainOption(graph, input.nodeId, input.option);
    case "explainMapping": return explainMapping(graph, input.nodeId);
    case "setDisposition": return setDisposition(graph, decisions, input.nodeId, input.option);
    case "resolveOpenQuestion": return resolveOpenQuestion(graph, decisions, input.id, input.mode, input.policy);
    case "setBuildScope": return setBuildScope(graph, decisions, input.nodeId, input.phase);
    case "setTarget": { const { nodeId, ...details } = input || {}; return setTarget(graph, decisions, nodeId, details); }
    case "bindRuleTerms": return bindRuleTerms(graph, decisions, input.id, input.bindings);
    case "setQuickQuestion": return setQuickQuestion(decisions, input.id, input.keep, input.wording, input.params, ctx.inventory || null);
    default: return { error: `unknown tool ${name}` };
  }
}

module.exports = { TOOL_SPECS, runTool, defaultDecisions, getState, categoryOf, CAT_OPTS, findNode, label, PHASE1_ONLY_MSG };
