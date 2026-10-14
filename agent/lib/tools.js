"use strict";
// Grounded tools for the Decide agent. Pure functions over (graph, decisions).
// No Bedrock dependency here — unit-testable on their own.

const CAT_OPTS = {
  oq:   ["Business rule", "Required input", "Defer"],
  rule: ["Preserve", "Inline", "Drop"],
  beh:  ["Business Operation", "Event", "Inline", "Drop"],
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
  "Defer":              { artifact: "unresolved — blocks the build", when: "the policy is not yet known", risk: "⚠ blocking; must be resolved before build" },
};

function C(graph) { return graph.capabilities[0]; }

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
  const c = C(graph), dec = {}, oqPolicy = {};
  (c.openQuestions || []).forEach(q => dec[q.id] = "Defer");
  (c.businessRules || []).forEach(r => dec[r.id] = "Preserve");
  (c.sideEffects || []).forEach(s => dec[s.id] = s.id === "SIDE.Bulletin" ? "Event" : "Business Operation");
  (c.data || []).filter(d => d.kind === "field" || d.kind === "crossReference").forEach(d => dec[d.id] = "Include");
  (c.security || []).forEach(s => dec[s.id] = "Require (auth)");
  (c.dependencies || []).forEach(d => dec[d.id] = /FileMan|DIC|DIE|DIQ|DIR|XLFSTR|ENUTL|ENJ/.test(d.target || d.id) ? "Platform (reuse)" : "Integration");
  return { dec, oqPolicy };
}

function label(node) {
  return node.decisionPoint || node.name || node.key || node.target || node.global || (node.index ? "xref " + node.index : node.id);
}

// ---- tool handlers ----

