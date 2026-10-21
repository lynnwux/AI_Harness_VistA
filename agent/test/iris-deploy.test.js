"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");

const { serverEntry, docPath, redact } = require("../lib/iris-deploy");

test("redact replaces every listed secret in the text", () => {
  assert.equal(redact("x s3cr3t y s3cr3t", ["s3cr3t"]), "x *** y ***");
  assert.equal(redact("pass1 and pass2 done", ["pass1", "pass2"]), "*** and *** done");
  assert.equal(redact("unchanged", []), "unchanged");
  assert.equal(redact("safe", [null, "", undefined]), "safe");
  assert.equal(redact("", ["x"]), "");
  // substrings are replaced (simple split/join — secrets are long in practice)
  assert.equal(redact("tok tokxyz", ["tok"]), "*** ***xyz");
});

test("serverEntry builds the interclaw server config from a URL", () => {
  const e = serverEntry("http://localhost:9092");
  assert.deepEqual(e["intersystems.servers"]["iris-ai-hub"].webServer, { scheme: "http", host: "localhost", port: 9092, pathPrefix: "" });
  assert.throws(() => serverEntry(""), /IRIS_AI_HUB_URL/);
  const e2 = serverEntry("https://iris.example.org/path/prefix/");
  assert.deepEqual(e2["intersystems.servers"]["iris-ai-hub"].webServer, { scheme: "https", host: "iris.example.org", port: 443, pathPrefix: "/path/prefix" });
});

test("docPath appends ?ignoreConflict=1 for the interclaw PUT", () => {
  assert.equal(docPath("INTEROP", "EquipmentAI.Agent.cls"), "/v2/INTEROP/doc/EquipmentAI.Agent.cls?ignoreConflict=1");
  assert.equal(docPath("INTEROP", "EquipmentEntry.Production.cls"), "/v2/INTEROP/doc/EquipmentEntry.Production.cls?ignoreConflict=1");
});
