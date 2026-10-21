"use strict";
// The decisions record: load (with migration), atomic save, and a before/after diff that
// drives the page's decision cards. The record is written only by the chat tools.
const fs = require("fs");

const SECTIONS = ["dec", "oqPolicy", "scope", "targets", "ruleBindings", "aiQuestions"];

function normalize(raw) {
  const src = raw || {};
  const r = {};
  for (const k of SECTIONS) r[k] = src[k] && typeof src[k] === "object" ? src[k] : {};
  if (src.integration && typeof src.integration === "object" && !src.targets) r.targets = src.integration;
  return r;
}

// opts.backup (default true): copy an unreadable file aside before falling back; opts.onCorrupt(backupPath) is told.
// Readers that must not write (the build) pass { backup: false }.
function loadRecord(file, fallback, opts = {}) {
  let text;
  try { text = fs.readFileSync(file, "utf8"); }
  catch (e) { return normalize(fallback ? fallback() : {}); }
  try { return normalize(JSON.parse(text)); }
  catch (e) {
    if (opts.backup !== false) {
      // never silently discard the user's decisions: keep the unreadable file before falling back
      const bak = file.replace(/\.json$/, "") + ".corrupt-" + new Date().toISOString().replace(/[:.]/g, "-") + ".json";
      fs.writeFileSync(bak, text);
      if (opts.onCorrupt) opts.onCorrupt(bak);
    }
    return normalize(fallback ? fallback() : {});
  }
}

function saveRecord(file, record) {
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(record, null, 2));
  fs.renameSync(tmp, file);
}

function flat(record) {
  const out = {};
  for (const k of ["dec", "oqPolicy", "scope"]) for (const [id, v] of Object.entries(record[k] || {})) out[`${k}|${id}`] = v;
  for (const k of ["targets", "ruleBindings"]) for (const [id, obj] of Object.entries(record[k] || {})) {
    const entries = Object.entries(obj || {});
    if (!entries.length) out[`${k}|${id}|(none)`] = "(none)";
    for (const [key, v] of entries) out[`${k}|${id}|${key}`] = v;
  }
  // aiQuestions: { "AIQ.X": { keep, wording, params: { key: value, … } } }
  // Flat keys: aiQuestions|AIQ.X|keep, aiQuestions|AIQ.X|wording, aiQuestions|AIQ.X|params.<key>
  for (const [id, obj] of Object.entries(record.aiQuestions || {})) {
    const { keep, wording, params } = obj || {};
    if (keep !== undefined) out[`aiQuestions|${id}|keep`] = keep;
    if (wording !== undefined) out[`aiQuestions|${id}|wording`] = wording;
    for (const [pk, pv] of Object.entries(params || {})) out[`aiQuestions|${id}|params.${pk}`] = pv;
  }
  return out;
}

function diffRecords(before, after, labelOf) {
  const a = flat(before), b = flat(after);
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()
    .filter(k => JSON.stringify(a[k]) !== JSON.stringify(b[k]))
    .map(k => {
      const [field, id, key] = k.split("|");
      return { id, label: labelOf ? labelOf(id) : id, field: key ? `${field}.${key}` : field, before: k in a ? a[k] : null, after: k in b ? b[k] : null };
    });
}

module.exports = { SECTIONS, normalize, loadRecord, saveRecord, diffRecords };
