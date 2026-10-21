"use strict";
const test   = require("node:test");
const assert = require("node:assert/strict");
const fs     = require("fs");
const path   = require("path");

const { TEMPLATES, validateParams, missingFor, sqlFor, invalidParams } = require("../lib/ai-templates");

const inv = JSON.parse(fs.readFileSync(
  path.join(__dirname, "..", "..", "capability-graph", "inventory-fields.json"), "utf8"
));

function tpl(id) { return TEMPLATES.find(t => t.id === id); }

// ── presence ──────────────────────────────────────────────────────────────────

test("TEMPLATES contains all four AIQ ids with required shape", () => {
  for (const id of ["AIQ.AgingOutFY", "AIQ.HighValueNoContract", "AIQ.JCAHOPendingInspection", "AIQ.CapitalPlanningTotals"]) {
    const t = tpl(id);
    assert.ok(t, id + " present");
    assert.ok(t.defaultWording, id + " has defaultWording");
    assert.ok(Array.isArray(t.params) && t.params.length, id + " has params");
    assert.ok(Array.isArray(t.tables) && t.tables.length, id + " has tables");
    assert.equal(typeof t.sql, "function", id + " has sql function");
  }
});

// ── AgingOutFY SQL ─────────────────────────────────────────────────────────────

test("sqlFor AgingOutFY returns SQL with FROM VISTA.EQUIPMENT_INV_6914", () => {
  const params = { fiscalYear: 2030, capitalizedMeans: "INVESTMENT_CATEGORY = 1", useStatuses: ["1", "2"] };
  const sql = sqlFor(tpl("AIQ.AgingOutFY"), params, inv);
  assert.match(sql, /FROM VISTA\.EQUIPMENT_INV_6914/);
  assert.match(sql, /IEN/);
  assert.match(sql, /MFGR__EQUIPMENT_NAME/);
});

test("sqlFor AgingOutFY FY2030 uses FileMan dates 3291001 and 3300930", () => {
  // FY2030 = Oct 1 2029 – Sep 30 2030
  // start: (2029-1700)*10000 + 10*100 + 1 = 3291001
  // end:   (2030-1700)*10000 + 9*100  + 30 = 3300930
  const params = { fiscalYear: 2030, capitalizedMeans: "INVESTMENT_CATEGORY = 1", useStatuses: ["ALL"] };
  const sql = sqlFor(tpl("AIQ.AgingOutFY"), params, inv);
  assert.match(sql, /3291001/);
  assert.match(sql, /3300930/);
});

test("sqlFor AgingOutFY includes USE_STATUS IN for partial codes", () => {
  const params = { fiscalYear: 2025, capitalizedMeans: "INVESTMENT_CATEGORY = 1", useStatuses: ["1", "3"] };
  const sql = sqlFor(tpl("AIQ.AgingOutFY"), params, inv);
  assert.match(sql, /USE_STATUS IN/);
  assert.match(sql, /'1'/);
  assert.match(sql, /'3'/);
});

test("sqlFor AgingOutFY omits USE_STATUS filter when useStatuses is ALL", () => {
  const params = { fiscalYear: 2025, capitalizedMeans: "INVESTMENT_CATEGORY = 1", useStatuses: ["ALL"] };
  const sql = sqlFor(tpl("AIQ.AgingOutFY"), params, inv);
  assert.doesNotMatch(sql, /USE_STATUS IN/);
});

// ── HighValueNoContract SQL ────────────────────────────────────────────────────

test("sqlFor HighValueNoContract SQL contains threshold value, FROM table, and SERVICE_CONTRACT check", () => {
  const params = { threshold: 75000, valueColumn: "TOTAL_ASSET_VALUE", useStatuses: ["1"] };
  const sql = sqlFor(tpl("AIQ.HighValueNoContract"), params, inv);
  assert.match(sql, /75000/);
  assert.match(sql, /FROM VISTA\.EQUIPMENT_INV_6914/);
  // should reference SERVICE_CONTRACT and the yes-code from inventory (Y)
  assert.match(sql, /SERVICE_CONTRACT/);
  assert.match(sql, /'Y'/);
});

