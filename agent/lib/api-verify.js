"use strict";
// Phase 1 test record: build a payload, POST via REST, read back over SQL, verify fidelity.

// form key → EQUIPMENT_INV_6914 SQL column
const COLUMN = {
  serial: "SERIAL_",
  manufacturer: "MANUFACTURER",
  mfgrEquipmentName: "MFGR__EQUIPMENT_NAME",
  model: "MODEL",
  equipmentCategory: "EQUIPMENT_CATEGORY",
  typeOfEntry: "TYPE_OF_ENTRY",
  acquisitionMethod: "ACQUISITION_METHOD",
  acquisitionDate: "ACQUISITION_DATE",
  vendorPointer: "VENDOR_POINTER",
  originalAssetValue: "ORIGINAL_ASSET_VALUE",
  warrantyExpDate: "WARRANTY_EXP__DATE",
  replacingEntryNumber: "REPLACING_ENTRY_NUMBER",
  categoryStockNumber: "CATEGORY_STOCK_NUMBER",
  servicePointer: "SERVICE_POINTER",
  useStatus: "USE_STATUS",
  parentSystem: "PARENT_SYSTEM",
  location: "LOCATION",
  lockoutRequired: "LOCKOUT_REQUIRED",
  conditionCode: "CONDITION_CODE",
  stationNumber: "STATION_NUMBER",
  vaPmNumber: "VA_PM_NUMBER",
  serviceContract: "SERVICE_CONTRACT",
  serviceContractCost: "SERVICE_CONTRACT_COST",
  localIdentifier: "LOCAL_IDENTIFIER",
  physicalInventoryDate: "PHYSICAL_INVENTORY_DATE",
  jcaho: "JCAHO",
  controlledItem: "CONTROLLED_ITEM",
  investmentCategory: "INVESTMENT_CATEGORY",
  fundControlPoint: "FUND_CONTROL_POINT",
  fund: "FUND",
  budgetObjectCode: "BUDGET_OBJECT_CODE",
  standardGeneralLedger: "STANDARD_GENERAL_LEDGER",
  equityAccount: "EQUITY_ACCOUNT",
  subaccount: "SUBACCOUNT",
};

// Fixed test values for non-pointer fields (non-serial)
const TEST_VALUES = {
  mfgrEquipmentName: "TEST ITEM - NOT REAL",
  model: "TEST-MODEL",
  typeOfEntry: "NX",
  acquisitionMethod: "O",
  acquisitionDate: "2000-01-01",
  originalAssetValue: 1,
  warrantyExpDate: "2000-01-01",
  useStatus: "1",
  lockoutRequired: "YES",
  conditionCode: "1",
  stationNumber: "TEST",
  vaPmNumber: "TEST-00001",
  serviceContract: "YES",
  serviceContractCost: 2,
  localIdentifier: "WORKBENCH-TEST",
  physicalInventoryDate: "2000-01-01",
  jcaho: "YES",
  controlledItem: "YES",
  investmentCategory: "1",
  fundControlPoint: "TEST",
  equityAccount: "3299",
};

// What Harness.Equipment.REST.Enum stores for YES/NO fields
const STORED_YESNO = {
  lockoutRequired: { YES: "1", NO: "0" },
  controlledItem: { YES: "1", NO: "0" },
  jcaho: { YES: "Y", NO: "N" },
  serviceContract: { YES: "Y", NO: "N" },
};

// UTC run identifier: "YYYYMMDDhhmmss"
function runIdOf(date) {
  const p = n => String(n).padStart(2, "0");
  return String(date.getUTCFullYear()) + p(date.getUTCMonth() + 1) + p(date.getUTCDate()) +
    p(date.getUTCHours()) + p(date.getUTCMinutes()) + p(date.getUTCSeconds());
}

const testSerial = runId => "HT-" + runId;

// ISO "YYYY-MM-DD" → FileMan internal string "(year-1700)MMDD"
const fmDate = iso => { const [y, m, d] = iso.split("-"); return String(Number(y) - 1700) + m + d; };

// All page fields except readonly (.01)
const operatorFields = apiSpec => apiSpec.detail.pages.flatMap(p => p.fields).filter(f => f.type !== "readonly");

