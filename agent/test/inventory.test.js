"use strict";
const test   = require("node:test");
const assert = require("node:assert/strict");
const fs     = require("fs");
const path   = require("path");

const { inventoryFields } = require("../discover-inventory");

// ─── Fixture for pure-function tests ──────────────────────────────────────────
// Three-pointer fixture: EQUIPMENT_CATEGORY → 6911 (nameCol = …_NAME),
// LOCATION → 6928 (nameCol = LOCATION_ROOM_NUMBER, not …_NAME), JCAHO (codes).
const COLUMNS_FIXTURE = [
  { TABLE_NAME: "EQUIPMENT_INV_6914",    COLUMN_NAME: "IEN",                     DATA_TYPE: "varchar" },
  { TABLE_NAME: "EQUIPMENT_INV_6914",    COLUMN_NAME: "EQUIPMENT_CATEGORY",      DATA_TYPE: "varchar" },
  { TABLE_NAME: "EQUIPMENT_INV_6914",    COLUMN_NAME: "EQUIPMENT_CATEGORY_NAME", DATA_TYPE: "varchar" },
  { TABLE_NAME: "EQUIPMENT_INV_6914",    COLUMN_NAME: "JCAHO",                   DATA_TYPE: "varchar" },
  { TABLE_NAME: "EQUIPMENT_INV_6914",    COLUMN_NAME: "LOCATION",                DATA_TYPE: "varchar" },
  { TABLE_NAME: "EQUIPMENT_INV_6914",    COLUMN_NAME: "LOCATION_ROOM_NUMBER",    DATA_TYPE: "varchar" },
  { TABLE_NAME: "EQUIPMENT_CATEGORY6911", COLUMN_NAME: "IEN",                    DATA_TYPE: "varchar" },
  { TABLE_NAME: "EQUIPMENT_CATEGORY6911", COLUMN_NAME: "NAME",                   DATA_TYPE: "varchar" },
];

const DD_FIXTURE = {
  EQUIPMENT_INV_6914: {
    file: "6914",
    allowList: true,
    fields: {
      EQUIPMENT_CATEGORY: {
        fieldNum: "6", ddName: "EQUIPMENT CATEGORY",
        type: "POINTER TO", pointsTo: "6911",
        description: "Pointer to Equipment Category file.",
      },
      JCAHO: {
        fieldNum: "27", ddName: "JCAHO",
        type: "SET OF CODES", codes: [["Y", "YES"], ["N", "NO"]],
        description: "JCAHO regulated item flag.",
      },
      LOCATION: {
        fieldNum: "24", ddName: "LOCATION",
        type: "POINTER TO", pointsTo: "6928",
        description: "Room where equipment is located.",
      },
      // LOCATION_ROOM_NUMBER is NOT in fields — it is a Calculated/ReadOnly
      // companion column produced by fm2class, so nameColumn detection picks it up.
    },
  },
  EQUIPMENT_CATEGORY6911: {
    file: "6911",
    allowList: true,
    fields: {
      NAME: { fieldNum: "0.01", ddName: "NAME", type: "FREE TEXT", description: "Category name." },
    },
  },
};

// ─── Pure-function tests ───────────────────────────────────────────────────────

test("inventoryFields: EQUIPMENT_CATEGORY gets pointsTo and nameColumn (_NAME suffix)", () => {
  const result = inventoryFields({ columns: COLUMNS_FIXTURE, dd: DD_FIXTURE });
  const t6914  = result.tables.EQUIPMENT_INV_6914;
  assert.ok(t6914, "EQUIPMENT_INV_6914 table present");
  const col = t6914.columns.find(c => c.column === "EQUIPMENT_CATEGORY");
  assert.ok(col, "EQUIPMENT_CATEGORY column present");
  assert.equal(col.pointsTo,   "6911",                    "pointsTo file 6911");
  assert.equal(col.nameColumn, "EQUIPMENT_CATEGORY_NAME", "nameColumn is EQUIPMENT_CATEGORY_NAME");
});

test("inventoryFields: LOCATION gets nameColumn LOCATION_ROOM_NUMBER (non-_NAME suffix)", () => {
  const result = inventoryFields({ columns: COLUMNS_FIXTURE, dd: DD_FIXTURE });
  const col = result.tables.EQUIPMENT_INV_6914.columns.find(c => c.column === "LOCATION");
  assert.ok(col, "LOCATION column present");
  assert.equal(col.pointsTo,   "6928",               "pointsTo file 6928");
  assert.equal(col.nameColumn, "LOCATION_ROOM_NUMBER", "nameColumn is LOCATION_ROOM_NUMBER");
});