// ── JCAHOPendingInspection SQL ─────────────────────────────────────────────────

test("sqlFor JCAHOPendingInspection SQL references WORK_ORDER_6920 and JCAHO yes-code", () => {
  const params = { workOrderStatusColumn: "STATUS", workOrderStatuses: ["2", "3"], useStatuses: ["1"] };
  const sql = sqlFor(tpl("AIQ.JCAHOPendingInspection"), params, inv);
  assert.match(sql, /WORK_ORDER_6920/);
  assert.match(sql, /FROM VISTA\.EQUIPMENT_INV_6914/);
  // JCAHO yes-code from inventory = 'Y'
  assert.match(sql, /JCAHO\s*=\s*'Y'/);
  // equipment pointer from inventory = EQUIPMENT_ID
  assert.match(sql, /EQUIPMENT_ID/);
});

test("sqlFor JCAHOPendingInspection uses PM_STATUS column when chosen", () => {
  const params = { workOrderStatusColumn: "PM_STATUS", workOrderStatuses: ["P", "C"], useStatuses: ["ALL"] };
  const sql = sqlFor(tpl("AIQ.JCAHOPendingInspection"), params, inv);
  assert.match(sql, /PM_STATUS/);
  assert.match(sql, /'P'/);
});

// ── CapitalPlanningTotals SQL ─────────────────────────────────────────────────

test("sqlFor CapitalPlanningTotals includes COUNT, SUM, GROUP BY when groupBy set", () => {
  const params = { useStatuses: ["1", "2"], valueColumns: ["TOTAL_ASSET_VALUE", "ORIGINAL_ASSET_VALUE"], groupBy: "EQUIPMENT_CATEGORY_NAME" };
  const sql = sqlFor(tpl("AIQ.CapitalPlanningTotals"), params, inv);
  assert.match(sql, /COUNT/);
  assert.match(sql, /SUM.*TOTAL_ASSET_VALUE/i);
  assert.match(sql, /SUM.*ORIGINAL_ASSET_VALUE/i);
  assert.match(sql, /FROM VISTA\.EQUIPMENT_INV_6914/);
  assert.match(sql, /GROUP BY EQUIPMENT_CATEGORY_NAME/);
});

test("sqlFor CapitalPlanningTotals with groupBy none omits GROUP BY", () => {
  const params = { useStatuses: ["ALL"], valueColumns: ["TOTAL_ASSET_VALUE"], groupBy: "none" };
  const sql = sqlFor(tpl("AIQ.CapitalPlanningTotals"), params, inv);
  assert.doesNotMatch(sql, /GROUP BY/);
});

// ── validateParams ─────────────────────────────────────────────────────────────

test("validateParams rejects threshold: '50000; DROP' (not a valid number)", () => {
  const t = tpl("AIQ.HighValueNoContract");
  const res = validateParams(t, { threshold: "50000; DROP", valueColumn: "TOTAL_ASSET_VALUE", useStatuses: ["1"] }, inv);
  assert.equal(res.ok, false);
  assert.ok(res.errors.some(e => e.includes("threshold")), "threshold error present");
});

test("validateParams rejects a code not in the discovered USE_STATUS list", () => {
  const t = tpl("AIQ.AgingOutFY");
  const res = validateParams(t, { fiscalYear: 2025, capitalizedMeans: "INVESTMENT_CATEGORY = 1", useStatuses: ["9"] }, inv);
  assert.equal(res.ok, false);
  assert.ok(res.errors.some(e => e.includes("useStatuses")), "useStatuses error present");
});

test("validateParams rejects fiscalYear: 1800 (out of valid range)", () => {
  const t = tpl("AIQ.AgingOutFY");
  const res = validateParams(t, { fiscalYear: 1800, capitalizedMeans: "INVESTMENT_CATEGORY = 1", useStatuses: ["1"] }, inv);
  assert.equal(res.ok, false);
  assert.ok(res.errors.some(e => e.includes("fiscalYear")), "fiscalYear error present");
});

