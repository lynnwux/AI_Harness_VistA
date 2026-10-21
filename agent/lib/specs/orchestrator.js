"use strict";
// Orchestrator layer spec: the IRIS production. Uses the API layer by reference and lists what it
// needs from it — it never changes the API layer.
// Stub-first: the mandatory side effects are real operations; every other decided side effect is a stub
// (registered in the production, not wired) carrying what wiring it later will take. A stub never blocks the build.
const { cap, isBlocking, isMandatory, requiredTargetKeys, buildTargetKeys, buildDefaults, describeKey } = require("../rules");
const { requestContract } = require("./api");

const CONTAINER = "iris-ai-hub", NAMESPACE = "INTEROP";
const has = (implemented, id) => ((implemented && implemented.api) || []).some(s => s.id === id);
const filled = v => String(v == null ? "" : v).trim() !== "";

function needsFor(se, target, implemented) {
  const out = [];
  if (se.writes) {
    const service = "write:" + se.writes.file;
    out.push({ for: se.id, service, what: `write file ${se.writes.file} for ${se.name} — proposed in the API spec from \`${se.call}\``, from: "api", met: has(implemented, service) });
  }
  if (target.via === "vista" && !se.writes) {
    const service = "call:" + se.call;
    out.push({ for: se.id, service, what: `run \`${se.call}\` on VistA for ${se.name}`, from: "api", met: has(implemented, service) });
  }
  return out;
}

// What a side effect is in this build: a real operation, a stub, or not built (and why).
function standing(se, record, oqs) {
  if (isMandatory(se)) return { as: "real" };
  if (record.dec[se.id] === "Drop") return { as: "notBuilt", reason: "dropped — not carried forward" };
  const q = se.openQuestion;
  if (q && isBlocking(record, q)) return { as: "notBuilt", reason: `waiting on the decision: ${oqs.find(x => x.id === q).decisionPoint}` };
  if (q && record.dec[q] === "Defer") return { as: "stub", reason: record.oqPolicy[q] };
  if ((record.scope[se.id] || "Build now") === "Defer") return { as: "stub", reason: "deferred to a later phase" };
  return { as: "stub", reason: null };
}

// What a legacy message template depends on, from the graph's params[].dependsOn — surfaced, never decided.
function templateNotes(se, graph, record) {
  const t = se.messageTemplate; if (!t) return [];
  const oqs = cap(graph).openQuestions || [];
  return t.params.filter(p => p.dependsOn || p.pointer).map(p => {
    if (p.pointer) return `\`|${p.n}|\`: the request carries the pointer's IEN, not its name — until a name lookup is wired, the email shows the IEN`;
    if (p.dependsOn === "operatorIdentity") return `\`|${p.n}|\`: no operator identity reaches the pipeline yet, so this would name the service account, not the clerk`;
    const dep = cap(graph).sideEffects.find(x => x.id === p.dependsOn);
    if (!dep) return `\`|${p.n}|\` depends on ${p.dependsOn}`;
    const st = standing(dep, record, oqs).as;
    if (st === "real") return `\`|${p.n}|\` reports the outcome of ${dep.name} — run the bulletin after that step, as the legacy does`;
    if (st === "stub") return `\`|${p.n}|\` reports the outcome of ${dep.name}, which is a stub in this build — it would always report that step as not done`;
    return `\`|${p.n}|\` reports the outcome of ${dep.name}, which is not built in this phase — it would always report that step as not done`;
  });
}

// What wiring a stub later will take — listed for the developer, never blocking.
function laterFor(se, record, rule, contract, implemented) {
  const L = [];
  if (rule && rule.mode === "Business rule" && rule.bindings === null) L.push("bind the policy's data words to fields of the API request contract");
  for (const [w, f] of Object.entries((rule && rule.bindings) || {})) {
    if (!contract.has(String(f))) L.push(`"${w}" is bound to fld ${f}, which the API request contract no longer carries`);
  }
  if (rule && rule.mode === "Required input") L.push(`operator prompt on the front end: "${rule.promptText}" (Phase 1 — \`prompt:${rule.id}\`)`);
  const target = record.targets[se.id] || {};
  const open = requiredTargetKeys(se, record).filter(k => !filled(target[k]));
  if (open.length) L.push(`target details: ${open.join(", ")}`);
  needsFor(se, target, implemented).filter(n => !n.met).forEach(n => L.push(`${n.what} (Phase 1 — \`${n.service}\`)`));
  return L;
}

