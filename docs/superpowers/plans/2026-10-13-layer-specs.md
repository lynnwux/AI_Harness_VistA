# Workbench Three Layer Specs (piece 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Decide stage's single browser-generated `spec.md` with three server-generated layer specs (API, Orchestrator, AI) built from one decisions record, and make the chat work through the orchestrator layer from a computed missing list.

**Architecture:** A pure generator (`agent/lib/specs/`) turns three input files — capability graph, decisions record, `implemented.json` — into `capability-graph/specs/<layer>.{json,md}`. Shared predicates live in `agent/lib/rules.js`; the record (load/atomic save/diff) in `agent/lib/record.js`. The chat tools write the record; the server regenerates specs after every chat turn and before every build; the page only displays. The Phase 1 build reads `specs/api.json`.

**Tech Stack:** Node 22.13.1 (CommonJS), Express 4, `node:test` + `node:assert/strict`, vanilla JS in `decide.html`. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-13-layer-specs-design.md`

## Before you start

- **Git:** this project is **not** a git repository. Ask the user whether to run `git init` before Task 1. If they decline, skip every "Commit" step.
- **Platform:** Windows with Git Bash. There is no `python`; use `node -e`. Use forward slashes in paths.
- **Live server:** the workbench runs on `http://localhost:8899` (`node agent/server.js`). To restart it:
  `PID=$(netstat -ano | grep ":8899" | grep LISTENING | awk '{print $5}' | head -1); [ -n "$PID" ] && taskkill //PID $PID //F` then start `node --env-file-if-exists=agent/.env agent/server.js` in the background. The VADEMO host and login come only from `agent/.env` (git-ignored; template `agent/.env.example`) — never put them in a committed file.
- Run tests from `agent/`: `cd agent && npm test` (all) or `node --test test/<file>.test.js` (one file).

## Global Constraints

- Decisions come only from the user in the front-end Decide chat. Never write `agent/decisions.json` from a development session; tests use temporary copies only.
- Dependencies point one way: the API spec is generated from the graph, the data-field dispositions (Phase 1 decisions) and `implemented.api` only — nothing else in the record may affect it.
- The legacy source and the data dictionary are the truth — never the `Vista-Engineering-IRIS` / `Equipment.*` prototype.
- Side effects the legacy calls unconditionally are mandatory in the production — discovery records `legacyInvocation: "unconditional"` with the citing lines (today only `SIDE.Bulletin`). They can never be dropped or deferred.
- No credentials or tokens in specs or records — they are Management Portal settings.
- The production deploys to container `iris-ai-hub`, namespace `INTEROP`.
- Do not modify `capability-graph/decide-classic.html`, `graph.html`, `map.html`, or `workbench-demo.html`.
- No new npm dependencies; Node built-ins only.
- Every chat reply passes the grounding guardrail (`agent/lib/grounding.js`, built ahead of this plan with `agent/test/grounding.test.js`): a reply that borrows another item's evidence, or states a threshold found in neither the item's evidence nor the developer's words, is retried once and otherwise shown with a ⚠. Keep it in the chat route; never bypass it.
- The chat's instructions contain no worked example drawn from a real item (real fields, routines, conditions) — the model transfers them to other items.

## Review Focus

1. **A corrupt or half-edited `decisions.json` at server start** — a person expects their decisions not to be silently wiped; the unreadable file is backed up before any fallback (test in Task 2).
2. **Re-resolving an already-decided question with a new policy** — a person expects field bindings made for the old wording to be cleared, not silently applied to the new rule (test in Task 8).
3. **A credential pasted into an allowed target field** (e.g. `recipients: "password=…"`) — a person expects it to be refused, not stored in a spec (test in Task 8).
4. **The model passing a field number as a number** (`7` instead of `"7"`) when binding — a person expects it to work and be stored as `"7"` (test in Task 8).
5. **The graph file edited while the server runs** — a person expects the next build to use it, not to be stuck forever with "spec is stale" (test in Task 9).

---

## File structure

| File | Responsibility |
|---|---|
| `agent/lib/angular-app.js` (new) | Angular source templates; `angularFiles(cfg)` → `{ relPath: content }` |
| `agent/lib/record.js` (new) | decisions record: normalize/migrate, load (corrupt-safe), atomic save, before/after diff |
| `agent/lib/rules.js` (new) | shared predicates: blocking, built, mandatory, target-key sets |
| `agent/lib/specs/api.js` (new) | API layer spec + markdown (graph + Phase 1 slice only) |
| `agent/lib/specs/orchestrator.js` (new) | Orchestrator layer spec + markdown, missing list, needs |
| `agent/lib/specs/ai.js` (new) | AI layer frame |
| `agent/lib/specs/index.js` (new) | `generate`, `render`, `writeSpecs`, `stage`, input hashes, `loadInputs`, default paths |
| `agent/lib/tools.js` (modify) | chat tools over the record; new `setTarget`, `bindRuleTerms`; mandatory refusals |
| `agent/lib/grounding.js` (exists — built ahead) | reply guardrail: `groundedTurn({ run, message, history, graph, record, currentId }) → { reply, toolTrace, grounding, evidence }`; per-item vocabulary from the graph |
| `agent/server.js` (modify) | `createApp()`; regenerate specs; `/api/specs`; chat returns `recorded`; PUT removed |
| `agent/build-runner.js` (modify) | importable; reads `specs/api.json` with a staleness guard |
| `agent/implemented.json` (new) | what exists and runs |
| `capability-graph/new-inventory-entry.json` (modify) | legacy evidence + `targetKind` on side effects |
| `capability-graph/decide.html` (replace) | single page: tabs, status line, decision cards, display only |
| `agent/test/*` (new) | tests, helpers, fixtures |

---

### Task 1: Make the build runner importable and extract the Angular generator

**Files:**
- Modify: `agent/package.json`
- Modify: `agent/build-runner.js`
- Create: `agent/lib/angular-app.js`
- Create (one-off, then delete): `agent/test/capture-golden.js`
- Create: `agent/test/fixtures/golden-cfg.json`, `agent/test/fixtures/golden-app.json` (generated)
- Test: `agent/test/angular-app.test.js`

**Interfaces:**
- Produces: `require("./lib/angular-app")` → `{ angularFiles(cfg) → { "src/main.ts", "src/index.html", "src/styles.css", "src/app/app.ts" }, DEFAULT_COMPONENT_FILES: string[] }`. `require("./build-runner")` → `{ buildConfig, angularFiles }` without starting a build.

- [ ] **Step 1: Add the test script**

In `agent/package.json`, change `"scripts"` to:

```json
  "scripts": {
    "start": "node --env-file-if-exists=.env server.js",
    "smoke": "node smoke.js",
    "test": "node --test test/*.test.js"
  },
```

- [ ] **Step 2: Make `build-runner.js` importable**

In `agent/build-runner.js`:

1. Replace the whole `function buildConfig(){ … }` (currently lines 71–83) with:

```js
function buildConfig(g, s){
  g = g || JSON.parse(fs.readFileSync(GRAPH,"utf8"));
  if(!s){ try{ s=JSON.parse(fs.readFileSync(DECISIONS,"utf8")); }catch(e){ s={}; } }
  const dec=s.dec||{}, scope=s.scope||{};
  const c=g.capabilities[0];
  const omit=new Set((c.data||[]).filter(d=>d.kind==="field"&&dec[d.id]==="Omit").map(d=>d.id));
  const byId=id=>(c.data||[]).find(d=>d.id===id);
  const pages=(c.formScreens||[]).filter(s=>s.fields&&s.fields.length).map(s=>({title:s.title,fields:s.fields.map(byId).filter(d=>d&&!omit.has(d.id)).map(fieldCfg)}));
  const OQ={"OQ.WorkOrderPolicy":"Create an incoming inspection work order?","OQ.PMEnrollmentPolicy":"Enroll the item in the PM program?","OQ.FAConfirmation":"Send the FA document to Austin once eligible?"};
  const oq=(c.openQuestions||[]).filter(q=>dec[q.id]==="Required input"&&OQ[q.id]).map(q=>({k:q.id,label:OQ[q.id]}));
  const sideEffects=(c.sideEffects||[]).filter(s=>dec[s.id]!=="Drop").map(s=>({name:s.name,disp:dec[s.id]||"",deferred:(scope[s.id]||"Build now")==="Defer"}));
  return {capability:c.name||"Register Equipment",command:"RegisterEquipment",pages,oq,sideEffects};
}
```

2. Replace the line `(async function(){` (start of the build IIFE) with `async function main(){`, and replace that IIFE's closing line `})();` with:

```js
}
if (require.main === module) main();
```

3. Replace the whole `function writeAngularApp(cfg){ … }` with:

```js
function angularFiles(cfg){
  return {
    "src/main.ts":
`import { bootstrapApplication } from '@angular/platform-browser';
import { App } from './app/app';
bootstrapApplication(App).catch(e => console.error(e));
`,
    "src/index.html":
`<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>${cfg.command} — build</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Bitter:wght@600;700&family=Source+Sans+3:wght@400;600;700&display=swap" rel="stylesheet">
</head><body><app-root></app-root></body></html>`,
    "src/styles.css": VA_CSS,
    "src/app/app.ts": APP_TS.replace("/*__CONFIG__*/", JSON.stringify(cfg)),
  };
}
const DEFAULT_COMPONENT_FILES = ["app.component.ts","app.component.html","app.component.css","app.component.spec.ts","app.config.ts","app.routes.ts"];
// remove default component files if present (avoid confusion; main.ts imports ./app/app)
function writeAngularApp(cfg){
  for (const [rel, content] of Object.entries(angularFiles(cfg))) fs.writeFileSync(path.join(APP, rel), content);
  const appDir = path.join(APP, "src", "app");
  DEFAULT_COMPONENT_FILES.forEach(f=>{ try{ fs.rmSync(path.join(appDir,f),{force:true}); }catch(e){} });
}
```

4. Append at the end of the file:

```js
module.exports = { buildConfig, angularFiles };
```

- [ ] **Step 3: Confirm requiring it does not start a build**

Run: `node -e "require('./agent/build-runner'); console.log('loaded, no build')"`
Expected: prints `loaded, no build` and exits; `agent/build-status.json` is unchanged.

- [ ] **Step 4: Capture today's generated app as the golden reference**

Create `agent/test/capture-golden.js`:

```js
"use strict";
// One-off: records today's generated Angular app as the golden reference for later refactors.
const fs = require("fs");
const path = require("path");
const { buildConfig, angularFiles } = require("../build-runner");
const { defaultDecisions } = require("../lib/tools");
const graph = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "capability-graph", "new-inventory-entry.json"), "utf8"));
const cfg = buildConfig(graph, defaultDecisions(graph));
const dir = path.join(__dirname, "fixtures");
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, "golden-cfg.json"), JSON.stringify(cfg, null, 2));
fs.writeFileSync(path.join(dir, "golden-app.json"), JSON.stringify(angularFiles(cfg), null, 2));
console.log("golden captured:", Object.keys(angularFiles(cfg)).join(", "));
```

Run: `node agent/test/capture-golden.js`
Expected: `golden captured: src/main.ts, src/index.html, src/styles.css, src/app/app.ts`

Then delete the script: `rm agent/test/capture-golden.js`

- [ ] **Step 5: Write the failing test**

Create `agent/test/angular-app.test.js`:

```js
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
```

- [ ] **Step 6: Run it to verify it fails**

Run: `cd agent && node --test test/angular-app.test.js`
Expected: FAIL — `Cannot find module '../lib/angular-app'`

- [ ] **Step 7: Move the generator into `agent/lib/angular-app.js`**

Create `agent/lib/angular-app.js` with this header:

```js
"use strict";
// Angular source for the Phase 1 data-entry app, generated from the API spec's build config.
```

then **move** (cut from `build-runner.js`, paste here, unchanged) the `const VA_CSS = \`…\`;` block, the `const APP_TS = \`…\`;` block, and the `angularFiles` function and `DEFAULT_COMPONENT_FILES` constant from Step 2. End the file with:

```js
module.exports = { angularFiles, DEFAULT_COMPONENT_FILES };
```

In `build-runner.js`, add near the other `require`s at the top:

```js
const { angularFiles, DEFAULT_COMPONENT_FILES } = require("./lib/angular-app");
```

`writeAngularApp` and `module.exports = { buildConfig, angularFiles };` stay in `build-runner.js`.

- [ ] **Step 8: Run the test and the import check**

Run: `cd agent && node --test test/angular-app.test.js` → Expected: PASS
Run: `node -e "require('./agent/build-runner'); console.log('ok')"` → Expected: `ok`

- [ ] **Step 9: Commit**

```bash
git add agent/package.json agent/build-runner.js agent/lib/angular-app.js agent/test/angular-app.test.js agent/test/fixtures/golden-cfg.json agent/test/fixtures/golden-app.json
git commit -m "refactor: make build runner importable and extract the Angular generator"
```

---

### Task 2: The decisions record module

**Files:**
- Create: `agent/lib/record.js`
- Test: `agent/test/record.test.js`

**Interfaces:**
- Produces: `normalize(raw) → { dec, oqPolicy, scope, targets, ruleBindings }` (migrates a legacy `integration` map into `targets`); `loadRecord(file, fallbackFn?) → record` (backs up an unparseable file as `<name>.corrupt-<timestamp>.json` before falling back); `saveRecord(file, record)` (temp file + rename); `diffRecords(before, after, labelOf?) → [{ id, label, field, before, after }]` sorted, `field` is `dec | oqPolicy | scope | targets.<key> | ruleBindings.<key>` (an empty map records as key `(none)`).

- [ ] **Step 1: Write the failing tests**

Create `agent/test/record.test.js`:

```js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { normalize, loadRecord, saveRecord, diffRecords } = require("../lib/record");

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "rec-"));

test("normalize moves the legacy integration map into targets and fills every section", () => {
  const r = normalize({ dec: { a: 1 }, integration: { "SIDE.PMSchedule": { system: "Jira" } } });
  assert.deepEqual(r, { dec: { a: 1 }, oqPolicy: {}, scope: {}, targets: { "SIDE.PMSchedule": { system: "Jira" } }, ruleBindings: {} });
});

test("loadRecord falls back when the file is missing", () => {
  const r = loadRecord(path.join(tmp(), "missing.json"), () => ({ dec: { x: "Defer" } }));
  assert.equal(r.dec.x, "Defer");
  assert.deepEqual(r.targets, {});
});

test("loadRecord backs up an unreadable record before falling back", () => {
  const dir = tmp(); const f = path.join(dir, "decisions.json");
  fs.writeFileSync(f, "{not json");
  const r = loadRecord(f, () => ({ dec: { x: "Defer" } }));
  assert.equal(r.dec.x, "Defer");
  const bak = fs.readdirSync(dir).find(n => /^decisions\.corrupt-.*\.json$/.test(n));
  assert.ok(bak, "backup file written");
  assert.equal(fs.readFileSync(path.join(dir, bak), "utf8"), "{not json");
});

test("saveRecord replaces the file atomically and leaves no temp file", () => {
  const dir = tmp(); const f = path.join(dir, "decisions.json");
  fs.writeFileSync(f, "{\"dec\":{}}");
  saveRecord(f, normalize({ dec: { y: "Include" } }));
  assert.equal(JSON.parse(fs.readFileSync(f, "utf8")).dec.y, "Include");
  assert.deepEqual(fs.readdirSync(dir), ["decisions.json"]);
});

test("diffRecords lists exactly what changed, per field and per target key", () => {
  const before = normalize({ dec: { "OQ.A": "Defer", "SIDE.B": "Event" }, targets: { "SIDE.B": { via: "iris" } } });
  const after = normalize({
    dec: { "OQ.A": "Business rule", "SIDE.B": "Event" }, oqPolicy: { "OQ.A": "rule text" },
    targets: { "SIDE.B": { via: "iris", channel: "email" } }, ruleBindings: { "OQ.A": { cost: "12" } },
  });
  assert.deepEqual(diffRecords(before, after, id => "L:" + id), [
    { id: "OQ.A", label: "L:OQ.A", field: "dec", before: "Defer", after: "Business rule" },
    { id: "OQ.A", label: "L:OQ.A", field: "oqPolicy", before: null, after: "rule text" },
    { id: "OQ.A", label: "L:OQ.A", field: "ruleBindings.cost", before: null, after: "12" },
    { id: "SIDE.B", label: "L:SIDE.B", field: "targets.channel", before: null, after: "email" },
  ]);
  assert.deepEqual(diffRecords(after, after), []);
});

test("diffRecords shows an empty binding map as an explicit change", () => {
  const d = diffRecords(normalize({}), normalize({ ruleBindings: { "OQ.A": {} } }));
  assert.deepEqual(d, [{ id: "OQ.A", label: "OQ.A", field: "ruleBindings.(none)", before: null, after: "(none)" }]);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd agent && node --test test/record.test.js`
Expected: FAIL — `Cannot find module '../lib/record'`

- [ ] **Step 3: Implement `agent/lib/record.js`**

```js
"use strict";
// The decisions record: load (with migration), atomic save, and a before/after diff that
// drives the page's decision cards. The record is written only by the chat tools.
const fs = require("fs");

const SECTIONS = ["dec", "oqPolicy", "scope", "targets", "ruleBindings"];

function normalize(raw) {
  const src = raw || {};
  const r = {};
  for (const k of SECTIONS) r[k] = src[k] && typeof src[k] === "object" ? src[k] : {};
  if (src.integration && typeof src.integration === "object" && !src.targets) r.targets = src.integration;
  return r;
}

function loadRecord(file, fallback) {
  let text;
  try { text = fs.readFileSync(file, "utf8"); }
  catch (e) { return normalize(fallback ? fallback() : {}); }
  try { return normalize(JSON.parse(text)); }
  catch (e) {
    // never silently discard the user's decisions: keep the unreadable file before falling back
    const bak = file.replace(/\.json$/, "") + ".corrupt-" + new Date().toISOString().replace(/[:.]/g, "-") + ".json";
    fs.writeFileSync(bak, text);
    return normalize(fallback ? fallback() : {});
  }
}

function saveRecord(file, record) {
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(record, null, 2));
  fs.renameSync(tmp, file);
}

function flat(record) {
  const out = {};
  for (const k of ["dec", "oqPolicy", "scope"]) for (const [id, v] of Object.entries(record[k] || {})) out[`${k}|${id}`] = v;
  for (const k of ["targets", "ruleBindings"]) for (const [id, obj] of Object.entries(record[k] || {})) {
    const entries = Object.entries(obj || {});
    if (!entries.length) out[`${k}|${id}|(none)`] = "(none)";
    for (const [key, v] of entries) out[`${k}|${id}|${key}`] = v;
  }
  return out;
}

function diffRecords(before, after, labelOf) {
  const a = flat(before), b = flat(after);
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()
    .filter(k => JSON.stringify(a[k]) !== JSON.stringify(b[k]))
    .map(k => {
      const [field, id, key] = k.split("|");
      return { id, label: labelOf ? labelOf(id) : id, field: key ? `${field}.${key}` : field, before: k in a ? a[k] : null, after: k in b ? b[k] : null };
    });
}

module.exports = { SECTIONS, normalize, loadRecord, saveRecord, diffRecords };
```

