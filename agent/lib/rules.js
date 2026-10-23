"use strict";
// Shared predicates over the decisions record — one definition, used by the spec generator and the tools.
const TARGET_KEYS = {
  vistaWrite:   { writePath: "how the write is performed", fields: "which fields and values are written", operatorValues: "where the values the clerk used to type now come from" },
  notification: { channel: "delivery channel", recipients: "who receives it (no default)", content: "what it contains" },
  external:     { system: "external system", endpoint: "endpoint called", trigger: "when it is called", mapping: "field mapping" },
};
const OPTIONAL_KEYS = { external: ["settings"] };
const VIA = ["vista", "iris", "external"];
const VIA_HELP = "where the work is performed (vista | iris | external)";

const cap = graph => graph.capabilities[0];
const isBlocking = (record, oqId) => !String((record.oqPolicy || {})[oqId] || "").trim();
const isMandatory = se => !!se && se.legacyInvocation === "unconditional";   // discovery: the legacy always calls it
const kindFor = (se, record) => (record.dec[se.id] === "Integration" ? "external" : se.targetKind || null);
const requiredTargetKeys = (se, record) => { const k = kindFor(se, record); return ["via", ...(k ? Object.keys(TARGET_KEYS[k]) : [])]; };
const allowedTargetKeys = (se, record) => { const k = kindFor(se, record); return [...new Set([...requiredTargetKeys(se, record), ...((k && OPTIONAL_KEYS[k]) || []), ...(se.targetKind === "notification" ? ["recipients"] : [])])]; };
const describeKey = (se, record, key) => (key === "via" ? VIA_HELP : (TARGET_KEYS[kindFor(se, record)] || {})[key] || (TARGET_KEYS[se.targetKind] || {})[key] || key);

// This build is stub-first: only the mandatory side effects are real operations. A notification then needs
// only its recipients — it goes out as an email from IRIS built from the legacy template unless recorded otherwise.
const BUILD_KEYS = { notification: ["recipients"] };
const BUILD_DEFAULTS = { notification: { via: "iris", channel: "email", content: "the legacy message template" } };
// a notification is built as an email from IRIS whatever its disposition — an Integration is not built yet
const buildKind = (se, record) => (se.targetKind === "notification" ? "notification" : kindFor(se, record));
const buildTargetKeys = (se, record) => BUILD_KEYS[buildKind(se, record)] || requiredTargetKeys(se, record);
const buildDefaults = (se, record) => ({ ...(BUILD_DEFAULTS[buildKind(se, record)] || {}) });

// built = carried into this build: not dropped, not deferred, and its gating question (if any)
// decided with a non-Defer mode. Mandatory items are always built — even a Drop left in an older record.
function isBuilt(se, record) {
  if (isMandatory(se)) return true;
  if (record.dec[se.id] === "Drop") return false;
  if ((record.scope[se.id] || "Build now") === "Defer") return false;
  if (se.openQuestion) return !isBlocking(record, se.openQuestion) && record.dec[se.openQuestion] !== "Defer";
  return true;
}

module.exports = { TARGET_KEYS, VIA, cap, isBlocking, isMandatory, kindFor, requiredTargetKeys, allowedTargetKeys, describeKey, buildTargetKeys, buildDefaults, isBuilt };
