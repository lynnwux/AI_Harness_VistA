"use strict";
// Orchestrator layer spec: the IRIS production. Uses the API layer by reference and lists what it
// needs from it — it never changes the API layer.
const { cap, isBlocking, isBuilt, isMandatory, requiredTargetKeys, describeKey } = require("../rules");
const { requestContract } = require("./api");

const CONTAINER = "iris-ai-hub", NAMESPACE = "INTEROP";
const has = (implemented, id) => ((implemented && implemented.api) || []).some(s => s.id === id);

function needsFor(se, record, implemented) {
  const out = [];
  if (se.writes) {
    const service = "write:" + se.writes.file;
    out.push({ for: se.id, service, what: `write file ${se.writes.file} for ${se.name} — proposed in the API spec from \`${se.call}\``, from: "api", met: has(implemented, service) });
  }
  if ((record.targets[se.id] || {}).via === "vista" && !se.writes) {
    const service = "call:" + se.call;
    out.push({ for: se.id, service, what: `run \`${se.call}\` on VistA for ${se.name}`, from: "api", met: has(implemented, service) });
  }
  return out;
}

// What a legacy message template depends on, from the graph's params[].dependsOn — surfaced, never decided.
function templateNotes(se, graph, record) {
  const t = se.messageTemplate; if (!t) return [];
  return t.params.filter(p => p.dependsOn).map(p => {
    if (p.dependsOn === "operatorIdentity") return `\`|${p.n}|\`: no operator identity reaches the pipeline yet, so this would name the service account, not the clerk`;
    const dep = cap(graph).sideEffects.find(x => x.id === p.dependsOn);
    if (!dep) return `\`|${p.n}|\` depends on ${p.dependsOn}`;
    return isBuilt(dep, record)
      ? `\`|${p.n}|\` reports the outcome of ${dep.name} — run the bulletin after that step, as the legacy does`
      : `\`|${p.n}|\` reports the outcome of ${dep.name}, which is not built in this phase — it would always report that step as not done`;
  });
}

function buildOrchestratorSpec(graph, record, implemented) {
  const c = cap(graph), oqs = c.openQuestions || [];
  const missing = [], needs = [], rules = [];
  for (const q of oqs) {
    if (isBlocking(record, q.id)) { missing.push({ id: q.id, kind: "decide", what: `decide: ${q.decisionPoint}` }); continue; }
    const mode = record.dec[q.id];
    if (mode === "Defer") continue;
    rules.push({ id: q.id, decisionPoint: q.decisionPoint, mode, policy: record.oqPolicy[q.id], bindings: record.ruleBindings[q.id] === undefined ? null : record.ruleBindings[q.id] });
    if (record.ruleBindings[q.id] === undefined) missing.push({ id: q.id, kind: "binding", what: `bind the data words in the policy for "${q.decisionPoint}" to fields of the API request contract` });
    if (mode === "Required input") {
      const service = "prompt:" + q.id;
      needs.push({ for: q.id, service, what: `operator prompt on the front end: "${q.promptText}"`, from: "api", met: has(implemented, service) });
    }
  }
  const coded = (c.businessRules || []).filter(r => record.dec[r.id] !== "Drop")
    .map(r => ({ id: r.id, name: r.name, disposition: record.dec[r.id] || "Preserve", condition: r.condition, effect: r.effect }));
  const built = [], deferred = [], notBuilt = [];
  for (const se of c.sideEffects || []) {
    const entry = { id: se.id, name: se.name, call: se.call, disposition: record.dec[se.id], mandatory: isMandatory(se), gatedBy: se.openQuestion || null, evidence: se.legacyEvidence || [], target: record.targets[se.id] || {}, template: se.messageTemplate || null, templateNotes: [] };
    if (!isBuilt(se, record)) {
      const q = se.openQuestion;
      if (record.dec[se.id] === "Drop") { notBuilt.push({ ...entry, reason: "dropped — not carried forward" }); continue; }
      if (q && isBlocking(record, q)) { notBuilt.push({ ...entry, reason: `waiting on the decision: ${oqs.find(x => x.id === q).decisionPoint}` }); continue; }
      // a Defer is a decision: an unwired stub, no target details, no needs — it never blocks Phase 2
      deferred.push({ ...entry, stub: true, reason: q && record.dec[q] === "Defer" ? record.oqPolicy[q] : "deferred to a later phase" });
      continue;
    }
    if (!se.targetKind && record.dec[se.id] !== "Integration") missing.push({ id: se.id, kind: "evidence", what: `${se.name}: legacy evidence not yet recorded in the graph` });
    for (const key of requiredTargetKeys(se, record)) {
      if (!String(entry.target[key] || "").trim()) missing.push({ id: se.id, kind: "target", key, what: `${se.name}: ${describeKey(se, record, key)}` });
    }
    needs.push(...needsFor(se, record, implemented));
    entry.templateNotes = templateNotes(se, graph, record);
    built.push(entry);
  }
  const security = (c.security || []).filter(s => record.dec[s.id] !== "Drop").map(s => ({ id: s.id, key: s.key, gates: s.gates, disposition: record.dec[s.id] }));
  return {
    layer: "orchestrator",
    builds: [`IRIS Interoperability production in container \`${CONTAINER}\`, namespace \`${NAMESPACE}\``, "a front door, an orchestrator, and one operation per built side effect — every outbound operation dry-run until enabled"],
    owns: ["the production's front-door request/response: the 6914 create request (see the API spec) plus a per-side-effect outcome (fired | skipped | dry-run | degraded)", "the rules below"],
    uses: ["API: `POST /equipment` — the 6914 create contract"],
    needs, missing,
    complete: missing.length === 0 && needs.every(n => n.met),
    detail: { container: CONTAINER, namespace: NAMESPACE, rules, coded, built, deferred, notBuilt, security, request: requestContract(graph, record) },
  };
}

