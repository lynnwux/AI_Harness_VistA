"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");

test("the teardown script names only the harness's own things", () => {
  const { irisTeardownScript } = require("../lib/teardown");
  const s = irisTeardownScript();
  // Harness packages
  assert.match(s, /DeletePackage\("EquipmentEntry"/);
  assert.match(s, /DeletePackage\("EquipmentAI"/);
  // All three credentials
  assert.match(s, /EquipmentEntryBulletinSMTP/);
  assert.match(s, /EquipmentAIVademo/);
  assert.match(s, /EquipmentAIBedrock/);
  // Harness web apps
  assert.match(s, /\/equipmententry/);
  assert.match(s, /\/equipmentai/);
  // AI config global
  assert.match(s, /\^EquipmentAI\.Config/);
  // Must NOT purge every production's messages or delete framework packages
  assert.doesNotMatch(s, /DeletePackage\("Ens/);
  assert.doesNotMatch(s, /Purge\(/);
});

test("parseIrisTeardown treats absent as removed", () => {
  const { parseIrisTeardown } = require("../lib/teardown");

  // All markers with absent/0/not-running → every outcome is "absent"
  const allAbsent = [
    "STOP:not running",
    "MESSAGES:0",
    "EVENTLOG:0",
    "SETTINGS:0",
    "AISESSIONS:0",
    "AICONFIG:0",
    "PKG:EquipmentEntry:absent",
    "PKG:EquipmentAI:absent",
    "CRED:EquipmentEntryBulletinSMTP:absent",
    "CRED:EquipmentAIVademo:absent",
    "CRED:EquipmentAIBedrock:absent",
    "WEBAPP:/equipmententry:absent",
    "WEBAPP:/equipmentai:absent",
  ].join("\n");
  const result = parseIrisTeardown(allAbsent);
  assert.ok(Array.isArray(result) && result.length > 0, "must return a non-empty array");
  const notAbsent = result.filter(r => r.outcome !== "absent");
  assert.deepEqual(notAbsent, [], `expected all absent; got: ${JSON.stringify(notAbsent)}`);

  // Empty output → every item "failed: no answer from IRIS"
  const noAnswer = parseIrisTeardown("");
  const notFailed = noAnswer.filter(r => r.outcome !== "failed: no answer from IRIS");
  assert.deepEqual(notFailed, [], `expected all no-answer; got: ${JSON.stringify(notFailed)}`);

  // WEBAPP:/equipmentai:ERROR #921 → that item "failed: ERROR #921"
  const errOut = "WEBAPP:/equipmentai:ERROR #921\n";
  const res = parseIrisTeardown(errOut);
  const webappAi = res.find(r => r.item === "WEBAPP:/equipmentai");
  assert.ok(webappAi, "WEBAPP:/equipmentai must be in the result");
  assert.equal(webappAi.outcome, "failed: ERROR #921");
});

test("the production and AI scripts update an existing web app", () => {
  const { sessionScript } = require("../production-runner");
  const { aiSettingsScript, checkSettingsMarkers } = require("../ai-runner");

  // sessionScript must contain the Modify branch
  const ss = sessionScript("INTEROP");
  assert.match(ss, /Security\.Applications\)\.Modify\(/);
  assert.match(ss, /WEBAPP:updated/);

  // aiSettingsScript must contain the Modify branch
  const as = aiSettingsScript({
    VADEMO_URL: "http://h:80",
    VADEMO_USER: "u",
    VADEMO_PASSWORD: "p",
    AWS_BEARER_TOKEN_BEDROCK: "t",
  });
  assert.match(as, /Security\.Applications\)\.Modify\(/);
  assert.match(as, /WEBAPP:updated/);

  // checkSettingsMarkers accepts "updated" as a valid WEBAPP outcome
  const out = "WEBAPP:updated\nCONFIG:set\nVADEMO:stored\nBEDROCK:stored\nSESSIONS:cleared 0\n";
  assert.deepEqual(checkSettingsMarkers(out), []);
});