test("validateParams rejects invalid enum value", () => {
  const t = tpl("AIQ.AgingOutFY");
  const res = validateParams(t, { fiscalYear: 2025, capitalizedMeans: "BOGUS_VALUE", useStatuses: ["1"] }, inv);
  assert.equal(res.ok, false);
  assert.ok(res.errors.some(e => e.includes("capitalizedMeans")));
});

test("validateParams rejects empty useStatuses array", () => {
  const t = tpl("AIQ.AgingOutFY");
  const res = validateParams(t, { fiscalYear: 2025, capitalizedMeans: "INVESTMENT_CATEGORY = 1", useStatuses: [] }, inv);
  assert.equal(res.ok, false);
  assert.ok(res.errors.some(e => e.includes("useStatuses")));
});

test("validateParams JCAHOPendingInspection: workOrderStatuses validated against the chosen column", () => {
  const t = tpl("AIQ.JCAHOPendingInspection");
  // code "2" is valid for STATUS but NOT for PM_STATUS
  const res = validateParams(t, { workOrderStatusColumn: "PM_STATUS", workOrderStatuses: ["2"], useStatuses: ["1"] }, inv);
  assert.equal(res.ok, false);
  assert.ok(res.errors.some(e => e.includes("workOrderStatuses")));
});

test("validateParams JCAHOPendingInspection: missing workOrderStatusColumn blocks workOrderStatuses validation", () => {
  const t = tpl("AIQ.JCAHOPendingInspection");
  // workOrderStatusColumn is absent; workOrderStatuses can't be validated
  const res = validateParams(t, { workOrderStatuses: ["P"], useStatuses: ["1"] }, inv);
  assert.equal(res.ok, false);
  // Both workOrderStatusColumn and workOrderStatuses should be in errors
  const text = res.errors.join(" ");
  assert.ok(text.includes("workOrderStatusColumn") || text.includes("workOrderStatuses"));
});

test("validateParams accepts valid params for all templates", () => {
  const cases = [
    { id: "AIQ.AgingOutFY", params: { fiscalYear: 2030, capitalizedMeans: "INVESTMENT_CATEGORY = 1", useStatuses: ["1", "2"] } },
    { id: "AIQ.HighValueNoContract", params: { threshold: 50000, valueColumn: "TOTAL_ASSET_VALUE", useStatuses: ["ALL"] } },
    { id: "AIQ.JCAHOPendingInspection", params: { workOrderStatusColumn: "STATUS", workOrderStatuses: ["1", "2"], useStatuses: ["1"] } },
    { id: "AIQ.CapitalPlanningTotals", params: { useStatuses: ["ALL"], valueColumns: ["TOTAL_ASSET_VALUE"], groupBy: "none" } },
  ];
  for (const { id, params } of cases) {
    const res = validateParams(tpl(id), params, inv);
    assert.equal(res.ok, true, id + " should be valid: " + res.errors.join("; "));
  }
});

// ── missingFor ─────────────────────────────────────────────────────────────────

test("missingFor lists every unrecorded param when recorded is empty", () => {
  const t = tpl("AIQ.AgingOutFY");
  const missing = missingFor(t, {});
  assert.equal(missing.length, t.params.length);
  assert.ok(missing.every(m => m.key && m.what));
});

test("missingFor returns empty array when all params are recorded", () => {
  const t = tpl("AIQ.AgingOutFY");
  const recorded = { fiscalYear: 2030, capitalizedMeans: "INVESTMENT_CATEGORY = 1", useStatuses: ["1"] };
  const missing = missingFor(t, recorded);
  assert.equal(missing.length, 0);
});

test("missingFor returns only the keys not yet recorded", () => {
  const t = tpl("AIQ.HighValueNoContract");
  const recorded = { threshold: 50000 };
  const missing = missingFor(t, recorded);
  assert.equal(missing.length, 2); // valueColumn and useStatuses
  assert.ok(missing.some(m => m.key === "valueColumn"));
  assert.ok(missing.some(m => m.key === "useStatuses"));
});