function renderOrchestrator(graph, record, spec) {
  const d = spec.detail, L = [];
  const fieldName = f => { const x = d.request.find(r => r.field === String(f)); return x ? x.name : "?"; };
  const unmet = spec.needs.filter(n => !n.met);
  const s = n => (n === 1 ? "" : "s");
  L.push("# Orchestrator layer spec — RegisterEquipment");
  L.push(spec.complete ? "✅ Complete — ready for the production build." : `⛔ Not ready for the production build: ${spec.missing.length} item${s(spec.missing.length)} missing · ${unmet.length} unmet need${s(unmet.length)}.`);
  L.push("");
  L.push("## Builds"); spec.builds.forEach(b => L.push(`- ${b}`)); L.push("");
  L.push("## Owns"); spec.owns.forEach(o => L.push(`- ${o}`)); L.push("");
  L.push("## Uses (by reference — see the API spec)"); spec.uses.forEach(u => L.push(`- ${u}`)); L.push("");
  L.push("## Needs from lower layers");
  if (!spec.needs.length) L.push("- none");
  spec.needs.forEach(n => L.push(`- ${n.met ? "✅ met" : "⛔ **unmet — requires Phase 1 work, not decidable here**"}: ${n.what} (\`${n.service}\`)`));
  L.push("");
  L.push("## Rules");
  L.push("### From resolved open questions");
  if (!d.rules.length) L.push("- none");
  d.rules.forEach(r => {
    const b = r.bindings === null ? "▢ field bindings"
      : Object.keys(r.bindings).length ? "fields: " + Object.entries(r.bindings).map(([w, f]) => `${w} → fld ${f} ${fieldName(f)}`).join("; ")
      : "fields: none (the policy uses no data)";
    L.push(`- **${r.decisionPoint}** — ${r.mode}: "${r.policy}" · ${b}`);
  });
  L.push("### Coded in the legacy");
  if (!d.coded.length) L.push("- none");
  d.coded.forEach(r => L.push(`- **${r.name}** (${r.disposition}): \`${r.condition}\` → ${r.effect}`));
  L.push("");
  L.push("## Side effects — built");
  if (!d.built.length) L.push("- none");
  d.built.forEach(e => {
    const se = cap(graph).sideEffects.find(x => x.id === e.id);
    const rule = d.rules.find(r => r.id === e.gatedBy);
    L.push(`### ${e.name}${e.mandatory ? " — mandatory" : ""}`);
    L.push(`- Decision: ${e.disposition}${e.mandatory ? " · always built (the legacy calls it unconditionally)" : rule ? ` · gate: ${rule.mode} "${rule.policy}"` : ""}`);
    L.push("- Legacy evidence:");
    if (!e.evidence.length) L.push("  - ▢ not yet recorded");
    e.evidence.forEach(x => L.push(`  - \`${x.routine}\` ${x.line}: ${x.says}`));
    if (e.template) {
      const t = e.template;
      L.push(`- Legacy message template (${t.source}) — the starting point for the modern message:`);
      L.push(`  - From: ${t.sender}`);
      L.push(`  - Subject: \`${t.subject}\``);
      L.push(`  - Body: ${t.body.map(b => (b.trim() ? "`" + b + "`" : "(blank line)")).join(" / ")}`);
      t.params.forEach(p => L.push(`  - \`|${p.n}|\` — ${p.value}${p.ifBlank ? ` (blank → \`${p.ifBlank}\`)` : ""}`));
      L.push(`  - Recipients (legacy): ${t.recipients}`);
      e.templateNotes.forEach(n => L.push(`  - ⚠ ${n}`));
    }
    L.push("- Target details:");
    const req = requiredTargetKeys(se, record);
    req.concat(Object.keys(e.target).filter(k => !req.includes(k))).forEach(k => {
      const v = e.target[k];
      L.push(v ? `  - ${k}: ${v}` : `  - ▢ ${k} — ${describeKey(se, record, k)}`);
    });
    L.push("- Dry-run: on until enabled");
  });
  L.push("");
  L.push("## Deferred — stub only, not wired");
  L.push("Each gets a stub Business Operation in the production — registered, never called — carrying its legacy evidence and the reason below. No target details are needed, so deferring never blocks this build.");
  if (!d.deferred.length) L.push("- none");
  d.deferred.forEach(e => {
    L.push(`- **${e.name}** — ${e.reason}`);
    e.evidence.forEach(x => L.push(`  - \`${x.routine}\` ${x.line}: ${x.says}`));
  });
  L.push("");
  L.push("## Not built");
  if (!d.notBuilt.length) L.push("- none");
  d.notBuilt.forEach(e => L.push(`- ${e.name} — ${e.reason}`));
  L.push("");
  L.push("## Security / auth");
  d.security.forEach(x => L.push(`- \`${x.key}\` → ${x.disposition}: gates ${x.gates}`));
  L.push("- Operator identity: no clerk identity reaches the pipeline yet, so key checks cannot be enforced.");
  L.push("");
  L.push("## Deployment");
  L.push(`- Deploy into container \`${d.container}\`, namespace \`${d.namespace}\`.`);
  L.push("- Route the Angular app's saves through the production: the dev server's `POST /equipment` forwarding target changes; the app itself does not.");
  L.push("");
  L.push("## Missing (▢)");
  if (!spec.missing.length) L.push("- none");
  spec.missing.forEach(m => L.push(`- ▢ ${m.what}`));
  return L.join("\n") + "\n";
}

module.exports = { buildOrchestratorSpec, renderOrchestrator };
