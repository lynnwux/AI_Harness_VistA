"use strict";
// Quick-access AI question templates for the Equipment inventory.
// All SQL values come from validated params: numbers via Number(), codes from
// the discovered code lists — never raw strings from input.

// ── Inventory lookup helpers ──────────────────────────────────────────────────

function codesFor(inventory, table, column) {
  if (!inventory) return [];
  const t = (inventory.tables || {})[table];
  if (!t) return [];
  const col = (t.columns || []).find(c => c.column === column);
  return (col && col.codes) ? col.codes : [];
}

function codeValues(inventory, table, column) {
  return codesFor(inventory, table, column).map(([code]) => code);
}

// The yes-code is the code whose label is exactly "YES".
function yesCode(inventory, table, column) {
  const codes = codesFor(inventory, table, column);
  const entry = codes.find(([, lbl]) => lbl === "YES");
  return entry ? entry[0] : null;
}

// The column in WORK_ORDER_6920 that points to EQUIPMENT_INV_6914.
function equipmentPointerCol(inventory) {
  const t = (inventory && inventory.tables || {})["WORK_ORDER_6920"];
  if (!t) return "EQUIPMENT_ID";
  const col = (t.columns || []).find(c => c.pointsTo === "6914");
  return col ? col.column : "EQUIPMENT_ID";
}

function evidenceFor(inventory, table, column) {
  if (!inventory) return [];
  return (inventory.evidence || {})[`${table}.${column}`] || [];
}

// ── SQL helpers ────────────────────────────────────────────────────────────────