- [ ] **Step 4: Run the tests**

Run: `cd agent && node --test test/record.test.js`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add agent/lib/record.js agent/test/record.test.js
git commit -m "feat: decisions record with corrupt-safe load, atomic save and diff"
```

---

### Task 3: Legacy evidence and the bulletin template in the graph; implemented services

**Files:**
- Modify: `capability-graph/new-inventory-entry.json` (via a one-off script)
- Create: `agent/implemented.json`
- Test: `agent/test/graph-evidence.test.js`

**Interfaces:**
- Produces: every `capabilities[0].sideEffects[i]` has `targetKind` (`vistaWrite | notification`) and `legacyEvidence: [{ routine, line, says }]`; `SIDE.WorkOrder.writes.file = 6920`, `SIDE.PMSchedule.writes.file = "6914.04"`, `SIDE.FinancialAsset.writes.file = "6915.2"`; every side effect has `legacyInvocation` (`"unconditional"` only for `SIDE.Bulletin`); `SIDE.Bulletin.messageTemplate = { source, sender, subject, body: string[9], params: [{ n, value, ifBlank?, dependsOn? }] (n = 1…7), recipients }`. `implemented.json = { api: [{ id, endpoint, what }], orchestrator: { built, verified } }`.

- [ ] **Step 1: Write the failing tests**

Create `agent/test/graph-evidence.test.js`:

```js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const graph = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "capability-graph", "new-inventory-entry.json"), "utf8"));
const c = graph.capabilities[0];

test("every side effect carries a target kind and source-cited legacy evidence", () => {
  for (const se of c.sideEffects) {
    assert.ok(["vistaWrite", "notification", "external"].includes(se.targetKind), se.id + " targetKind");
    assert.ok(Array.isArray(se.legacyEvidence) && se.legacyEvidence.length > 0, se.id + " evidence");
    for (const e of se.legacyEvidence) assert.ok(e.routine && e.line && e.says, se.id + " evidence entry");
  }
});

test("side effects that write VistA files declare the file", () => {
  const w = Object.fromEntries(c.sideEffects.filter(s => s.writes).map(s => [s.id, String(s.writes.file)]));
  assert.deepEqual(w, { "SIDE.WorkOrder": "6920", "SIDE.PMSchedule": "6914.04", "SIDE.FinancialAsset": "6915.2" });
});

test("no legacy evidence mentions a dollar threshold", () => {
  assert.doesNotMatch(JSON.stringify(c.sideEffects), /50,?000/);
});

test("the serial guidance states the canonical key as ASKSER builds it", () => {
  const serial = c.data.find(d => d.id === "FLD.serial");
  assert.match(serial.legacyInput, /one trailing space appended, cut to 30 characters/);
  assert.doesNotMatch(serial.legacyInput, /UPPERCASE/);
});

test("discovery marks only the bulletin as called unconditionally, citing the call sites", () => {
  const inv = Object.fromEntries(c.sideEffects.map(s => [s.id, s.legacyInvocation]));
  assert.deepEqual(inv, { "SIDE.WorkOrder": "conditional", "SIDE.PMSchedule": "conditional", "SIDE.FinancialAsset": "conditional", "SIDE.Bulletin": "unconditional" });
  const b = c.sideEffects.find(s => s.id === "SIDE.Bulletin");
  assert.ok(b.legacyEvidence.some(e => e.routine === "ENEQ1" && /D BULL\^ENEQ3/.test(e.says)));
  assert.ok(b.legacyEvidence.some(e => e.routine === "ENEQ3" && /EQMAS/.test(e.line)));
});

test("the bulletin carries the legacy message template from BULLETIN file 3.6", () => {
  const t = c.sideEffects.find(s => s.id === "SIDE.Bulletin").messageTemplate;
  assert.equal(t.subject, "NEW EQUIPMENT: ENTRY #|1|");
  assert.equal(t.sender, "AEMS/MERS");
  assert.equal(t.body.length, 9);
  assert.equal(t.body[8], "|7|");
  assert.deepEqual(t.params.map(p => p.n), [1, 2, 3, 4, 5, 6, 7]);
  assert.equal(t.params.find(p => p.n === 7).dependsOn, "SIDE.FinancialAsset");
  assert.equal(t.params.find(p => p.n === 2).dependsOn, "operatorIdentity");
  assert.match(t.recipients, /CLICKAAH/);
});

test("the implemented-services file has the expected shape", () => {
  const im = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "implemented.json"), "utf8"));
  assert.deepEqual(im.api.map(s => s.id), ["write:6914", "read:next-ien", "read:lookup"]);
  assert.deepEqual(im.orchestrator, { built: false, verified: false });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd agent && node --test test/graph-evidence.test.js`
Expected: FAIL — `SIDE.WorkOrder targetKind` (and missing files)

- [ ] **Step 3: Add the evidence to the graph**

Create `agent/add-evidence.tmp.js`:

```js
"use strict";
// One-off: records legacy evidence read from the routine source on VADEMO (2026-10-13).
const fs = require("fs");
const P = "capability-graph/new-inventory-entry.json";
const src = fs.readFileSync(P, "utf8");
const g = JSON.parse(src);
const c = g.capabilities[0];
const set = (id, patch) => { const s = c.sideEffects.find(x => x.id === id); if (!s) throw new Error("missing " + id); Object.assign(s, patch); };

set("SIDE.WorkOrder", {
  targetKind: "vistaWrite",
  legacyInvocation: "conditional",
  legacyEvidence: [
    { routine: "ENEQ1", line: "ADDEQ", says: "The work-order prompt appears only if site parameter ASK INCOMING INSPECTION W.O. (file 6910.2) exists with piece 2 set; the default answer is YES when piece 2 = 2, otherwise NO. On YES it calls IIWO^ENWONEW3(ENNXL)." },
    { routine: "ENWONEW3", line: "IIWO (line 5)", says: "Shop: the site's incoming-inspection section (^DIC(6910,1,0) piece 13), else the item's responsible shop (^ENG(6914,ien,4)), else the temporary work-order section (piece 6). The clerk is asked if it is still blank or if they hold key ENEDPM (non-holders are restricted to receiving areas). No shop means no work order." },
    { routine: "ENWONEW3", line: "IIWO", says: "Creates the work order via WONUM^ENWONEW and WOFILL^ENWONEW, then files: 6 = Incoming Inspection, 17 = AVERAGE, 32 = PENDING for receiving shops (shop #100 > 89) else IN PROGRESS, 10 = TODAY for receiving shops, sub-file 6920.035 .01 = I1, 18 = the equipment IEN, 3 = the item's LOCATION (6914 fld 24)." },
    { routine: "ENWONEW3", line: "IIWO", says: "Clerk-entered fields: 16 technician (defaulted from the item's responsible technician), 7 contact, 8 phone, 40 comments." },
  ],
});
set("SIDE.PMSchedule", {
  targetKind: "vistaWrite",
  legacyInvocation: "conditional",
  writes: { file: "6914.04", global: "^ENG(6914,ien,4,*)", access: "create" },
  legacyEvidence: [
    { routine: "ENEQ1", line: "ADDEQ", says: "Shown only to holders of key ENEDPM: 'Would you like to include this item in the PM program' (default YES). On YES it runs DINV^ENEQPMP3 when a PM schedule already exists, then XNPMSE^ENEQPMP." },
    { routine: "ENEQPMP", line: "lines 12–34", says: "Reads the item's EQUIPMENT CATEGORY (6914 node 1 piece 1). If that category has a standard PM schedule (^ENG(6911,cat,4)) the clerk is offered it and, on acceptance, it is copied onto the item (^ENG(6914,ien,4)). There is no asset-value or capitalization condition." },
  ],
});
set("SIDE.FinancialAsset", {
  targetKind: "vistaWrite",
  legacyInvocation: "conditional",
  writes: { file: "6915.2", global: "^ENG(6915.2,*)", access: "create" },
  legacyEvidence: [
    { routine: "ENEQ1", line: "ADDEQ", says: "Legacy POLICY: capitalized NX equipment is reported to FAP. Mechanism: for TYPE OF ENTRY = NX and INVESTMENT CATEGORY = 1 (CAPITALIZED/ACCOUNTABLE), the clerk holding key ENFACS is asked 'Do you wish to send an FA document to Austin' with default YES; YES runs ^ENFAACQ. Override: a NO — the bulletin then flags 'It was NOT reported to FAP' and the item can be reported later." },
    { routine: "DD 6914", line: "fld 61 BUDGET OBJECT CODE", says: "Only capitalized assets are to be recorded in the Fixed Assets Package." },
    { routine: "ENFAACQ", line: "VALEQ (line 32)", says: "Validates the equipment via ^ENFAVAL into temporary global ^TMP($J,\"BAD\",ien); any problem aborts with 'No action taken. Database unchanged.'" },
    { routine: "ENFAACQ", line: "ADDFA (line 37)", says: "Creates an FA DOCUMENT LOG entry in file 6915.2 (field 1 = NOW, 1.5 = DUZ)." },
    { routine: "ENFAACQ", line: "UPDATE (line 59)", says: "Updates the equipment record: fills STATION NUMBER (node 9 piece 5) from the FA site if blank, normalizes TOTAL ASSET VALUE (fld 12, node 2 piece 3) to two decimals, defaults day 01 on acquisition and replacement dates; stores TOTAL ASSET VALUE on the code sheet (^ENG(6915.2,ien,200)) and adjusts the FAP balance (ADJBAL^ENFABAL)." },
    { routine: "ENFAACQ", line: "UPDATE (line 83)", says: "Transmits the code sheet to FAP via ^ENFAXMT; an adjustment voucher may also be created ($$AVP^ENFAAV)." },
  ],
});
set("SIDE.Bulletin", {
  targetKind: "notification",
  legacyInvocation: "unconditional",
  legacyEvidence: [
    { routine: "ENEQ1", line: "ADDEQ", says: "S DA=ENNXL D BULL^ENEQ3 — runs unconditionally after every new entry." },
    { routine: "ENEQ3", line: "EQMAS (line 56)", says: "S DA=ENNXL D BULL — the multiple-entry copy also sends it unconditionally for every additional item." },
    { routine: "ENEQ3", line: "BULL (line 60)", says: "Recipients: mail group 'EN NEW EQUIPMENT <station number>' if it exists with at least one member (CHKMGRP, MAIL GROUP file 3.8), otherwise 'EN NEW EQUIPMENT' on the same test. If neither qualifies, no bulletin is sent and nothing is reported." },
    { routine: "ENEQ3", line: "BULL", says: "Sends MailMan bulletin EN NEW EQUIPMENT from sender AEMS/MERS with: 1 equipment IEN, 2 the entering user's name (from DUZ), 3 MFGR. EQUIPMENT NAME (node 0 piece 2), 4 category, 5 service, 6 station number, 7 'Item is [NOT] capitalized NX.' plus, when capitalized NX, 'It was [NOT] reported to FAP.' Missing 4–6 are sent as MISSING." },
    { routine: "XMB", line: "lines 12–16", says: "MailMan delivers a bulletin to the XMY recipients the caller sets AND to the members of the mail groups listed on the bulletin's own entry in file 3.6." },
  ],
  // the legacy email, read from BULLETIN file 3.6 entry EN NEW EQUIPMENT (IEN 114) on VADEMO, 2026-10-14
  messageTemplate: {
    source: "BULLETIN file 3.6 · EN NEW EQUIPMENT (IEN 114)",
    sender: "AEMS/MERS",
    subject: "NEW EQUIPMENT: ENTRY #|1|",
    body: [
      "A new equipment record has been added to the AEMS/MERS database.",
      "The ENTRY NUMBER is |1|.",
      "It was entered by |2|.",
      "The MFGR EQUIPMENT NAME is |3|.",
      "The EQUIPMENT CATEGORY is |4|.",
      "The SERVICE is |5|.",
      "The STATION NUMBER is |6|.",
      "",
      "|7|",
    ],
    params: [
      { n: 1, value: "the equipment IEN (ENTRY NUMBER, fld .01)" },
      { n: 2, value: "the entering user's name — NEW PERSON (file 200) .01 for DUZ", dependsOn: "operatorIdentity" },
      { n: 3, value: "MFGR. EQUIPMENT NAME (fld 3, node 0 piece 2)" },
      { n: 4, value: "the EQUIPMENT CATEGORY name (fld 6 → file 6911)", ifBlank: "MISSING" },
      { n: 5, value: "the SERVICE POINTER name (fld 21, node 3 piece 2 → file 49)", ifBlank: "MISSING" },
      { n: 6, value: "STATION NUMBER (fld 60), else the site default (file 6910 fld 1)", ifBlank: "MISSING" },
      { n: 7, value: "ENEQ3 lines 92–96: 'Item is [NOT] capitalized NX.' (capitalized NX = TYPE OF ENTRY = NX and INVESTMENT CATEGORY = 1); for capitalized NX items adds 'It was [NOT] reported to FAP.' from $$CHKFA^ENFAUTL (an FA document exists)", dependsOn: "SIDE.FinancialAsset" },
    ],
    recipients: "members of mail group 'EN NEW EQUIPMENT <station>' if it has any, otherwise 'EN NEW EQUIPMENT' (CHKMGRP), plus the members of the groups listed on the bulletin itself (XMB lines 12–16): CLICKAAH. Nothing is sent if neither EN group qualifies.",
  },
});

const serial = c.data.find(d => d.id === "FLD.serial");
serial.legacyInput = "OPTIONAL — ASKSER lets the clerk press <return> to skip. On a matching canonical serial (FC index: uppercased, spaces and punctuation stripped, one trailing space appended, cut to 30 characters) it lists existing matches and asks to reconfirm (default NO); a duplicate is ALLOWED on override. Not enforced-unique.";

fs.writeFileSync(P, JSON.stringify(g, null, 2) + (src.endsWith("\n") ? "\n" : ""));
console.log("evidence recorded on", c.sideEffects.map(s => s.id).join(", "));
```

Run: `node agent/add-evidence.tmp.js`
Expected: `evidence recorded on SIDE.WorkOrder, SIDE.PMSchedule, SIDE.FinancialAsset, SIDE.Bulletin`

Then: `rm agent/add-evidence.tmp.js`

- [ ] **Step 4: Create the implemented-services file**

`agent/implemented.json`:

```json
{
  "api": [
    { "id": "write:6914", "endpoint": "POST /equipment", "what": "create a file-6914 record; body = the request contract; returns { status, equipmentIEN, lifecycleStatus }" },
    { "id": "read:next-ien", "endpoint": "GET /equipment/next-ien", "what": "returns { status, ien } — shown display-only; the POST allocates authoritatively" },
    { "id": "read:lookup", "endpoint": "GET /lookup/{file}?q=", "what": "pointer-file search; returns { items: [{ ien, display }], total }; &all=1 returns every row" }
  ],
  "orchestrator": { "built": false, "verified": false }
}
```

- [ ] **Step 5: Run the tests**

Run: `cd agent && node --test test/graph-evidence.test.js test/angular-app.test.js`
Expected: PASS (the Angular golden still passes — pages do not depend on side-effect or serial-guidance fields)

- [ ] **Step 6: Commit**

```bash
git add capability-graph/new-inventory-entry.json agent/implemented.json agent/test/graph-evidence.test.js
git commit -m "feat: record legacy evidence, invocation and the bulletin template for every side effect; add implemented services"
```

---

### Task 4: Shared rules

**Files:**
- Create: `agent/lib/rules.js`
- Create: `agent/test/helpers.js`
- Test: `agent/test/rules.test.js`

**Interfaces:**
- Consumes: `normalize` (Task 2); graph `targetKind` (Task 3).
- Produces: `TARGET_KEYS`, `VIA = ["vista","iris","external"]`, `cap(graph)`, `isBlocking(record, oqId) → bool` (true when `oqPolicy[oqId]` is empty), `isMandatory(se)` (true when discovery marked it `legacyInvocation: "unconditional"`), `kindFor(se, record)`, `requiredTargetKeys(se, record) → ["via", …]`, `allowedTargetKeys(se, record)`, `describeKey(se, record, key) → string`, `isBuilt(se, record) → bool`. Test helpers: `{ graph, IM, rec(patch), se(id) }`.

- [ ] **Step 1: Create the test helpers**

Create `agent/test/helpers.js`:

```js
"use strict";
const fs = require("fs");
const path = require("path");
const { defaultDecisions } = require("../lib/tools");
const { normalize } = require("../lib/record");

const graph = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "capability-graph", "new-inventory-entry.json"), "utf8"));
const IM = {
  api: [
    { id: "write:6914", endpoint: "POST /equipment", what: "create a file-6914 record" },
    { id: "read:next-ien", endpoint: "GET /equipment/next-ien", what: "next IEN, display-only" },
    { id: "read:lookup", endpoint: "GET /lookup/{file}?q=", what: "pointer-file search" },
  ],
  orchestrator: { built: false, verified: false },
};
// a fresh, normalized default record with sections patched in, e.g. rec({ dec: { … }, oqPolicy: { … } })
function rec(patch) {
  const r = normalize(JSON.parse(JSON.stringify(defaultDecisions(graph))));
  for (const [k, v] of Object.entries(patch || {})) Object.assign(r[k], v);
  return r;
}
const se = id => graph.capabilities[0].sideEffects.find(s => s.id === id);

module.exports = { graph, IM, rec, se };
```

- [ ] **Step 2: Write the failing tests**

Create `agent/test/rules.test.js`:

```js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { rec, se } = require("./helpers");
const R = require("../lib/rules");

test("an untouched question blocks; a recorded Defer reason does not; an empty policy blocks", () => {
  assert.equal(R.isBlocking(rec(), "OQ.PMEnrollmentPolicy"), true);
  assert.equal(R.isBlocking(rec({ oqPolicy: { "OQ.PMEnrollmentPolicy": "Deferred — later phase" } }), "OQ.PMEnrollmentPolicy"), false);
  assert.equal(R.isBlocking(rec({ dec: { "OQ.WorkOrderPolicy": "Business rule" }, oqPolicy: { "OQ.WorkOrderPolicy": "  " } }), "OQ.WorkOrderPolicy"), true);
});

