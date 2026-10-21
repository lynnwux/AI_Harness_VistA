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

// ── Final review M1: a secret straddling the cut never leaks its prefix ───────
test("irisSession redacts before it cuts the output, so a long token across the 600-char cut leaves no prefix", () => {
  const { irisSession } = require("../lib/iris-deploy");
  const token = "BEDROCK-API-KEY-" + "abcdefghijklmnopqrstuvwxyz0123456789".repeat(8);   // ~300 chars
  const echo = "x".repeat(580) + `set sc=##class(Ens.Config.Credentials).SetCredential("EquipmentAIBedrock","","${token}",1)\n`;
  const fakeSpawn = () => ({ status: 1, stdout: echo, stderr: "" });
  let msg = "";
  try { irisSession("iris-ai-hub", "script", { secrets: [token], spawnSyncImpl: fakeSpawn }); } catch (e) { msg = e.message; }
  assert.match(msg, /iris session failed \(exit 1\)/);
  assert.ok(!msg.includes("BEDROCK-API-KEY"), "no prefix of the token survives: " + msg.slice(-80));
  assert.ok(!msg.includes("abcdefghij"), "no part of the token survives");
  // an error message never carries the echoed SetCredential line either
  assert.doesNotMatch(msg, /SetCredential/);
});

test("irisScript redacts the IRIS password from a failed call's output", () => {
  const { irisScript } = require("../lib/iris-deploy");
  const pass = "iris-pass-" + "q".repeat(700);
  const call = irisScript({ INTERCLAW_SCRIPTS: "x", IRIS_PASSWORD: pass }, "iris-ai-hub", "cfg.json", { spawnSyncImpl: () => ({ status: 2, stdout: "", stderr: "auth " + pass }) });
  assert.throws(() => call("GET", "/v2/INTEROP/doc/X.cls"), e => !e.message.includes("iris-pass") && !e.message.includes("qqqq") && /\*\*\*/.test(e.message));
});