// Safe single-quote a validated code value.
function qsql(val) {
  return "'" + String(val).replace(/'/g, "''") + "'";
}

// Builds CAST(REPLACEMENT_DATE AS INTEGER) range for a federal fiscal year.
// FY N = Oct 1 of year N-1 through Sep 30 of year N.
// FileMan date integer = (year - 1700) * 10000 + month * 100 + day.
function fyDates(fiscalYear) {
  const fy  = Number(fiscalYear);
  const start = (fy - 1 - 1700) * 10000 + 10 * 100 + 1;   // Oct 1 of FY-1
  const end   = (fy     - 1700) * 10000 +  9 * 100 + 30;  // Sep 30 of FY
  return { start, end };
}

// A coded 6914 column shown by its label: CASE <col> WHEN '<code>' THEN '<label>' … ELSE <col> END AS <col>.
// The codes come from the inventory (the data dictionary); a column without codes is selected as it is.
function codeLabel(inventory, column, prefix = "") {
  const col = prefix + column;
  const codes = codesFor(inventory, "EQUIPMENT_INV_6914", column);
  if (!codes.length) return col;
  return `CASE ${col} ${codes.map(([c, l]) => `WHEN ${qsql(c)} THEN ${qsql(l)}`).join(" ")} ELSE ${col} END AS ${column}`;
}

// A FileMan date column shown readably: YYYY-MM-DD, or YYYY-MM / YYYY when the date has no day / month
// (FileMan stores imprecise dates with 00 there). FileMan dates are YYYMMDD with YYY = year - 1700.
function fmDateIso(column, prefix = "") {
  const d = `CAST(${prefix}${column} AS INTEGER)`;
  const s = `CAST(${d} AS VARCHAR(7))`;
  const year = `CAST(FLOOR(${d} / 10000) + 1700 AS VARCHAR(4))`;
  return `CASE WHEN ${prefix}${column} IS NULL OR ${prefix}${column} = '' THEN NULL`
    + ` WHEN SUBSTRING(${s}, 4, 4) = '0000' THEN ${year}`
    + ` WHEN SUBSTRING(${s}, 6, 2) = '00' THEN ${year} || '-' || SUBSTRING(${s}, 4, 2)`
    + ` ELSE ${year} || '-' || SUBSTRING(${s}, 4, 2) || '-' || SUBSTRING(${s}, 6, 2) END AS ${column}`;
}

// Returns `USE_STATUS IN ('1','2',...)` or null when ALL.
function useStatusClause(codes) {
  if (!codes || codes[0] === "ALL") return null;
  return `USE_STATUS IN (${codes.map(qsql).join(", ")})`;
}

// ── Templates ─────────────────────────────────────────────────────────────────

const TEMPLATES = [
  {
    id: "AIQ.AgingOutFY",
    defaultWording: "Which capitalized equipment items are scheduled for replacement in the chosen fiscal year?",
    params: [
      {
        key: "fiscalYear",
        type: "year",
        describe: "Federal fiscal year whose replacement window to query (Oct 1 of prior year – Sep 30 of that year)",
      },
      {
        key: "capitalizedMeans",
        type: "enum",
        describe: "Which records count as capitalized for this query",
        options: [
          "INVESTMENT_CATEGORY = 1",
          "TYPE_OF_ENTRY = NX and INVESTMENT_CATEGORY = 1",
        ],
      },
      {
        key: "useStatuses",
        type: "codes",
        describe: "Equipment use-status codes to include (or [\"ALL\"] for no filter)",
        table: "EQUIPMENT_INV_6914",
        column: "USE_STATUS",
      },
    ],
    tables: ["EQUIPMENT_INV_6914"],
    sql(params, inventory) {
      const { start, end } = fyDates(params.fiscalYear);
      const capCond = params.capitalizedMeans === "INVESTMENT_CATEGORY = 1"
        ? "INVESTMENT_CATEGORY = '1'"
        : "TYPE_OF_ENTRY = 'NX' AND INVESTMENT_CATEGORY = '1'";
      const statusCond = useStatusClause(params.useStatuses);
      const wheres = [
        `CAST(REPLACEMENT_DATE AS INTEGER) >= ${start}`,
        `CAST(REPLACEMENT_DATE AS INTEGER) <= ${end}`,
        capCond,
      ];
      if (statusCond) wheres.push(statusCond);
      return [
        "SELECT IEN, MFGR__EQUIPMENT_NAME, EQUIPMENT_CATEGORY_NAME, SERVICE_POINTER_NAME, LOCATION_ROOM_NUMBER,",
        `       ${fmDateIso("REPLACEMENT_DATE")},`,
        `       ${codeLabel(inventory, "INVESTMENT_CATEGORY")},`,
        `       ${codeLabel(inventory, "TYPE_OF_ENTRY")},`,
        `       ${codeLabel(inventory, "USE_STATUS")}`,
        "FROM VISTA.EQUIPMENT_INV_6914",
        "WHERE " + wheres.join("\n  AND "),
      ].join("\n");
    },
  },

  {
    id: "AIQ.HighValueNoContract",
    defaultWording: "Which high-value equipment items have no service contract?",
    params: [
      {
        key: "threshold",
        type: "money",
        describe: "Minimum asset value (≥ 0): items at or above this value are returned",
      },
      {
        key: "valueColumn",
        type: "enum",
        describe: "Which asset-value column to compare against the threshold",
        options: ["TOTAL_ASSET_VALUE", "ORIGINAL_ASSET_VALUE"],
      },
      {
        key: "useStatuses",
        type: "codes",
        describe: "Equipment use-status codes to include (or [\"ALL\"] for no filter)",
        table: "EQUIPMENT_INV_6914",
        column: "USE_STATUS",
      },
    ],
    tables: ["EQUIPMENT_INV_6914"],
    sql(params, inventory) {
      const threshold  = Number(params.threshold);
      const valueCol   = params.valueColumn;
      const scYes      = yesCode(inventory, "EQUIPMENT_INV_6914", "SERVICE_CONTRACT");
      const noContract = scYes
        ? `(SERVICE_CONTRACT != ${qsql(scYes)} OR SERVICE_CONTRACT IS NULL)`
        : "SERVICE_CONTRACT IS NULL";
      const statusCond = useStatusClause(params.useStatuses);
      const wheres = [`${valueCol} >= ${threshold}`, noContract];
      if (statusCond) wheres.push(statusCond);
      return [
        `SELECT IEN, MFGR__EQUIPMENT_NAME, EQUIPMENT_CATEGORY_NAME, SERVICE_POINTER_NAME, LOCATION_ROOM_NUMBER, ${valueCol},`,
        `       ${codeLabel(inventory, "SERVICE_CONTRACT")},`,
        `       ${codeLabel(inventory, "USE_STATUS")}`,
        "FROM VISTA.EQUIPMENT_INV_6914",
        "WHERE " + wheres.join("\n  AND "),
      ].join("\n");
    },
  },

  {
    id: "AIQ.JCAHOPendingInspection",
    defaultWording: "Which JCAHO-regulated equipment items have a pending inspection work order?",
    params: [
      {
        key: "workOrderStatusColumn",
        type: "enum",
        describe: "Column in WORK_ORDER_6920 used to judge a work order as pending",
        options: ["STATUS", "PM_STATUS"],
      },
      {
        // column is dynamic: resolved at validation time from workOrderStatusColumn
        key: "workOrderStatuses",
        type: "codes",
        describe: "Work-order status codes that count as pending (or [\"ALL\"] for any work order on file, whatever its status)",
        table: "WORK_ORDER_6920",
        column: null,   // resolved against params.workOrderStatusColumn at validate time
      },
      {
        key: "useStatuses",
        type: "codes",
        describe: "Equipment use-status codes to include (or [\"ALL\"] for no filter)",
        table: "EQUIPMENT_INV_6914",
        column: "USE_STATUS",
      },
    ],
    tables: ["EQUIPMENT_INV_6914", "WORK_ORDER_6920"],
    sql(params, inventory) {
      const jcahoYes  = yesCode(inventory, "EQUIPMENT_INV_6914", "JCAHO");
      const eqPtr     = equipmentPointerCol(inventory);
      const statusCol = params.workOrderStatusColumn;
      const woSt      = params.workOrderStatuses;
      const jcahoCond = jcahoYes ? `JCAHO = ${qsql(jcahoYes)}` : "JCAHO IS NOT NULL";
      const woFilter  = woSt[0] === "ALL"
        ? ""
        : ` AND w.${statusCol} IN (${woSt.map(qsql).join(", ")})`;
      const statusCond = useStatusClause(params.useStatuses);
      const wheres = [
        jcahoCond,
        `EXISTS (SELECT 1 FROM VISTA.WORK_ORDER_6920 w WHERE w.${eqPtr} = e.IEN${woFilter})`,
      ];
      if (statusCond) wheres.push(statusCond);
      return [
        "SELECT e.IEN, e.MFGR__EQUIPMENT_NAME, e.EQUIPMENT_CATEGORY_NAME, e.SERVICE_POINTER_NAME, e.LOCATION_ROOM_NUMBER,",
        `       ${codeLabel(inventory, "JCAHO", "e.")},`,
        `       ${codeLabel(inventory, "USE_STATUS", "e.")}`,
        "FROM VISTA.EQUIPMENT_INV_6914 e",
        "WHERE " + wheres.join("\n  AND "),
      ].join("\n");
    },
  },

  {
    id: "AIQ.CapitalPlanningTotals",
    defaultWording: "What are the capital-planning totals — equipment counts and asset values?",
    params: [
      {
        key: "useStatuses",
        type: "codes",
        describe: "Equipment use-status codes to include (or [\"ALL\"] for no filter)",
        table: "EQUIPMENT_INV_6914",
        column: "USE_STATUS",
      },
      {
        key: "valueColumns",
        type: "enumSet",
        describe: "Value columns to sum",
        options: ["TOTAL_ASSET_VALUE", "ORIGINAL_ASSET_VALUE"],
      },
      {
        key: "groupBy",
        type: "enum",
        describe: "Column to group results by (or 'none' for grand totals only)",
        options: ["none", "EQUIPMENT_CATEGORY_NAME", "SERVICE_POINTER_NAME", "INVESTMENT_CATEGORY"],
      },
    ],
    tables: ["EQUIPMENT_INV_6914"],
    sql(params, inventory) {
      // Capitalized = INVESTMENT_CATEGORY code '1' (CAPITALIZED/ACCOUNTABLE), read from inventory.
      const invCodes = codesFor(inventory, "EQUIPMENT_INV_6914", "INVESTMENT_CATEGORY");
      const capEntry = invCodes.find(([c]) => c === "1");
      const capCond  = capEntry ? `CASE WHEN INVESTMENT_CATEGORY = ${qsql(capEntry[0])} THEN 1 END` : "NULL";
      const statusCond = useStatusClause(params.useStatuses);
      const sums = params.valueColumns.map(vc => `SUM(${vc}) AS SUM_${vc}`).join(",\n       ");
      const groupCol = params.groupBy !== "none" ? params.groupBy : null;
      const selectParts = [];
      if (groupCol) selectParts.push(codeLabel(inventory, groupCol));   // a coded group (INVESTMENT_CATEGORY) shows its label
      selectParts.push("COUNT(*) AS TOTAL_COUNT");
      selectParts.push(sums);
      selectParts.push(`COUNT(${capCond}) AS CAPITALIZED_COUNT`);
      const lines = [
        "SELECT " + selectParts.join(",\n       "),
        "FROM VISTA.EQUIPMENT_INV_6914",
      ];
      if (statusCond) lines.push("WHERE " + statusCond);
      if (groupCol)   lines.push("GROUP BY " + groupCol);
      lines.push("ORDER BY " + (groupCol ? groupCol : "TOTAL_COUNT") + " ASC");
      return lines.join("\n");
    },
  },
];

// ── Validation ────────────────────────────────────────────────────────────────

// Validate one param's value; returns an array of error strings (empty = ok).
// A number the developer stated: a finite JSON number, or a plain decimal string ("50000", "50000.50");
// anything else (booleans, "", arrays, Infinity, "1e3", "50,000") is not a number here. null when it is not.
function asNumber(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && /^\s*-?\d+(\.\d+)?\s*$/.test(value)) return Number(value);
  return null;
}