test("inventoryFields: JCAHO column gets codes array", () => {
  const result = inventoryFields({ columns: COLUMNS_FIXTURE, dd: DD_FIXTURE });
  const col = result.tables.EQUIPMENT_INV_6914.columns.find(c => c.column === "JCAHO");
  assert.ok(col, "JCAHO column present");
  assert.ok(Array.isArray(col.codes) && col.codes.length > 0, "codes is a non-empty array");
  assert.deepEqual(col.codes, [["Y", "YES"], ["N", "NO"]], "codes match fixture");
});

test("inventoryFields: allowList contains both fixture tables", () => {
  const result = inventoryFields({ columns: COLUMNS_FIXTURE, dd: DD_FIXTURE });
  assert.ok(result.allowList.includes("VISTA.EQUIPMENT_INV_6914"),    "6914 in allowList");
  assert.ok(result.allowList.includes("VISTA.EQUIPMENT_CATEGORY6911"), "6911 in allowList");
});

// ─── Tests against the committed inventory-fields.json ────────────────────────
const INV_PATH    = path.join(__dirname, "..", "..", "capability-graph", "inventory-fields.json");
const invExists   = fs.existsSync(INV_PATH);
const skipIfMissing = invExists ? false : "inventory-fields.json not yet committed";

test("inventory-fields.json: required EQUIPMENT_INV_6914 columns present", { skip: skipIfMissing }, () => {
  const inv = JSON.parse(fs.readFileSync(INV_PATH, "utf8"));
  const t   = inv.tables.EQUIPMENT_INV_6914;
  assert.ok(t, "EQUIPMENT_INV_6914 table present");
  const cols = t.columns.map(c => c.column);
  const required = [
    "REPLACEMENT_DATE", "TOTAL_ASSET_VALUE", "ORIGINAL_ASSET_VALUE",
    "SERVICE_CONTRACT", "JCAHO", "USE_STATUS", "INVESTMENT_CATEGORY",
    "TYPE_OF_ENTRY", "MFGR__EQUIPMENT_NAME", "EQUIPMENT_CATEGORY_NAME",
  ];
  for (const r of required) {
    assert.ok(cols.includes(r), r + " present in EQUIPMENT_INV_6914 columns");
  }
});

test("inventory-fields.json: USE_STATUS, JCAHO, SERVICE_CONTRACT have codes", { skip: skipIfMissing }, () => {
  const inv = JSON.parse(fs.readFileSync(INV_PATH, "utf8"));
  const t   = inv.tables.EQUIPMENT_INV_6914;
  for (const name of ["USE_STATUS", "JCAHO", "SERVICE_CONTRACT"]) {
    const col = t.columns.find(c => c.column === name);
    assert.ok(col, name + " column present");
    assert.ok(Array.isArray(col.codes) && col.codes.length > 0, name + " has codes");
  }
});

test("inventory-fields.json: WORK_ORDER_6920 STATUS column has codes", { skip: skipIfMissing }, () => {
  const inv = JSON.parse(fs.readFileSync(INV_PATH, "utf8"));
  const t6920 = inv.tables.WORK_ORDER_6920;
  assert.ok(t6920, "WORK_ORDER_6920 present");
  const statusCol = t6920.columns.find(c => c.column === "STATUS");
  assert.ok(statusCol, "STATUS column present in WORK_ORDER_6920");
  assert.ok(Array.isArray(statusCol.codes) && statusCol.codes.length > 0, "STATUS has codes");
});

test("inventory-fields.json: allowList includes 6914 and excludes 6920 and NEW_PERSON200", { skip: skipIfMissing }, () => {
  const inv = JSON.parse(fs.readFileSync(INV_PATH, "utf8"));
  assert.ok(inv.allowList.includes("VISTA.EQUIPMENT_INV_6914"),    "VISTA.EQUIPMENT_INV_6914 in allowList");
  assert.ok(!inv.allowList.includes("VISTA.WORK_ORDER_6920"),      "VISTA.WORK_ORDER_6920 not in allowList");
  assert.ok(!inv.allowList.includes("VISTA.NEW_PERSON200"),        "VISTA.NEW_PERSON200 not in allowList");
});

test("inventory-fields.json: EQUIPMENT_CATEGORY nameColumn is EQUIPMENT_CATEGORY_NAME", { skip: skipIfMissing }, () => {
  const inv = JSON.parse(fs.readFileSync(INV_PATH, "utf8"));
  const col = inv.tables.EQUIPMENT_INV_6914.columns.find(c => c.column === "EQUIPMENT_CATEGORY");
  assert.ok(col, "EQUIPMENT_CATEGORY present");
  assert.equal(col.nameColumn, "EQUIPMENT_CATEGORY_NAME", "nameColumn");
});

