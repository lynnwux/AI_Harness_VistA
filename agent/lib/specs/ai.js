"use strict";
// AI layer spec: quick-access question page + general question path for the Equipment inventory chatbot.
// Consumes: TEMPLATES, missingFor, sqlFor, validateOne (Task 2); inventory-fields.json (Task 1).
const { TEMPLATES, sqlFor, invalidParams } = require("../ai-templates");

const CONTAINER = "iris-ai-hub", NAMESPACE = "INTEROP", PACKAGE = "EquipmentAI";
const ALL_TABLES = [...new Set(TEMPLATES.flatMap(t => t.tables))];
const has = (implemented, id) => ((implemented && implemented.api) || []).some(s => s.id === id);

function buildAiSpec(graph, record, implemented, inventory) {
  void graph; // not needed by this layer — accepted for a uniform signature
  const missing = [];

  if (!inventory) {
    missing.push({ kind: "discovery", what: "inventory-fields.json not loaded — run the discovery step to build it before designing the AI layer" });
  } else {
    for (const t of TEMPLATES) {
      const recEntry  = (record.aiQuestions || {})[t.id] || null;
      const recKeep   = recEntry != null ? recEntry.keep : undefined;

      // keep not yet decided
      if (recKeep === undefined || recKeep === null) {
        missing.push({ kind: "keep", id: t.id, what: `decide whether to include "${t.id}" on the quick-access page` });
        continue;
      }
      // keep: false — no missing items (ruling 2)
      if (!recKeep) continue;

      // keep: true
      const recParams  = (recEntry && recEntry.params) || {};
      const recWording = recEntry && recEntry.wording ? String(recEntry.wording) : null;

      if (!recWording) {
        missing.push({ kind: "wording", id: t.id, what: `set a wording for "${t.id}" (or confirm the template default)` });
      }

      // params: absent → "param" with description; present-but-invalid → "param" with validation error (ruling 1)
      for (const p of t.params) {
        if (recParams[p.key] === undefined || recParams[p.key] === null) {
          missing.push({ kind: "param", id: t.id, key: p.key, what: p.describe });
        }
      }
      for (const { key, what } of invalidParams(t, recParams, inventory)) {
        missing.push({ kind: "param", id: t.id, key, what });
      }
    }
  }

  const needs = [{
    service: "read:lookup",
    what:    "read-only SQL over the 6914 projection on VADEMO (as GET /lookup uses)",
    met:     has(implemented, "read:lookup"),
  }];

  // Build detail.questions — only kept questions (ruling 2)
  const questions = [];
  if (inventory) {
    for (const t of TEMPLATES) {
      const recEntry = (record.aiQuestions || {})[t.id] || null;
      if (!recEntry || !recEntry.keep) continue;
      const recParams  = (recEntry.params) || {};
      const recWording = recEntry.wording ? String(recEntry.wording) : t.defaultWording;
      let sql = null;
      try { sql = sqlFor(t, recParams, inventory); } catch (_e) { /* params not yet fully valid */ }
      questions.push({ id: t.id, wording: recWording, params: recParams, sql, tables: t.tables });
    }
  }

  // schemaColumns: column names per table, from inventory
  const schemaColumns = {};
  if (inventory) {
    for (const tbl of ALL_TABLES) {
      const tblObj = (inventory.tables || {})[tbl];
      if (tblObj) schemaColumns[tbl] = (tblObj.columns || []).map(c => c.column);
    }
  }

  return {
    layer:    "ai",
    builds: [
      `AI chatbot in container \`${CONTAINER}\`, namespace \`${NAMESPACE}\`, package \`${PACKAGE}\``,
      "quick-access question page with pre-filled SQL for each kept question",
      "general question path — read-only SQL over the allow-listed tables only",
    ],
    owns:    ["the quick-access question page", "the general question handler"],
    uses:    ["Orchestrator: the production front door", "API: GET /lookup — read-only SQL over the 6914 projection"],
    needs,
    missing,
    complete: missing.length === 0 && needs.every(n => n.met),
    detail: {
      container: CONTAINER,
      namespace: NAMESPACE,
      package:   PACKAGE,
      questions,
      general:   { allowList: ALL_TABLES, rowCap: 200 },
      schemaColumns,
    },
  };
}

function renderAi(spec) {
  const d   = spec.detail;
  const unmet = spec.needs.filter(n => !n.met);
  const s = n => (n === 1 ? "" : "s");
  const L = [];

  L.push("# AI layer spec — Equipment inventory chatbot");
  L.push(spec.complete
    ? "✅ Complete — ready for the AI build."
    : `⛔ Not ready for the AI build: ${spec.missing.length} item${s(spec.missing.length)} missing · ${unmet.length} unmet need${s(unmet.length)}.`);
  L.push("");

  L.push("## Builds"); spec.builds.forEach(b => L.push(`- ${b}`)); L.push("");
  L.push("## Owns");   spec.owns.forEach(o => L.push(`- ${o}`));   L.push("");
  L.push("## Uses (by reference)"); spec.uses.forEach(u => L.push(`- ${u}`)); L.push("");

  L.push("## Quick-access questions");
  if (!d.questions.length) {
    L.push("- none kept");
  } else {
    for (const q of d.questions) {
      L.push("");
      L.push(`### ${q.id}`);
      L.push(`**Wording:** ${q.wording}`);
      const paramLines = Object.entries(q.params).map(([k, v]) => `- \`${k}\`: ${JSON.stringify(v)}`);
      if (paramLines.length) { L.push("**Params:**"); paramLines.forEach(p => L.push(p)); }
      L.push(`**Tables:** ${q.tables.join(", ")}`);
      if (q.sql) {
        L.push("```sql");
        L.push(q.sql);
        L.push("```");
      } else {
        L.push("_SQL not yet available — params incomplete or invalid._");
      }
    }
  }
  L.push("");

  L.push("## General questions");
  L.push(`- Guard rule: every query must be a single \`SELECT\` over the allow-listed tables only.`);
  L.push(`- Allow-list: ${d.general.allowList.map(t => `\`${t}\``).join(", ")}.`);
  L.push(`- Row cap: ${d.general.rowCap} rows; \`truncated: true\` when capped.`);
  L.push("");

  L.push("## Needs from lower layers");
  if (!spec.needs.length) {
    L.push("- none");
  } else {
    spec.needs.forEach(n => L.push(`- ${n.met ? "✅ met" : "⛔ **unmet**"}: ${n.what} (\`${n.service}\`)`));
  }
  L.push("");

  L.push("## Missing (▢)");
  if (!spec.missing.length) {
    L.push("- none");
  } else {
    spec.missing.forEach(m => L.push(`- ▢ [${m.kind}] ${m.what}`));
  }
  return L.join("\n") + "\n";
}

module.exports = { buildAiSpec, renderAi };
