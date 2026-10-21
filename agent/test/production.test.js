"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { graph, rec, IM } = require("./helpers");
const { generate } = require("../lib/specs");
const { productionClasses, PKG } = require("../lib/production");

const decided = {
  dec: { "OQ.WorkOrderPolicy": "Required input", "OQ.PMEnrollmentPolicy": "Business rule", "OQ.FAConfirmation": "Business rule" },
  oqPolicy: { "OQ.WorkOrderPolicy": "ask the clerk", "OQ.PMEnrollmentPolicy": "a rule the developer stated", "OQ.FAConfirmation": "send it \"always\" & <now>" },
  targets: { "SIDE.Bulletin": { recipients: "eng@example.org; it@example.org" } },
};
const specsFor = record => generate({ graph, record, implemented: IM });
const classes = (record = rec(decided)) => { const s = specsFor(record); return productionClasses({ orchestrator: s.orchestrator, api: s.api }); };
const byName = list => Object.fromEntries(list.map(c => [c.name, c.text]));
const productionXml = list => byName(list)[`${PKG}.Production.cls`];

test("generates the production's classes under one package, messages first and the production last", () => {
  const names = classes().map(c => c.name);
  assert.deepEqual(names, [
    `${PKG}.Msg.RegisterRequest.cls`, `${PKG}.Msg.RegisterResponse.cls`, `${PKG}.Msg.BulletinRequest.cls`, `${PKG}.Msg.BulletinResponse.cls`, `${PKG}.Msg.StubRequest.cls`,
    `${PKG}.BS.RegisterService.cls`, `${PKG}.BO.VistAEquipmentWriteOperation.cls`, `${PKG}.BO.NewEquipmentBulletinOperation.cls`, `${PKG}.BO.StubOperation.cls`,
    `${PKG}.BPL.RegisterProcess.cls`, `${PKG}.REST.Dispatch.cls`, `${PKG}.Production.cls`,
  ]);
  assert.ok(classes().every(c => c.text.startsWith(`Class ${c.name.replace(/\.cls$/, "")} `) || c.text.startsWith("Include Ensemble\n\nClass " + c.name.replace(/\.cls$/, ""))));
});

test("refuses a spec that is not complete", () => {
  const s = specsFor(rec({ ...decided, targets: {} }));
  assert.throws(() => productionClasses({ orchestrator: s.orchestrator, api: s.api }), /not complete/);
});

test("the production registers the front door, orchestrator, both real operations dry-run, and one stub per other side effect", () => {
  const x = productionXml(classes());
  assert.match(x, /<Item Name="EquipmentEntry Front Door"[^>]*ClassName="EquipmentEntry.BS.RegisterService"[^>]*PoolSize="0"/);
  assert.match(x, /<Item Name="Register Equipment Orchestrator"[^>]*ClassName="EquipmentEntry.BPL.RegisterProcess"/);
  assert.match(x, /<Item Name="VistA Equipment Write"[\s\S]*?<Setting Target="Host" Name="DryRun">1<\/Setting>/);
  assert.match(x, /<Item Name="New Equipment Bulletin"[\s\S]*?<Setting Target="Host" Name="Recipients">eng@example.org; it@example.org<\/Setting>[\s\S]*?<Setting Target="Host" Name="DryRun">1<\/Setting>/);
  const stubs = [...x.matchAll(/<Item Name="([^"]+) \(stub\)"[^>]*ClassName="EquipmentEntry.BO.StubOperation"/g)].map(m => m[1]);
  assert.deepEqual(stubs, ["Incoming inspection work order", "PM-schedule enrollment", "FA document to Austin"]);
});

test("the recorded decisions travel with each stub, XML-escaped", () => {
  const x = productionXml(classes());
  assert.match(x, /Name="Decision">Business rule: send it &quot;always&quot; &amp; &lt;now&gt;<\/Setting>/);
  assert.match(x, /Name="Decision">Required input: ask the clerk<\/Setting>/);
});

test("the orchestrator writes to VistA, then sends the bulletin — it never calls a stub", () => {
  const bpl = byName(classes())[`${PKG}.BPL.RegisterProcess.cls`];
  const targets = [...bpl.matchAll(/<call [^>]*target='([^']+)'/g)].map(m => m[1]);
  assert.deepEqual(targets, ["VistA Equipment Write", "New Equipment Bulletin"]);
  assert.match(bpl, /request='EquipmentEntry.Msg.RegisterRequest' response='EquipmentEntry.Msg.RegisterResponse'/);
});

test("the bulletin fills the legacy template from the form's own keys and reports a stubbed FA as not reported", () => {
  const bo = byName(classes())[`${PKG}.BO.NewEquipmentBulletinOperation.cls`];
  assert.match(bo, /"NEW EQUIPMENT: ENTRY #\|1\|"/);
  assert.match(bo, /"A new equipment record has been added to the AEMS\/MERS database\."/);
  for (const k of ["mfgrEquipmentName", "equipmentCategory", "servicePointer", "stationNumber", "typeOfEntry", "investmentCategory"]) assert.match(bo, new RegExp(`%Get\\("${k}"\\)`), k);
  assert.match(bo, /\("typeOfEntry"\)="NX"\)&&\(tIn\.%Get\("investmentCategory"\)="1"\)/);
  assert.match(bo, /"It was NOT reported to FAP\."/);
  assert.doesNotMatch(bo, /"It was reported to FAP\."/);
});

test("nothing generated carries a credential or a host", () => {
  const all = classes().map(c => c.text).join("\n");
  assert.doesNotMatch(all, /password|VADEMO_|IRIS_AI_HUB|Basic [A-Za-z0-9+/=]{8,}/i);
});

test("with a mail server for the deployment the bulletin sends for real, the VistA write stays dry-run, and no host is generated", () => {
  const s = specsFor(rec(decided));
  const list = productionClasses({ orchestrator: s.orchestrator, api: s.api }, { bulletinLive: true });
  const x = productionXml(list);
  assert.match(x, /<Item Name="New Equipment Bulletin"[\s\S]*?Name="DryRun">0<\/Setting>/);
  assert.match(x, /<Item Name="VistA Equipment Write"[\s\S]*?Name="DryRun">1<\/Setting>/);
  assert.doesNotMatch(list.map(c => c.text).join("\n"), /SMTPServer|mailpit/i);
});