function validateOne(p, value, allParams, inventory) {
  if (p.type === "year") {
    const n = asNumber(value);
    if (n === null || !Number.isInteger(n) || n < 1990 || n > 2100)
      return [`${p.key}: must be an integer between 1990 and 2100, got ${JSON.stringify(value)}`];
  } else if (p.type === "money") {
    const n = asNumber(value);
    if (n === null || n < 0)
      return [`${p.key}: must be a number ≥ 0, got ${JSON.stringify(value)}`];
  } else if (p.type === "enum") {
    if (!p.options.includes(value))
      return [`${p.key}: must be one of [${p.options.join(", ")}], got ${JSON.stringify(value)}`];
  } else if (p.type === "enumSet") {
    if (!Array.isArray(value) || value.length === 0)
      return [`${p.key}: must be a non-empty subset of [${p.options.join(", ")}]`];
    const bad = value.filter(v => !p.options.includes(v));
    if (bad.length)
      return [`${p.key}: invalid options [${bad.join(", ")}]; valid: [${p.options.join(", ")}]`];
  } else if (p.type === "codes") {
    if (!Array.isArray(value) || value.length === 0)
      return [`${p.key}: must be a non-empty array of codes or ["ALL"]`];
    if (value[0] === "ALL") return [];  // ["ALL"] is always valid
    // Resolve the actual column name (workOrderStatuses depends on workOrderStatusColumn).
    let colName = p.column;
    if (p.key === "workOrderStatuses") {
      colName = (allParams || {}).workOrderStatusColumn;
      if (!colName)
        return [`${p.key}: workOrderStatusColumn must be set before workOrderStatuses can be validated`];
    }
    const valid = codeValues(inventory, p.table || "EQUIPMENT_INV_6914", colName);
    const bad   = value.filter(v => !valid.includes(v));
    if (bad.length) {
      return [`${p.key}: invalid codes [${bad.join(", ")}]; valid codes for ${p.table || "EQUIPMENT_INV_6914"}.${colName}: [${valid.join(", ")}]`];
    }
  }
  return [];
}

