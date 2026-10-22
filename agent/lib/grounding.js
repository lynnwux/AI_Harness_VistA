"use strict";
// Grounding check for chat replies. Deterministic — no model. Flags:
//   · legacy terms (routines, keys, codes, file numbers, rule-condition words) that appear only in
//     ANOTHER item's evidence, never in the evidence of the item the reply is about;
//   · thresholds stated in neither that item's evidence nor the developer's own words.
// Items: each open question with the side effects it gates and the rules they reference, plus each
// side effect that has no question (e.g. the bulletin). Vocabulary is built from the graph itself.
// AI template groups are added when inventory is supplied (one group per TEMPLATES entry).

const { TEMPLATES } = require("./ai-templates");

const STOP = new Set(["YES", "NO", "NOT", "AND", "OR", "OF", "THE", "IF", "IS", "IT", "IN", "ON", "BY", "TO", "FOR", "ALL", "ANY",
  "ASK", "DD", "IEN", "DUZ", "FLD", "ENG", "XUSEC", "POLICY", "NOTE", "BP", "API", "REST", "IRIS", "UI", "OK", "ID", "AT", "AS",
  "BE", "DO", "SO", "UP", "NOW", "MUMPS", "THEN", "ELSE", "ONLY", "ALSO", "WHEN", "WITH", "FROM", "THIS", "THAT"]);
const NAME_STOP = new Set(["to", "the", "of", "a", "an", "and", "new", "equipment", "item", "record"]);
const LEX_STOP = new Set(["confirms", "prompt", "gated", "eligible", "held"]);
const TOKEN = /\^?[A-Z][A-Z0-9]*(?:\^[A-Z][A-Z0-9]*)*|\b\d{3,4}(?:\.\d+)?\b/g;
const THRESH = /(?:≥|≤|>=|<=|>|<)\s*\$?\s*(?:\d[\d,]*(?:\.\d+)?|X\b)|\$\s?\d[\d,]*(?:\.\d+)?/g;

const cap = g => g.capabilities[0];
const escRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const lexRe = w => new RegExp(`\\b${escRe(w).replace(/i[sz]ed$/, "i[sz]ed")}\\b`, "i");
const norm = s => String(s || "").replace(/[\s,]/g, "").toLowerCase();

function tokens(text) {
  const out = new Set();
  for (const t of String(text || "").match(TOKEN) || []) {
    const bare = t.replace(/^\^/, "");
    for (const p of [bare, ...bare.split("^")]) if (p.length >= 2 && !STOP.has(p)) out.add(p);
  }
  return out;
}

function nodeText(n) {
  const parts = [n.name, n.decisionPoint, n.promptText, n.codedBehavior, n.whatIsNotCoded, n.condition, n.effect, n.call, n.key, n.gates];
  if (n.writes) parts.push(n.writes.global, String(n.writes.file));
  if (n.meta) parts.push(...(n.meta.evidence || []), ...(n.meta.conditions || []));
  for (const e of n.legacyEvidence || []) parts.push(e.routine, e.line, e.says);
  return parts.filter(Boolean).join("\n");
}

function evidenceLines(n) {
  return [
    n.codedBehavior, n.whatIsNotCoded, n.condition && `condition: ${n.condition}`,
    ...((n.meta && n.meta.evidence) || []),
    ...(n.legacyEvidence || []).map(e => `${e.routine} ${e.line}: ${e.says}`),
  ].filter(Boolean);
}