function getState(graph, decisions) {
  const c = C(graph);
  const cats = { oq: c.openQuestions, rule: c.businessRules, beh: c.sideEffects, sec: c.security, dep: c.dependencies };
  const summary = {};
  for (const [k, arr] of Object.entries(cats)) {
    summary[k] = (arr || []).map(n => ({ id: n.id, label: label(n), decision: decisions.dec[n.id] || "(unset)" }));
  }
  const blocking = (c.openQuestions || []).filter(q => decisions.dec[q.id] === "Defer" || !(decisions.oqPolicy[q.id] || "").trim()).map(q => q.id);
  return { capability: c.name, summary, blocking };
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
    if (node.writes) layers.push("REST data service (e.g. POST /work-orders)", `FileMan file ${node.writes.file}`);
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

function setDisposition(graph, decisions, id, option) {
  const cat = categoryOf(graph, id);
  if (!cat) return { ok: false, message: `unknown node ${id}` };
  if (cat === "oq") return { ok: false, message: `${id} is an open question — use resolveOpenQuestion instead` };
  if (!CAT_OPTS[cat].includes(option)) return { ok: false, message: `option "${option}" invalid for ${id}; valid: ${CAT_OPTS[cat].join(", ")}` };
  decisions.dec[id] = option;
  return { ok: true, message: `${id} → ${option}`, decisions };
}

function resolveOpenQuestion(graph, decisions, id, mode, policy) {
  if (categoryOf(graph, id) !== "oq") return { ok: false, message: `${id} is not an open question` };
  if (!CAT_OPTS.oq.includes(mode)) return { ok: false, message: `mode must be one of ${CAT_OPTS.oq.join(", ")}` };
  decisions.dec[id] = mode;
  if (mode !== "Defer") decisions.oqPolicy[id] = policy || "";
  const resolved = mode !== "Defer" && (policy || "").trim();
  return { ok: true, message: `${id} → ${mode}${resolved ? " (resolved)" : " (still blocking — needs policy text)"}`, decisions };
}

function setBuildScope(graph, decisions, id, phase) {
  if (categoryOf(graph, id) !== "beh") return { ok: false, message: `${id} is not a side effect; build scope applies to behaviors/side effects` };
  if (!["Build now", "Defer"].includes(phase)) return { ok: false, message: `phase must be "Build now" or "Defer"` };
  decisions.scope = decisions.scope || {};
  decisions.scope[id] = phase;
  return { ok: true, message: `${id} build scope → ${phase}`, decisions };
}

function setIntegration(graph, decisions, id, target) {
  if (categoryOf(graph, id) !== "beh") return { ok: false, message: `${id} is not a side effect` };
  decisions.dec[id] = "Integration";
  decisions.integration = decisions.integration || {};
  const t = decisions.integration[id] || {};
  ["system", "endpoint", "trigger", "mapping"].forEach(k => { if (target && target[k] != null) t[k] = target[k]; });
  decisions.integration[id] = t;
  return { ok: true, message: `${id} → Integration (${t.system || "target TBD"})`, decisions };
}

const TOOL_SPECS = [
  { toolSpec: { name: "getState", description: "List all decision elements, their current disposition, and which open questions are still blocking.", inputSchema: { json: { type: "object", properties: {} } } } },
  { toolSpec: { name: "explainOption", description: "Explain what a disposition option means for a specific element: the IRIS artifact it produces, when to use it, and its risk.", inputSchema: { json: { type: "object", properties: { nodeId: { type: "string" }, option: { type: "string" } }, required: ["nodeId", "option"] } } } },
  { toolSpec: { name: "explainMapping", description: "Explain how a legacy element maps through the target layers (AI Hub / IRIS Production / REST / FileMan).", inputSchema: { json: { type: "object", properties: { nodeId: { type: "string" } }, required: ["nodeId"] } } } },
  { toolSpec: { name: "setDisposition", description: "Apply a disposition to an element (rule/behavior/data/security/dependency). Not for open questions.", inputSchema: { json: { type: "object", properties: { nodeId: { type: "string" }, option: { type: "string" } }, required: ["nodeId", "option"] } } } },
  { toolSpec: { name: "resolveOpenQuestion", description: "Resolve an open question: mode is 'Business rule', 'Required input', or 'Defer'; policy is the resolved rule/input statement.", inputSchema: { json: { type: "object", properties: { id: { type: "string" }, mode: { type: "string" }, policy: { type: "string" } }, required: ["id", "mode"] } } } },
  { toolSpec: { name: "setBuildScope", description: "Set whether a side effect is built in this phase. phase is 'Build now' or 'Defer' (defer = out of this build, revisit later).", inputSchema: { json: { type: "object", properties: { nodeId: { type: "string" }, phase: { type: "string" } }, required: ["nodeId", "phase"] } } } },
  { toolSpec: { name: "setIntegration", description: "Mark a side effect as an external integration and capture its target so the coding agent can build the call. Provide system (e.g. Jira), endpoint, trigger, and field mapping.", inputSchema: { json: { type: "object", properties: { nodeId: { type: "string" }, system: { type: "string" }, endpoint: { type: "string" }, trigger: { type: "string" }, mapping: { type: "string" } }, required: ["nodeId", "system"] } } } },
];

function runTool(name, input, ctx) {
  const { graph, decisions } = ctx;
  switch (name) {
    case "getState": return getState(graph, decisions);
    case "explainOption": return explainOption(graph, input.nodeId, input.option);
    case "explainMapping": return explainMapping(graph, input.nodeId);
    case "setDisposition": return setDisposition(graph, decisions, input.nodeId, input.option);
    case "resolveOpenQuestion": return resolveOpenQuestion(graph, decisions, input.id, input.mode, input.policy);
    case "setBuildScope": return setBuildScope(graph, decisions, input.nodeId, input.phase);
    case "setIntegration": return setIntegration(graph, decisions, input.nodeId, { system: input.system, endpoint: input.endpoint, trigger: input.trigger, mapping: input.mapping });
    default: return { error: `unknown tool ${name}` };
  }
}

module.exports = { TOOL_SPECS, runTool, defaultDecisions, getState, categoryOf, CAT_OPTS, findNode, label };
