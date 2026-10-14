"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { angularFiles } = require("../lib/angular-app");

const FIX = path.join(__dirname, "fixtures");
const goldenCfg = () => JSON.parse(fs.readFileSync(path.join(FIX, "golden-cfg.json"), "utf8"));
const goldenApp = () => JSON.parse(fs.readFileSync(path.join(FIX, "golden-app.json"), "utf8"));

test("angularFiles reproduces the pre-refactor generated app byte for byte", () => {
  assert.deepEqual(angularFiles(goldenCfg()), goldenApp());
});
