"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { saveKnownGood, readKnownGood, LAYERS } = require("../lib/known-good");

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "kg-"));
const files = (dir, map) => { for (const [f, t] of Object.entries(map)) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), t); } return dir; };

test("the three deliverables are the layers that get a known-good copy", () => {
  assert.deepEqual(LAYERS, ["api", "orchestrator", "ai"]);
});

test("a good build's files are copied under the layer, with when and what, and read back", () => {
  const root = tmp(), src = files(tmp(), { "index.html": "<p>v1</p>", "assets/main.js": "x" });
  try {
    saveKnownGood("api", { dirs: { site: src }, meta: { url: "/prototype/build/" } }, root);
    const kg = readKnownGood("api", root);
    assert.equal(fs.readFileSync(path.join(kg.dirs.site, "assets", "main.js"), "utf8"), "x");
    assert.equal(kg.meta.layer, "api");
    assert.equal(kg.meta.url, "/prototype/build/");
    assert.ok(Date.parse(kg.meta.savedAt));
  } finally { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(src, { recursive: true, force: true }); }
});

test("a newer good copy replaces the old one completely; a copy that fails half-way leaves the old one intact", () => {
  const root = tmp(), v1 = files(tmp(), { "a.cls": "v1", "old.cls": "gone later" }), v2 = files(tmp(), { "a.cls": "v2" });
  try {
    saveKnownGood("orchestrator", { dirs: { classes: v1 } }, root);
    saveKnownGood("orchestrator", { dirs: { classes: v2 } }, root);
    const kg = readKnownGood("orchestrator", root);
    assert.equal(fs.readFileSync(path.join(kg.dirs.classes, "a.cls"), "utf8"), "v2");
    assert.ok(!fs.existsSync(path.join(kg.dirs.classes, "old.cls")));
    assert.throws(() => saveKnownGood("orchestrator", { dirs: { classes: path.join(root, "does-not-exist") } }, root));
    assert.equal(fs.readFileSync(path.join(readKnownGood("orchestrator", root).dirs.classes, "a.cls"), "utf8"), "v2");
  } finally { for (const d of [root, v1, v2]) fs.rmSync(d, { recursive: true, force: true }); }
});

test("no copy yet reads as null, and an unknown layer is refused", () => {
  const root = tmp();
  try {
    assert.equal(readKnownGood("ai", root), null);
    assert.throws(() => saveKnownGood("nope", { dirs: {} }, root), /layer/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("a copy never holds a secret: a meta value that looks like a credential is refused", () => {
  const root = tmp(), src = files(tmp(), { "a.cls": "x" });
  try {
    assert.throws(() => saveKnownGood("ai", { dirs: { classes: src }, meta: { note: "password=hunter2" } }, root), /credential/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(src, { recursive: true, force: true }); }
});

test("a rename that throws EPERM twice then succeeds saves the copy (transient Windows lock)", () => {
  const root = tmp(), src = files(tmp(), { "a.cls": "v1" });
  let calls = 0;
  const _rename = (from, to) => { if (++calls <= 2) throw Object.assign(new Error("EPERM"), { code: "EPERM" }); fs.renameSync(from, to); };
  try {
    saveKnownGood("ai", { dirs: { classes: src }, _rename }, root);
    assert.equal(fs.readFileSync(path.join(readKnownGood("ai", root).dirs.classes, "a.cls"), "utf8"), "v1");
    assert.ok(calls >= 3, `_rename must have been called at least 3 times, got ${calls}`);
  } finally { for (const d of [root, src]) fs.rmSync(d, { recursive: true, force: true }); }
});

test("a rename that always throws EPERM exhausts retries and the previous good copy is still readable", () => {
  const root = tmp(), v1 = files(tmp(), { "a.cls": "v1" }), v2 = files(tmp(), { "a.cls": "v2" });
  try {
    saveKnownGood("ai", { dirs: { classes: v1 } }, root);
    const _rename = () => { throw Object.assign(new Error("EPERM"), { code: "EPERM" }); };
    assert.throws(() => saveKnownGood("ai", { dirs: { classes: v2 }, _rename }, root));
    assert.equal(fs.readFileSync(path.join(readKnownGood("ai", root).dirs.classes, "a.cls"), "utf8"), "v1");
  } finally { for (const d of [root, v1, v2]) fs.rmSync(d, { recursive: true, force: true }); }
});

test("a non-retryable rename error (ENOENT) is thrown at once without retrying", () => {
  const root = tmp(), src = files(tmp(), { "a.cls": "v1" });
  let calls = 0;
  const _rename = () => { calls++; throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); };
  try {
    assert.throws(() => saveKnownGood("ai", { dirs: { classes: src }, _rename }, root), /ENOENT/);
    assert.equal(calls, 1);
  } finally { for (const d of [root, src]) fs.rmSync(d, { recursive: true, force: true }); }
});