function buildIndex(graph, inventory) {
  const c = cap(graph);
  const lexicon = [...new Set((c.businessRules || []).flatMap(r => ((r.meta && r.meta.conditions) || []).flatMap(s => s.match(/\b[a-z]{5,}\b/g) || [])))]
    .filter(w => !LEX_STOP.has(w));
  const group = (id, names, nodes) => {
    const text = nodes.map(nodeText).join("\n");
    const aliasWords = [...new Set(names.flatMap(n => String(n).toLowerCase().split(/[\s\-/]+/)).filter(w => w.length >= 2 && !NAME_STOP.has(w)))];
    return { id, names, members: nodes.map(n => n.id), aliasWords, need: aliasWords.length >= 3 ? 2 : 1, vocab: tokens(text), lex: new Set(lexicon.filter(w => lexRe(w).test(text))), evidence: nodes.flatMap(evidenceLines), text };
  };
  const groups = [], used = new Set();
  for (const q of c.openQuestions || []) {
    const ses = (c.sideEffects || []).filter(s => s.openQuestion === q.id);
    ses.forEach(s => used.add(s.id));
    const ruleIds = new Set([...((q.meta && q.meta.conditions) || []), ...ses.flatMap(s => (s.meta && s.meta.conditions) || [])]);
    const rules = (c.businessRules || []).filter(r => ruleIds.has(r.id));
    groups.push(group(q.id, ses.length ? ses.map(s => s.name) : [q.decisionPoint], [q, ...ses, ...rules]));
  }
  for (const s of c.sideEffects || []) if (!used.has(s.id)) groups.push(group(s.id, [s.name], [s]));
  // shared vocabulary — the capability's own file, entry routine and field names — is never "borrowed"
  const common = new Set();
  for (const d of c.data || []) { tokens(d.name).forEach(t => common.add(t)); if (d.file) common.add(String(d.file)); }
  if (c.entryPoint) tokens(`${c.entryPoint.dispatch || ""} ${c.entryPoint.name || ""}`).forEach(t => common.add(t));
  tokens((graph.workflow && graph.workflow.name) || "").forEach(t => common.add(t));
  // every field of file 6914 (its SQL column and DD name) is the capability's own vocabulary too, not only the form's
  if (inventory && inventory.tables && inventory.tables.EQUIPMENT_INV_6914) {
    for (const col of inventory.tables.EQUIPMENT_INV_6914.columns || []) {
      tokens(String(col.column || "").replace(/_+/g, " ")).forEach(t => common.add(t));
      tokens(col.ddName || "").forEach(t => common.add(t));
    }
  }
  // AI template groups — one per template, evidence from inventory columns
  if (inventory) {
    for (const t of TEMPLATES) {
      const evLines = (t.evidenceColumns || []).flatMap(k => (inventory.evidence || {})[k] || []);
      const text = [t.defaultWording, ...evLines].join("\n");
      // Strip trailing punctuation (e.g. "contract?" → "contract") so alias tokens
      // behave as whole words. need=4: AI wordings share common terms like "inspection",
      // "work", "order" with capability-graph replies; 4 matches prevent false positives
      // while still focusing on replies that clearly name the AI question (3+ distinctive
      // words like "jcaho","pending","inspection","items" from a single AI question).
      const aliasWords = [...new Set(
        [t.defaultWording].flatMap(n => String(n).toLowerCase().split(/[\s\-/]+/))
          .map(w => w.replace(/[^a-z0-9]/g, ""))
          .filter(w => w.length >= 2 && !NAME_STOP.has(w))
      )];
      groups.push({
        id: t.id,
        names: [t.defaultWording],
        members: [],
        aliasWords,
        need: 4,
        vocab: tokens(text),
        lex: new Set(lexicon.filter(w => lexRe(w).test(text))),
        evidence: evLines,
        text,
      });
    }
  }
  return { groups, common, lexicon };
}

function checkReply({ graph, reply, userMessage = "", record = {}, currentId = null, index }) {
  const ix = index || buildIndex(graph);
  const text = String(reply || "");
  const hay = (text + "\n" + userMessage).toLowerCase();
  const named = ix.groups.filter(g => g.aliasWords.filter(w => new RegExp(`(^|[^a-z0-9])${escRe(w)}([^a-z0-9]|$)`).test(hay)).length >= g.need);
  const focus = named.length ? named : ix.groups.filter(g => g.id === currentId || g.members.includes(currentId));
  if (!focus.length) return { ok: true, focus: [], borrowed: [], thresholds: [] };
  const focusVocab = new Set(focus.flatMap(g => [...g.vocab])), focusLex = new Set(focus.flatMap(g => [...g.lex]));
  const others = ix.groups.filter(g => !focus.includes(g));
  const borrowed = [];
  // dollar amounts are judged by the threshold rule below, never as borrowed legacy terms ("$50,000" is not the term "000")
  for (const t of tokens(text.replace(THRESH, " "))) {
    if (focusVocab.has(t) || ix.common.has(t)) continue;
    const from = others.filter(g => g.vocab.has(t)).map(g => g.id);
    if (from.length) borrowed.push({ term: t, from });
  }
  for (const w of ix.lexicon) {
    if (focusLex.has(w) || !lexRe(w).test(text)) continue;
    const from = others.filter(g => g.lex.has(w)).map(g => g.id);
    if (from.length) borrowed.push({ term: w, from });
  }
  // a threshold is supported by the focused item's evidence, the developer's words now, that item's recorded
  // policy, or the recorded params of the focused AI question (number params as "$value" to match threshold patterns)
  const allowed = norm([
    focus.map(g => g.text).join("\n"),
    userMessage,
    ...focus.map(g => (record.oqPolicy || {})[g.id] || ""),
    ...focus.flatMap(g => {
      const entry = (record.aiQuestions || {})[g.id];
      if (!entry || !entry.params) return [];
      return Object.values(entry.params).map(v => typeof v === "number" && v >= 0 ? "$" + v : String(v));
    }),
  ].join("\n"));
  const thresholds = [...new Set((text.match(THRESH) || []).map(s => s.trim()))].filter(s => !allowed.includes(norm(s)));
  return { ok: borrowed.length === 0 && thresholds.length === 0, focus: focus.map(g => g.id), borrowed, thresholds };
}

