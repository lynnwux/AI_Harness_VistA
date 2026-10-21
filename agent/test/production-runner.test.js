"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { graph, rec, IM } = require("./helpers");
const { generate, writeSpecs } = require("../lib/specs");
const { readSpecs, serverEntry, samplePayload, judge } = require("../production-runner");

const decided = {
  dec: { "OQ.WorkOrderPolicy": "Required input", "OQ.PMEnrollmentPolicy": "Business rule", "OQ.FAConfirmation": "Defer" },
  oqPolicy: { "OQ.WorkOrderPolicy": "ask", "OQ.PMEnrollmentPolicy": "a rule", "OQ.FAConfirmation": "later" },
};
function setupSpecs(record) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prod-"));
  const paths = { graph: path.join(dir, "graph.json"), decisions: path.join(dir, "decisions.json"), implemented: path.join(dir, "implemented.json"), specsDir: path.join(dir, "specs") };
  fs.writeFileSync(paths.graph, JSON.stringify(graph));
  fs.writeFileSync(paths.decisions, JSON.stringify(record));
  fs.writeFileSync(paths.implemented, JSON.stringify(IM));
  const inputs = { graph, record, implemented: IM };
  writeSpecs(paths.specsDir, generate(inputs), inputs);
  return paths;
}

test("the production build reads a fresh, complete orchestrator spec", () => {
  const paths = setupSpecs(rec({ ...decided, targets: { "SIDE.Bulletin": { recipients: "x@example.org" } } }));
  const s = readSpecs(paths);
  assert.equal(s.orchestrator.complete, true);
  assert.equal(s.orchestrator.detail.namespace, "INTEROP");
  assert.ok(s.api.detail.pages.length > 0);
});

test("it refuses an incomplete spec and a stale one", () => {
  assert.throws(() => readSpecs(setupSpecs(rec(decided))), /not complete/);
  const paths = setupSpecs(rec({ ...decided, targets: { "SIDE.Bulletin": { recipients: "x@example.org" } } }));
  fs.writeFileSync(paths.decisions, JSON.stringify(rec({ ...decided, targets: { "SIDE.Bulletin": { recipients: "changed@example.org" } } })));
  assert.throws(() => readSpecs(paths), /stale/);
});

test("the interclaw server entry comes from the URL and never holds a password", () => {
  const e = serverEntry("http://localhost:9092");
  assert.deepEqual(e["intersystems.servers"]["iris-ai-hub"].webServer, { scheme: "http", host: "localhost", port: 9092, pathPrefix: "" });
  assert.ok(!JSON.stringify(e).includes("password"));
  assert.throws(() => serverEntry(""), /IRIS_AI_HUB_URL/);
});

test("the verification request uses the form's own keys for a capitalized NX test item", () => {
  const s = generate({ graph, record: rec(decided), implemented: IM });
  const p = samplePayload(s.api);
  assert.equal(p.typeOfEntry, "NX");
  assert.equal(p.investmentCategory, "1");
});

test("the test payload fills the form fully, with values that are valid and plainly a test", () => {
  const s = generate({ graph, record: rec(decided), implemented: IM });
  const p = samplePayload(s.api);
  const fields = s.api.detail.pages.flatMap(pg => pg.fields);
  const byKey = Object.fromEntries(fields.map(f => [f.k, f]));
  for (const [k, v] of Object.entries(p)) {
    const f = byKey[k];
    assert.ok(f, `${k} is a form field`);
    assert.ok(!/^lookup/.test(f.type), `${k}: no made-up record number for a lookup field`);
    if (f.type === "select") assert.ok(f.options.some(([code]) => code === v), `${k}: ${v} is one of its codes`);
    if (f.type === "date") assert.match(v, /^\d{4}-\d{2}-\d{2}$/, k);
    if (f.type === "number") assert.equal(typeof v, "number", k);
    if (f.type === "text") assert.match(v, /TEST/, `${k} reads as a test`);
  }
  for (const f of fields.filter(f => ["text", "select", "date", "number"].includes(f.type))) assert.ok(f.k in p, `${f.k} is filled`);
  const limits = { stationNumber: [3, 5], vaPmNumber: [9, 10], localIdentifier: [3, 15], fundControlPoint: [3, 30] };
  for (const [k, [lo, hi]] of Object.entries(limits)) assert.ok(p[k].length >= lo && p[k].length <= hi, `${k} length ${p[k].length}`);
  assert.match(p.mfgrEquipmentName, /^TEST .*NOT REAL/);
});