// ── sqlFor throws on invalid ───────────────────────────────────────────────────

test("sqlFor throws if params fail validation", () => {
  assert.throws(
    () => sqlFor(tpl("AIQ.AgingOutFY"), { fiscalYear: 1800, capitalizedMeans: "INVESTMENT_CATEGORY = 1", useStatuses: ["1"] }, inv),
    /invalid params/i
  );
});

// ── invalidParams ──────────────────────────────────────────────────────────────

test("invalidParams: present-and-valid params → empty array", () => {
  const params = { fiscalYear: 2030, capitalizedMeans: "INVESTMENT_CATEGORY = 1", useStatuses: ["ALL"] };
  const result = invalidParams(tpl("AIQ.AgingOutFY"), params, inv);
  assert.deepEqual(result, []);
});

test("invalidParams: present-and-invalid param → one item with validation error in 'what'", () => {
  // fiscalYear out of range — present but invalid
  const params = { fiscalYear: 1800, capitalizedMeans: "INVESTMENT_CATEGORY = 1", useStatuses: ["ALL"] };
  const result = invalidParams(tpl("AIQ.AgingOutFY"), params, inv);
  assert.equal(result.length, 1);
  assert.equal(result[0].key, "fiscalYear");
  assert.ok(typeof result[0].what === "string" && result[0].what.includes("fiscalYear"), "what must contain the error message");
});

test("invalidParams: absent param (undefined) → not included (absence is caller's concern)", () => {
  // fiscalYear absent — invalidParams should not report it
  const params = { capitalizedMeans: "INVESTMENT_CATEGORY = 1", useStatuses: ["ALL"] };
  const result = invalidParams(tpl("AIQ.AgingOutFY"), params, inv);
  assert.ok(!result.some(r => r.key === "fiscalYear"), "absent param must not appear in invalidParams output");
});

test("invalidParams: null inventory → empty array regardless of params", () => {
  const params = { fiscalYear: 1800, capitalizedMeans: "INVESTMENT_CATEGORY = 1", useStatuses: ["ALL"] };
  const result = invalidParams(tpl("AIQ.AgingOutFY"), params, null);
  assert.deepEqual(result, []);
});

// ── Final review M4: money is a finite number ≥ 0 (or a plain decimal string) ──
test("validateParams money: only finite numbers ≥ 0 and plain decimal strings", () => {
  const t = tpl("AIQ.HighValueNoContract");
  const check = threshold => validateParams(t, { threshold, valueColumn: "TOTAL_ASSET_VALUE", useStatuses: ["ALL"] }, inv).ok;
  for (const good of [0, 50000, 1234.5, "50000", "50000.50", " 75000 "]) assert.equal(check(good), true, JSON.stringify(good));
  for (const bad of ["", "   ", true, false, Infinity, -Infinity, NaN, "Infinity", -1, "-1", [50000], {}, "50,000", "1e309", "0x10", "50000; DROP"]) {
    assert.equal(check(bad), false, `${typeof bad} ${String(bad)}`);
  }
});

test("validateParams year: arrays and booleans are not years", () => {
  const t = tpl("AIQ.AgingOutFY");
  const check = fiscalYear => validateParams(t, { fiscalYear, capitalizedMeans: "INVESTMENT_CATEGORY = 1", useStatuses: ["ALL"] }, inv).ok;
  for (const good of [2030, "2030"]) assert.equal(check(good), true, JSON.stringify(good));
  for (const bad of [[2030], true, "", "2030.5", 2030.5, Infinity]) assert.equal(check(bad), false, JSON.stringify(bad));
});