test("inventory-fields.json: LOCATION nameColumn is LOCATION_ROOM_NUMBER", { skip: skipIfMissing }, () => {
  const inv = JSON.parse(fs.readFileSync(INV_PATH, "utf8"));
  const col = inv.tables.EQUIPMENT_INV_6914.columns.find(c => c.column === "LOCATION");
  assert.ok(col, "LOCATION present");
  assert.equal(col.nameColumn, "LOCATION_ROOM_NUMBER", "nameColumn is LOCATION_ROOM_NUMBER");
});

test("inventory-fields.json: no secrets or internal host patterns in file", { skip: skipIfMissing }, () => {
  const raw = fs.readFileSync(INV_PATH, "utf8");
  assert.doesNotMatch(raw, /password/i,        "no 'password' in any string value");
  assert.doesNotMatch(raw, /172\.17\./,        "no internal IP 172.17.x.x");
  // Word-boundary so column names like PARENT_SYSTEM / Y2K_UTILITY_SYSTEM don't
  // trigger the check — only standalone _SYSTEM (the IRIS system account) is blocked.
  assert.doesNotMatch(raw, /\b_SYSTEM\b/i,     "no standalone _SYSTEM credential reference");
});

// ─── Personal data (final review C2): excluded by content, not by file name ────
const { personalColumns } = require("../discover-inventory");

// The finding's patterns, independent of the implementation: a test that the committed allow-list
// holds no table with a personal-data column.
const PERSONAL_NAME = /(^|_)SSN|SSN(_|$)|TAX_?ID|(^|_)HOME(_|$)|(^|_)DOB(_|$)|DATE_OF_BIRTH|WAGE|SALAR|HOURLY/;

const PERSONAL_FIXTURE_COLUMNS = [
  { TABLE_NAME: "EQUIPMENT_INV_6914", COLUMN_NAME: "IEN",            DATA_TYPE: "varchar" },
  { TABLE_NAME: "STAFF6929",          COLUMN_NAME: "IEN",            DATA_TYPE: "varchar" },
  { TABLE_NAME: "STAFF6929",          COLUMN_NAME: "NAME",           DATA_TYPE: "varchar" },
  { TABLE_NAME: "STAFF6929",          COLUMN_NAME: "HOME_PHONE",     DATA_TYPE: "varchar" },
  { TABLE_NAME: "STAFF6929",          COLUMN_NAME: "WAGE",           DATA_TYPE: "numeric" },
  { TABLE_NAME: "SUPPLIER440",        COLUMN_NAME: "IEN",            DATA_TYPE: "varchar" },
  { TABLE_NAME: "SUPPLIER440",        COLUMN_NAME: "TAX_IDSSN",      DATA_TYPE: "varchar" },
  { TABLE_NAME: "ROSTER6914_1",       COLUMN_NAME: "IEN",            DATA_TYPE: "varchar" },
  { TABLE_NAME: "ROSTER6914_1",       COLUMN_NAME: "PHONE_RESP_OFFICIAL", DATA_TYPE: "varchar" },
  { TABLE_NAME: "MAKER6912",          COLUMN_NAME: "IEN",            DATA_TYPE: "varchar" },
  { TABLE_NAME: "MAKER6912",          COLUMN_NAME: "PHONE",          DATA_TYPE: "varchar" },
  { TABLE_NAME: "MAKER6912",          COLUMN_NAME: "STREET",         DATA_TYPE: "varchar" },
  { TABLE_NAME: "WORK_ORDER_6920",    COLUMN_NAME: "IEN",            DATA_TYPE: "varchar" },
  { TABLE_NAME: "WORK_ORDER_6920",    COLUMN_NAME: "PHONE",          DATA_TYPE: "varchar" },
];
const PERSONAL_FIXTURE_DD = {
  EQUIPMENT_INV_6914: { file: "6914", fields: {} },
  STAFF6929:   { file: "6929", fields: { HOME_PHONE: { fieldNum: "4", ddName: "HOME PHONE", type: "FREE TEXT", description: "Employee's home telephone number." } } },
  SUPPLIER440: { file: "440",  fields: {} },
  ROSTER6914_1: { file: "6914.1", fields: { PHONE_RESP_OFFICIAL: { fieldNum: "3", ddName: "PHONE (RESP OFFICIAL)", type: "FREE TEXT", description: "" } } },
  MAKER6912:   { file: "6912", fields: { PHONE: { fieldNum: "5", ddName: "PHONE", type: "FREE TEXT", description: "Commercial telephone number (including area code)." },
                                         STREET: { fieldNum: "2", ddName: "STREET", type: "FREE TEXT", description: "Street address to which correspondence could be directed." } } },
  WORK_ORDER_6920: { file: "6920", allowList: false, keep: true, reason: "not an inventory file",
                     fields: { PHONE: { fieldNum: "9", ddName: "PHONE", type: "FREE TEXT", description: "Telephone number or extension of the individual requesting the work." } } },
};

