"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { angularFiles } = require("../lib/angular-app");
const { graph, rec, IM } = require("./helpers");
const { generate, writeSpecs, loadInputs, DEFAULT_PATHS } = require("../lib/specs");

const FIX = path.join(__dirname, "fixtures");
const goldenCfg = () => JSON.parse(fs.readFileSync(path.join(FIX, "golden-cfg.json"), "utf8"));
const goldenApp = () => JSON.parse(fs.readFileSync(path.join(FIX, "golden-app.json"), "utf8"));

const PHASE2_BLOCK = [
  '          <div class="oq"><h3>Ensuing workflows <span class="nb">Phase 2 · not in this build</span></h3>',
  '            <label *ngFor="let q of cfg.oq"><input type="checkbox" [(ngModel)]="model[q.k]"> {{q.label}}</label>',
  '            <div *ngIf="!cfg.oq.length" style="color:var(--dim);font-size:12.5px">No per-item decisions.</div>',
  "            <div *ngFor=\"let s of cfg.sideEffects\" style=\"font-size:12px;margin-top:4px\">{{s.deferred?'⏸ ':''}}{{s.name}} — {{s.disp}} <span class=\"nb\">Phase 2</span></div>",
  "          </div>",
].join("\n") + "\n";

test("angularFiles reproduces the pre-refactor generated app byte for byte, minus the Phase 2 block", () => {
  const golden = goldenApp();
  assert.deepEqual(angularFiles(goldenCfg()), { ...golden, "src/app/app.ts": golden["src/app/app.ts"].replace(PHASE2_BLOCK, "") });
});

test("the app built from the API spec equals the pre-refactor app minus the Phase 2 block", () => {
  const spec = generate({ graph, record: rec(), implemented: IM }).api;
  const { oq, sideEffects, ...kept } = goldenCfg();
  assert.deepEqual(spec.detail, kept);
  const golden = goldenApp();
  assert.ok(golden["src/app/app.ts"].includes(PHASE2_BLOCK), "golden contains the block being removed");
  const files = angularFiles(spec.detail);
  assert.equal(files["src/app/app.ts"], golden["src/app/app.ts"].replace(JSON.stringify(goldenCfg()), JSON.stringify(kept)).replace(PHASE2_BLOCK, ""));
  for (const f of ["src/main.ts", "src/index.html", "src/styles.css"]) assert.equal(files[f], golden[f]);
});

test("buildConfig reads a fresh API spec and refuses a stale one", () => {
  const { buildConfig } = require("../build-runner");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bc-"));
  const inputs = loadInputs(DEFAULT_PATHS);
  writeSpecs(dir, generate(inputs), inputs);
  assert.deepEqual(buildConfig(path.join(dir, "api.json")), generate(inputs).api.detail);
  const stale = path.join(dir, "stale.json");
  fs.writeFileSync(stale, JSON.stringify({ inputs: { graph: "old" }, detail: {} }));
  assert.throws(() => buildConfig(stale), /stale/);
});
