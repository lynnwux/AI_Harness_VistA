"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { deployRestService, removeRestService, REST_CLASSES, REST_WEB_APP, REST_TEARDOWN_CLASSES, HARNESS_DIR } = require("../lib/rest-service");

// Temp dir with stub .cls files so readFileSync in the module under test succeeds.
function tempDir(classes) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rs-"));
  for (const cls of classes) fs.writeFileSync(path.join(dir, cls), `/// ${cls}`);
  return dir;
}

test("deployRestService uploads three classes, compiles once, returns classes and webApp", async () => {
  const calls = [];
  const client = {
    async putClass(name) { calls.push(`PUT ${name}`); },
    async compile(names) { calls.push(`COMPILE ${names.join(",")}`); },
    async query() { return [{ r: "created: /Harness/Equipment" }]; },
  };
  const sourceDir = tempDir(REST_CLASSES);
  try {
    const r = await deployRestService(client, { sourceDir });
    assert.deepEqual(r.classes, REST_CLASSES);
    assert.equal(r.webApp, "created");
    assert.deepEqual(calls, [
      "PUT Harness.Setup.cls",
      "PUT Harness.Equipment6914.API.cls",
      "PUT Harness.Equipment.REST.cls",
      "COMPILE Harness.Setup.cls,Harness.Equipment6914.API.cls,Harness.Equipment.REST.cls",
    ]);
  } finally { fs.rmSync(sourceDir, { recursive: true, force: true }); }
});

test("deployRestService webApp:updated when CreateWebApp returns updated", async () => {
  const client = {
    async putClass() {}, async compile() {},
    async query() { return [{ r: "updated: /Harness/Equipment" }]; },
  };
  const sourceDir = tempDir(REST_CLASSES);
  try {
    const r = await deployRestService(client, { sourceDir });
    assert.equal(r.webApp, "updated");
  } finally { fs.rmSync(sourceDir, { recursive: true, force: true }); }
});

test("deployRestService throws on unexpected CreateWebApp response", async () => {
  const client = {
    async putClass() {}, async compile() {},
    async query() { return [{ r: "ERROR: no source app" }]; },
  };
  const sourceDir = tempDir(REST_CLASSES);
  try {
    await assert.rejects(() => deployRestService(client, { sourceDir }), /ERROR: no source app/);
  } finally { fs.rmSync(sourceDir, { recursive: true, force: true }); }
});

test("removeRestService on an empty VADEMO gives four absent results", async () => {
  const client = {
    async putClass() {}, async compile() {},
    async query() { return [{ r: "absent: /Harness/Equipment" }]; },
    async deleteClass() { return "absent"; },
  };
  const sourceDir = tempDir(["Harness.Setup.cls"]);
  try {
    const results = await removeRestService(client, { sourceDir });
    assert.equal(results.length, 4, JSON.stringify(results));
    assert.ok(results.every(r => r.outcome === "absent"), JSON.stringify(results));
    assert.equal(results[0].item, `web app ${REST_WEB_APP}`);
    assert.deepEqual(results.slice(1).map(r => r.item), REST_TEARDOWN_CLASSES.map(c => `class ${c}`));
  } finally { fs.rmSync(sourceDir, { recursive: true, force: true }); }
});

test("removeRestService keeps going after a web-app failure", async () => {
  const client = {
    async putClass() {}, async compile() {},
    async query() { throw new Error("VADEMO unreachable"); },
    async deleteClass() { return "deleted"; },
  };
  const sourceDir = tempDir(["Harness.Setup.cls"]);
  try {
    const results = await removeRestService(client, { sourceDir });
    assert.equal(results.length, 4, JSON.stringify(results));
    assert.match(results[0].outcome, /^failed:/);
    assert.ok(results.slice(1).every(r => r.outcome === "removed"), JSON.stringify(results));
  } finally { fs.rmSync(sourceDir, { recursive: true, force: true }); }
});

test("Harness.Setup.cls has create-or-update and delete", () => {
  const text = fs.readFileSync(path.resolve(HARNESS_DIR, "Harness.Setup.cls"), "utf8");
  assert.ok(text.includes("ClassMethod DeleteWebApp()"), "has DeleteWebApp");
  assert.ok(text.includes("Security.Applications).Modify("), "has Modify call");
  assert.ok(text.includes('"updated: "'), "has updated response");
  assert.ok(text.includes('"absent: "'), "has absent response");
});