// ── Final review M3: the template texts decide nothing ─────────────────────────
test("template texts are neutral: no built-in 'active use', and ['ALL'] work-order statuses mean any work order", () => {
  const cap = tpl("AIQ.CapitalPlanningTotals");
  assert.doesNotMatch(cap.defaultWording, /active|in use/i, "the use statuses are the developer's decision");
  const wo = tpl("AIQ.JCAHOPendingInspection").params.find(p => p.key === "workOrderStatuses");
  assert.doesNotMatch(wo.describe, /open/i, "ALL also matches completed and disapproved work orders");
  assert.match(wo.describe, /any work order/i);
  assert.match(wo.describe, /whatever its status/i);
});

// ── Final review M6: quick-access results are readable ─────────────────────────
const { fmDateIso, codeLabel } = require("../lib/ai-templates");
test("AgingOutFY shows REPLACEMENT_DATE as an ISO date and the coded columns by their labels", () => {
  const sql = sqlFor(tpl("AIQ.AgingOutFY"), { fiscalYear: 2030, capitalizedMeans: "INVESTMENT_CATEGORY = 1", useStatuses: ["ALL"] }, inv);
  assert.ok(sql.includes(fmDateIso("REPLACEMENT_DATE")), "the date is converted");
  assert.match(sql, /END AS REPLACEMENT_DATE/);
  for (const c of ["USE_STATUS", "INVESTMENT_CATEGORY", "TYPE_OF_ENTRY"]) assert.ok(sql.includes(codeLabel(inv, c)), c);
  assert.match(sql, /WHEN '1' THEN 'IN USE'/);
  assert.match(sql, /WHEN 'NX' THEN 'NON-EXPENDABLE EQPT'/);
  // no raw coded or date column is selected on its own
  const select = sql.split(/\nFROM /)[0];
  assert.doesNotMatch(select, /, (USE_STATUS|INVESTMENT_CATEGORY|TYPE_OF_ENTRY|REPLACEMENT_DATE)\s*(,|$)/m);
});

test("the other quick-access lists show their codes by label too", () => {
  const hv = sqlFor(tpl("AIQ.HighValueNoContract"), { threshold: 1000, valueColumn: "TOTAL_ASSET_VALUE", useStatuses: ["ALL"] }, inv);
  assert.ok(hv.includes(codeLabel(inv, "SERVICE_CONTRACT")) && hv.includes(codeLabel(inv, "USE_STATUS")));
  const jc = sqlFor(tpl("AIQ.JCAHOPendingInspection"), { workOrderStatusColumn: "STATUS", workOrderStatuses: ["ALL"], useStatuses: ["ALL"] }, inv);
  assert.ok(jc.includes(codeLabel(inv, "JCAHO", "e.")) && jc.includes(codeLabel(inv, "USE_STATUS", "e.")));
  const ct = sqlFor(tpl("AIQ.CapitalPlanningTotals"), { useStatuses: ["ALL"], valueColumns: ["TOTAL_ASSET_VALUE"], groupBy: "INVESTMENT_CATEGORY" }, inv);
  assert.ok(ct.includes(codeLabel(inv, "INVESTMENT_CATEGORY")), "a coded group shows its label");
  assert.match(ct, /GROUP BY INVESTMENT_CATEGORY/);
});

test("fmDateIso and codeLabel: a FileMan date as YYYY, YYYY-MM or YYYY-MM-DD; a code as its label", () => {
  const d = fmDateIso("REPLACEMENT_DATE");
  assert.match(d, /^CASE WHEN REPLACEMENT_DATE IS NULL/);
  assert.match(d, /\+ 1700/);
  assert.match(d, /END AS REPLACEMENT_DATE$/);
  assert.equal(codeLabel(inv, "JCAHO"), "CASE JCAHO WHEN 'Y' THEN 'YES' WHEN 'N' THEN 'NO' ELSE JCAHO END AS JCAHO");
  assert.equal(codeLabel(inv, "JCAHO", "e."), "CASE e.JCAHO WHEN 'Y' THEN 'YES' WHEN 'N' THEN 'NO' ELSE e.JCAHO END AS JCAHO");
  assert.equal(codeLabel(inv, "MFGR__EQUIPMENT_NAME"), "MFGR__EQUIPMENT_NAME", "an uncoded column is selected as it is");
});