const namesOf = (ix, id) => { const g = ix.groups.find(x => x.id === id); return g ? g.names.join(" / ") : id; };
const borrowedText = (r, ix) => r.borrowed.map(b => `${b.term} (from ${b.from.map(id => namesOf(ix, id)).join(", ")})`).join("; ");

// The message sent back to the chat for one automatic retry.
function correctionPrompt(r, ix) {
  const focus = r.focus.map(id => ix.groups.find(g => g.id === id)).filter(Boolean);
  const L = [`GROUNDING CHECK (automatic — not from the developer). Your previous reply did not stay within the evidence for: ${focus.map(g => g.names.join(" / ")).join("; ")}.`];
  if (r.borrowed.length) L.push(`It used terms that come from OTHER items' evidence: ${borrowedText(r, ix)}.`);
  if (r.thresholds.length) L.push(`It stated thresholds that appear in neither this item's evidence nor the developer's words: ${r.thresholds.join("; ")}.`);
  L.push("Rewrite the reply using ONLY this item's evidence, quoted where you describe the legacy:");
  focus.forEach(g => g.evidence.forEach(e => L.push(`- ${e}`)));
  L.push("Do not mention this check; just give the corrected reply.");
  return L.join("\n");
}

// Shown under a reply the retry fixed, so the developer can see the guardrail at work.
function correctedNote(r, ix) {
  const parts = [];
  if (r.borrowed.length) parts.push(`borrowed ${borrowedText(r, ix)}`);
  if (r.thresholds.length) parts.push(`stated an unsupported threshold (${r.thresholds.join("; ")})`);
  return `↻ Grounding check: a first draft ${parts.join(" and ")}; this reply was regenerated from this item's evidence.`;
}

// Shown under a reply the retry did NOT fix.
function warningNote(r, ix) {
  const parts = [];
  if (r.borrowed.length) parts.push(`terms from other items' evidence — ${borrowedText(r, ix)}`);
  if (r.thresholds.length) parts.push(`thresholds found in neither the evidence nor your words — ${r.thresholds.join("; ")}`);
  return `⚠ **Grounding check:** this reply still contains ${parts.join(", and ")}. Treat those parts as unverified and check the item's evidence.`;
}

// One chat turn with the guardrail: run, check, and on a failed check retry once with the item's
// evidence. `run(userText, history)` is the agent call, injected so the loop is testable without a model.
// `inventory` is optional; when supplied it is passed to buildIndex so AI template groups are included.
async function groundedTurn({ run, message, history = [], graph, record, currentId, inventory }) {
  const index = buildIndex(graph, inventory);
  const ground = reply => checkReply({ graph, index, reply, userMessage: message, record, currentId });
  // the evidence card: the graph's own evidence for the item(s) the final reply is about
  const evidence = r => r.focus.map(id => ix(id)).filter(Boolean).map(g => ({ id: g.id, names: g.names, lines: g.evidence }));
  const ix = id => index.groups.find(g => g.id === id);
  const out = await run(message, history);
  const g = ground(out.reply);
  if (g.ok) return { reply: out.reply, toolTrace: out.toolTrace || [], grounding: { ok: true, retried: false }, evidence: evidence(g) };
  const out2 = await run(correctionPrompt(g, index), [...history, { role: "user", text: message }, { role: "assistant", text: out.reply }]);
  const g2 = ground(out2.reply);
  return {
    reply: out2.reply + "\n\n" + (g2.ok ? correctedNote(g, index) : warningNote(g2, index)),
    toolTrace: [...(out.toolTrace || []), ...(out2.toolTrace || [])],
    grounding: { ok: g2.ok, retried: true, first: g, second: g2.ok ? null : g2 },
    evidence: evidence(g2.focus.length ? g2 : g),
  };
}

module.exports = { buildIndex, checkReply, correctionPrompt, correctedNote, warningNote, groundedTurn, tokens };
