"use strict";
// Keeps what the chat says in step with the decisions record. The record is the truth; these checks correct a
// reply that says otherwise, deterministically, in the same reply — the model is never trusted to report itself.
const { THRESH, buildIndex } = require("./grounding");

// the tools that change the record (every other tool only reads)
const RECORDING_TOOLS = ["setDisposition", "resolveOpenQuestion", "setBuildScope", "setTarget", "bindRuleTerms", "setQuickQuestion"];
// what a recording tool answers during a read-only turn (the grounding retry rewrites the reply, never the record)
const READ_ONLY_MSG = "refused: this turn only rewrites the reply — the first draft's record changes already stand, so recording tools are switched off. Do not call them.";

const plain = s => String(s || "").replace(/[*_`~]/g, "").replace(/\s+/g, " ").trim();
const norm = s => String(s || "").replace(/[\s,]/g, "").toLowerCase();
// "I've recorded …", "… has been set", "is now resolved", a reply opening with "Done/Recorded/Saved", "Recorded — …"
const CLAIM = /\bI(?:'ve| have)\s+(?:now\s+|also\s+)?(?:recorded|saved|updated|set|changed|resolved|marked|stored)\b|\b(?:has|have) been (?:recorded|saved|updated|set|changed|resolved|stored)\b|\bis now (?:set|recorded|resolved|stored)\b|^(?:done|recorded|saved)\b|\b(?:done|recorded|saved)\s*[—–-]/i;

// The notes appended under a reply: every refused recording, and a claim of recording when nothing changed.
function syncNotes({ reply, recorded = [], toolTrace = [] }) {
  const notes = [], seen = new Set();
  for (const t of toolTrace) {
    const r = t && t.result;
    if (!RECORDING_TOOLS.includes(t.name) || !r || !(r.ok === false || r.error) || r.message === READ_ONLY_MSG) continue;
    const id = (t.input && (t.input.id || t.input.nodeId)) || "";
    const text = `⚠ Not recorded: ${t.name}${id ? " " + id : ""} — ${r.message || r.error}`;
    if (!seen.has(text)) { seen.add(text); notes.push({ check: "refused", text }); }
  }
  if (!recorded.length && !notes.length && CLAIM.test(plain(reply))) {
    notes.push({ check: "claim-without-change", text: "⚠ Nothing was recorded this turn — the record is unchanged, so anything the reply above says was recorded is not in it. Say it again and it will be recorded." });
  }
  return notes;
}

// Changed text values (a policy, a target detail, a wording) that state a threshold found in neither the developer's
// words, the value it replaced, nor the item's own evidence — the same test the reply's threshold check applies.
function ungroundedChanges({ changes, before, graph, userMessage = "", index }) {
  const ix = index || buildIndex(graph);
  const text = id => { const g = ix.groups.find(x => x.id === id || x.members.includes(id)); return g ? g.text : ""; };
  return changes.filter(c => typeof c.after === "string").map(c => {
    const allowed = norm([userMessage, typeof c.before === "string" ? c.before : "", text(c.id)].join("\n"));
    const thresholds = [...new Set((c.after.match(THRESH) || []).map(s => s.trim()))].filter(s => !allowed.includes(norm(s)));
    return { ...c, thresholds };
  }).filter(c => c.thresholds.length);
}

// Put back exactly the listed leaves (diffRecords changes) from `before`; nothing else is touched.
function revertChanges(record, before, changes) {
  for (const c of changes) {
    const [section, ...rest] = c.field.split(".");
    const keyPath = rest.join(".");
    if (!keyPath) {
      if (before[section] && c.id in before[section]) record[section][c.id] = before[section][c.id];
      else delete record[section][c.id];
      continue;
    }
    const keys = keyPath.split(".");
    let node = record[section][c.id];
    for (const k of keys.slice(0, -1)) node = node && node[k];
    if (!node) continue;
    const last = keys[keys.length - 1];
    if (c.before === null || c.before === undefined) delete node[last]; else node[last] = c.before;
  }
  return record;
}

module.exports = { RECORDING_TOOLS, READ_ONLY_MSG, syncNotes, ungroundedChanges, revertChanges };