// Full validation: every param must be present and valid.
function validateParams(template, params, inventory) {
  const errors = [];
  for (const p of template.params) {
    const value = (params || {})[p.key];
    if (value === undefined || value === null) {
      errors.push(`${p.key}: required`);
      continue;
    }
    errors.push(...validateOne(p, value, params, inventory));
  }
  return { ok: errors.length === 0, errors };
}

// List params that have no recorded value in `recorded` (used for "missing" display).
function missingFor(template, recorded) {
  const p = recorded || {};
  return template.params
    .filter(def => p[def.key] === undefined || p[def.key] === null)
    .map(def => ({ key: def.key, what: def.describe }));
}

// Validate, then generate SQL. Throws if any param is invalid.
function sqlFor(template, params, inventory) {
  const { ok, errors } = validateParams(template, params, inventory);
  if (!ok) throw new Error(`invalid params for ${template.id}: ${errors.join("; ")}`);
  return template.sql(params, inventory);
}

// Returns only params that are present (non-null/undefined) but fail validation.
// Used by buildAiSpec and buildAiState to surface recorded-but-invalid params as missing items.
// Absent params are NOT included — callers handle absence separately.
function invalidParams(template, recordedParams, inventory) {
  if (!inventory) return [];
  const p = recordedParams || {};
  return template.params
    .filter(def => p[def.key] !== undefined && p[def.key] !== null)
    .flatMap(def => {
      const errs = validateOne(def, p[def.key], p, inventory);
      return errs.length ? [{ key: def.key, what: errs[0] }] : [];
    });
}

