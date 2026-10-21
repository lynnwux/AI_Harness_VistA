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