test("a dry-run verification passes only if the write and bulletin are dry-run and every stub stayed unwired", () => {
  const stubs = ["A", "B"];
  const good = { status: "DRY-RUN", outcomes: { vistaWrite: "DRY-RUN", bulletin: "dry-run", stubs: { A: "stub - not wired", B: "stub - not wired" } } };
  assert.deepEqual(judge(good, stubs), { ok: true, problems: [] });
  const bad = { status: "OK", outcomes: { vistaWrite: "OK", bulletin: "sent", stubs: { A: "stub - not wired" } } };
  const j = judge(bad, stubs);
  assert.equal(j.ok, false);
  assert.equal(j.problems.length, 3);
});

test("the link to the production comes from the namespace's own portal web app", () => {
  const { portalUrl, sessionScript } = require("../production-runner");
  assert.equal(portalUrl("http://localhost:9092/", "/csp/healthshare/interop/"), "http://localhost:9092/csp/healthshare/interop/EnsPortal.ProductionConfig.zen?PRODUCTION=EquipmentEntry.Production");
  assert.equal(portalUrl("http://localhost:9092", ""), null);
  assert.match(sessionScript("INTEROP"), /write "PORTAL:",\$system\.CSP\.GetDefaultApp\("INTEROP"\)/);
});

test("a rebuild overwrites the classes already in IRIS instead of failing on a conflict", () => {
  const { docPath } = require("../production-runner");
  assert.equal(docPath("INTEROP", "EquipmentEntry.Production.cls"), "/v2/INTEROP/doc/EquipmentEntry.Production.cls?ignoreConflict=1");
});

test("the bulletin's mail server comes only from the environment, and is optional", () => {
  const { smtpSettings } = require("../production-runner");
  assert.equal(smtpSettings({}), null);
  assert.deepEqual(smtpSettings({ BULLETIN_SMTP_HOST: "mailpit", BULLETIN_SMTP_PORT: "1025", BULLETIN_SMTP_FROM: "aems@example.org" }),
    { host: "mailpit", port: 1025, from: "aems@example.org", user: null, password: null });
  assert.throws(() => smtpSettings({ BULLETIN_SMTP_HOST: "mailpit" }), /BULLETIN_SMTP_FROM/);
});

test("the mail settings are written into IRIS as default settings, quoted, with a login only when one is given", () => {
  const { bulletinSettingsScript } = require("../production-runner");
  const clear = bulletinSettingsScript("INTEROP", null);
  assert.match(clear, /DELETE FROM Ens_Config\.DefaultSettings WHERE ProductionName='EquipmentEntry\.Production'/);
  assert.doesNotMatch(clear, /INSERT/);
  const s = bulletinSettingsScript("INTEROP", { host: "mailpit", port: 1025, from: 'say "hi"@example.org', user: null, password: null });
  assert.match(s, /"SMTPServer","mailpit"\)/);
  assert.match(s, /"SMTPPort","1025"\)/);
  assert.match(s, /"From","say ""hi""@example.org"\)/);
  assert.doesNotMatch(s, /Credentials/);
  const withLogin = bulletinSettingsScript("INTEROP", { host: "smtp.example.org", port: 587, from: "a@example.org", user: "u", password: "p" });
  assert.match(withLogin, /SetCredential\("EquipmentEntryBulletinSMTP","u","p",1\)/);
  assert.match(withLogin, /"Credentials","EquipmentEntryBulletinSMTP"\)/);
});

test("a live bulletin passes verification only when it reports sent", () => {
  const ok = { status: "DRY-RUN", outcomes: { vistaWrite: "DRY-RUN", bulletin: "sent", stubs: { A: "stub - not wired" } } };
  assert.deepEqual(judge(ok, ["A"], "sent"), { ok: true, problems: [] });
  assert.equal(judge({ ...ok, outcomes: { ...ok.outcomes, bulletin: "dry-run" } }, ["A"], "sent").ok, false);
});

test("the mail catcher check finds this build's bulletin, not an older one", () => {
  const { findDelivered } = require("../production-runner");
  const since = "2026-10-20T21:00:00.000Z";
  const msgs = [
    { ID: "new", Subject: "NEW EQUIPMENT: ENTRY #x", To: [{ Address: "Eng@Example.org" }, { Address: "it@example.org" }], Created: "2026-10-20T21:00:05.000Z" },
    { ID: "old", Subject: "NEW EQUIPMENT: ENTRY #x", To: [{ Address: "eng@example.org" }], Created: "2026-10-20T20:00:00.000Z" },
  ];
  assert.equal(findDelivered(msgs, { subject: "NEW EQUIPMENT: ENTRY #x", recipients: "eng@example.org; it@example.org", since }).ID, "new");
  assert.equal(findDelivered(msgs.slice(1), { subject: "NEW EQUIPMENT: ENTRY #x", recipients: "eng@example.org", since }), null);
});