// The fields each question reads — its legacy evidence in the Decide chat is these fields' DD text only.
const EVIDENCE_COLUMNS = {
  "AIQ.AgingOutFY":             ["EQUIPMENT_INV_6914.REPLACEMENT_DATE", "EQUIPMENT_INV_6914.INVESTMENT_CATEGORY", "EQUIPMENT_INV_6914.TYPE_OF_ENTRY", "EQUIPMENT_INV_6914.USE_STATUS"],
  "AIQ.HighValueNoContract":    ["EQUIPMENT_INV_6914.TOTAL_ASSET_VALUE", "EQUIPMENT_INV_6914.ORIGINAL_ASSET_VALUE", "EQUIPMENT_INV_6914.SERVICE_CONTRACT", "EQUIPMENT_INV_6914.USE_STATUS"],
  "AIQ.JCAHOPendingInspection": ["EQUIPMENT_INV_6914.JCAHO", "EQUIPMENT_INV_6914.USE_STATUS", "WORK_ORDER_6920.EQUIPMENT_ID", "WORK_ORDER_6920.STATUS", "WORK_ORDER_6920.PM_STATUS"],
  "AIQ.CapitalPlanningTotals":  ["EQUIPMENT_INV_6914.TOTAL_ASSET_VALUE", "EQUIPMENT_INV_6914.ORIGINAL_ASSET_VALUE", "EQUIPMENT_INV_6914.INVESTMENT_CATEGORY", "EQUIPMENT_INV_6914.USE_STATUS"],
};
for (const t of TEMPLATES) t.evidenceColumns = EVIDENCE_COLUMNS[t.id];

module.exports = { TEMPLATES, validateParams, missingFor, sqlFor, validateOne, invalidParams, codeLabel, fmDateIso };