// SELECT TOP 1 IEN from each pointer table; throws when any table is empty
async function pickPointers(client, fields) {
  const result = {};
  for (const f of fields.filter(f => f.table)) {
    const rows = await client.query(`SELECT TOP 1 IEN AS ien FROM VISTA.${f.table}`);
    if (!rows.length) throw new Error(`no rows in VISTA.${f.table} to point the test record at`);
    result[f.k] = rows[0].ien;
  }
  return result;
}

// Build the test payload: serial + pointer IENs + TEST_VALUES for everything else
function testRecord(apiSpec, pointers, runId) {
  const payload = {};
  for (const f of operatorFields(apiSpec)) {
    if (f.k === "serial") payload.serial = testSerial(runId);
    else if (pointers[f.k] !== undefined) payload[f.k] = pointers[f.k];
    else if (TEST_VALUES[f.k] !== undefined) payload[f.k] = TEST_VALUES[f.k];
  }
  return payload;
}

// Convert form payload → expected SQL column values (dates, YES/NO, pointers, numbers)
function expectedRow(payload) {
  const row = {};
  for (const [k, v] of Object.entries(payload)) {
    const col = COLUMN[k]; if (!col) continue;
    if (STORED_YESNO[k]) row[col] = STORED_YESNO[k][v] ?? String(v);
    else if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v)) row[col] = fmDate(v);
    else row[col] = String(v);
  }
  return row;
}

// Compare expected vs stored; numeric strings compare as numbers (handles FileMan int vs IRIS decimal)
function compareRow(expected, row) {
  const rows = Object.entries(expected).map(([column, exp]) => {
    const e = String(exp ?? "").trim(), s = String(row[column] ?? "").trim();
    const numOk = e !== "" && s !== "" && isFinite(Number(e)) && isFinite(Number(s)) && Number(e) === Number(s);
    return { column, expected: e, stored: s, ok: e === s || numOk };
  });
  return { ok: rows.every(r => r.ok), rows };
}

// Case-insensitive OK check: real REST returns "ok" for NextIEN but "OK" for POST
const isOK = status => String(status).toUpperCase() === "OK";

// Full write-path: GET NextIEN → POST → GET record → SQL read-back → compare
async function verifyWritePath(client, apiSpec, { runId, log = () => {} }) {
  const fields = operatorFields(apiSpec);
  const pointers = await pickPointers(client, fields);
  const payload = testRecord(apiSpec, pointers, runId);

  log("GET /NextIEN");
  const nextRes = await client.rest("GET", "/NextIEN");
  if (!isOK(nextRes.json?.status)) throw new Error(`GET /NextIEN failed: ${JSON.stringify(nextRes.json)}`);

  log("POST /Equipment6914");
  const postRes = await client.rest("POST", "/Equipment6914", payload);
  if (!isOK(postRes.json?.status)) throw new Error(`POST /Equipment6914 failed: ${JSON.stringify(postRes.json)}`);
  const ien = postRes.json.equipmentIEN;

  log(`GET /Equipment6914/${ien}`);
  const getRes = await client.rest("GET", `/Equipment6914/${ien}`);
  if (getRes.status !== 200) throw new Error(`GET /Equipment6914/${ien} failed: status ${getRes.status}`);

  const columns = Object.values(COLUMN).join(", ");
  log(`SELECT from VISTA.EQUIPMENT_INV_6914 WHERE IEN = ${ien}`);
  const dbRows = await client.query(`SELECT ${columns} FROM VISTA.EQUIPMENT_INV_6914 WHERE IEN = ?`, [String(ien)]);
  const cmp = compareRow(expectedRow(payload), dbRows[0] || {});
  if (!cmp.ok) {
    const msg = cmp.rows.filter(r => !r.ok).map(r => `${r.column} expected ${r.expected}, stored ${r.stored}`).join("; ");
    throw new Error(`the test record (IEN ${ien}) did not read back as written: ${msg}`);
  }
  return { ien, serial: payload.serial, rows: cmp.rows };
}

module.exports = { COLUMN, TEST_VALUES, STORED_YESNO, runIdOf, testSerial, fmDate, operatorFields, pickPointers, testRecord, expectedRow, compareRow, verifyWritePath, isOK };