test("a side effect is built only once its gating question is decided with a non-Defer mode", () => {
  assert.equal(R.isBuilt(se("SIDE.WorkOrder"), rec(), false);
  assert.equal(R.isBuilt(se("SIDE.WorkOrder"), rec({ dec: { "OQ.WorkOrderPolicy": "Business rule" }, oqPolicy: { "OQ.WorkOrderPolicy": "always" } }), true);
  assert.equal(R.isBuilt(se("SIDE.WorkOrder"), rec({ oqPolicy: { "OQ.WorkOrderPolicy": "later" } }), false);
});

test("the mandatory bulletin is always built unless dropped", () => {
  assert.equal(R.isBuilt(se("SIDE.Bulletin"), rec({ scope: { "SIDE.Bulletin": "Defer" } }), true);
  assert.equal(R.isBuilt(se("SIDE.Bulletin"), rec({ dec: { "SIDE.Bulletin": "Drop" } }), false);
});

test("target keys follow the graph's targetKind, or the external set when the disposition is Integration", () => {
  assert.deepEqual(R.requiredTargetKeys(se("SIDE.Bulletin"), rec()), ["via", "channel", "recipients", "content"]);
  assert.deepEqual(R.requiredTargetKeys(se("SIDE.WorkOrder"), rec()), ["via", "writePath", "fields", "operatorValues"]);
  const asIntegration = rec({ dec: { "SIDE.PMSchedule": "Integration" } });
  assert.deepEqual(R.requiredTargetKeys(se("SIDE.PMSchedule"), asIntegration), ["via", "system", "endpoint", "trigger", "mapping"]);
  assert.ok(R.allowedTargetKeys(se("SIDE.PMSchedule"), asIntegration).includes("settings"));
  assert.equal(R.describeKey(se("SIDE.Bulletin"), rec(), "via"), "where the work is performed (vista | iris | external)");
});
```

- [ ] **Step 3: Run to verify they fail**

Run: `cd agent && node --test test/rules.test.js`
Expected: FAIL — `Cannot find module '../lib/rules'`

- [ ] **Step 4: Implement `agent/lib/rules.js`**

```js
"use strict";
// Shared predicates over the decisions record — one definition, used by the spec generator and the tools.
const TARGET_KEYS = {
  vistaWrite:   { writePath: "how the write is performed", fields: "which fields and values are written", operatorValues: "where the values the clerk used to type now come from" },
  notification: { channel: "delivery channel", recipients: "who receives it (no default)", content: "what it contains" },
  external:     { system: "external system", endpoint: "endpoint called", trigger: "when it is called", mapping: "field mapping" },
};
const OPTIONAL_KEYS = { external: ["settings"] };
const VIA = ["vista", "iris", "external"];
const VIA_HELP = "where the work is performed (vista | iris | external)";

const cap = graph => graph.capabilities[0];
const isBlocking = (record, oqId) => !String((record.oqPolicy || {})[oqId] || "").trim();
const isMandatory = se => !!se && se.legacyInvocation === "unconditional";   // discovery: the legacy always calls it
const kindFor = (se, record) => (record.dec[se.id] === "Integration" ? "external" : se.targetKind || null);
const requiredTargetKeys = (se, record) => { const k = kindFor(se, record); return ["via", ...(k ? Object.keys(TARGET_KEYS[k]) : [])]; };
const allowedTargetKeys = (se, record) => { const k = kindFor(se, record); return [...requiredTargetKeys(se, record), ...((k && OPTIONAL_KEYS[k]) || [])]; };
const describeKey = (se, record, key) => (key === "via" ? VIA_HELP : (TARGET_KEYS[kindFor(se, record)] || {})[key] || key);

// built = carried into this build: not dropped, not deferred, and its gating question (if any)
// decided with a non-Defer mode. Mandatory items are always built.
function isBuilt(se, record) {
  if (record.dec[se.id] === "Drop") return false;
  if (isMandatory(se)) return true;
  if ((record.scope[se.id] || "Build now") === "Defer") return false;
  if (se.openQuestion) return !isBlocking(record, se.openQuestion) && record.dec[se.openQuestion] !== "Defer";
  return true;
}

module.exports = { TARGET_KEYS, VIA, cap, isBlocking, isMandatory, kindFor, requiredTargetKeys, allowedTargetKeys, describeKey, isBuilt };
```

- [ ] **Step 5: Run the tests**

Run: `cd agent && node --test test/rules.test.js`
Expected: PASS (4 tests)

- [ ] **Step 6: Commit**

```bash
git add agent/lib/rules.js agent/test/helpers.js agent/test/rules.test.js
git commit -m "feat: shared rules for blocking, built, mandatory and target keys"
```

---

### Task 5: The API layer spec

**Files:**
- Create: `agent/lib/specs/api.js`
- Create: `agent/test/fixtures/spec-phase1.md` (extracted from today's `capability-graph/spec.md`)
- Test: `agent/test/spec-api.test.js`

**Interfaces:**
- Consumes: `cap` (Task 4).
- Produces: `dataSlice(graph, record) → { [dataNodeId]: disposition }`; `requestContract(graph, record) → [{ id, field, name }]`; `buildApiSpec(graph, record, implemented) → { layer:"api", builds, owns:{ built, proposed:[{ id, what, source }] }, uses, needs, missing, complete, request, detail:{ capability, command, pages } }`; `renderApi(graph, record, spec) → markdown`. **Both functions read only `dataSlice` of the record.**

- [ ] **Step 1: Freeze today's Phase 1 text as a fixture**

`capability-graph/spec.md` holds Phase 1 front-end rules the browser generator never learned (left-rail panel, option-label rule, `?all=1`). Extract its Phase 1 lines so the new renderer is held to them:

```bash
node -e "const fs=require('fs'); const L=fs.readFileSync('capability-graph/spec.md','utf8').split('\n'); const keep=[[12,73],[97,157],[160,172],[174,181],[183,185],[191,191],[193,194]]; fs.writeFileSync('agent/test/fixtures/spec-phase1.md', keep.flatMap(([a,b])=>L.slice(a-1,b)).join('\n')+'\n');"
```

Check: `head -3 agent/test/fixtures/spec-phase1.md` shows `## Phase 1 · Command & REST contract`.

- [ ] **Step 2: Write the failing tests**

Create `agent/test/spec-api.test.js`:

```js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { graph, rec, IM } = require("./helpers");
const { buildApiSpec, renderApi } = require("../lib/specs/api");

test("the API spec's detail is the Angular build config from the graph and data-field decisions", () => {
  const spec = buildApiSpec(graph, rec(), IM);
  assert.equal(spec.layer, "api");
  assert.equal(spec.detail.command, "RegisterEquipment");
  assert.deepEqual(spec.detail.pages.map(p => p.title), ["Equipment Identity & Acquisition", "Ownership & Location", "Financial"]);
  assert.equal(spec.detail.pages.flatMap(p => p.fields).length, 35);
});

test("omitting a field removes it from the pages and the request contract", () => {
  const spec = buildApiSpec(graph, rec({ dec: { "FLD.serial": "Omit" } }), IM);
  assert.ok(!spec.detail.pages.flatMap(p => p.fields).some(f => f.k === "serial"));
  assert.ok(!spec.request.some(f => f.id === "FLD.serial"));
});

test("discovery proposes a service for every legacy write that is not built", () => {
  assert.deepEqual(buildApiSpec(graph, rec(), IM).owns.proposed.map(p => p.id), ["write:6920", "write:6914.04", "write:6915.2"]);
  const im2 = { ...IM, api: [...IM.api, { id: "write:6920", endpoint: "POST /work-orders", what: "x" }] };
  assert.deepEqual(buildApiSpec(graph, rec(), im2).owns.proposed.map(p => p.id), ["write:6914.04", "write:6915.2"]);
});

test("the API markdown carries every Phase 1 line of the retired spec.md", () => {
  const md = renderApi(graph, rec(), buildApiSpec(graph, rec(), IM)).split("\n");
  const expected = fs.readFileSync(path.join(__dirname, "fixtures", "spec-phase1.md"), "utf8")
    .split("\n").filter(l => l.trim() && !/UPPERCASE/.test(l));
  assert.deepEqual(expected.filter(l => !md.includes(l)), []);
});

test("the API markdown states the canonical serial as ASKSER builds it and carries no Phase 2/3 content", () => {
  const md = renderApi(graph, rec(), buildApiSpec(graph, rec(), IM));
  assert.match(md, /one trailing space appended, cut to 30 characters/);
  assert.doesNotMatch(md, /UPPERCASE|Phase 2|Phase 3|Blocked side-effect prompts/);
  assert.match(md, /^## Owns — proposed services \(from legacy discovery, not built\)$/m);
});
```

- [ ] **Step 3: Run to verify they fail**

Run: `cd agent && node --test test/spec-api.test.js`
Expected: FAIL — `Cannot find module '../lib/specs/api'`

- [ ] **Step 4: Implement `agent/lib/specs/api.js`**

````js
"use strict";
// API layer spec: legacy discovery + a REST service proposal. Reads ONLY the graph, the Phase 1
// slice of the record (data-field dispositions) and implemented services — never a higher layer's decisions.
const { cap } = require("../rules");

const TARGET = "RegisterEquipment";
const DROPDOWN_MAX = 60;

function enumOpts(s){ return String(s||"").split(";").map(x=>x.trim()).filter(Boolean).map(p=>{const i=p.indexOf("=");return i>0?[p.slice(0,i).trim(),p.slice(i+1).trim()]:[p,p];}); }
function fieldCfg(d){
  const b={k:d.id.replace(/^FLD\./,""),label:d.name,fno:d.field};
  if(d.field===".01") return {...b,type:"readonly"};
  if(d.enumValues) return {...b,type:"select",options:enumOpts(d.enumValues)};
  if(d.pointsTo){ const small=(typeof d.lookupCount==="number"&&d.lookupCount<=60); return {...b,type:small?"lookupSelect":"lookupType",table:d.lookupTable||"",sample:d.sample||null}; }
  if(/date/i.test(d.name)||/Date/.test(d.type||"")) return {...b,type:"date"};
  if(/Numeric/.test(d.type||"")||/value|cost/i.test(d.name)) return {...b,type:"number"};
  const m=/\((\d+)\s*-\s*(\d+)\)/.exec(d.type||""); return {...b,type:"text",maxlen:m?+m[2]:null};
}

function dataSlice(graph, record) {
  const ids = new Set((cap(graph).data || []).map(d => d.id));
  return Object.fromEntries(Object.keys(record.dec || {}).filter(id => ids.has(id)).sort().map(id => [id, record.dec[id]]));
}
const phase1 = (graph, record) => ({ dec: dataSlice(graph, record) });
const included = (graph, r1) => (cap(graph).data || []).filter(d => d.kind === "field" && r1.dec[d.id] !== "Omit");

function requestContract(graph, record) {
  return included(graph, phase1(graph, record)).map(d => ({ id: d.id, field: String(d.field), name: d.name }));
}

function proposedServices(graph) {
  return (cap(graph).sideEffects || []).filter(s => s.writes)
    .map(s => ({ id: "write:" + s.writes.file, what: `write file ${s.writes.file} — ${s.name}`, source: s.call }));
}

function buildApiSpec(graph, record, implemented) {
  const c = cap(graph), r1 = phase1(graph, record);
  const omit = new Set((c.data || []).filter(d => d.kind === "field" && r1.dec[d.id] === "Omit").map(d => d.id));
  const byId = id => (c.data || []).find(d => d.id === id);
  const pages = (c.formScreens || []).filter(s => s.fields && s.fields.length)
    .map(s => ({ title: s.title, fields: s.fields.map(byId).filter(d => d && !omit.has(d.id)).map(fieldCfg) }));
  const built = (implemented && implemented.api) || [];
  return {
    layer: "api",
    builds: ["REST data service on VADEMO (file 6914)", "Angular data-entry app"],
    owns: { built, proposed: proposedServices(graph).filter(p => !built.some(b => b.id === p.id)) },
    uses: [], needs: [], missing: [], complete: true,
    request: requestContract(graph, record),
    detail: { capability: c.name || "Register Equipment", command: TARGET, pages },
  };
}

function control(d) {
  if (d.enumValues) return "select (dropdown) — options: " + d.enumValues;
  if (d.pointsTo) {
    const n = d.lookupCount, tbl = d.lookupTable ? ` from \`${d.lookupTable}\`` : "";
    const eg = d.sample ? ` · e.g. \`${d.sample.value}\` — ${d.sample.label}` : "";
    if (typeof n === "number") return (n <= DROPDOWN_MAX ? `select (dropdown) — ${n} options${tbl}, fetched via \`GET /lookup\`` : `left-rail lookup panel — ${n} rows${tbl} · \`GET /lookup\``) + eg;
    return "autocomplete / lookup → file " + d.pointsTo + eg;
  }
  if (/date/i.test(d.name) || /Date/.test(d.type || "")) return "date picker";
  if (/Numeric/.test(d.type || "") || /value|cost/i.test(d.name)) return "number";
  return d.type || "text";
}

const LABEL_RULES = [
  "- **Option labels are a UX decision, not a mirror of VistA storage.** An option's label exists to let the operator *recognise the right entry*; it is chosen for helpfulness, not because it is how the field happens to be stored. The stored value is always the IEN, so the label is free to differ from the stored column. Three consequences:",
  "  1. **Never show a bare code.** Coded reference sets store a terse code (`AMAF`, `3110`, `1750`) that means nothing on its own, while a description column sits alongside it. Render **`CODE — Description`**: FUND → `NX_FUND_CODE — BRIEF_DESCRIPTION` (\"4014 — Canteen Service\"); BUDGET OBJECT CODE → `CAPITALIZED_BUDGET_OBJECT_CODE — BOC_TITLE` (\"3110 — TRANSPORTATION EQUIPMENT, PASSENGER VEHICLES\"); STANDARD GENERAL LEDGER → `ACCOUNT — ACCOUNT_DESCRIPTION` (\"1750 — NONEXPENDABLE EQUIPMENT\").",
  "  2. **Add a descriptor that aids recognition, even if sparsely populated.** LOCATION → `ROOM_NUMBER — FUNCTION_NAME` (\"201 — OFFICE, PHYSICIAN\"); where FUNCTION_NAME is blank the label degrades cleanly to the bare room number. A descriptor that helps on some rows and is omitted on the rest beats no descriptor at all.",
  "  3. **Don't append a column just because it exists.** Verify it actually adds information. ENG_SPACE's `BUILDING_NUMBER` was rejected: room numbers already embed the building (`304-110` = room 304, bldg 110) in 229 of 234 rows, and no room number repeats — so appending it would restate the room and disambiguate nothing.",
  "  When profiling a lookup file, list **all** its columns, then pick the label that a clerk would find most recognisable — don't settle for the storage column by default.",
];
const LEFT_RAIL = [
  "- **Left-rail lookup panel** (large pointer fields, > 60 rows): when the operator focuses a large-pointer field a collapsible panel slides in from the left alongside the form. Behaviour:",
  "  - **Header shows total count**: e.g. \"MANUFACTURER (5,175)\" so the operator knows the full size of the list before filtering.",
  "  - **On open (empty filter): loads ALL options** and shows them in a scrollable list — the operator can scroll through the full list without typing anything. This mirrors the VistA `??` full-list browse.",
  "  - **On typing: live-filters** the full list client-side (no extra network call once loaded); shows matching rows only.",
  "  - Selecting a row fills the field and collapses the panel. Escape also closes the panel.",
  "  - `GET /lookup/<file>?all=1` is used on open to load the full option set; response format is `{ items: [{ ien, display }], total: N }`. Filtered searches (`?q=<term>`) return the same format.",
  "  - Keyboard-navigable (arrow keys to move highlight, Enter to pick).",
];
const LOOK_AND_FEEL = [
  "Adopt the **U.S. Web Design System (USWDS v3) with the VA.gov theme** — this is a federal VA application, so the visual language must match VA.gov (reference: the Million Veteran Program site). Recommended: the `@department-of-veterans-affairs/component-library` (VA design system) or `@uswds/uswds` for tokens + components.",
  "- **Color tokens:** header/footer band navy `#112e51`; accent section band blue `#2a5599` (lighter `#4a6ba5`); primary action (buttons/links) `#0071bc`, hover/active `#205493`; page background `#f1f1f1`; content surfaces white `#ffffff`; ink `#1b1b1b`, muted `#5b616b`, borders `#d6d7d9`; crisis/error red `#e31c3d`.",
  "- **Typography:** serif headings (`Bitter` / `Merriweather`), sans body (`Source Sans Pro`); base 16–17px, line-height 1.5; bold section headings.",
  "- **Layout:** centered container (max-width ~1000px); top utility bar (Contact Us / Sign In) → navy primary nav → content in alternating white / blue section bands; white cards with 1px `#d6d7d9` border + subtle shadow; generous vertical rhythm.",
  "- **App shell:** keep it minimal — just a navy app header showing the app title. Do NOT add a VA masthead/\"official website\" strip, a crisis-line banner, footer link columns, or a contact/phone block; this is an internal data-entry tool, only the VA visual language (color, type, components) is wanted.",
  "- **Form components (USWDS):** labels **bold, above** each control; large inputs (≥44px touch target), 2px border, focus ring `#0071bc`; wizard steps → USWDS **Step indicator** (numbered, current highlighted); primary Next/Submit = solid primary button, Back = outline button; lookup combobox / left-rail → USWDS **combo box**, enum selects → USWDS **dropdown**; confirmation → USWDS **Summary box**; success → green alert, errors → red alert.",
  "- **Accessibility:** Section 508 / WCAG 2.1 AA — semantic landmarks, every control labeled, visible focus, ≥4.5:1 text contrast, fully keyboard-navigable wizard and lookups.",
];

function renderApi(graph, record, spec) {
  const c = cap(graph), r1 = phase1(graph, record), w = graph.workflow;
  const dataFields = included(graph, r1);
  const xrefs = (c.data || []).filter(d => d.kind === "crossReference" && r1.dec[d.id] !== "Omit");
  const L = [];
  L.push(`# API layer spec — ${TARGET}`);
  L.push(`Source: ${w.name} · legacy ${c.entryPoint ? c.entryPoint.dispatch : ""} (file 6914). Generated from the capability graph and Phase 1 decisions only — legacy discovery plus a REST service proposal.`);
  L.push("");
  L.push("## Builds"); spec.builds.forEach(b => L.push(`- ${b}`)); L.push("");
  L.push("## Owns — built services"); spec.owns.built.forEach(s => L.push(`- \`${s.endpoint}\` — ${s.what} (\`${s.id}\`)`)); L.push("");
  L.push("## Owns — proposed services (from legacy discovery, not built)");
  if (!spec.owns.proposed.length) L.push("- none");
  spec.owns.proposed.forEach(p => L.push(`- ${p.what} — from \`${p.source}\` (\`${p.id}\`)`));
  L.push("");
  L.push("## Uses"); L.push("- none — bottom layer"); L.push("");
  L.push("## Needs from lower layers"); L.push("- none — bottom layer"); L.push("");

  L.push("## Phase 1 · Command & REST contract");
  L.push(`- Command: \`${TARGET}\``);
  L.push("- `POST /equipment` — create; body = the request data contract below; returns the response contract below.");
  L.push("- `GET /equipment/next-ien` — returns `{ status, ien }`; the form pre-fetches this to show the IEN display-only (server re-allocates authoritatively on POST).");
  L.push("- `GET /lookup/{file}?q=<term>` — filtered search; returns `{ items: [{ ien, display }], total: N }` where `total` is the full file size (pre-filter).");
  L.push("- `GET /lookup/{file}?all=1` — full list; returns `{ items: [...all options...], total: N }`. Used on rail open (large pointers) and `<select>` load (small pointers).");
  const ptrs = dataFields.filter(d => d.pointsTo && typeof d.lookupCount === "number");
  const files = pred => [...new Set(ptrs.filter(pred).map(d => d.lookupTable || d.pointsTo))].map(n => "`" + n + "`").join(", ");
  const large = files(d => d.lookupCount > DROPDOWN_MAX), small = files(d => d.lookupCount <= DROPDOWN_MAX);
  if (large || small) L.push(`- Files: ${[large && large + " (large, left-rail)", small && small + " (small, select)"].filter(Boolean).join("; ")}.`);
  L.push("");

  L.push("## Phase 1 · REST request — data contract");
  const inScreens = new Set(); (c.formScreens || []).forEach(s => (s.fields || []).forEach(f => inScreens.add(f)));
  const serverNote = { ".01": "system-allocated IEN (= ENTRY NUMBER)", "5.1": "canonical serial, derived from SERIAL (uppercased, spaces and punctuation stripped, one trailing space, cut to 30) — drives the FC duplicate index", ".5": "filing user (DUZ)", ".6": "filing date/time" };
  const operatorFields = dataFields.filter(d => inScreens.has(d.id) && d.field !== ".01");
  const serverFields = dataFields.filter(d => !(inScreens.has(d.id) && d.field !== ".01"));
  if (operatorFields.length) { L.push("**Operator-entered** — the form POSTs these:"); L.push("```"); operatorFields.forEach(d => L.push(`${d.name || d.field}   [fld ${d.field}]`)); L.push("```"); }
  if (serverFields.length) { L.push("**Server-populated** — set by the write, NOT on the form (do not add inputs for these):"); L.push("```"); serverFields.forEach(d => L.push(`${d.name || d.field}   [fld ${d.field}]${serverNote[d.field] ? "  — " + serverNote[d.field] : "  — server-set"}`)); L.push("```"); }
  if (!operatorFields.length && !serverFields.length) L.push("- (no fields selected)");
  const xrefNames = xrefs.map(x => x.index || x.name).filter(Boolean);
  if (xrefNames.length) L.push(`Query filters (from cross-references): ${xrefNames.map(n => "`" + n + "`").join(", ")}.`);
  L.push("");

  L.push("## Phase 1 · REST response — data contract");
  L.push("```"); L.push("{ status, equipmentIEN, lifecycleStatus }"); L.push("```");
  L.push("- `status` — `\"OK\"` or an error code/message.");
  L.push("- `equipmentIEN` — new IEN allocated in `^ENG(6914)`; drives the confirmation page.");
  L.push("- `lifecycleStatus` — outcome of the write (created / error).");
  L.push("");

  L.push("## Phase 1 · Front end (Angular)");
  L.push("- Angular 21 SPA (matches the existing Vista_Equipment stack); calls `POST /equipment` via `HttpClient` through the dev proxy.");
  L.push(`- **Form-control convention:** set-of-codes fields → native \`<select>\` (dropdown); pointer/lookup fields with **≤ ${DROPDOWN_MAX} rows** → \`<select>\` (populated via \`GET /lookup/<file>?all=1\`); pointer/lookup fields with **> ${DROPDOWN_MAX} rows** → **left-rail lookup panel** (see below). Dates → date picker; numerics → number input. Each field below states its resolved control.`);
  LABEL_RULES.forEach(l => L.push(l));
  LEFT_RAIL.forEach(l => L.push(l));
  const entry = (c.formScreens || []).filter(s => s.fields && s.fields.length);
  const fieldById = id => (c.data || []).find(x => x.id === id);
  if (entry.length) {
    L.push("- Container component `register-equipment` drives a **multi-step wizard**. **Rule: each legacy ScreenMan screen becomes one Angular page** — preserving the operator's screen-by-screen entry flow. A **confirmation page is always appended** as the final step.");
    entry.forEach(s => {
      L.push("");
      L.push(`### Page ${s.screen} — ${s.title}  _(← ScreenMan screen ${s.screen} of ${entry.length})_`);
      s.fields.forEach(fid => {
        const d = fieldById(fid); if (!d || r1.dec[d.id] === "Omit") return;
        L.push(`- **${d.name}** \`[fld ${d.field}]\` — ${d.field === ".01" ? "display-only (system-allocated IEN)" : control(d)}${d.condition ? ` · _${d.condition}_` : ""}`);
      });
    });
    L.push("");
    L.push(`### Page ${entry.length + 1} — Confirmation & Submit`);
    L.push("- Read-only summary of every entered field, grouped under the page headings above — the operator reviews before committing.");
    L.push("- **Submit** → `POST /equipment`; show \"Saving…\", then the new **IEN + lifecycle status**, or an error banner on failure.");
  } else {
    L.push("- Single `register-equipment` form bound to the data-contract fields above (no ScreenMan screen structure detected); append a confirmation step before submit.");
  }
  L.push("");
  L.push("- Form uses template-driven bindings (`FormsModule`), matching the existing Vista_Equipment stack.");
  L.push("- Fetch the next IEN up front (`GET /equipment/next-ien`) so page 1 can show it display-only; the POST allocates authoritatively server-side.");
  L.push("- Validation is DEVELOPER-REVIEWED, not assumed — see \"Input requirements & validation\" below. Server (FileMan) remains the source of truth.");
  L.push("");

  const ff = dataFields.filter(d => d.field !== ".01");
  L.push("## Phase 1 · Input requirements & validation ==developer review==");
  L.push("What the legacy actually enforces — at the DD (field definition) and routine (runtime) level. **Confirm whether the modern app should keep each, tighten it under current regulation/policy, or relax it. None of this is auto-applied.**");
  const req = ff.filter(d => d.required);
  L.push(`- **Required (DD):** ${req.length ? req.map(d => d.name).join(", ") : "none — every operator field is optional at the DD level (ENTRY NUMBER is system-allocated). Making any field mandatory is a modern-policy choice."}`);
  const lenF = ff.map(d => { const m = /\((\d+)\s*-\s*(\d+)\)/.exec(d.type || ""); return m ? `${d.name} ${m[1]}–${m[2]}` : null; }).filter(Boolean);
  if (lenF.length) L.push(`- **Length bounds (DD):** ${lenF.join("; ")}.`);
  const enumF = ff.filter(d => d.enumValues); if (enumF.length) L.push(`- **Set-of-codes — value must be one of the listed options:** ${enumF.map(d => d.name).join(", ")}.`);
  const ptrF = ff.filter(d => d.pointsTo); if (ptrF.length) L.push(`- **Pointer — must resolve to a real entry:** ${ptrF.map(d => d.name + " → " + String(d.pointsTo).split(" ")[0]).join(", ")}.`);
  const dateF = ff.filter(d => /date/i.test(d.name) || /Date/.test(d.type || "")); if (dateF.length) L.push(`- **Dates — FileMan date validity:** ${dateF.map(d => d.name).join(", ")}.`);
  const serialF = ff.find(d => d.id === "FLD.serial"); if (serialF && serialF.legacyInput) L.push(`- **SERIAL (routine \`ASKSER\`):** ${serialF.legacyInput}`);
  L.push("- **Modern validation = your call.** e.g. should SERIAL become *required* and/or *hard-unique* (the legacy is neither)? should any optional field be mandatory under current policy? The legacy behavior above is the baseline to review, not a mandate.");
  L.push("");

  L.push("## Phase 1 · Look & feel (design system)");
  LOOK_AND_FEEL.forEach(l => L.push(l));
  L.push("");
  L.push("## Acceptance criteria — differential vs. legacy");
  L.push("- Creates a record in `^ENG(6914)` with a new IEN (next-IEN = `$P(^ENG(6914,0),\"^\",3)+1`).");
  if (dataFields.some(d => d.id === "FLD.serial")) L.push("- Files SERIAL (field 5) and maintains the `F` + `FC` cross-references; `FC` uses the canonical serial ASKSER builds — uppercased, spaces and punctuation stripped, one trailing space appended, cut to 30 characters — for duplicate detection.");
  L.push("- Given identical sandbox input, target output & state match the legacy option on all of the above.");
  L.push("");
  L.push("## Traceability");
  L.push(`- \`${TARGET}\` ← ${c.id}, ${c.entryPoint ? c.entryPoint.id : ""}, ${c.entryPoint ? c.entryPoint.dispatch : ""}`);
  return L.join("\n") + "\n";
}

module.exports = { TARGET, dataSlice, requestContract, buildApiSpec, renderApi };
````

- [ ] **Step 5: Run the tests**

Run: `cd agent && node --test test/spec-api.test.js`
Expected: PASS (5 tests). If the fixture test lists missing lines, compare each with the graph: a line that differs because the graph changed after 2026-10-01 is correct as generated — update the fixture line and note why in the commit message; any other difference is a renderer bug to fix.

- [ ] **Step 6: Commit**

```bash
git add agent/lib/specs/api.js agent/test/spec-api.test.js agent/test/fixtures/spec-phase1.md
git commit -m "feat: API layer spec generated from graph and Phase 1 decisions only"
```

---

### Task 6: The orchestrator layer spec

**Files:**
- Create: `agent/lib/specs/orchestrator.js`
- Test: `agent/test/spec-orchestrator.test.js`

**Interfaces:**
- Consumes: `cap, isBlocking, isBuilt, isMandatory, requiredTargetKeys, describeKey` (Task 4); `requestContract` (Task 5).
- Produces: `buildOrchestratorSpec(graph, record, implemented) → { layer:"orchestrator", builds, owns, uses, needs:[{ for, service, what, from:"api", met }], missing:[{ id, kind:"decide"|"binding"|"evidence"|"target", key?, what }], complete, detail:{ container, namespace, rules, coded, built (a notification also carries `template` and `templateNotes`), deferred (each `stub: true`, with `reason` — never adds ▢ items or needs), notBuilt (dropped, or waiting on a decision), security, request } }`; `renderOrchestrator(graph, record, spec) → markdown`.

- [ ] **Step 1: Write the failing tests**

Create `agent/test/spec-orchestrator.test.js`:

```js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { graph, rec, IM } = require("./helpers");
const { buildOrchestratorSpec, renderOrchestrator } = require("../lib/specs/orchestrator");

const decided = {
  dec: { "OQ.WorkOrderPolicy": "Business rule" },
  oqPolicy: { "OQ.WorkOrderPolicy": "Create incoming inspection work order if TYPE OF ENTRY = NX", "OQ.PMEnrollmentPolicy": "later phase", "OQ.FAConfirmation": "no FAP target here" },
};
const withWrite = { ...IM, api: [...IM.api, { id: "write:6920", endpoint: "POST /work-orders", what: "x" }] };

test("untouched record: three decisions missing and only the mandatory bulletin is built", () => {
  const s = buildOrchestratorSpec(graph, rec(), IM);
  assert.deepEqual(s.missing.filter(m => m.kind === "decide").map(m => m.id), ["OQ.WorkOrderPolicy", "OQ.PMEnrollmentPolicy", "OQ.FAConfirmation"]);
  assert.deepEqual(s.detail.built.map(e => e.id), ["SIDE.Bulletin"]);
  assert.deepEqual(s.missing.filter(m => m.id === "SIDE.Bulletin").map(m => m.key), ["via", "channel", "recipients", "content"]);
  assert.equal(s.complete, false);
});

test("a business-rule work order needs bindings, target details and the unbuilt 6920 write", () => {
  const s = buildOrchestratorSpec(graph, rec(decided), IM);
  assert.equal(s.detail.rules[0].policy, "Create incoming inspection work order if TYPE OF ENTRY = NX");
  assert.ok(s.missing.some(m => m.id === "OQ.WorkOrderPolicy" && m.kind === "binding"));
  assert.deepEqual(s.missing.filter(m => m.id === "SIDE.WorkOrder").map(m => m.key), ["via", "writePath", "fields", "operatorValues"]);
  assert.deepEqual(s.needs, [{ for: "SIDE.WorkOrder", service: "write:6920", what: "write file 6920 for Incoming inspection work order — proposed in the API spec from `IIWO^ENWONEW3(IEN)`", from: "api", met: false }]);
});

test("with PM and FA deferred, recording the rest and building the 6920 write makes the spec complete — deferring never blocks", () => {
  const r = rec({
    ...decided,
    ruleBindings: { "OQ.WorkOrderPolicy": { "TYPE OF ENTRY": "7" } },
    targets: {
      "SIDE.WorkOrder": { via: "vista", writePath: "new REST endpoint", fields: "as legacy", operatorValues: "defaults" },
      "SIDE.Bulletin": { via: "iris", channel: "email", recipients: "eng-group", content: "as legacy" },
    },
  });
  const s = buildOrchestratorSpec(graph, r, withWrite);
  assert.deepEqual(s.missing, []);
  assert.equal(s.complete, true);
});

test("deferred side effects become unwired stubs with the recorded reason and add nothing to the missing list", () => {
  const s = buildOrchestratorSpec(graph, rec(decided), IM);
  assert.deepEqual(s.detail.deferred.map(e => [e.id, e.stub, e.reason]), [["SIDE.PMSchedule", true, "later phase"], ["SIDE.FinancialAsset", true, "no FAP target here"]]);
  assert.ok(!s.missing.some(m => m.id === "SIDE.PMSchedule" || m.id === "SIDE.FinancialAsset"));
  assert.ok(!s.needs.some(n => n.for === "SIDE.PMSchedule" || n.for === "SIDE.FinancialAsset"));
  assert.deepEqual(s.detail.notBuilt, []);
  assert.match(renderOrchestrator(graph, rec(decided), s), /## Deferred — stub only, not wired[\s\S]*\*\*FA document to Austin\*\* — no FAP target here/);
});

test("a side effect still waiting on its decision is listed as not built, not as a stub", () => {
  const s = buildOrchestratorSpec(graph, rec(), IM);
  assert.deepEqual(s.detail.notBuilt.map(e => e.id), ["SIDE.WorkOrder", "SIDE.PMSchedule", "SIDE.FinancialAsset"]);
  assert.deepEqual(s.detail.deferred, []);
});

test("a Required-input question is an unmet front-end need, never written into the API layer", () => {
  const s = buildOrchestratorSpec(graph, rec({ dec: { "OQ.PMEnrollmentPolicy": "Required input" }, oqPolicy: { "OQ.PMEnrollmentPolicy": "ask the clerk" } }), IM);
  assert.ok(s.needs.some(n => n.service === "prompt:OQ.PMEnrollmentPolicy" && n.met === false));
});

test("the rendered spec quotes the record verbatim and never invents a threshold", () => {
  const r = rec(decided);
  const md = renderOrchestrator(graph, r, buildOrchestratorSpec(graph, r, IM));
  assert.match(md, /"Create incoming inspection work order if TYPE OF ENTRY = NX"/);
  assert.match(md, /▢ via — where the work is performed/);
  assert.match(md, /unmet — requires Phase 1 work/);
  assert.match(md, /`ENEQ3` BULL \(line 60\): Recipients:/);
  assert.doesNotMatch(md, /50,?000/);
});

test("the bulletin shows the legacy email template and what it depends on", () => {
  const r = rec(decided);   // FA deferred
  const s = buildOrchestratorSpec(graph, r, IM);
  const b = s.detail.built.find(e => e.id === "SIDE.Bulletin");
  assert.equal(b.template.subject, "NEW EQUIPMENT: ENTRY #|1|");
  assert.deepEqual(b.templateNotes.map(n => n.slice(0, 5)), ["`|2|`", "`|7|`"]);
  const md = renderOrchestrator(graph, r, s);
  assert.match(md, /Subject: `NEW EQUIPMENT: ENTRY #\|1\|`/);
  assert.match(md, /⚠ `\|7\|` reports the outcome of FA document to Austin, which is not built in this phase/);
  assert.match(md, /⚠ `\|2\|`: no operator identity reaches the pipeline yet/);
  const withFA = rec({ ...decided, dec: { ...decided.dec, "OQ.FAConfirmation": "Business rule" }, oqPolicy: { ...decided.oqPolicy, "OQ.FAConfirmation": "send when eligible" } });
  assert.match(renderOrchestrator(graph, withFA, buildOrchestratorSpec(graph, withFA, IM)), /⚠ `\|7\|` reports the outcome of FA document to Austin — run the bulletin after that step, as the legacy does/);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd agent && node --test test/spec-orchestrator.test.js`
Expected: FAIL — `Cannot find module '../lib/specs/orchestrator'`

- [ ] **Step 3: Implement `agent/lib/specs/orchestrator.js`**

```js
"use strict";
// Orchestrator layer spec: the IRIS production. Uses the API layer by reference and lists what it
// needs from it — it never changes the API layer.
const { cap, isBlocking, isBuilt, isMandatory, requiredTargetKeys, describeKey } = require("../rules");
const { requestContract } = require("./api");

const CONTAINER = "iris-ai-hub", NAMESPACE = "INTEROP";
const has = (implemented, id) => ((implemented && implemented.api) || []).some(s => s.id === id);

function needsFor(se, record, implemented) {
  const out = [];
  if (se.writes) {
    const service = "write:" + se.writes.file;
    out.push({ for: se.id, service, what: `write file ${se.writes.file} for ${se.name} — proposed in the API spec from \`${se.call}\``, from: "api", met: has(implemented, service) });
  }
  if ((record.targets[se.id] || {}).via === "vista" && !se.writes) {
    const service = "call:" + se.call;
    out.push({ for: se.id, service, what: `run \`${se.call}\` on VistA for ${se.name}`, from: "api", met: has(implemented, service) });
  }
  return out;
}

// What a legacy message template depends on, from the graph's params[].dependsOn — surfaced, never decided.
function templateNotes(se, graph, record) {
  const t = se.messageTemplate; if (!t) return [];
  return t.params.filter(p => p.dependsOn).map(p => {
    if (p.dependsOn === "operatorIdentity") return `\`|${p.n}|\`: no operator identity reaches the pipeline yet, so this would name the service account, not the clerk`;
    const dep = cap(graph).sideEffects.find(x => x.id === p.dependsOn);
    if (!dep) return `\`|${p.n}|\` depends on ${p.dependsOn}`;
    return isBuilt(dep, record)
      ? `\`|${p.n}|\` reports the outcome of ${dep.name} — run the bulletin after that step, as the legacy does`
      : `\`|${p.n}|\` reports the outcome of ${dep.name}, which is not built in this phase — it would always report that step as not done`;
  });
}

function buildOrchestratorSpec(graph, record, implemented) {
  const c = cap(graph), oqs = c.openQuestions || [];
  const missing = [], needs = [], rules = [];
  for (const q of oqs) {
    if (isBlocking(record, q.id)) { missing.push({ id: q.id, kind: "decide", what: `decide: ${q.decisionPoint}` }); continue; }
    const mode = record.dec[q.id];
    if (mode === "Defer") continue;
    rules.push({ id: q.id, decisionPoint: q.decisionPoint, mode, policy: record.oqPolicy[q.id], bindings: record.ruleBindings[q.id] === undefined ? null : record.ruleBindings[q.id] });
    if (record.ruleBindings[q.id] === undefined) missing.push({ id: q.id, kind: "binding", what: `bind the data words in the policy for "${q.decisionPoint}" to fields of the API request contract` });
    if (mode === "Required input") {
      const service = "prompt:" + q.id;
      needs.push({ for: q.id, service, what: `operator prompt on the front end: "${q.promptText}"`, from: "api", met: has(implemented, service) });
    }
  }
  const coded = (c.businessRules || []).filter(r => record.dec[r.id] !== "Drop")
    .map(r => ({ id: r.id, name: r.name, disposition: record.dec[r.id] || "Preserve", condition: r.condition, effect: r.effect }));
  const built = [], deferred = [], notBuilt = [];
  for (const se of c.sideEffects || []) {
    const entry = { id: se.id, name: se.name, call: se.call, disposition: record.dec[se.id], mandatory: isMandatory(se), gatedBy: se.openQuestion || null, evidence: se.legacyEvidence || [], target: record.targets[se.id] || {}, template: se.messageTemplate || null, templateNotes: [] };
    if (!isBuilt(se, record)) {
      const q = se.openQuestion;
      if (record.dec[se.id] === "Drop") { notBuilt.push({ ...entry, reason: "dropped — not carried forward" }); continue; }
      if (q && isBlocking(record, q)) { notBuilt.push({ ...entry, reason: `waiting on the decision: ${oqs.find(x => x.id === q).decisionPoint}` }); continue; }
      // a Defer is a decision: an unwired stub, no target details, no needs — it never blocks Phase 2
      deferred.push({ ...entry, stub: true, reason: q && record.dec[q] === "Defer" ? record.oqPolicy[q] : "deferred to a later phase" });
      continue;
    }
    if (!se.targetKind && record.dec[se.id] !== "Integration") missing.push({ id: se.id, kind: "evidence", what: `${se.name}: legacy evidence not yet recorded in the graph` });
    for (const key of requiredTargetKeys(se, record)) {
      if (!String(entry.target[key] || "").trim()) missing.push({ id: se.id, kind: "target", key, what: `${se.name}: ${describeKey(se, record, key)}` });
    }
    needs.push(...needsFor(se, record, implemented));
    entry.templateNotes = templateNotes(se, graph, record);
    built.push(entry);
  }
  const security = (c.security || []).filter(s => record.dec[s.id] !== "Drop").map(s => ({ id: s.id, key: s.key, gates: s.gates, disposition: record.dec[s.id] }));
  return {
    layer: "orchestrator",
    builds: [`IRIS Interoperability production in container \`${CONTAINER}\`, namespace \`${NAMESPACE}\``, "a front door, an orchestrator, and one operation per built side effect — every outbound operation dry-run until enabled"],
    owns: ["the production's front-door request/response: the 6914 create request (see the API spec) plus a per-side-effect outcome (fired | skipped | dry-run | degraded)", "the rules below"],
    uses: ["API: `POST /equipment` — the 6914 create contract"],
    needs, missing,
    complete: missing.length === 0 && needs.every(n => n.met),
    detail: { container: CONTAINER, namespace: NAMESPACE, rules, coded, built, deferred, notBuilt, security, request: requestContract(graph, record) },
  };
}

function renderOrchestrator(graph, record, spec) {
  const d = spec.detail, L = [];
  const fieldName = f => { const x = d.request.find(r => r.field === String(f)); return x ? x.name : "?"; };
  const unmet = spec.needs.filter(n => !n.met);
  const s = n => (n === 1 ? "" : "s");
  L.push("# Orchestrator layer spec — RegisterEquipment");
  L.push(spec.complete ? "✅ Complete — ready for the production build." : `⛔ Not ready for the production build: ${spec.missing.length} item${s(spec.missing.length)} missing · ${unmet.length} unmet need${s(unmet.length)}.`);
  L.push("");
  L.push("## Builds"); spec.builds.forEach(b => L.push(`- ${b}`)); L.push("");
  L.push("## Owns"); spec.owns.forEach(o => L.push(`- ${o}`)); L.push("");
  L.push("## Uses (by reference — see the API spec)"); spec.uses.forEach(u => L.push(`- ${u}`)); L.push("");
  L.push("## Needs from lower layers");
  if (!spec.needs.length) L.push("- none");
  spec.needs.forEach(n => L.push(`- ${n.met ? "✅ met" : "⛔ **unmet — requires Phase 1 work, not decidable here**"}: ${n.what} (\`${n.service}\`)`));
  L.push("");
  L.push("## Rules");
  L.push("### From resolved open questions");
  if (!d.rules.length) L.push("- none");
  d.rules.forEach(r => {
    const b = r.bindings === null ? "▢ field bindings"
      : Object.keys(r.bindings).length ? "fields: " + Object.entries(r.bindings).map(([w, f]) => `${w} → fld ${f} ${fieldName(f)}`).join("; ")
      : "fields: none (the policy uses no data)";
    L.push(`- **${r.decisionPoint}** — ${r.mode}: "${r.policy}" · ${b}`);
  });
  L.push("### Coded in the legacy");
  if (!d.coded.length) L.push("- none");
  d.coded.forEach(r => L.push(`- **${r.name}** (${r.disposition}): \`${r.condition}\` → ${r.effect}`));
  L.push("");
  L.push("## Side effects — built");
  if (!d.built.length) L.push("- none");
  d.built.forEach(e => {
    const se = cap(graph).sideEffects.find(x => x.id === e.id);
    const rule = d.rules.find(r => r.id === e.gatedBy);
    L.push(`### ${e.name}${e.mandatory ? " — mandatory" : ""}`);
    L.push(`- Decision: ${e.disposition}${e.mandatory ? " · always built (the legacy calls it unconditionally)" : rule ? ` · gate: ${rule.mode} "${rule.policy}"` : ""}`);
    L.push("- Legacy evidence:");
    if (!e.evidence.length) L.push("  - ▢ not yet recorded");
    e.evidence.forEach(x => L.push(`  - \`${x.routine}\` ${x.line}: ${x.says}`));
    if (e.template) {
      const t = e.template;
      L.push(`- Legacy message template (${t.source}) — the starting point for the modern message:`);
      L.push(`  - From: ${t.sender}`);
      L.push(`  - Subject: \`${t.subject}\``);
      L.push(`  - Body: ${t.body.map(b => (b.trim() ? "`" + b + "`" : "(blank line)")).join(" / ")}`);
      t.params.forEach(p => L.push(`  - \`|${p.n}|\` — ${p.value}${p.ifBlank ? ` (blank → \`${p.ifBlank}\`)` : ""}`));
      L.push(`  - Recipients (legacy): ${t.recipients}`);
      e.templateNotes.forEach(n => L.push(`  - ⚠ ${n}`));
    }
    L.push("- Target details:");
    const req = requiredTargetKeys(se, record);
    req.concat(Object.keys(e.target).filter(k => !req.includes(k))).forEach(k => {
      const v = e.target[k];
      L.push(v ? `  - ${k}: ${v}` : `  - ▢ ${k} — ${describeKey(se, record, k)}`);
    });
    L.push("- Dry-run: on until enabled");
  });
  L.push("");
  L.push("## Deferred — stub only, not wired");
  L.push("Each gets a stub Business Operation in the production — registered, never called — carrying its legacy evidence and the reason below. No target details are needed, so deferring never blocks this build.");
  if (!d.deferred.length) L.push("- none");
  d.deferred.forEach(e => {
    L.push(`- **${e.name}** — ${e.reason}`);
    e.evidence.forEach(x => L.push(`  - \`${x.routine}\` ${x.line}: ${x.says}`));
  });
  L.push("");
  L.push("## Not built");
  if (!d.notBuilt.length) L.push("- none");
  d.notBuilt.forEach(e => L.push(`- ${e.name} — ${e.reason}`));
  L.push("");
  L.push("## Security / auth");
  d.security.forEach(x => L.push(`- \`${x.key}\` → ${x.disposition}: gates ${x.gates}`));
  L.push("- Operator identity: no clerk identity reaches the pipeline yet, so key checks cannot be enforced.");
  L.push("");
  L.push("## Deployment");
  L.push(`- Deploy into container \`${d.container}\`, namespace \`${d.namespace}\`.`);
  L.push("- Route the Angular app's saves through the production: the dev server's `POST /equipment` forwarding target changes; the app itself does not.");
  L.push("");
  L.push("## Missing (▢)");
  if (!spec.missing.length) L.push("- none");
  spec.missing.forEach(m => L.push(`- ▢ ${m.what}`));
  return L.join("\n") + "\n";
}

module.exports = { buildOrchestratorSpec, renderOrchestrator };
```

- [ ] **Step 4: Run the tests**

Run: `cd agent && node --test test/spec-orchestrator.test.js`
Expected: PASS (8 tests)

- [ ] **Step 5: Commit**

```bash
git add agent/lib/specs/orchestrator.js agent/test/spec-orchestrator.test.js
git commit -m "feat: orchestrator layer spec with missing list and needs from lower layers"
```

---

### Task 7: AI frame, generator entry point, stage

**Files:**
- Create: `agent/lib/specs/ai.js`, `agent/lib/specs/index.js`
- Test: `agent/test/specs.test.js`

**Interfaces:**
- Consumes: Tasks 2, 5, 6.
- Produces (`require("./lib/specs")`): `DEFAULT_PATHS { graph, decisions, implemented, specsDir }`, `LAYERS`, `canon(v)`, `inputHashes(layer, inputs)`, `generate(inputs) → { api, orchestrator, ai }` (each with `inputs` hashes), `render(layer, spec, inputs) → md`, `writeSpecs(dir, specs, inputs) → { api: md, orchestrator: md, ai: md }`, `stage(specs, implemented) → { layer, step: "decide"|"binding"|"evidence"|"target"|"needs"|"ready"|"design", next }`, `loadInputs(paths?, fallbackRecord?) → { graph, record, implemented }`. `inputs` = `{ graph, record, implemented }`.

- [ ] **Step 1: Write the failing tests**

Create `agent/test/specs.test.js`:

```js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { graph, rec, IM } = require("./helpers");
const { generate, render, writeSpecs, stage, inputHashes } = require("../lib/specs");

const inputs = (record, implemented = IM) => ({ graph, record, implemented });

test("one-way rule: no orchestrator-layer decision changes the API spec or its markdown", () => {
  const base = inputs(rec()); const a = generate(base).api; const amd = render("api", a, base);
  const variants = [
    { dec: { "OQ.WorkOrderPolicy": "Business rule" }, oqPolicy: { "OQ.WorkOrderPolicy": "always" } },
    { dec: { "SIDE.PMSchedule": "Integration", "RULE.FinancialEligibility": "Drop", "SEC.ENFACS": "Note" } },
    { scope: { "SIDE.WorkOrder": "Defer" } },
    { targets: { "SIDE.Bulletin": { via: "iris", channel: "email" } } },
    { ruleBindings: { "OQ.WorkOrderPolicy": { cost: "31.5" } } },
  ];
  for (const v of variants) {
    const i = inputs(rec(v)); const b = generate(i).api;
    assert.equal(JSON.stringify(b), JSON.stringify(a), JSON.stringify(v));
    assert.equal(render("api", b, i), amd, JSON.stringify(v));
  }
});

test("a Phase 1 decision does change the API spec", () => {
  assert.notEqual(JSON.stringify(generate(inputs(rec({ dec: { "FLD.serial": "Omit" } }))).api), JSON.stringify(generate(inputs(rec())).api));
});

test("API input hashes ignore orchestrator decisions; orchestrator hashes do not", () => {
  const later = rec({ oqPolicy: { "OQ.FAConfirmation": "later" } });
  assert.deepEqual(inputHashes("api", inputs(rec())), inputHashes("api", inputs(later)));
  assert.notDeepEqual(inputHashes("orchestrator", inputs(rec())), inputHashes("orchestrator", inputs(later)));
});

test("writeSpecs writes json and markdown for all three layers", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "specs-")); const i = inputs(rec());
  const md = writeSpecs(dir, generate(i), i);
  assert.deepEqual(fs.readdirSync(dir).sort(), ["ai.json", "ai.md", "api.json", "api.md", "orchestrator.json", "orchestrator.md"]);
  assert.match(md.ai, /^# AI layer spec/);
});

test("stage walks decide → binding → target → needs → ready → ai", () => {
  assert.equal(stage(generate(inputs(rec())), IM).step, "decide");
  const d = { dec: { "OQ.WorkOrderPolicy": "Business rule" }, oqPolicy: { "OQ.WorkOrderPolicy": "if TYPE OF ENTRY = NX", "OQ.PMEnrollmentPolicy": "later", "OQ.FAConfirmation": "later" } };
  assert.equal(stage(generate(inputs(rec(d))), IM).step, "binding");
  const b = { ...d, ruleBindings: { "OQ.WorkOrderPolicy": { "TYPE OF ENTRY": "7" } } };
  assert.equal(stage(generate(inputs(rec(b))), IM).step, "target");
  const t = { ...b, targets: { "SIDE.WorkOrder": { via: "vista", writePath: "x", fields: "x", operatorValues: "x" }, "SIDE.Bulletin": { via: "iris", channel: "x", recipients: "x", content: "x" } } };
  const st = stage(generate(inputs(rec(t))), IM);
  assert.equal(st.step, "needs"); assert.equal(st.next.service, "write:6920");
  const im = { ...IM, api: [...IM.api, { id: "write:6920", endpoint: "POST /work-orders", what: "x" }] };
  assert.equal(stage(generate(inputs(rec(t), im)), im).step, "ready");
  const done = { ...im, orchestrator: { built: true, verified: true } };
  assert.equal(stage(generate(inputs(rec(t), done)), done).layer, "ai");
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd agent && node --test test/specs.test.js`
Expected: FAIL — `Cannot find module '../lib/specs'`

- [ ] **Step 3: Implement `agent/lib/specs/ai.js`**

```js
"use strict";
// AI layer spec: a frame until piece 3 designs it.
function buildAiSpec() {
  return { layer: "ai", builds: [], owns: [], uses: ["Orchestrator: the production front door"], needs: [], missing: [{ id: "AI", kind: "design", what: "AI layer not yet designed (piece 3)" }], complete: false, detail: {} };
}
function renderAi(spec) {
  return [
    "# AI layer spec — RegisterEquipment",
    "⏸ Not yet designed — piece 3. Offered only once the production is built and verified.",
    "", "## Builds", "- not yet designed",
    "", "## Owns", "- not yet designed",
    "", "## Uses (by reference)", ...spec.uses.map(u => `- ${u}`),
    "", "## Needs from lower layers", "- read endpoints for operational analytics — to be designed in piece 3",
    "",
  ].join("\n");
}
module.exports = { buildAiSpec, renderAi };
```

- [ ] **Step 4: Implement `agent/lib/specs/index.js`**

```js
"use strict";
// The one generator: four input files → three layer specs (structured JSON + markdown from the same object).
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { loadRecord } = require("../record");
const api = require("./api");
const orchestrator = require("./orchestrator");
const ai = require("./ai");

const ROOT = path.join(__dirname, "..", "..", "..");
const DEFAULT_PATHS = {
  graph: path.join(ROOT, "capability-graph", "new-inventory-entry.json"),
  decisions: path.join(ROOT, "agent", "decisions.json"),
  implemented: path.join(ROOT, "agent", "implemented.json"),
  specsDir: path.join(ROOT, "capability-graph", "specs"),
};
const LAYERS = ["api", "orchestrator", "ai"];

function canon(v) {
  if (Array.isArray(v)) return "[" + v.map(canon).join(",") + "]";
  if (v && typeof v === "object") return "{" + Object.keys(v).sort().map(k => JSON.stringify(k) + ":" + canon(v[k])).join(",") + "}";
  return JSON.stringify(v === undefined ? null : v);
}
const sha = v => crypto.createHash("sha256").update(canon(v)).digest("hex");

// The API spec hashes only what it may depend on, so orchestrator decisions never make it look stale.
function inputHashes(layer, { graph, record, implemented }) {
  if (layer === "api") return { graph: sha(graph), decisions: sha(api.dataSlice(graph, record)), implemented: sha((implemented && implemented.api) || []) };
  return { graph: sha(graph), decisions: sha(record), implemented: sha(implemented) };
}

function generate(inputs) {
  const { graph, record, implemented } = inputs;
  const specs = {
    api: api.buildApiSpec(graph, record, implemented),
    orchestrator: orchestrator.buildOrchestratorSpec(graph, record, implemented),
    ai: ai.buildAiSpec(),
  };
  for (const l of LAYERS) specs[l].inputs = inputHashes(l, inputs);
  return specs;
}

function render(layer, spec, inputs) {
  if (layer === "api") return api.renderApi(inputs.graph, inputs.record, spec);
  if (layer === "orchestrator") return orchestrator.renderOrchestrator(inputs.graph, inputs.record, spec);
  return ai.renderAi(spec);
}

function writeSpecs(dir, specs, inputs) {
  // render everything first, so a rendering error never leaves a half-written set of spec files
  const md = Object.fromEntries(LAYERS.map(l => [l, render(l, specs[l], inputs)]));
  fs.mkdirSync(dir, { recursive: true });
  for (const l of LAYERS) {
    fs.writeFileSync(path.join(dir, `${l}.json`), JSON.stringify(specs[l], null, 2) + "\n");
    fs.writeFileSync(path.join(dir, `${l}.md`), md[l]);
  }
  return md;
}

function stage(specs, implemented) {
  const o = specs.orchestrator;
  for (const kind of ["decide", "binding", "evidence", "target"]) {
    const m = o.missing.find(x => x.kind === kind);
    if (m) return { layer: "orchestrator", step: kind, next: m };
  }
  const unmet = o.needs.find(n => !n.met);
  if (unmet) return { layer: "orchestrator", step: "needs", next: unmet };
  const p = (implemented && implemented.orchestrator) || {};
  if (!(p.built && p.verified)) return { layer: "orchestrator", step: "ready", next: null };
  return { layer: "ai", step: "design", next: null };
}

const readJson = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { return fallback; } };

function loadInputs(paths = DEFAULT_PATHS, fallbackRecord) {
  return {
    graph: JSON.parse(fs.readFileSync(paths.graph, "utf8")),
    record: loadRecord(paths.decisions, fallbackRecord),
    implemented: readJson(paths.implemented, { api: [], orchestrator: { built: false, verified: false } }),
  };
}

module.exports = { DEFAULT_PATHS, LAYERS, canon, inputHashes, generate, render, writeSpecs, stage, loadInputs };
```

- [ ] **Step 5: Run the tests**

Run: `cd agent && npm test`
Expected: PASS (all files so far)

- [ ] **Step 6: Commit**

```bash
git add agent/lib/specs/ai.js agent/lib/specs/index.js agent/test/specs.test.js
git commit -m "feat: generator entry point, input hashes and chat stage"
```

---

### Task 8: Chat tools over the record

**Files:**
- Modify: `agent/lib/tools.js`
- Test: `agent/test/tools.test.js`

**Interfaces:**
- Consumes: `normalize` (Task 2); `cap, isBlocking, isMandatory, allowedTargetKeys, VIA` (Task 4); `generate, stage` (Task 7); `requestContract` (Task 5).
- Produces: `runTool(name, input, ctx)` with `ctx = { graph, decisions, implemented }`; tools `getState, explainOption, explainMapping, setDisposition, resolveOpenQuestion, setBuildScope, setTarget, bindRuleTerms` (`setIntegration` is removed). `getState(graph, decisions, { implemented }) → { capability, summary, blocking, resolutions, sideEffects, missing, needs, requestContract, mandatory, stage }`. `defaultDecisions(graph) → { dec, oqPolicy:{}, scope:{}, targets:{}, ruleBindings:{} }`. Tool results no longer embed the whole record.

- [ ] **Step 1: Write the failing tests**

Create `agent/test/tools.test.js`:

```js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { graph, rec, IM } = require("./helpers");
const { runTool } = require("../lib/tools");

const ctx = record => ({ graph, decisions: record, implemented: IM });

test("Defer without a reason records a default reason and takes the gated side effect out of the build", () => {
  const r = rec();
  assert.equal(runTool("resolveOpenQuestion", { id: "OQ.FAConfirmation", mode: "Defer" }, ctx(r)).ok, true);
  assert.equal(r.oqPolicy["OQ.FAConfirmation"], "Deferred — not built in this phase; revisit later.");
  assert.equal(r.scope["SIDE.FinancialAsset"], "Defer");
});

test("a Business rule brings the gated side effect into the build", () => {
  const r = rec({ scope: { "SIDE.WorkOrder": "Defer" } });
  runTool("resolveOpenQuestion", { id: "OQ.WorkOrderPolicy", mode: "Business rule", policy: "if TYPE OF ENTRY = NX" }, ctx(r));
  assert.equal(r.scope["SIDE.WorkOrder"], "Build now");
});

test("re-resolving a question with a new policy clears bindings made for the old one", () => {
  const r = rec();
  runTool("resolveOpenQuestion", { id: "OQ.WorkOrderPolicy", mode: "Business rule", policy: "if TYPE OF ENTRY = NX" }, ctx(r));
  runTool("bindRuleTerms", { id: "OQ.WorkOrderPolicy", bindings: { "TYPE OF ENTRY": "7" } }, ctx(r));
  runTool("resolveOpenQuestion", { id: "OQ.WorkOrderPolicy", mode: "Business rule", policy: "if INVESTMENT CATEGORY = 1" }, ctx(r));
  assert.equal(r.ruleBindings["OQ.WorkOrderPolicy"], undefined);
});

test("the mandatory bulletin cannot be dropped or deferred, but its disposition can change", () => {
  const r = rec();
  assert.equal(runTool("setDisposition", { nodeId: "SIDE.Bulletin", option: "Drop" }, ctx(r)).ok, false);
  assert.equal(runTool("setBuildScope", { nodeId: "SIDE.Bulletin", phase: "Defer" }, ctx(r)).ok, false);
  assert.equal(runTool("setDisposition", { nodeId: "SIDE.Bulletin", option: "Business Operation" }, ctx(r)).ok, true);
  assert.equal(r.dec["SIDE.Bulletin"], "Business Operation");
});

test("setTarget accepts only the keys for the side effect's kind and never changes the disposition", () => {
  const r = rec();
  assert.equal(runTool("setTarget", { nodeId: "SIDE.WorkOrder", channel: "email" }, ctx(r)).ok, false);
  assert.equal(runTool("setTarget", { nodeId: "SIDE.WorkOrder", via: "somewhere" }, ctx(r)).ok, false);
  const ok = runTool("setTarget", { nodeId: "SIDE.WorkOrder", via: "vista", writePath: "new REST endpoint on VADEMO" }, ctx(r));
  assert.equal(ok.ok, true);
  assert.deepEqual(r.targets["SIDE.WorkOrder"], { via: "vista", writePath: "new REST endpoint on VADEMO" });
  assert.equal(r.dec["SIDE.WorkOrder"], "Business Operation");
});

test("setTarget refuses a value that looks like a credential", () => {
  const r = rec();
  const out = runTool("setTarget", { nodeId: "SIDE.Bulletin", recipients: "password=hunter2" }, ctx(r));
  assert.equal(out.ok, false);
  assert.match(out.message, /credential/);
  assert.equal(r.targets["SIDE.Bulletin"], undefined);
});

test("bindRuleTerms only binds a resolved rule, only to fields in the API request contract", () => {
  const r = rec();
  assert.equal(runTool("bindRuleTerms", { id: "OQ.WorkOrderPolicy", bindings: { "TYPE OF ENTRY": "7" } }, ctx(r)).ok, false);
  runTool("resolveOpenQuestion", { id: "OQ.WorkOrderPolicy", mode: "Business rule", policy: "if TYPE OF ENTRY = NX OR cost over a limit" }, ctx(r));
  const bad = runTool("bindRuleTerms", { id: "OQ.WorkOrderPolicy", bindings: { cost: "12" } }, ctx(r));
  assert.equal(bad.ok, false);
  assert.match(bad.message, /not in the API request contract/);
  assert.equal(runTool("bindRuleTerms", { id: "OQ.WorkOrderPolicy", bindings: { "TYPE OF ENTRY": 7 } }, ctx(r)).ok, true);
  assert.deepEqual(r.ruleBindings["OQ.WorkOrderPolicy"], { "TYPE OF ENTRY": "7" });
  assert.equal(runTool("bindRuleTerms", { id: "OQ.WorkOrderPolicy", bindings: {} }, ctx(r)).ok, true);
  assert.deepEqual(r.ruleBindings["OQ.WorkOrderPolicy"], {});
});

test("getState reports stage, missing items, evidence, the request contract and mandatory items", () => {
  const st = runTool("getState", {}, ctx(rec()));
  assert.equal(st.stage.step, "decide");
  assert.ok(st.sideEffects.find(s => s.id === "SIDE.Bulletin").evidence.length > 0);
  assert.ok(st.requestContract.some(f => f.field === "7"));
  assert.deepEqual(st.mandatory, ["SIDE.Bulletin"]);
  assert.deepEqual(st.blocking, ["OQ.WorkOrderPolicy", "OQ.PMEnrollmentPolicy", "OQ.FAConfirmation"]);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd agent && node --test test/tools.test.js`
Expected: FAIL (e.g. `setTarget` → `unknown tool setTarget`, mandatory Drop returns ok)

- [ ] **Step 3: Update `agent/lib/tools.js`**

1. Replace the header (lines 1–3) and add requires:

```js
"use strict";
// Grounded tools for the Decide agent. Pure functions over (graph, decisions record).
// No Bedrock dependency here — unit-testable on their own.
const { normalize } = require("./record");
const { cap: C, isBlocking, isMandatory, allowedTargetKeys, VIA } = require("./rules");
const { generate, stage } = require("./specs");
const { requestContract } = require("./specs/api");
```

   and delete the local `function C(graph) { return graph.capabilities[0]; }` (now imported). `module.exports` stays as is — it still exports `TOOL_SPECS, runTool, defaultDecisions, getState, categoryOf, CAT_OPTS, findNode, label`.

2. In `CAT_OPTS`, change the `beh` line to `beh:  ["Business Operation", "Event", "Integration", "Inline", "Drop"],`.

3. In `defaultDecisions`, replace `const c = C(graph), dec = {}, oqPolicy = {};` with `const c = C(graph), dec = {};` and the `return { dec, oqPolicy };` with:

```js
  return { dec, oqPolicy: {}, scope: {}, targets: {}, ruleBindings: {} };
```

4. Replace `function getState(graph, decisions) { … }` with:

```js
function getState(graph, decisions, extra = {}) {
  const c = C(graph);
  const record = normalize(decisions);
  const implemented = extra.implemented || { api: [], orchestrator: { built: false, verified: false } };
  const cats = { oq: c.openQuestions, rule: c.businessRules, beh: c.sideEffects, sec: c.security, dep: c.dependencies };
  const summary = {};
  for (const [k, arr] of Object.entries(cats)) {
    summary[k] = (arr || []).map(n => ({ id: n.id, label: label(n), decision: record.dec[n.id] || "(unset)" }));
  }
  const specs = generate({ graph, record, implemented });
  const o = specs.orchestrator;
  return {
    capability: c.name, summary,
    blocking: (c.openQuestions || []).filter(q => isBlocking(record, q.id)).map(q => q.id),
    resolutions: Object.fromEntries((c.openQuestions || []).map(q => [q.id, { mode: record.dec[q.id], policy: record.oqPolicy[q.id] || null, bindings: record.ruleBindings[q.id] === undefined ? null : record.ruleBindings[q.id] }])),
    sideEffects: [...o.detail.built.map(e => ({ ...e, built: true })), ...o.detail.deferred.map(e => ({ ...e, built: false })), ...o.detail.notBuilt.map(e => ({ ...e, built: false }))],
    missing: o.missing, needs: o.needs,
    requestContract: specs.api.request,
    mandatory: (c.sideEffects || []).filter(isMandatory).map(s => s.id),
    stage: stage(specs, implemented),
  };
}
```

5. Replace `setDisposition`, `resolveOpenQuestion`, `setBuildScope` and `setIntegration` with:

```js
const MANDATORY_MSG = id => `${id} is mandatory in the production — the legacy calls it unconditionally (discovery). Only how it is implemented is decided here.`;

function setDisposition(graph, decisions, id, option) {
  const cat = categoryOf(graph, id);
  if (!cat) return { ok: false, message: `unknown node ${id}` };
  if (cat === "oq") return { ok: false, message: `${id} is an open question — use resolveOpenQuestion instead` };
  if (!CAT_OPTS[cat].includes(option)) return { ok: false, message: `option "${option}" invalid for ${id}; valid: ${CAT_OPTS[cat].join(", ")}` };
  if (option === "Drop" && cat === "beh" && isMandatory(findNode(graph, id))) return { ok: false, message: `refused: ${MANDATORY_MSG(id)}` };
  decisions.dec[id] = option;
  return { ok: true, message: `${id} → ${option}` };
}

function resolveOpenQuestion(graph, decisions, id, mode, policy) {
  if (categoryOf(graph, id) !== "oq") return { ok: false, message: `${id} is not an open question` };
  if (!CAT_OPTS.oq.includes(mode)) return { ok: false, message: `mode must be one of ${CAT_OPTS.oq.join(", ")}` };
  const text = String(policy || "").trim() || (mode === "Defer" ? "Deferred — not built in this phase; revisit later." : "");
  // bindings were made for the old wording — a changed resolution must be re-bound
  if (decisions.dec[id] !== mode || decisions.oqPolicy[id] !== text) delete decisions.ruleBindings[id];
  decisions.dec[id] = mode;
  decisions.oqPolicy[id] = text;
  (C(graph).sideEffects || []).filter(s => s.openQuestion === id).forEach(s => { decisions.scope[s.id] = mode === "Defer" ? "Defer" : "Build now"; });
  return { ok: true, message: `${id} → ${mode}${text ? " (resolved)" : " (still blocking — needs policy text)"}` };
}

function setBuildScope(graph, decisions, id, phase) {
  if (categoryOf(graph, id) !== "beh") return { ok: false, message: `${id} is not a side effect; build scope applies to behaviors/side effects` };
  if (!["Build now", "Defer"].includes(phase)) return { ok: false, message: `phase must be "Build now" or "Defer"` };
  if (phase === "Defer" && isMandatory(findNode(graph, id))) return { ok: false, message: `refused: ${MANDATORY_MSG(id)}` };
  decisions.scope[id] = phase;
  return { ok: true, message: `${id} build scope → ${phase}` };
}

const SECRET = /(password|passwd|secret|token|api[_-]?key|bearer|authorization)\s*[:=]/i;

function setTarget(graph, decisions, id, details) {
  const se = (C(graph).sideEffects || []).find(s => s.id === id);
  if (!se) return { ok: false, message: `${id} is not a side effect` };
  const allowed = allowedTargetKeys(se, decisions);
  const given = Object.entries(details || {}).filter(([, v]) => v != null && String(v).trim() !== "");
  const bad = given.map(([k]) => k).filter(k => !allowed.includes(k));
  if (bad.length) return { ok: false, message: `not a target detail for ${id}: ${bad.join(", ")}. Allowed: ${allowed.join(", ")}. Credentials are never recorded.` };
  const leaked = given.filter(([, v]) => SECRET.test(String(v)));
  if (leaked.length) return { ok: false, message: `refused: ${leaked.map(([k]) => k).join(", ")} looks like it contains a credential. Credentials are never recorded — they are Management Portal settings.` };
  const via = given.find(([k]) => k === "via");
  if (via && !VIA.includes(String(via[1]).trim())) return { ok: false, message: `via must be one of ${VIA.join(", ")}` };
  decisions.targets[id] = Object.assign({}, decisions.targets[id] || {}, Object.fromEntries(given.map(([k, v]) => [k, String(v).trim()])));
  return { ok: true, message: `${id} target details recorded (${given.map(([k]) => k).join(", ")}); disposition unchanged: ${decisions.dec[id]}` };
}

function bindRuleTerms(graph, decisions, id, bindings) {
  if (categoryOf(graph, id) !== "oq") return { ok: false, message: `${id} is not an open question` };
  if (isBlocking(decisions, id) || decisions.dec[id] === "Defer") return { ok: false, message: `${id} has no resolved rule to bind — decide it first` };
  const fields = new Map(requestContract(graph, decisions).map(f => [f.field, f.name]));
  const entries = Object.entries(bindings || {}).map(([w, f]) => [w, String(f).trim()]);
  const bad = entries.filter(([, f]) => !fields.has(f));
  if (bad.length) return { ok: false, message: `not in the API request contract: ${bad.map(([w, f]) => `${w} → ${f}`).join(", ")}. A word with no field in the contract is an unmet need — report it, don't bind it.` };
  decisions.ruleBindings[id] = Object.fromEntries(entries);
  return { ok: true, message: entries.length ? `${id} bindings: ${entries.map(([w, f]) => `${w} → fld ${f} ${fields.get(f)}`).join("; ")}` : `${id}: recorded that the policy uses no data words` };
}
```

6. Replace `TOOL_SPECS` and `runTool` with:

```js
const TARGET_PROPS = { via: { type: "string", description: "where the work is performed: vista | iris | external" } };
for (const k of ["writePath", "fields", "operatorValues", "channel", "recipients", "content", "system", "endpoint", "trigger", "mapping", "settings"]) TARGET_PROPS[k] = { type: "string" };

const TOOL_SPECS = [
  { toolSpec: { name: "getState", description: "The RECORDED state — the only source of truth for summaries and status. Returns every disposition, which open questions block, each question's recorded resolution (mode, policy, field bindings), every side effect (built or not, mandatory, gating question, legacy evidence, recorded target details, reason if not built), the missing list, needs from lower layers, the API request contract, mandatory items, and the current stage.", inputSchema: { json: { type: "object", properties: {} } } } },
  { toolSpec: { name: "explainOption", description: "Explain what a disposition option means for a specific element: the IRIS artifact it produces, when to use it, and its risk.", inputSchema: { json: { type: "object", properties: { nodeId: { type: "string" }, option: { type: "string" } }, required: ["nodeId", "option"] } } } },
  { toolSpec: { name: "explainMapping", description: "Explain how a legacy element maps through the target layers (AI Hub / IRIS Production / REST / FileMan).", inputSchema: { json: { type: "object", properties: { nodeId: { type: "string" } }, required: ["nodeId"] } } } },
  { toolSpec: { name: "setDisposition", description: "Apply a disposition to an element (rule/behavior/data/security/dependency). Not for open questions. Drop is refused for mandatory items.", inputSchema: { json: { type: "object", properties: { nodeId: { type: "string" }, option: { type: "string" } }, required: ["nodeId", "option"] } } } },
  { toolSpec: { name: "resolveOpenQuestion", description: "Resolve an open question: mode is 'Business rule', 'Required input', or 'Defer'; policy is the developer's statement in their own words (for Defer, their reason). The side effect the question gates moves into this build (Business rule / Required input) or out of it (Defer). Changing a resolution clears its field bindings.", inputSchema: { json: { type: "object", properties: { id: { type: "string" }, mode: { type: "string" }, policy: { type: "string" } }, required: ["id", "mode"] } } } },
  { toolSpec: { name: "setBuildScope", description: "Set whether a side effect is built in this phase: 'Build now' or 'Defer'. Defer is refused for mandatory items.", inputSchema: { json: { type: "object", properties: { nodeId: { type: "string" }, phase: { type: "string" } }, required: ["nodeId", "phase"] } } } },
  { toolSpec: { name: "setTarget", description: "Record target details for a built side effect so the production can be built. Never changes the disposition. Accepts via plus only the keys for that side effect's kind (vistaWrite: writePath, fields, operatorValues; notification: channel, recipients, content; Integration disposition: system, endpoint, trigger, mapping, settings). Never pass credentials or tokens.", inputSchema: { json: { type: "object", properties: { nodeId: { type: "string" }, ...TARGET_PROPS }, required: ["nodeId"] } } } },
  { toolSpec: { name: "bindRuleTerms", description: "Bind the data words in a resolved open question's policy to DD field numbers from the API request contract (getState.requestContract). Pass {} if the policy uses no data. A word with no field in the contract is an unmet need — report it instead of binding.", inputSchema: { json: { type: "object", properties: { id: { type: "string" }, bindings: { type: "object", description: "map of policy word → DD field number, e.g. {\"TYPE OF ENTRY\": \"7\"}" } }, required: ["id", "bindings"] } } } },
];

function runTool(name, input, ctx) {
  const { graph, decisions } = ctx;
  switch (name) {
    case "getState": return getState(graph, decisions, ctx);
    case "explainOption": return explainOption(graph, input.nodeId, input.option);
    case "explainMapping": return explainMapping(graph, input.nodeId);
    case "setDisposition": return setDisposition(graph, decisions, input.nodeId, input.option);
    case "resolveOpenQuestion": return resolveOpenQuestion(graph, decisions, input.id, input.mode, input.policy);
    case "setBuildScope": return setBuildScope(graph, decisions, input.nodeId, input.phase);
    case "setTarget": { const { nodeId, ...details } = input || {}; return setTarget(graph, decisions, nodeId, details); }
    case "bindRuleTerms": return bindRuleTerms(graph, decisions, input.id, input.bindings);
    default: return { error: `unknown tool ${name}` };
  }
}
```


- [ ] **Step 4: Run all tests**

Run: `cd agent && npm test`
Expected: PASS — including Task 4–7 tests, which now use the new `defaultDecisions` shape.

- [ ] **Step 5: Commit**

```bash
git add agent/lib/tools.js agent/test/tools.test.js
git commit -m "feat: chat tools record targets and field bindings, enforce mandatory items"
```

---

### Task 9: Server — regenerate specs, serve them, return recorded changes

**Files:**
- Modify (rewrite top/bottom, move blocks): `agent/server.js`
- Modify: `agent/README.md` (line 23)
- Test: `agent/test/server.test.js`

**Interfaces:**
- Consumes: Tasks 2, 7, 8.
- Produces: `require("./server")` → `{ createApp({ paths?, runAgentImpl? }) → { app, state, regenerate, systemPrompt } }`. Routes: `GET /api/specs → { error, stage, layers: { api|orchestrator|ai: { md, complete, missing, needs, owns } } }`; `POST /api/agent/chat → { reply, toolTrace, recorded, grounding, evidence, specsError }` (the reply has passed `groundedTurn`; `evidence` = `[{ id, names, lines }]` for the evidence card); `GET /api/decisions`, `GET /api/state`; `PUT /api/decisions` and `POST /api/decisions/reset` are removed; `POST /api/build` ignores its body.

- [ ] **Step 1: Write the failing tests**

Create `agent/test/server.test.js`:

```js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createApp } = require("../server");
const { runTool } = require("../lib/tools");
const { inputHashes, loadInputs } = require("../lib/specs");

function setup(fakeAgent) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "srv-"));
  const graphCopy = path.join(dir, "graph.json");
  fs.copyFileSync(path.join(__dirname, "..", "..", "capability-graph", "new-inventory-entry.json"), graphCopy);
  const paths = { graph: graphCopy, decisions: path.join(dir, "decisions.json"), implemented: path.join(__dirname, "..", "implemented.json"), specsDir: path.join(dir, "specs") };
  const made = createApp({ paths, runAgentImpl: fakeAgent || (async () => ({ reply: "ok", toolTrace: [] })) });
  return new Promise(resolve => {
    const srv = made.app.listen(0, "127.0.0.1", () => resolve({ ...made, srv, paths, base: `http://127.0.0.1:${srv.address().port}` }));
  });
}

test("GET /api/specs serves all three layers; writing decisions over HTTP is gone", async () => {
  const t = await setup();
  try {
    const s = await (await fetch(t.base + "/api/specs")).json();
    assert.match(s.layers.api.md, /^# API layer spec/);
    assert.equal(s.stage.step, "decide");
    assert.ok(fs.existsSync(path.join(t.paths.specsDir, "orchestrator.json")));
    assert.ok(fs.existsSync(t.paths.decisions), "default record materialized");
    const put = await fetch(t.base + "/api/decisions", { method: "PUT", headers: { "Content-Type": "application/json" }, body: "{\"dec\":{}}" });
    assert.equal(put.status, 404);
  } finally { t.srv.close(); }
});

test("a chat turn saves the record, regenerates the specs and returns exactly what changed", async () => {
  const fake = async (_m, _h, ctx) => {
    runTool("resolveOpenQuestion", { id: "OQ.FAConfirmation", mode: "Defer", policy: "no FAP target yet" }, ctx);
    return { reply: "done", toolTrace: [] };
  };
  const t = await setup(fake);
  try {
    const r = await (await fetch(t.base + "/api/agent/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: "defer FA", history: [] }) })).json();
    assert.deepEqual(r.recorded.map(c => [c.id, c.field, c.after]), [["OQ.FAConfirmation", "oqPolicy", "no FAP target yet"], ["SIDE.FinancialAsset", "scope", "Defer"]]);
    assert.equal(JSON.parse(fs.readFileSync(t.paths.decisions, "utf8")).oqPolicy["OQ.FAConfirmation"], "no FAP target yet");
    const o = JSON.parse(fs.readFileSync(path.join(t.paths.specsDir, "orchestrator.json"), "utf8"));
    assert.ok(!o.missing.some(m => m.id === "OQ.FAConfirmation"));
  } finally { t.srv.close(); }
});

test("the chat route runs the grounding guardrail and returns the evidence for the card", async () => {
  const BAD = "For the incoming inspection work order, the legacy calls ENEQ3 automatically for capitalized NX items.";
  const GOOD = "For the incoming inspection work order, ENEQ1 ADDEQ asks the clerk; IIWO^ENWONEW3 creates the 6920 work order.";
  let calls = 0;
  const fake = async () => ({ reply: ++calls === 1 ? BAD : GOOD, toolTrace: [] });
  const t = await setup(fake);
  try {
    const r = await (await fetch(t.base + "/api/agent/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: "tell me about the work order", history: [] }) })).json();
    assert.equal(calls, 2);
    assert.ok(r.reply.startsWith(GOOD));
    assert.match(r.reply, /↻ Grounding check/);
    assert.equal(r.grounding.retried, true);
    assert.deepEqual(r.evidence.map(e => e.id), ["OQ.WorkOrderPolicy"]);
  } finally { t.srv.close(); }
});

test("the chat's instructions carry the method and the record, never a past outcome", async () => {
  const t = await setup();
  try {
    const p = t.systemPrompt();
    assert.match(p, /Current stage: /);
    assert.match(p, /MANDATORY in the production[^\n]*SIDE\.Bulletin/);
    for (const banned of ["50,000", "50000", "≥", "RELOCATE", "right move"]) assert.ok(!p.includes(banned), banned);
    // no worked example drawn from a real item — the model transfers them to other items
    for (const realExample of ["TYPE OF ENTRY = NX", "ENFACS security key", "$P(^ENG(6914"]) assert.ok(!p.includes(realExample), realExample);
    assert.match(p, /EVIDENCE IS PER ITEM/);
  } finally { t.srv.close(); }
});

test("regenerate re-reads the graph, so an edited graph never leaves builds stuck as stale", async () => {
  const t = await setup();
  try {
    const g = JSON.parse(fs.readFileSync(t.paths.graph, "utf8"));
    g.workflow.name = "Edited while running";
    fs.writeFileSync(t.paths.graph, JSON.stringify(g));
    t.regenerate();
    const spec = JSON.parse(fs.readFileSync(path.join(t.paths.specsDir, "api.json"), "utf8"));
    assert.deepEqual(spec.inputs, inputHashes("api", loadInputs(t.paths)));
  } finally { t.srv.close(); }
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd agent && node --test test/server.test.js`
Expected: FAIL — `createApp is not a function` (server.js starts listening on require and exports nothing)

- [ ] **Step 3: Restructure `agent/server.js`**

1. Replace everything from the top of the file through the end of the `app.post("/api/agent/chat", …)` handler (current lines 1–90) with:

```js
"use strict";
const express = require("express");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { runAgent } = require("./lib/bedrock");
const { defaultDecisions, getState, findNode, label } = require("./lib/tools");
const { loadRecord, saveRecord, diffRecords } = require("./lib/record");
const { DEFAULT_PATHS, generate, writeSpecs, stage } = require("./lib/specs");
const { groundedTurn } = require("./lib/grounding");

const ROOT = path.join(__dirname, "..");                 // repo root (serves capability-graph/, workbench-demo.html, …)
const PORT = process.env.PORT || 8899;
const readJson = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { return fallback; } };

function createApp({ paths = DEFAULT_PATHS, runAgentImpl = runAgent } = {}) {
  let graph = JSON.parse(fs.readFileSync(paths.graph, "utf8"));
  const state = { record: loadRecord(paths.decisions, () => defaultDecisions(graph)), specs: null, md: null, stage: null, specsError: null };
  if (!fs.existsSync(paths.decisions)) saveRecord(paths.decisions, state.record);   // the file is the single truth builds read
  const implemented = () => readJson(paths.implemented, { api: [], orchestrator: { built: false, verified: false } });
  const labelOf = id => { const n = findNode(graph, id); return n ? label(n) : id; };

  // Regenerate all three layer specs from the four input files. On failure the last good specs stay.
  function regenerate() {
    try {
      graph = JSON.parse(fs.readFileSync(paths.graph, "utf8"));
      const inputs = { graph, record: state.record, implemented: implemented() };
      const specs = generate(inputs);
      state.md = writeSpecs(paths.specsDir, specs, inputs);
      state.specs = specs;
      state.stage = stage(specs, inputs.implemented);
      state.specsError = null;
      return {};
    } catch (e) {
      state.specsError = String(e.message || e);
      return { error: state.specsError };
    }
  }

  function systemPrompt() {
    const st = getState(graph, state.record, { implemented: implemented() });
    return [
      "You are the Decide-stage GUIDE for the VistA Service Enablement Workbench.",
      "You lead a human, one decision at a time, through turning a legacy VistA capability into three layer specs that drive the builds: API (Phase 1 — REST service on VistA + Angular app), Orchestrator (Phase 2 — IRIS Interoperability production), AI (Phase 3 — AI Hub). The specs render live on the right, one tab per layer.",
      "",
      "DEPENDENCIES POINT ONE WAY. A decision in a higher layer never changes a lower layer. The API layer is legacy discovery plus a REST service proposal, and it is built and verified. Form feedback is an API-layer decision (setDisposition Include/Omit); tell the user to click 🔨 Build on the API tab to regenerate the app. If an orchestrator decision needs something the API layer does not provide, report it as an UNMET NEED that requires Phase 1 work — never treat it as satisfied.",
      "",
      "WORK FROM THE MISSING LIST, one item at a time. The current stage and the next item are below. Order: decide the open questions → bind each resolved rule's data words to fields → record target details for each built side effect → report unmet needs (Phase 1 work, not decidable here) → only when nothing is missing and every need is met, say the orchestrator spec is complete and ready for the production build. Never start or offer the AI layer until the production has been built and verified.",
      "",
      "For each open question explain the three resolution modes before asking, because they produce different architecture:",
      "  · 'Business rule' = the orchestrator decides automatically from data, no prompt at entry time. Needs a stated rule — a condition on the item's data, in the developer's own words.",
      "  · 'Required input' = the operator is asked at entry time. The front-end prompt is an API-layer need, so it shows as an unmet need until Phase 1 provides it.",
      "  · 'Defer' = not built in this phase: the production gets a stub operation that is registered but never called. It NEVER blocks Phase 2. Record the developer's reason as the policy.",
      "",
      "LEGACY-FIRST, THEN MODERNIZE — the core loop for every item (open question, field binding, target detail). Do NOT open with a menu and do NOT treat keeping the legacy as the default:",
      "  1. SHOW what the legacy actually does — quote the evidence (getState → sideEffects[].evidence, or the node's meta.evidence) and state its determinacy.",
      "  2. EXPLAIN it in plain language, decomposing compound conditions into parts that can be judged separately.",
      "  3. ASK how the developer wants to modernize each part — keep, change, relocate to another layer, or drop — with a recommendation and reasoning.",
      "  4. RECORD the outcome with the tools, naming which parts changed and which were preserved. Flag clearly when a choice departs from the legacy.",
      "READ INTENT AS POLICY: when the legacy code expresses intent — a default answer that performs the action, a flag raised for the non-compliant case, DD text stating a rule, a path to catch up later — present it as the legacy POLICY, which most likely carries over, and recommend carrying it over. A human override is an exception path; the decision is how to treat the override, not whether the policy exists. Never describe a default-YES step as optional.",
      "EVIDENCE IS PER ITEM. Describe an item's legacy behaviour ONLY from that item's own evidence: call explainOption or explainMapping (or getState) for that node id and quote what it returns. Never borrow a condition, routine, field, threshold or outcome from another item — not as an example, an analogy, or a 'similar case'. If an item's evidence says something is not coded, say exactly that. To illustrate the method, stay abstract: no real fields, routines or conditions.",
      "Never present any outcome as already decided, never bring in a condition, threshold, or decision the developer has not stated in THIS conversation, and never move a condition between rules unless the developer says so.",
      "Tooling limit to be honest about: rule dispositions are only Preserve/Inline/Drop, so a 'modernized' rule has no exact disposition. Record the closest one AND state the modification in words.",
      "",
      "FIELD BINDINGS: list candidate fields from getState.requestContract with their DD names, let the developer choose, and record with bindRuleTerms. A word with no field in the contract is an unmet need.",
      "NOTIFICATIONS: start the content and recipients details from the legacy message template (getState → sideEffects[].template) — show the subject, body and placeholders verbatim, then ask what to keep or change — and raise every ⚠ note in sideEffects[].templateNotes before recording.",
      "TARGET DETAILS: record with setTarget — it never changes the disposition. To make a side effect an external integration, first setDisposition(id,'Integration'). Never ask for or record passwords, tokens, or other secrets — those are Management Portal settings.",
      `MANDATORY in the production (discovery: the legacy calls these unconditionally): ${st.mandatory.join(", ") || "none"}. Never offer Drop or Defer for these and never ask the operator about them; the developer decides only HOW each is implemented.`,
      "",
      "STATUS AND SUMMARIES COME FROM THE RECORD, NOT FROM MEMORY. Before you summarise decisions or claim any status, call getState and report only what it returns; restate a recorded policy verbatim. If a tool result says something is still blocking or refused, say so. If what is recorded differs from what the developer told you, point out the difference and ask them to correct it.",
      "",
      "How to present each item: lead with one bold line naming it; one plain sentence on why it is a decision; only the relevant options, each one line, with a short recommendation; then ask. Keep it to a few lines and strictly one item at a time. Expand only if asked (explainOption / explainMapping).",
      "",
      "Rules:",
      "- Ground every answer in the capability graph and the tools; never invent routines, fields, or rules.",
      "- Disposition→target: Business Operation = an Ens.BusinessOperation; Event = async publish; Integration = external system call; Inline = folded into the orchestrator; Drop = not carried forward.",
      "- Be concise. Cite node ids only when useful. Flag risky choices (e.g. dropping a coded rule).",
      "",
      "Current capability: " + st.capability,
      "Current stage: " + JSON.stringify(st.stage),
      "Missing items: " + JSON.stringify(st.missing),
      "Needs from lower layers: " + JSON.stringify(st.needs),
      "Elements & current decisions: " + JSON.stringify(st.summary),
      "Currently blocking open questions: " + JSON.stringify(st.blocking),
    ].join("\n");
  }

  const app = express();
  app.use(express.json({ limit: "1mb" }));

  app.get("/api/state", (_req, res) => res.json({ workflow: graph.workflow, decisions: state.record, state: getState(graph, state.record, { implemented: implemented() }) }));
  app.get("/api/decisions", (_req, res) => res.json(state.record));

  app.get("/api/specs", (_req, res) => {
    if (!state.specs) return res.status(500).json({ error: state.specsError || "specs not generated" });
    const layer = l => ({ md: state.md[l], complete: state.specs[l].complete, missing: state.specs[l].missing, needs: state.specs[l].needs, owns: state.specs[l].owns });
    res.json({ error: state.specsError, stage: state.stage, layers: { api: layer("api"), orchestrator: layer("orchestrator"), ai: layer("ai") } });
  });

  app.post("/api/agent/chat", async (req, res) => {
    const { message, history } = req.body || {};
    if (!message) return res.status(400).json({ error: "message required" });
    const before = JSON.parse(JSON.stringify(state.record));
    let out = null, err = null;
    try {
      const ctx = { graph, decisions: state.record, implemented: implemented(), system: systemPrompt() };
      const next = state.stage && state.stage.next;   // the item being worked on, before tools change it
      const currentId = next ? next.id || next.for || null : null;
      // tools mutate state.record in place; the guardrail retries a reply that borrows another item's evidence
      out = await groundedTurn({ run: (t, h) => runAgentImpl(t, h, ctx), message: String(message), history: history || [], graph, record: state.record, currentId });
    } catch (e) { err = String(e.message || e); }
    saveRecord(paths.decisions, state.record);
    const g = regenerate();
    const recorded = diffRecords(before, state.record, labelOf);
    if (err) return res.status(500).json({ error: err, recorded });
    res.json({ reply: out.reply, toolTrace: out.toolTrace, recorded, grounding: out.grounding, evidence: out.evidence, specsError: g.error || null });
  });

  registerVistaRoutes(app);
  registerBuildRoutes(app, regenerate);
  app.use(express.static(ROOT));

  regenerate();
  return { app, state, regenerate, systemPrompt };
}
```

2. Wrap the VistA proxy block — from the comment `// ── Dev proxy to the real Harness REST data service on VADEMO` through the end of the `app.get("/lookup/:file", …)` handler — **unchanged** inside:

```js
function registerVistaRoutes(app) {
  // … existing block, unchanged …
}
```

3. Replace the build block — from the comment `// ── Build: run the REAL naive build as an async job` through the end of the `app.post("/api/build/cancel", …)` handler — with the same code wrapped in `function registerBuildRoutes(app, regenerate) { … }`, keeping `STATUS_FILE` and `let buildProc = null;` **above** the function (module level), removing the `const { spawn } = require("child_process");` line (now at the top), and replacing the `app.post("/api/build", …)` handler with:

```js
  app.post("/api/build", (_req, res) => {
    try {
      if (buildProc) return res.json({ started: false, running: true, note: "a build is already running" });
      const g = regenerate();   // the build always reads the latest specs; it ignores any request body
      if (g.error) return res.status(500).json({ started: false, error: "spec generation failed: " + g.error });
      fs.writeFileSync(STATUS_FILE, JSON.stringify({ state: "starting", step: "queued", log: ["▶ queued"], url: null, error: null, startedAt: new Date().toISOString() }, null, 2));
      buildProc = spawn(process.execPath, [path.join(__dirname, "build-runner.js")], { cwd: __dirname, detached: true, stdio: "ignore" });
      buildProc.on("exit", (code) => {
        buildProc = null;
        // Safety net: if the runner died without writing a terminal state (crash / kill),
        // mark the status errored so the UI poll ends and the Build button re-enables.
        try {
          const s = JSON.parse(fs.readFileSync(STATUS_FILE, "utf8"));
          if (s.state !== "done" && s.state !== "error" && s.state !== "cancelled") {
            s.state = "error"; s.error = "build process exited unexpectedly (code " + code + ")"; s.etaSec = 0;
            (s.log = s.log || []).push("✗ build process exited unexpectedly (code " + code + ")");
            fs.writeFileSync(STATUS_FILE, JSON.stringify(s, null, 2));
          }
        } catch (e) { /* no status file yet — nothing to reconcile */ }
      });
      buildProc.unref();
      res.json({ started: true, statusUrl: "/api/build/status" });
    } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
  });
```

4. Delete the old module-level `graph`, `decisions`, `saveStore`, `systemPrompt`, `app`, `PUT /api/decisions` and `POST /api/decisions/reset` code (all replaced above), and replace the closing `app.use(express.static(ROOT)); app.listen(…)` with:

```js
if (require.main === module) {
  const { app } = createApp();
  app.listen(PORT, "127.0.0.1", () => {
    console.log(`VistA SE Workbench agent on http://localhost:${PORT}`);
    console.log(`Open  http://localhost:${PORT}/capability-graph/decide.html`);
    console.log(`Prototype  http://localhost:${PORT}/prototype/`);
  });
}

module.exports = { createApp };
```

- [ ] **Step 4: Update the README**

In `agent/README.md`, replace line 23 with:

```markdown
- `server.js` — serves the workbench + APIs: `GET /api/state`, `GET /api/decisions` (read-only — decisions are written only by the chat tools), `GET /api/specs` (the three generated layer specs), `POST /api/agent/chat` (returns `recorded`, the exact record changes), `POST /api/build` (regenerates the specs, then builds the API layer from `capability-graph/specs/api.json`).
- `lib/specs/` — generates `capability-graph/specs/{api,orchestrator,ai}.{json,md}` from the graph, `decisions.json` and `implemented.json`.
```

- [ ] **Step 5: Run all tests**

Run: `cd agent && npm test`
Expected: PASS

- [ ] **Step 6: Restart the live server and check it**

Restart (see *Before you start*), then:
Run: `curl -s http://localhost:8899/api/specs | node -e "const c=[];process.stdin.on('data',d=>c.push(d));process.stdin.on('end',()=>{const j=JSON.parse(Buffer.concat(c));console.log(j.error, j.stage.step, Object.keys(j.layers));})"`
Expected: `null decide [ 'api', 'orchestrator', 'ai' ]` (the live record has PM and FA as untouched Defers) and `capability-graph/specs/` contains six files.

- [ ] **Step 7: Commit**

```bash
git add agent/server.js agent/README.md agent/test/server.test.js
git commit -m "feat: server regenerates layer specs, serves them, and returns recorded changes"
```

---

### Task 10: The Phase 1 build reads the API spec

**Files:**
- Modify: `agent/build-runner.js`
- Modify: `agent/lib/angular-app.js`
- Test: `agent/test/angular-app.test.js` (add tests)

**Interfaces:**
- Consumes: `DEFAULT_PATHS, loadInputs, inputHashes, canon` (Task 7); golden fixtures (Task 1).
- Produces: `buildConfig(specFile = <specsDir>/api.json, paths = DEFAULT_PATHS) → spec.detail`, throwing `/stale/` when the spec's input hashes do not match the current files.

- [ ] **Step 1: Write the failing tests**

Append to `agent/test/angular-app.test.js`:

```js
const os = require("os");
const { graph, rec, IM } = require("./helpers");
const { generate, writeSpecs, loadInputs, DEFAULT_PATHS } = require("../lib/specs");

const PHASE2_BLOCK = [
  '          <div class="oq"><h3>Ensuing workflows <span class="nb">Phase 2 · not in this build</span></h3>',
  '            <label *ngFor="let q of cfg.oq"><input type="checkbox" [(ngModel)]="model[q.k]"> {{q.label}}</label>',
  '            <div *ngIf="!cfg.oq.length" style="color:var(--dim);font-size:12.5px">No per-item decisions.</div>',
  "            <div *ngFor=\"let s of cfg.sideEffects\" style=\"font-size:12px;margin-top:4px\">{{s.deferred?'⏸ ':''}}{{s.name}} — {{s.disp}} <span class=\"nb\">Phase 2</span></div>",
  "          </div>",
].join("\n") + "\n";

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
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd agent && node --test test/angular-app.test.js`
Expected: FAIL — app.ts still contains the Phase 2 block; `buildConfig(path)` treats the path as a graph

- [ ] **Step 3: Remove the Phase 2 block from the template**

In `agent/lib/angular-app.js`, inside `APP_TS`, delete exactly the five lines of `PHASE2_BLOCK` (from `<div class="oq"><h3>Ensuing workflows` through its closing `</div>`).

- [ ] **Step 4: Switch `build-runner.js` to the API spec**

1. Replace the header comment's second line with `   Driven from capability-graph/specs/api.json (the API layer spec). Streams progress to build-status.json.`
2. Delete the `GRAPH` and `DECISIONS` constants, `enumOpts`, `fieldCfg`, and the `buildConfig(g, s)` function from Task 1.
3. Add near the top requires:

```js
const { DEFAULT_PATHS, loadInputs, inputHashes, canon } = require("./lib/specs");
const API_SPEC = path.join(DEFAULT_PATHS.specsDir, "api.json");
```

4. Add in place of the old `buildConfig`:

```js
// The build reads ONLY the API layer spec, and refuses one generated from inputs that have since changed.
function buildConfig(specFile = API_SPEC, paths = DEFAULT_PATHS){
  const spec = JSON.parse(fs.readFileSync(specFile, "utf8"));
  if (canon(inputHashes("api", loadInputs(paths))) !== canon(spec.inputs)) throw new Error("api spec is stale — its inputs changed since it was generated; regenerate (POST /api/build does this) and retry");
  return spec.detail;
}
```

5. In `main()`, change `setStep("Reading spec (capability graph + decisions)");` to `setStep("Reading spec (capability-graph/specs/api.json)");`.

- [ ] **Step 5: Run all tests**

Run: `cd agent && npm test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add agent/build-runner.js agent/lib/angular-app.js agent/test/angular-app.test.js
git commit -m "feat: Phase 1 build reads only the API spec and drops Phase 2 content"
```

---

### Task 11: One Decide page — tabs, status line, decision cards

**Files:**
- Replace: `capability-graph/decide.html` (from `decide.template.html`), then delete `capability-graph/decide.template.html`
- Test: manual browser checks (no browser automation in this repo)

**Interfaces:**
- Consumes: `GET /api/specs`, `POST /api/agent/chat` (`recorded`), `POST /api/build` (Task 9).

- [ ] **Step 1: Make the template the only page**

```bash
cp capability-graph/decide.template.html capability-graph/decide.html
rm capability-graph/decide.template.html
```

All edits below are to `capability-graph/decide.html`.

- [ ] **Step 2: Header and right pane**

Delete the three header buttons (`id="dlBtn"`, `id="buildBtn"`, `id="killBtn"`). Replace the right pane:

```html
  <div class="pane right">
    <div class="pane-title">Development Spec — Angular · REST · IRIS Interop · AI Hub</div>
    <div class="doc" id="doc"></div>
  </div>
```

with:

```html
  <div class="pane right">
    <div class="tabs">
      <button class="tab" data-layer="api">API</button>
      <button class="tab" data-layer="orchestrator">Orchestrator</button>
      <button class="tab" data-layer="ai">AI</button>
      <span class="sp"></span>
      <button class="btn" id="dlBtn" title="Download this layer's spec">⬇ Download</button>
      <button class="btn primary" id="buildBtn" title="Regenerate the API layer (Angular app) from the API spec and open it">🔨 Build</button>
      <button class="btn" id="killBtn" title="Cancel the running build and reset the environment for the next one" disabled>⏹ Stop</button>
    </div>
    <div class="doc" id="doc"></div>
  </div>
```

Add before `</style>`:

```css
  .tabs{display:flex;align-items:center;gap:6px;margin:0 0 12px;flex-wrap:wrap}
  .tab{background:var(--panel2);color:var(--dim);border:1px solid var(--edge);border-radius:7px;padding:5px 12px;font-size:12px;font-weight:700;cursor:pointer;font-family:var(--sans)}
  .tab.on{background:var(--accent);border-color:var(--accent);color:#04121f}
  .tabs .sp{flex:1}
  .specerr{background:#2a1713;border:1px solid var(--question);border-radius:8px;padding:9px 12px;color:#ffb3aa;margin-bottom:10px}
  .reccard{align-self:stretch;background:#10221a;border:1px solid #2f6b4a;border-left:3px solid var(--accent2);border-radius:10px;padding:8px 12px;font-size:12px}
  .reccard .rh{font-size:9.5px;font-weight:800;text-transform:uppercase;letter-spacing:.7px;color:var(--accent2);margin-bottom:4px}
  .reccard .rr{margin:3px 0;line-height:1.45}
  .reccard .was{color:var(--faint);text-decoration:line-through}
  .reccard .now{color:#d6ffe4}
```

- [ ] **Step 3: Replace the client-side spec generator with spec loading**

Replace everything from `const EMBED = %%GRAPH%%;` through the closing `}` of `function specMD(){ … }` (the line before `/* tiny markdown -> html */`) with:

```js
const cap = g => g.capabilities[0];
const esc = s => String(s==null?"":s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
const TARGET = "RegisterEquipment";
let G = null, SPECS = null, TAB = "orchestrator";

async function loadSpecs(){
  try{ const r=await fetch("/api/specs",{cache:"no-store"}); SPECS=await r.json(); }
  catch(e){ SPECS={error:"Could not reach the workbench server: "+e.message}; }
  renderRight();
}
function updateProg(){
  if(!G||!SPECS||!SPECS.layers) return;
  const n=(cap(G).openQuestions||[]).length, open=SPECS.layers.orchestrator.missing.filter(m=>m.kind==="decide").length;
  document.getElementById("prog").textContent=`${n-open}/${n} open questions decided`;
}
function wireTabs(){
  document.querySelectorAll(".tab").forEach(b=>{ b.onclick=()=>{ TAB=b.dataset.layer; renderRight(); }; });
}
```

- [ ] **Step 4: Replace `renderRight` and `updateAgenda`**

Replace `function renderRight(){ … }` and `function updateAgenda(){ … }` with:

```js
function renderRight(){
  document.querySelectorAll(".tab").forEach(b=>b.classList.toggle("on", b.dataset.layer===TAB));
  const onApi = TAB==="api";
  document.getElementById("buildBtn").style.display = onApi ? "" : "none";
  document.getElementById("killBtn").style.display = onApi ? "" : "none";
  const doc=document.getElementById("doc");
  if(!SPECS||!SPECS.layers){ doc.innerHTML=`<div class="specerr">${esc((SPECS&&SPECS.error)||"Specs not available")}</div>`; return; }
  const banner = SPECS.error ? `<div class="specerr">⚠ Spec generation failed — showing the last good version. ${esc(SPECS.error)}</div>` : "";
  doc.innerHTML = banner + mdToHtml(SPECS.layers[TAB].md);
  updateProg(); updateAgenda();
}
function updateAgenda(){
  const el=document.getElementById("agenda"); if(!el||!SPECS||!SPECS.layers) return;
  const a=SPECS.layers.api, o=SPECS.layers.orchestrator;
  const unmet=o.needs.filter(n=>!n.met).length;
  el.innerHTML =
    `<span>API <b>${a.owns.built.length}</b> services built · ${a.owns.proposed.length} proposed</span>`
    + `<span>Orchestrator ${o.complete?'<span class="rdy">✓ ready to build</span>':`<b>${o.missing.length}</b> items missing${unmet?` · <span class="blk">${unmet} unmet need${unmet>1?"s":""}</span>`:""}`}</span>`
    + `<span>AI <b>not started</b></span>`;
}
```

- [ ] **Step 5: Remove browser-side record writes; add decision cards**

1. Replace the `function persist(){ … }` block with nothing (keep the `const SERVED = …` line above it).
2. Delete `function restore(){ … }`.
3. Add after `function addMsg(…){ … }`:

```js
const fmtVal = v => v==null||v==="" ? "(none)" : typeof v==="object" ? JSON.stringify(v) : String(v);
function addRecordedCards(list){
  if(!list||!list.length) return;
  const box=document.getElementById("chatMsgs");
  const d=document.createElement("div"); d.className="reccard";
  d.innerHTML=`<div class="rh">Recorded</div>`+list.map(c=>`<div class="rr"><b>${esc(c.label)}</b> · <code>${esc(c.field)}</code><br><span class="was">${esc(fmtVal(c.before))}</span> → <span class="now">${esc(fmtVal(c.after))}</span></div>`).join("");
  box.appendChild(d); box.scrollTop=box.scrollHeight;
}
// Evidence card: the graph's own evidence for the item the reply is about, shown beside the chat's words.
function addEvidenceCard(list){
  if(!list||!list.length) return;
  const box=document.getElementById("chatMsgs");
  const d=document.createElement("div"); d.className="evcard";
  d.innerHTML=list.map(e=>`<div class="eh">Legacy evidence — ${esc(e.names.join(" / "))}</div>`+e.lines.map(l=>`<div class="el">${esc(l)}</div>`).join("")).join("");
  box.appendChild(d); box.scrollTop=box.scrollHeight;
}
```

Add to the CSS from Step 2:

```css
  .evcard{align-self:stretch;background:#141c2a;border:1px solid #33465f;border-left:3px solid var(--warn);border-radius:10px;padding:8px 12px;font-size:11.5px}
  .evcard .eh{font-size:9.5px;font-weight:800;text-transform:uppercase;letter-spacing:.7px;color:var(--warn);margin:4px 0}
  .evcard .el{font-family:var(--mono);color:#c9d3dd;margin:2px 0;white-space:pre-wrap}
```

4. In `sendChat`, replace the line starting `if(res.decisions&&res.decisions.dec){` with:

```js
    addEvidenceCard(res.evidence); addRecordedCards(res.recorded); await loadSpecs();
```

and change `if(res.error){ addMsg("assistant","⚠ "+res.error); return; }` to `if(res.error){ addMsg("assistant","⚠ "+res.error); addRecordedCards(res.recorded); await loadSpecs(); return; }`.

- [ ] **Step 6: Download and Build**

Replace the `document.getElementById("dlBtn").onclick=…` handler with:

```js
document.getElementById("dlBtn").onclick=()=>{
  if(!SPECS||!SPECS.layers) return;
  const blob=new Blob([SPECS.layers[TAB].md],{type:"text/markdown"});
  const a=document.createElement("a"); a.href=URL.createObjectURL(blob); a.download=TAB+".md"; a.click();
};
```

In the Build handler, replace `const r=await fetch("/api/build",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({dec,oqPolicy,scope,integration})});` with `const r=await fetch("/api/build",{method:"POST"});`, and change the `upd("<b>🔨 Building from spec…</b> …")` text to `upd("<b>🔨 Building the API layer from its spec…</b> scaffolding Angular, installing dependencies, then compiling. This takes a few minutes.");`.

- [ ] **Step 7: Replace the boot block**

Replace the whole `/* ---------- boot ---------- */` IIFE with:

```js
/* ---------- boot ---------- */
(async function(){
  try{ const r=await fetch("new-inventory-entry.json",{cache:"no-store"}); G=await r.json(); }
  catch(e){ document.getElementById("doc").innerHTML='<div class="specerr">Could not load the capability graph — run the workbench server and open http://localhost:8899/capability-graph/decide.html</div>'; return; }
  document.getElementById("hdrSub").textContent = G.workflow.name + " → " + TARGET;
  wireTabs(); wireChat();
  await loadSpecs();
  addMsg("assistant", capabilityOverview());
  addMsg("assistant","**Where we are — ✅ Phase 1 is built and verified.** The Angular app is published at [/prototype/build/](/prototype/build/) and the write path is proven end-to-end against VADEMO file 6914.\n\nThe right pane now has one spec per layer — **API · Orchestrator · AI**. We're working on the **Orchestrator** layer (the IRIS production); **AI** comes after the production is built and verified.");
  const o = SPECS&&SPECS.layers ? SPECS.layers.orchestrator : null;
  const pend = o ? o.missing.filter(m=>m.kind==="decide") : [];
  addMsg("assistant", !o ? "⚠ The layer specs could not be generated — see the right pane."
    : pend.length ? `**Still to decide for the orchestrator layer:** ${pend.map((m,i)=>`${i+1}. ${m.what.replace(/^decide: /,"")}`).join(" · ")}.\n\nFor each one I'll work the same way: **show you what the legacy code actually does** — quoting the MUMPS and breaking a compound condition into its individual parts — **explain it**, and then **you decide how to modernize** each part: keep it, change it, move it to a different layer, or drop it. Anything that departs from the legacy gets flagged, and after each decision a card shows exactly what was recorded.\n\nReady to start with the first one?`
    : o.complete ? "**The orchestrator spec is complete** — ready for the production build."
    : `**The open questions are decided.** Next: ${(SPECS.stage&&SPECS.stage.next&&(SPECS.stage.next.what||SPECS.stage.next.service))||""}`);
  chatHistory.push({role:"assistant",text:`[intro: Phase 1 built+verified; stage=${SPECS&&SPECS.stage?SPECS.stage.step:"unknown"}; still to decide: ${pend.map(m=>m.id).join(", ")||"none"}; approach = show legacy evidence, explain, developer decides]`});
})();
```

- [ ] **Step 8: Check nothing references removed code**

Run: `grep -n "specMD\|isBlocking\|blockingList\|persist(\|restore()\|LSKEY\|%%GRAPH%%\|CATS\|defaultFor\|oqPolicy\|integration" capability-graph/decide.html`
Expected: no output. If any remain, they belong to removed code — delete them.

Run: `node -e "const h=require('fs').readFileSync('capability-graph/decide.html','utf8'); const s=[...h.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m=>m[1]).pop(); new Function(s); console.log('script parses')"`
Expected: `script parses`

- [ ] **Step 9: Manual browser check**

Restart the server, open `http://localhost:8899/capability-graph/decide.html`, and confirm:
1. Three tabs; Orchestrator is selected; its spec shows ⛔ with missing items and the bulletin under *Side effects — built* with ▢ target items.
2. The status line reads `API 3 services built · 3 proposed · Orchestrator N items missing · AI not started`.
3. The API tab shows 🔨 Build and ⏹ Stop; the other tabs do not. ⬇ Download saves `<layer>.md`.
4. In the chat, defer one open question with a reason → a green **Recorded** card shows `oqPolicy` and `scope` changes, and the Orchestrator tab updates without a reload.
5. Ask the chat for the bulletin's recipients → it quotes the `BULL^ENEQ3` evidence first, and an amber **Legacy evidence — New-equipment MailMan bulletin** card shows the graph's own lines beside the reply; record one value → a card shows `targets.recipients`.
6. Reload the page → the chat transcript resets but the specs and record persist.

- [ ] **Step 10: Commit**

```bash
git add capability-graph/decide.html
git rm capability-graph/decide.template.html
git commit -m "feat: Decide page shows three layer specs and decision cards; browser no longer writes decisions"
```

---

### Task 12: Retire the old spec and verify end to end

**Files:**
- Delete: `capability-graph/spec.md`, `agent/build-decisions.json`

- [ ] **Step 1: Delete the retired files**

`capability-graph/spec.md`'s Phase 1 content now lives in `agent/lib/specs/api.js`, held by `agent/test/fixtures/spec-phase1.md`. `agent/build-decisions.json` is no longer written.

```bash
rm capability-graph/spec.md agent/build-decisions.json
```

- [ ] **Step 2: Run the full test suite**

Run: `cd agent && npm test`
Expected: PASS — all files.

- [ ] **Step 3: Verify the live system**

Restart the server, then:

Run: `ls capability-graph/specs` → Expected: `ai.json ai.md api.json api.md orchestrator.json orchestrator.md`
Run: `grep -c "unmet" capability-graph/specs/orchestrator.md` → Expected: ≥ 1 when the record holds the work-order rule (the 6920 write is proposed, not built)
Run: `curl -s -o /dev/null -w "%{http_code}\n" -X PUT http://localhost:8899/api/decisions` → Expected: `404`

- [ ] **Step 4: Build once from the API spec**

On the Decide page, open the API tab and press 🔨 Build. Expected: the build completes and opens `/prototype/build/`; the confirmation page no longer has the "Ensuing workflows · Phase 2" box; everything else is unchanged.

- [ ] **Step 5: Commit**

```bash
git rm capability-graph/spec.md agent/build-decisions.json
git commit -m "chore: retire the combined spec.md and the build-decisions hand-off file"
```