function buildOrchestratorSpec(graph, record, implemented) {
  const c = cap(graph), oqs = c.openQuestions || [];
  const missing = [], needs = [], rules = [];
  const contract = new Set(requestContract(graph, record).map(f => f.field));
  for (const q of oqs) {
    if (isBlocking(record, q.id)) { missing.push({ id: q.id, kind: "decide", what: `decide: ${q.decisionPoint}` }); continue; }
    const mode = record.dec[q.id];
    if (mode === "Defer") continue;
    rules.push({ id: q.id, decisionPoint: q.decisionPoint, mode, policy: record.oqPolicy[q.id], bindings: record.ruleBindings[q.id] === undefined ? null : record.ruleBindings[q.id], promptText: q.promptText });
  }
  const coded = (c.businessRules || []).filter(r => record.dec[r.id] !== "Drop")
    .map(r => ({ id: r.id, name: r.name, disposition: record.dec[r.id] || "Preserve", condition: r.condition, effect: r.effect }));
  const built = [], stubs = [], notBuilt = [];
  for (const se of c.sideEffects || []) {
    const st = standing(se, record, oqs);
    const entry = { id: se.id, name: se.name, call: se.call, disposition: record.dec[se.id], mandatory: isMandatory(se), gatedBy: se.openQuestion || null, evidence: se.legacyEvidence || [], template: se.messageTemplate || null, templateNotes: [] };
    if (st.as === "notBuilt") { notBuilt.push({ ...entry, target: record.targets[se.id] || {}, reason: st.reason }); continue; }
    if (st.as === "stub") {
      const rule = rules.find(r => r.id === se.openQuestion) || null;
      stubs.push({ ...entry, target: record.targets[se.id] || {}, stub: true, reason: st.reason, decision: rule, later: laterFor(se, record, rule, contract, implemented) });
      continue;
    }
    // a real operation: recorded details over this build's defaults
    const defaults = buildDefaults(se, record), recorded = record.targets[se.id] || {};
    const target = { ...defaults, ...Object.fromEntries(Object.entries(recorded).filter(([, v]) => filled(v))) };
    if (record.dec[se.id] === "Drop") missing.push({ id: se.id, kind: "decide", what: `decide how ${se.name} is implemented — it is mandatory, so the Drop in the record cannot apply` });
    if (!se.targetKind && record.dec[se.id] !== "Integration") missing.push({ id: se.id, kind: "evidence", what: `${se.name}: legacy evidence not yet recorded in the graph` });
    for (const key of buildTargetKeys(se, record)) {
      if (!filled(target[key])) missing.push({ id: se.id, kind: "target", key, what: `${se.name}: ${describeKey(se, record, key)}` });
    }
    needs.push(...needsFor(se, target, implemented));
    built.push({ ...entry, target, defaults: Object.keys(defaults).filter(k => !filled(recorded[k])), templateNotes: templateNotes(se, graph, record) });
  }
  const security = (c.security || []).filter(s => record.dec[s.id] !== "Drop").map(s => ({ id: s.id, key: s.key, gates: s.gates, disposition: record.dec[s.id] }));
  return {
    layer: "orchestrator",
    builds: [`IRIS Interoperability production in container \`${CONTAINER}\`, namespace \`${NAMESPACE}\``, "a front door, an orchestrator, one real operation per mandatory side effect and one stub operation per other decided side effect — every outbound operation dry-run until enabled"],
    owns: ["the production's front-door request/response: the 6914 create request (see the API spec) plus a per-side-effect outcome (fired | skipped | dry-run | stub | degraded)", "the rules below"],
    uses: ["API: `POST /equipment` — the 6914 create contract"],
    needs, missing,
    complete: missing.length === 0 && needs.every(n => n.met),
    detail: { container: CONTAINER, namespace: NAMESPACE, rules, coded, built, stubs, notBuilt, security, request: requestContract(graph, record) },
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
  if (!spec.needs.length) L.push("- none for this build");
  spec.needs.forEach(n => L.push(`- ${n.met ? "✅ met" : "⛔ **unmet — requires Phase 1 work, not decidable here**"}: ${n.what} (\`${n.service}\`)`));
  L.push("");
  L.push("## Rules");
  L.push("### From resolved open questions");
  if (!d.rules.length) L.push("- none");
  d.rules.forEach(r => {
    const b = r.bindings === null ? "field bindings: later, when its stub is wired"
      : Object.keys(r.bindings).length ? "fields: " + Object.entries(r.bindings).map(([w, f]) => `${w} → fld ${f} ${fieldName(f)}`).join("; ")
      : "fields: none (the policy uses no data)";
    L.push(`- **${r.decisionPoint}** — ${r.mode}: "${r.policy}" · ${b}`);
  });
  L.push("### Coded in the legacy");
  if (!d.coded.length) L.push("- none");
  d.coded.forEach(r => L.push(`- **${r.name}** (${r.disposition}): \`${r.condition}\` → ${r.effect}`));
  L.push("");
  L.push("## Side effects — real operations");
  if (!d.built.length) L.push("- none");
  d.built.forEach(e => {
    const se = cap(graph).sideEffects.find(x => x.id === e.id);
    L.push(`### ${e.name}${e.mandatory ? " — mandatory" : ""}`);
    L.push(`- Decision: ${e.disposition}${e.mandatory ? " · always built (the legacy calls it unconditionally)" : ""}`);
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
    const ask = buildTargetKeys(se, record);
    [...new Set([...requiredTargetKeys(se, record), ...ask, ...Object.keys(e.target)])].forEach(k => {
      const v = e.target[k];
      if (filled(v)) L.push(`  - ${k}: ${v}${e.defaults.includes(k) ? " (default)" : ""}`);
      else if (ask.includes(k)) L.push(`  - ▢ ${k} — ${describeKey(se, record, k)}`);
    });
    L.push("- Dry-run: on until enabled");
  });
  L.push("");
  L.push("## Stubs — registered in the production, not wired");
  L.push("Each is a Business Operation registered in the production that does nothing yet. It carries the decision and its legacy evidence; wiring it is later work and never blocks this build.");
  if (!d.stubs.length) L.push("- none");
  d.stubs.forEach(e => {
    const why = e.decision ? `${e.decision.mode}: "${e.decision.policy}"` : `deferred — ${e.reason}`;
    L.push(`- **${e.name}** — ${why}`);
    e.evidence.forEach(x => L.push(`  - \`${x.routine}\` ${x.line}: ${x.says}`));
    L.push(`  - Later, to wire this stub: ${e.later.length ? e.later.join("; ") : "nothing recorded yet"}`);
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