test("personalColumns: SSN, tax id, home, birth date, wage and a person's phone are personal; a company's phone is not", () => {
  const cols = names => names.map(([column, ddName = column, meaning = ""]) => ({ column, ddName, meaning }));
  const hit = list => personalColumns(cols(list)).map(c => c.column);
  assert.deepEqual(hit([["SSN"], ["TAX_IDSSN"], ["SSNTAX_ID_INDICATOR"], ["PHONE_HOME"], ["HOME_STREET_ADDRESS"], ["DOB"], ["DATE_OF_BIRTH"], ["WAGE"], ["HOURLYRATE"], ["ANNUAL_SALARY"]]),
    ["SSN", "TAX_IDSSN", "SSNTAX_ID_INDICATOR", "PHONE_HOME", "HOME_STREET_ADDRESS", "DOB", "DATE_OF_BIRTH", "WAGE", "HOURLYRATE", "ANNUAL_SALARY"]);
  assert.deepEqual(hit([["PHONE_RESP_OFFICIAL", "PHONE (RESP OFFICIAL)"], ["HOSP_TELE_EXT_", "HOSP.TELE.EXT.", "Telephone extension on which this employee may be reached."],
                        ["CITY", "CITY", "This is the city of the permanent address of the new person."]]),
    ["PHONE_RESP_OFFICIAL", "HOSP_TELE_EXT_", "CITY"]);
  assert.deepEqual(hit([["PHONE", "PHONE", "Commercial telephone number (including area code)."], ["STREET", "STREET", "Street address to which correspondence could be directed."],
                        ["CLASSNAME"], ["MFGR__EQUIPMENT_NAME"], ["DLA_ADDRESS", "DLA ADDRESS", "This field restricts the selection to DLA addresses only."]]), []);
});

test("inventoryFields: a table with personal data is never allow-listed, is dropped, and its reason is recorded", () => {
  const r = inventoryFields({ columns: PERSONAL_FIXTURE_COLUMNS, dd: PERSONAL_FIXTURE_DD });
  assert.deepEqual(r.allowList, ["VISTA.EQUIPMENT_INV_6914", "VISTA.MAKER6912"]);
  for (const t of ["STAFF6929", "SUPPLIER440", "ROSTER6914_1"]) {
    assert.ok(!r.tables[t], `${t} is not described at all`);
    assert.ok(!Object.keys(r.evidence).some(k => k.startsWith(t + ".")), `${t} has no evidence lines`);
    assert.match(r.excluded["VISTA." + t], /personal data/, `${t} has a reason`);
  }
  assert.match(r.excluded["VISTA.STAFF6929"], /HOME_PHONE/);
  assert.match(r.excluded["VISTA.STAFF6929"], /WAGE/);
  assert.match(r.excluded["VISTA.SUPPLIER440"], /TAX_IDSSN/);
  assert.match(r.excluded["VISTA.ROSTER6914_1"], /PHONE_RESP_OFFICIAL/);
  // a table a quick-access template reads stays described, but is still not allow-listed
  assert.ok(r.tables.WORK_ORDER_6920, "WORK_ORDER_6920 is kept for the JCAHO template");
  assert.match(r.excluded["VISTA.WORK_ORDER_6920"], /not an inventory file/);
  assert.match(r.excluded["VISTA.WORK_ORDER_6920"], /personal data[^\n]*PHONE/);
});

test("inventory-fields.json: no allow-listed table has a personal-data column", { skip: skipIfMissing }, () => {
  const inv = JSON.parse(fs.readFileSync(INV_PATH, "utf8"));
  for (const q of inv.allowList) {
    const t = inv.tables[q.replace(/^VISTA\./, "")];
    assert.ok(t, `${q} is described`);
    for (const c of t.columns) assert.doesNotMatch(c.column, PERSONAL_NAME, `${q}.${c.column} is personal data`);
    assert.deepEqual(personalColumns(t.columns).map(c => c.column), [], `${q} has no personal columns by the discovery rule`);
  }
  for (const q of ["VISTA.ENG_EMPLOYEE6929", "VISTA.VENDOR440", "VISTA.NEW_PERSON200", "VISTA.CMR6914_1"]) {
    assert.ok(!inv.allowList.includes(q), `${q} is not allow-listed`);
    assert.match(inv.excluded[q] || "", /personal data/, `${q} has a recorded reason`);
  }
  assert.ok(!inv.tables.ENG_EMPLOYEE6929 && !inv.tables.VENDOR440 && !inv.tables.NEW_PERSON200, "personal tables are not described");
});
