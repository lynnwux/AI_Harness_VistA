# Phase 1 stage and clean demo reset — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After a demo reset nothing is built or deployed for any layer; the Decide page opens in Phase 1, whose 🔨 Build deploys the VADEMO REST service, proves it with a real 6914 record read back over SQL, publishes the Angular app, and only then opens Phase 2 — with no leftover from one cycle able to block the next.

**Architecture:** `implemented.api` becomes a `{built, verified, services, verifiedRecord, builtFrom}` record read through one helper module; `stage()` gains an `api/build` stage and an `apiOutOfDate` flag. Two new libs talk to VADEMO (`vademo.js` — Atelier + REST over `fetch`; `rest-service.js` — deploy/remove the Harness service) and one builds/checks the test record (`api-verify.js`). Reset does the local teardown in the server, then spawns `teardown-runner.js` for VADEMO + IRIS, followed by the page like a restore.

**Tech Stack:** Node 22 (CommonJS, Express 4, built-in `fetch`, `node --test`), InterSystems IRIS (Atelier REST v1 on VADEMO, `docker exec … iris session` on `iris-ai-hub`), ObjectScript, plain-JS page `capability-graph/decide.html`.

**Spec:** `docs/superpowers/specs/2026-10-22-phase1-stage-and-clean-reset-design.md` (U1–U12 are the user's decisions; read it first).

## Global Constraints

- Tests: `cd agent && npm test` (`node --test test/*.test.js`). No new dependencies. No test touches VADEMO, IRIS, Docker or Bedrock — every remote call is injected.
- Secrets (`VADEMO_PASSWORD`, `IRIS_AI_HUB_PASSWORD`, `AWS_BEARER_TOKEN_BEDROCK`, `BULLETIN_SMTP_PASSWORD`, `VADEMO_READ_PASSWORD`) never appear in a status file, log line, error message, known-good copy or committed file; redact with `redact()` from `lib/iris-deploy.js`.
- VADEMO: Atelier v1 at `${VADEMO_URL}/api/atelier/v1/VISTA-DIEGO`; REST service at `${VADEMO_URL}/irishealth/Harness/Equipment`; Basic auth from `VADEMO_USER`/`VADEMO_PASSWORD`. Every `fetch` has `signal: AbortSignal.timeout(ms)`.
- IRIS: container `iris-ai-hub`, namespace `INTEROP`. Teardown removes only fixed names: package `EquipmentEntry`, package `EquipmentAI`, web apps `/equipmententry`, `/equipmentai`, credentials `EquipmentEntryBulletinSMTP`, `EquipmentAIVademo`, `EquipmentAIBedrock`, globals `^EquipmentAI.Config`, `^EquipmentAI.Sessions`. VADEMO teardown removes only `/Harness/Equipment`, `Harness.Equipment.REST.cls`, `Harness.Equipment6914.API.cls`, `Harness.EquipmentAPI.cls`. Never a wildcard over anything else (the VADEMO login is `_SYSTEM`/`%All`).
- 6914 test records are never deleted (U6).
- Known-good copies (`agent/_known-good/<layer>/`) are never deleted.
- Match the surrounding code: dense one-line helpers, short comments that state intent, no classes.
- The working tree already holds uncommitted restore/reset work and three test-first tests for an `entryForm` flag (`test/specs.test.js:59-74`, `buildSetup({entryFormBuilt})` in `test/server.test.js`). This plan replaces `entryForm` with `implemented.api`; rewrite those tests, don't keep both.

## Review Focus

1. **Reset with VADEMO or IRIS unreachable** → local reset still completes, the page opens in Phase 1, the teardown status ends `error` naming each item that failed, and the next 🔨 Build still deploys (create-or-update). Pinned in Task 9 (`teardown with VADEMO down…`).
2. **Reset while a build is running** → the runner's process tree is killed first, then the teardown; no status file is left `building`/`starting`. Pinned in Task 9 (`reset stops a running build…`).
3. **Phase 1 build after the developer Omits form fields** → the test record carries only included fields and the comparison checks only those. Pinned in Task 5 (`omitted fields are neither posted nor compared`).
4. **An `implemented.json` in the old array shape** (today's file) → read as "Phase 1 not built", no crash, next build writes the new shape. Pinned in Task 1 (`old array shape reads as not built`).
5. **Teardown run twice / on a fresh environment** → everything already absent counts as removed and the reset ends `done`. Pinned in Task 4 (`removeRestService on an empty VADEMO`) and Task 7 (`parseIrisTeardown treats absent as removed`).

---

### Task 1: The `implemented` record and its readers

**Files:**
- Create: `agent/lib/implemented.js`
- Modify: `agent/lib/specs/api.js:31-46,101`, `agent/lib/specs/orchestrator.js:10`, `agent/lib/specs/ai.js:8`, `agent/lib/specs/index.js:34,97`, `agent/lib/tools.js:140`, `agent/server.js:27`, `agent/implemented.json`
- Test: `agent/test/implemented.test.js` (new), `agent/test/helpers.js`, `agent/test/spec-api.test.js`, `agent/test/graph-evidence.test.js:65`

**Interfaces:**
- Produces:
  - `PHASE1_SERVICES` — the three entries now in `agent/implemented.json` (`write:6914`, `read:next-ien`, `read:lookup`, with `endpoint` and `what` verbatim).
  - `emptyImplemented() → { api: { built:false, verified:false, services:[], verifiedRecord:null, builtFrom:null }, orchestrator:{built:false,verified:false}, ai:{built:false,verified:false} }`
  - `apiRecord(im) → { built, verified, services, verifiedRecord, builtFrom }` — normalized; an array (old shape), a missing `api`, or `built:false` gives the empty record.
  - `apiServices(im) → services[]` — `apiRecord(im).built ? services : []`.
  - `builtApi(services = PHASE1_SERVICES, extra = {}) → api record` with `built:true, verified:true` — for tests and the build runner.
  - `test/helpers.js` `IM` becomes `{ api: builtApi(), orchestrator:{built:false,verified:false}, ai:{built:false,verified:false} }` (drop `entryForm`).

- [ ] **Step 1: Write the failing tests** in `test/implemented.test.js`:
  - `old array shape reads as not built`: `apiRecord({ api: PHASE1_SERVICES })` deep-equals `emptyImplemented().api`; `apiServices({ api: PHASE1_SERVICES })` is `[]`.
  - `apiServices returns the services only when built`: `apiServices({ api: builtApi() }).map(s => s.id)` is `["write:6914","read:next-ien","read:lookup"]`; with `{...builtApi(), built:false}` → `[]`.
  - `the API spec lists the Phase 1 endpoints as proposed until built` (in `spec-api.test.js`): `buildApiSpec(graph, rec(), emptyImplemented())` → `owns.built` is `[]` and `owns.proposed` ids include all three `PHASE1_SERVICES` ids; with `IM` → those three are in `owns.built` and not in `owns.proposed`; the rendered markdown under `## Owns — built services` reads `- none` when nothing is built.
  - Update `graph-evidence.test.js:65` to assert `PHASE1_SERVICES` ids instead of reading `agent/implemented.json`.
- [ ] **Step 2: Run** `node --test test/implemented.test.js test/spec-api.test.js test/graph-evidence.test.js` — Expected: FAIL (`Cannot find module '../lib/implemented'`).
- [ ] **Step 3: Implement** `lib/implemented.js`; switch every `implemented.api` reader listed above to `apiServices(...)`; `proposedServices` returns `PHASE1_SERVICES` mapped to `{ id, what: endpoint + " — " + what, source: "Phase 1 (REST service on VADEMO)" }` followed by the discovered writes, deduped by id; the API input hash (`specs/index.js:34`) hashes `apiServices(implemented)` (so `verifiedRecord`/`builtFrom` never make the API spec stale); `loadInputs` fallback, `getState` fallback and `server.js` `implemented()` fallback use `emptyImplemented()`. Write `agent/implemented.json` as `emptyImplemented()` (2-space JSON + newline).
- [ ] **Step 4: Run** `npm test` — Expected: only stage-related failures remain (fixed in Task 2); everything else PASS.
- [ ] **Step 5: Commit** `feat: implemented.api is a built/verified record; Phase 1 endpoints start as proposed`

### Task 2: The Phase 1 stage, "out of date", and the gates

**Files:**
- Modify: `agent/lib/specs/index.js:72-89,102`, `agent/server.js:297-323,371-388,408-419`
- Test: `agent/test/specs.test.js:59-74` (rewrite), `agent/test/server.test.js:263-285` (rewrite `buildSetup`), new server tests

**Interfaces:**
- Consumes: `apiRecord`, `builtApi`, `emptyImplemented` (Task 1).
- Produces:
  - `designHash(apiSpec) → string` — sha256 of `canon({ graph: apiSpec.inputs.graph, decisions: apiSpec.inputs.decisions })`. Exported from `lib/specs/index.js`.
  - `stage(specs, implemented)`: `{ layer:"api", step:"build", next:null }` while `!(api.built && api.verified)`; otherwise today's result plus `apiOutOfDate: true` when `typeof api.builtFrom === "string" && api.builtFrom !== designHash(specs.api)` (a built record without `builtFrom` is never out of date).
  - `buildSetup({ apiBuilt = true, orchestratorVerified = true, aiQuestions, agentCalls })` in `server.test.js`: writes `implemented.json` with `api: apiBuilt ? builtApi() : emptyImplemented().api`; drop `entryFormBuilt` and `publishedDir`.
  - `createApp` passes `spawnImpl` and `statusFiles.build` to the API build route (today it uses `spawn` and `STATUS_FILE` directly).
  - Refusal texts (exact):
    - `PHASE2_CLOSED = "Phase 2 opens after the Phase 1 build — press 🔨 Build on the API tab first"`
    - `API_OUT_OF_DATE = "the API layer changed since it was built — press 🔨 Build on the API tab to rebuild Phase 1 first"`

- [ ] **Step 1: Write the failing tests**
  - `specs.test.js` `stage starts at Phase 1 until the API layer is built and verified`: for `im` in `[emptyImplemented(), { ...IM, api: { ...builtApi(), verified:false } }, { ...IM, api: PHASE1_SERVICES }]` → `stage(...)` deep-equals `{ layer:"api", step:"build", next:null }`; with orchestrator built but API not → layer `"api"`; with `IM` → layer `"orchestrator"`.
  - `a Phase 1 decision after the build marks it out of date`: `im = { ...IM, api: builtApi(PHASE1_SERVICES, { builtFrom: designHash(generate(inputs(rec())).api) }) }` → `stage(...).apiOutOfDate` is `undefined`; same `im` with `rec({ dec: { "FLD.model": "Omit" } })` → `apiOutOfDate === true` and `layer === "orchestrator"`.
  - `building Phase 1 never makes the API spec look stale`: `inputHashes("api", …)` equal for `builtApi()` and `builtApi(PHASE1_SERVICES, { verifiedRecord: { ien: 9 }, builtFrom: "x" })`.
  - `server.test.js` `the production build is refused (409) until Phase 1 is built`: `buildSetup({ apiBuilt:false, orchestratorVerified:false })` with the `DONE` decisions → `POST /api/build/production` 409, error matches `/Phase 2 opens after the Phase 1 build/`, no proc.
  - `production and AI builds are refused while Phase 1 is out of date`: implemented with `builtFrom: "stale"` → both routes 409 with `API_OUT_OF_DATE`.
  - `the API build route uses the injected spawn and status file, and regenerates on exit`: `POST /api/build` → `procs[0].args` ends with `build-runner.js`, `statusFiles.build` exists with `state:"starting"`; after writing `implemented.json` with `builtApi()` and `procs[0].emit("exit",0)`, `GET /api/specs` → `stage.layer === "orchestrator"`.
  - Update `GET /api/specs serves all three layers` (`server.test.js:24`) — its `setup()` must write a temp `implemented.json` with `IM`, never point at `agent/implemented.json`.
- [ ] **Step 2: Run** `node --test test/specs.test.js test/server.test.js` — Expected: FAIL on the new tests.
- [ ] **Step 3: Implement** `designHash` and the `stage()` changes; in `registerBuildRoutes` take `{ spawnImpl, buildStatus }` and add `serially(() => regenerate())` on exit (as the production route does); the production route refuses on `stage.layer === "api"` (PHASE2_CLOSED) and on `stage.apiOutOfDate` (API_OUT_OF_DATE) before the completeness check; the AI route refuses on `apiOutOfDate` first.
- [ ] **Step 4: Run** `npm test` — Expected: PASS except the decide-page tests that assume Phase 1 is built (fixed in Task 11); note them.
- [ ] **Step 5: Commit** `feat: Phase 1 stage gates Phase 2; a changed API layer blocks later builds until rebuilt`

### Task 3: Tools refuse Phase 2/3 decisions in Phase 1; stage-dependent system prompt

**Files:**
- Modify: `agent/lib/tools.js:336-350`, `agent/server.js:55-107`
- Test: `agent/test/tools.test.js`, `agent/test/server.test.js`

**Interfaces:**
- Consumes: `stage`, `generate` (already imported in tools.js), `emptyImplemented`.
- Produces: `PHASE1_ONLY_MSG = "refused: Phase 1 is not built yet — orchestrator and AI decisions open after the Phase 1 build. Press 🔨 Build on the API tab first; form fields (Include/Omit) can be decided now."` exported from `lib/tools.js`.

- [ ] **Step 1: Write the failing tests** (`tools.test.js`):
  - `in Phase 1 the orchestrator and AI tools refuse and change nothing`: `ctx = { graph, decisions: rec(), implemented: emptyImplemented() }`; each of `resolveOpenQuestion {id:"OQ.WorkOrderPolicy",mode:"Defer",policy:"x"}`, `setBuildScope`, `setTarget`, `bindRuleTerms`, `setQuickQuestion {id:"AIQ.AgingOutFY",keep:true}`, `setDisposition {nodeId:"SIDE.Bulletin",option:"Event"}` returns `{ ok:false, message: PHASE1_ONLY_MSG }` and `ctx.decisions` deep-equals `rec()`.
  - `form fields can be decided in every stage`: `setDisposition {nodeId:"FLD.model",option:"Omit"}` with `emptyImplemented()` → `ok:true`; `getState`, `explainOption`, `explainMapping` still answer.
  - `server.test.js` `the guide is told Phase 1 is not built, and never that it is`: with `apiBuilt:false`, `t.systemPrompt()` matches `/PHASE 1 IS NOT BUILT/` and does not match `/built and verified/` in the API sentence; with `apiBuilt:true` it matches `/The API layer .* is built and verified/`.
- [ ] **Step 2: Run** `node --test test/tools.test.js test/server.test.js` — Expected: FAIL.
- [ ] **Step 3: Implement** in `runTool`: compute `stage(generate({ graph, record: normalize(decisions), implemented: ctx.implemented || emptyImplemented(), inventory: ctx.inventory || null }), …)` only for the record-changing tools; refuse when `layer === "api"` and the tool is one of `resolveOpenQuestion, setBuildScope, setTarget, bindRuleTerms, setQuickQuestion`, or `setDisposition` on a node whose `categoryOf` is not `"data"`. In `systemPrompt()`, replace the fixed line 62 sentence: in the api stage emit a block starting `PHASE 1 IS NOT BUILT.` that says the REST service on VADEMO and the Angular entry app are designed but not built; the guide explains the API spec, takes form-field Include/Omit decisions if asked, points to 🔨 Build on the API tab (which deploys the REST service, proves it with a test record in 6914, then publishes the app), and does not start or offer orchestrator or AI decisions. Otherwise keep today's sentence, and when `stage.apiOutOfDate` add one line: the API layer changed since it was built — say so first and point to 🔨 Build on the API tab. Skip the orchestrator missing-list block in the api stage.
- [ ] **Step 4: Run** `npm test` — Expected: PASS (decide-page exceptions from Task 2 only).
- [ ] **Step 5: Commit** `feat: Phase 2/3 tools refuse until Phase 1 is built; the guide's prompt follows the stage`

### Task 4: VADEMO client and the REST service deploy / remove

**Files:**
- Create: `agent/lib/vademo.js`, `agent/lib/rest-service.js`
- Modify: `harness/Harness.Setup.cls` (`CreateWebApp` → create or update; add `DeleteWebApp`)
- Test: `agent/test/vademo.test.js`, `agent/test/rest-service.test.js`

**Interfaces:**
- Produces (`lib/vademo.js`):
  - `vademoFromEnv(env, { fetchImpl = fetch, timeoutMs = 30000 } = {}) → client`; throws `"VADEMO connection not configured — set VADEMO_URL, VADEMO_USER and VADEMO_PASSWORD (see agent/.env.example)"` when any is missing.
  - `client.putClass(name, text) → void` — `PUT /doc/<name>?ignoreConflict=1` body `{enc:false, content: text.replace(/\r/g,"").split("\n")}`.
  - `client.compile(names) → void` — `POST /action/compile` body `names`; throws `"compile errors: …"` listing `status.errors` and any `console` line matching `/ERROR/`.
  - `client.deleteClass(name) → "deleted" | "absent"` — `DELETE /doc/<name>`; HTTP 404 → `"absent"`.
  - `client.query(sql, parameters = []) → rows[]` — `POST /action/query`; throws on `status.errors`.
  - `client.rest(method, p, body) → { status, json }` — `${VADEMO_URL}/irishealth/Harness/Equipment${p}`.
  - Every thrown message is redacted of the password and never contains the `Authorization` header.
- Produces (`lib/rest-service.js`):
  - `HARNESS_DIR` (repo `harness/`), `REST_CLASSES = ["Harness.Setup.cls","Harness.Equipment6914.API.cls","Harness.Equipment.REST.cls"]`, `REST_WEB_APP = "/Harness/Equipment"`, `REST_TEARDOWN_CLASSES = ["Harness.Equipment.REST.cls","Harness.Equipment6914.API.cls","Harness.EquipmentAPI.cls"]`.
  - `deployRestService(client, { sourceDir = HARNESS_DIR, log = () => {} }) → { classes: REST_CLASSES, webApp: "created" | "updated" }` — upload all three, compile in one call, then `SELECT Harness.Setup_CreateWebApp() AS r`; anything other than `/^(created|updated): \/Harness\/Equipment$/` throws with the returned text.
  - `removeRestService(client, { sourceDir = HARNESS_DIR }) → [{ item, outcome }]` — never throws. Order: upload + compile `Harness.Setup.cls` (so the delete works on a box that lost it), `SELECT Harness.Setup_DeleteWebApp() AS r` → item `web app /Harness/Equipment`; then `deleteClass` each of `REST_TEARDOWN_CLASSES` → item `class <name>`. Outcomes: `"removed"`, `"absent"` (for `absent:` / 404), or `"failed: <message>"`.
- `Harness.Setup.cls`: `CreateWebApp()` — when the app exists, `Security.Applications.Modify(name, .p)` with `DispatchClass`, `NameSpace`, `CookiePath`, `Description` set as today and returns `"updated: /Harness/Equipment"`; when absent, clone `/FileMan/Lynn` as today and return `"created: /Harness/Equipment"`. New `DeleteWebApp() As %String [ ProcedureBlock = 0, SqlProc ]` → `"deleted: /Harness/Equipment"` | `"absent: /Harness/Equipment"` | `"ERROR: …"` (same `New $namespace` / `%SYS` pattern).

- [ ] **Step 1: Write the failing tests** with a fake `fetchImpl` that records `(method, url, body)` and answers per route:
  - `putClass/compile/deleteClass/query speak Atelier v1 on VISTA-DIEGO`: URLs are `${VADEMO_URL}/api/atelier/v1/VISTA-DIEGO/doc/Harness.Setup.cls?ignoreConflict=1` etc.; every request carries `Authorization: Basic …` and an `AbortSignal`; `deleteClass` on 404 → `"absent"`.
  - `errors never carry the password`: fake answers 500 with body echoing the password → thrown message contains `***`, not the password.
  - `deployRestService uploads the three classes, compiles once, creates or updates the web app`: calls in order PUT×3 → compile `[REST_CLASSES]` → query `SELECT Harness.Setup_CreateWebApp() AS r`; `"updated: /Harness/Equipment"` → `webApp:"updated"`; `"ERROR: no source app"` → throws matching `/ERROR: no source app/`.
  - `removeRestService on an empty VADEMO`: DeleteWebApp answers `absent: /Harness/Equipment`, every DELETE 404 → four results, all `outcome:"absent"`.
  - `removeRestService keeps going after a failure`: the query throws → web app item `failed: …`, class items still attempted.
  - `Harness.Setup.cls has create-or-update and delete` (static): the file text contains `ClassMethod DeleteWebApp()`, `Security.Applications).Modify(`, `"updated: "`, `"absent: "`.
- [ ] **Step 2: Run** `node --test test/vademo.test.js test/rest-service.test.js` — Expected: FAIL (modules missing).
- [ ] **Step 3: Implement** both modules and the `Harness.Setup.cls` change.
- [ ] **Step 4: Run** `npm test` — Expected: PASS (same known exceptions).
- [ ] **Step 5: Commit** `feat: deploy and remove the VADEMO REST service over Atelier`

### Task 5: The Phase 1 test record and its SQL read-back

**Files:**
- Create: `agent/lib/api-verify.js`
- Test: `agent/test/api-verify.test.js`

**Interfaces:**
- Consumes: a `client` (Task 4 shape); the API spec (`api.json`: `detail.pages[].fields[]` with `k`, `fno`, `type`, `table`).
- Produces:
  - `COLUMN` — form key → 6914 SQL column, exactly: `serial:SERIAL_, manufacturer:MANUFACTURER, mfgrEquipmentName:MFGR__EQUIPMENT_NAME, model:MODEL, equipmentCategory:EQUIPMENT_CATEGORY, typeOfEntry:TYPE_OF_ENTRY, acquisitionMethod:ACQUISITION_METHOD, acquisitionDate:ACQUISITION_DATE, vendorPointer:VENDOR_POINTER, originalAssetValue:ORIGINAL_ASSET_VALUE, warrantyExpDate:WARRANTY_EXP__DATE, replacingEntryNumber:REPLACING_ENTRY_NUMBER, categoryStockNumber:CATEGORY_STOCK_NUMBER, servicePointer:SERVICE_POINTER, useStatus:USE_STATUS, parentSystem:PARENT_SYSTEM, location:LOCATION, lockoutRequired:LOCKOUT_REQUIRED, conditionCode:CONDITION_CODE, stationNumber:STATION_NUMBER, vaPmNumber:VA_PM_NUMBER, serviceContract:SERVICE_CONTRACT, serviceContractCost:SERVICE_CONTRACT_COST, localIdentifier:LOCAL_IDENTIFIER, physicalInventoryDate:PHYSICAL_INVENTORY_DATE, jcaho:JCAHO, controlledItem:CONTROLLED_ITEM, investmentCategory:INVESTMENT_CATEGORY, fundControlPoint:FUND_CONTROL_POINT, fund:FUND, budgetObjectCode:BUDGET_OBJECT_CODE, standardGeneralLedger:STANDARD_GENERAL_LEDGER, equityAccount:EQUITY_ACCOUNT, subaccount:SUBACCOUNT`.
  - `TEST_VALUES` (non-pointer keys): `mfgrEquipmentName:"TEST ITEM - NOT REAL", model:"TEST-MODEL", typeOfEntry:"NX", acquisitionMethod:"O", acquisitionDate:"2000-01-01", originalAssetValue:1, warrantyExpDate:"2000-01-01", useStatus:"1", lockoutRequired:"YES", conditionCode:"1", stationNumber:"TEST", vaPmNumber:"TEST-00001", serviceContract:"YES", serviceContractCost:2, localIdentifier:"WORKBENCH-TEST", physicalInventoryDate:"2000-01-01", jcaho:"YES", controlledItem:"YES", investmentCategory:"1", fundControlPoint:"TEST", equityAccount:"3299"`.
  - `STORED_YESNO = { lockoutRequired:{YES:"1",NO:"0"}, controlledItem:{YES:"1",NO:"0"}, jcaho:{YES:"Y",NO:"N"}, serviceContract:{YES:"Y",NO:"N"} }` (what `Harness.Equipment.REST.Enum` stores).
  - `runIdOf(date) → "YYYYMMDDhhmmss"` (UTC); `testSerial(runId) → "HT-" + runId`.
  - `fmDate(iso) → string` — `"2000-01-01"` → `"3000101"` (`(year-1700)` + `MM` + `DD`).
  - `operatorFields(apiSpec) → fields[]` — every page field except `type:"readonly"`.
  - `async pickPointers(client, fields) → { [key]: ien }` — for each field with `table`: `SELECT TOP 1 IEN AS ien FROM VISTA.<table>`; throws `"no rows in VISTA.<table> to point the test record at"` when empty.
  - `testRecord(apiSpec, pointers, runId) → payload` — keys from `operatorFields` only: `serial` = `testSerial(runId)`, pointer keys from `pointers`, others from `TEST_VALUES`.
  - `expectedRow(payload) → { [COLUMN]: string }` — dates via `fmDate`, YES/NO via `STORED_YESNO`, pointers and codes as strings, numbers as `String(n)`.
  - `compareRow(expected, row) → { ok, rows: [{ column, expected, stored, ok }] }` — compare `String(v ?? "").trim()`; numeric strings compare as numbers.
  - `async verifyWritePath(client, apiSpec, { runId, log = () => {} }) → { ien, serial, rows }` — `rest("GET","/NextIEN")` must answer `status:"OK"`; `rest("POST","/Equipment6914", payload)` must answer `status:"OK"` with `equipmentIEN`; `rest("GET","/Equipment6914/"+ien)` must answer 200; `query("SELECT " + columns + " FROM VISTA.EQUIPMENT_INV_6914 WHERE IEN = ?", [String(ien)])`; mismatch throws `"the test record (IEN n) did not read back as written: COLUMN expected X, stored Y; …"`. Never deletes the record.

- [ ] **Step 1: Write the failing tests**:
  - `fmDate converts ISO to FileMan`: `fmDate("2000-01-01") === "3000101"`, `fmDate("2026-10-22") === "3261022"`.
  - `the test record covers every included operator field with a unique serial`: from `generate(inputs(rec())).api` → `Object.keys(testRecord(...)).sort()` equals `Object.keys(COLUMN).sort()`; `serial` is `HT-20261022153000` for `runIdOf(new Date("2026-10-22T15:30:00Z"))`.
  - `omitted fields are neither posted nor compared`: with `rec({ dec: { "FLD.model": "Omit", "FLD.fund": "Omit" } })` → payload has no `model`/`fund`, `expectedRow` has no `MODEL`/`FUND`, and `pickPointers` was not asked for `NX_FUND6914_6`.
  - `expectedRow maps form values to storage`: `JCAHO:"Y"`, `LOCKOUT_REQUIRED:"1"`, `ACQUISITION_DATE:"3000101"`, `MANUFACTURER:"<picked ien>"`, `ORIGINAL_ASSET_VALUE:"1"`.
  - `verifyWritePath posts, reads back and passes` (fake client answering the stored row) → `{ ien: 12345, serial: "HT-…" }`; the client saw no DELETE.
  - `verifyWritePath names every mismatch`: stored `MODEL:""` → throws matching `/MODEL expected TEST-MODEL, stored /`.
- [ ] **Step 2: Run** `node --test test/api-verify.test.js` — Expected: FAIL (module missing).
- [ ] **Step 3: Implement** `lib/api-verify.js`.
- [ ] **Step 4: Run** `npm test` — Expected: PASS (same known exceptions).
- [ ] **Step 5: Commit** `feat: Phase 1 test record, written through the REST service and read back over SQL`

### Task 6: The Phase 1 build runner

**Files:**
- Modify: `agent/build-runner.js` (whole `main`)
- Test: `agent/test/build-runner.test.js` (new)

**Interfaces:**
- Consumes: `vademoFromEnv`, `deployRestService`, `REST_CLASSES`, `HARNESS_DIR` (Task 4); `verifyWritePath`, `runIdOf` (Task 5); `builtApi`, `emptyImplemented`, `PHASE1_SERVICES` (Task 1); `designHash` (Task 2); `buildAngularApp`, `saveKnownGood` (existing); `watchParent` (Task 8 — until then call nothing).
- Produces: `main(deps = {}) → Promise<status>` with injectable `{ paths = DEFAULT_PATHS, statusFile = STATUS, outDir = OUT, workRoot = WORK_ROOT, knownGoodRoot = KNOWN_GOOD_ROOT, env = process.env, vademo = vademoFromEnv(env), buildApp = buildAngularApp, now = () => new Date() }`. Phases (labels shown in the UI, in order): `Reading spec`, `Deploying the REST service to VADEMO`, `Verifying the write path in file 6914`, `Preparing workspace`, `Scaffolding Angular + installing deps`, `Generating app from spec`, `Compiling (ng build)`, `Publishing to /prototype/build/`. Status gains `verification: [{ check, result }]` (rows: `REST service deployed`, `web app /Harness/Equipment <created|updated>`, `GET next IEN`, `POST test record → IEN n`, `read back N fields over SQL`). Exports `{ buildConfig, angularFiles, main, STATUS_FILE: STATUS }`.

- [ ] **Step 1: Write the failing tests** (fake `vademo`, fake `buildApp` that writes `index.html` into `outDir`, temp `paths`/dirs, a real `api.json` from `writeSpecs`):
  - `a successful Phase 1 build deploys, verifies, publishes, then records`: status `state:"done"`; `implemented.json` `api` deep-equals `builtApi(PHASE1_SERVICES, { verifiedRecord: { ien, serial, at }, builtFrom: designHash(apiSpec) })` (compare fields, `at` any ISO string); orchestrator/ai entries untouched; known-good `api` copy has dirs `site` and `rest` with the three `REST_CLASSES` files.
  - `the REST service fails before the Angular build starts`: `deployRestService` compile throws → `state:"error"`, `buildApp` never called, `implemented.api.built === false`.
  - `a failed rebuild clears built`: start with `api: builtApi()`, make `verifyWritePath` fail → `implemented.api` deep-equals `emptyImplemented().api`.
  - `a stale spec changes nothing`: tamper `api.json` inputs → `state:"error"` matching `/stale/`, `implemented.json` byte-identical, no VADEMO call.
  - `nothing secret in the status`: env password `"fake-vademo-pass-123"` echoed by a failing fake → status file text has no `fake-vademo-pass-123`.
- [ ] **Step 2: Run** `node --test test/build-runner.test.js` — Expected: FAIL.
- [ ] **Step 3: Implement**. After the stale check and before any VADEMO call, if `implemented.api.built`, write `emptyImplemented().api` into `implemented.json` (a rebuild in flight is not the verified thing). Record `{...builtApi(PHASE1_SERVICES, {...})}` with read-modify-write of `implemented.json` only after publish. `saveKnownGood("api", { dirs: { site: outDir, rest: <temp dir holding copies of REST_CLASSES from HARNESS_DIR> }, meta: { url: "/prototype/build/", restClasses: REST_CLASSES } }, knownGoodRoot)`. Keep the existing workspace sweep and the ticker.
- [ ] **Step 4: Run** `npm test` — Expected: PASS (same known exceptions).
- [ ] **Step 5: Commit** `feat: Phase 1 build deploys the REST service, proves it in 6914, then publishes the app`

### Task 7: IRIS teardown script; web apps create-or-update in the production and AI builds

**Files:**
- Create: `agent/lib/teardown.js`
- Modify: `agent/production-runner.js:103-118` (`sessionScript`), `agent/ai-runner.js:102-104` (`aiSettingsScript`)
- Test: `agent/test/teardown.test.js`, `agent/test/production-runner.test.js`, `agent/test/ai-runner.test.js`

**Interfaces:**
- Consumes: `PKG`/`WEB_APP` from `lib/production.js` and `lib/ai-hub.js`, `CREDENTIALS` from `lib/ai-hub.js`, `CREDENTIAL_ID` (export it from `production-runner.js`).
- Produces:
  - `irisTeardownScript() → string` for `iris session IRIS`, writing one marker line per item, in this order: `STOP:<stopped|not running|ERROR …>` (stop + `CleanProduction` only when `GetProductionStatus` names `EquipmentEntry.Production`), `MESSAGES:<n>` (delete `Ens.MessageHeader` rows whose `MessageBodyClassName %STARTSWITH 'EquipmentEntry.'` or `'EquipmentAI.'`), `EVENTLOG:<n>` (delete `Ens_Util.Log` rows whose `SourceClass %STARTSWITH` either package), `SETTINGS:<SQLCODE>` (the `Ens_Config.DefaultSettings` delete already in `bulletinSettingsScript`), `AISESSIONS:<n>` (the `^EquipmentAI.Sessions` → `%AI.Agent.Session` loop already in `aiSettingsScript:115` — this settles design §6.2: only sessions the AI layer recorded are deleted), `AICONFIG:killed`, `PKG:EquipmentEntry:<ok|absent|ERROR …>` and `PKG:EquipmentAI:…` (`$System.OBJ.DeletePackage(pkg, "/deleteextent")`; absent when `##class(%Dictionary.PackageDefinition)` has no classes), `CRED:<id>:<deleted|absent>` for the three credentials, then `zn "%SYS"` and `WEBAPP:<name>:<deleted|absent|ERROR …>` for `/equipmententry` and `/equipmentai`.
  - `parseIrisTeardown(stdout) → [{ item, outcome }]` — one entry per expected marker; a missing marker → `failed: no answer from IRIS`; `absent`/`not running`/`0` counts → `"absent"`; `ERROR …` → `"failed: …"`; otherwise `"removed"`.
  - `sessionScript` / `aiSettingsScript`: when the web app exists, `Security.Applications.Modify` with the same properties and write `WEBAPP:updated`; when absent, create as today (`WEBAPP:created`). `checkSettingsMarkers` and the production runner accept `updated`.

- [ ] **Step 1: Write the failing tests**:
  - `the teardown script names only the harness's own things`: script contains `DeletePackage("EquipmentEntry"`, `DeletePackage("EquipmentAI"`, each credential id, `"/equipmententry"`, `"/equipmentai"`, `^EquipmentAI.Config`; contains no `DeletePackage("Ens`, no `Purge(` (which would purge every production's messages).
  - `parseIrisTeardown treats absent as removed`: an output where every marker says `absent`/`not running`/`0` → every outcome is `"absent"`; output `""` → every item `failed: no answer from IRIS`; `WEBAPP:/equipmentai:ERROR #921` → that item `failed: ERROR #921`.
  - `the production and AI scripts update an existing web app`: both scripts contain `Security.Applications).Modify(` and `WEBAPP:updated`; `checkSettingsMarkers("WEBAPP:updated\nCONFIG:set\nVADEMO:stored\nBEDROCK:stored\nSESSIONS:cleared 0\n")` returns `[]`.
- [ ] **Step 2: Run** `node --test test/teardown.test.js test/production-runner.test.js test/ai-runner.test.js` — Expected: FAIL.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run** `npm test` — Expected: PASS (same known exceptions).
- [ ] **Step 5: Commit** `feat: IRIS teardown script; builds correct an existing web app`

### Task 8: Runner hygiene — timeouts, stop, parent watchdog, fresh inventory

**Files:**
- Create: `agent/lib/runner-control.js`
- Modify: `agent/production-runner.js:180,205`, `agent/ai-runner.js` (`main`'s `_fetch` default), `agent/lib/bedrock.js:23`, `agent/build-runner.js`, `agent/restore-runner.js`, `agent/server.js` (cancel routes, `inventory` re-read in `regenerate`, `_production` sweep)
- Test: `agent/test/runner-control.test.js`, `agent/test/server.test.js`, `agent/test/bedrock.test.js`

**Interfaces:**
- Produces (`lib/runner-control.js`):
  - `killTree(pid, { spawnSyncImpl = spawnSync, platform = process.platform } = {}) → void` — synchronous: `taskkill /PID <pid> /T /F` on win32, `process.kill(-pid,"SIGKILL")` elsewhere; ignores "not found".
  - `watchParent({ ppid = process.ppid, intervalMs = 2000, isAlive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return false; } }, onGone = () => killTree(process.pid) } = {}) → stop()` — calls `onGone` once when the parent is gone.
  - `timedFetch(fetchImpl, ms) → (url, opts) => fetchImpl(url, { ...opts, signal: AbortSignal.timeout(ms) })`.
  - `sweepWorkspaces(dir, { keep = [] }) → string[]` — removes every entry of `dir` not in `keep`, skipping locked ones; returns removed names.
- Timeouts (ms): production front-door POST `60000`, Mailpit poll `10000`, AI-runner fetches `120000`, Bedrock `converse` `120000`.
- Server: `POST /api/build/production/cancel`, `/api/build/ai/cancel`, `/api/restore/cancel` → `killTree(proc.pid)` **then** mark the status `cancelled`; the existing `/api/build/cancel` also kills first, then marks. `reconcileExit` leaves `cancelled` alone. `regenerate()` re-reads `paths.inventory` each time.
- Every runner calls `watchParent()` at the top of its `require.main === module` branch; the production and AI runners call `sweepWorkspaces(path.join(__dirname,"_production"), { keep: [<this run's dir>] })` before writing classes.

- [ ] **Step 1: Write the failing tests**:
  - `killTree uses taskkill /T /F on Windows`: fake `spawnSyncImpl` records `["taskkill",["/PID","42","/T","/F"]]`.
  - `watchParent fires once when the parent dies`: `isAlive` true, true, false (fake timers or `intervalMs: 5`) → `onGone` called exactly once.
  - `timedFetch passes an AbortSignal`: fake fetch receives `opts.signal` instanceof `AbortSignal`.
  - `converse gives up after its timeout` (`bedrock.test.js`): fake `fetchImpl` that never resolves but honours `signal` + a `timeoutMs: 20` option → rejects with a message matching `/timed out|aborted/i` (add `{ fetchImpl, timeoutMs }` options to `converse`).
  - `stopping a production build kills it first, then marks it cancelled, and the exit leaves it cancelled` (`server.test.js`, inject `killTreeImpl`): order of events is `kill` then status `cancelled`; after `procs[0].emit("exit",1)` the status is still `cancelled`.
  - `a changed inventory file is picked up without a restart`: rewrite `paths.inventory`, call a chat turn, then `GET /api/specs` → the AI spec's input hash equals `inputHashes("ai", loadInputs(paths)).inventory`.
- [ ] **Step 2: Run** `node --test test/runner-control.test.js test/server.test.js test/bedrock.test.js` — Expected: FAIL.
- [ ] **Step 3: Implement**; `createApp` takes `killTreeImpl = killTree`.
- [ ] **Step 4: Run** `npm test` — Expected: PASS (same known exceptions).
- [ ] **Step 5: Commit** `fix: every remote call times out, every runner can be stopped, runners die with the server`

### Task 9: Demo reset — stop, local teardown, remote teardown job

**Files:**
- Create: `agent/teardown-runner.js`
- Modify: `agent/lib/teardown.js` (add `localTeardown`), `agent/server.js:156-179`, `agent/README.md` (`## Demo reset`)
- Test: `agent/test/teardown-runner.test.js`, `agent/test/teardown.test.js`, `agent/test/server.test.js:436-480` (rewrite the three reset tests)

**Interfaces:**
- Consumes: `removeRestService`, `vademoFromEnv` (Task 4); `irisTeardownScript`, `parseIrisTeardown` (Task 7); `killTree` (Task 8); `irisSession`, `redact`, `SERVER` (`lib/iris-deploy.js`); `emptyImplemented` (Task 1).
- Produces:
  - `localTeardown({ agentDir, repoRoot, knownGoodRoot, statusFiles, decisionsFile, tmpDir = os.tmpdir(), keepBackups = 5 }) → [{ item, outcome }]` — deletes: `<repo>/prototype/build`, `<repo>/prototype/chat`, the four status files + `teardown-status.json` of the previous reset, `<agent>/_build/*`, `<agent>/_production/*`, `<knownGood>/<layer>.new-*` and `.old-*` (never `<knownGood>/<layer>`), `<tmp>/eqchat-*`, `<agent>/decisions.json.tmp`, `<agent>/interclaw-servers.json`; prunes `decisions.backup-*.json` beside `decisionsFile` to the newest `keepBackups`. Outcome per item `removed`/`absent`/`failed: …`; never throws.
  - `teardownAll({ statusFile, env = process.env, vademoImpl = () => vademoFromEnv(env), irisSessionImpl = irisSession }) → Promise<status>` in `teardown-runner.js` — status `{ state: "tearing down"|"done"|"error", step, log, results: [{ where: "VADEMO"|"IRIS", item, outcome }], error }`; runs `removeRestService` then `irisSessionImpl(SERVER, irisTeardownScript(), { secrets })` → `parseIrisTeardown`; each side's failure is recorded as one `failed:` result per item of that side, and the other side still runs; `done` only if no outcome starts with `failed`. Exports `{ teardownAll, STATUS_FILE }` (`agent/teardown-status.json`).
  - `POST /api/demo/reset` (still queued with `serially`): (1) `killTreeImpl` every running `buildProc`/`productionProc`/`aiProc`/`restoreProc`/`teardownProc` and mark their status files `cancelled`; (2) back up and reset decisions (as today); (3) write `emptyImplemented()`; (4) `localTeardown(...)`; (5) clear the lookup cache (`registerVistaRoutes` returns `{ clearCache }`), re-read the inventory, `regenerate()`; (6) spawn `teardown-runner.js` with `spawnImpl` → `teardownProc`. Response `{ ok: true, backup, local: [...], teardown: { started: true, statusUrl: "/api/demo/reset/status" } }`. While `teardownProc` runs, every build route and restore answer 409 `"the demo reset is still tearing down — wait for it to finish"`.
  - `GET /api/demo/reset/status` → the teardown status file, or `{ state: "idle", step: "", log: [], results: [] }`.
  - README `## Demo reset` rewritten to: every phase torn down (VADEMO REST service and web app, IRIS production and AI layer, published apps, build logs and workspaces), decisions back to defaults with a backup (newest 5 kept), known-good copies and 6914 records kept; running builds are stopped first; progress follows `/api/demo/reset/status`.

- [ ] **Step 1: Write the failing tests**:
  - `localTeardown removes leftovers and keeps the known-good copies` (temp tree with each listed path, plus `_known-good/api/meta.json`, and 7 backups) → listed paths gone, `_known-good/api/meta.json` present, 5 newest backups remain.
  - `teardown with VADEMO down still tears down IRIS and reports both` (`teardown-runner.test.js`): `vademoImpl` throws `"VADEMO connection not configured…"` → VADEMO results all `failed: …`, IRIS script still run, `state:"error"`, `error` names the VADEMO items.
  - `teardown of an empty world is done`: VADEMO fake answers `absent` everywhere, IRIS fake prints every marker as absent → `state:"done"`.
  - `reset: nothing built anywhere, the page opens in Phase 1` (rewrite of `server.test.js:436`): `buildSetup({ aiQuestions: ALL_KEPT })` → reset → decisions are defaults, backup kept, `implemented.json` deep-equals `emptyImplemented()`, `GET /api/specs` → `stage` deep-equals `{ layer:"api", step:"build", next:null }`, `procs.at(-1).args` ends with `teardown-runner.js`.
  - `reset stops a running build, then tears down` (rewrite of `server.test.js:462`): start the AI build → reset answers 200 (not 409); `killTreeImpl` got the AI proc's pid before the teardown runner was spawned; `statusFiles.ai` says `cancelled`.
  - `builds wait while the reset tears down`: after reset (teardown proc not exited) `POST /api/build` and `/api/build/production` → 409 matching `/still tearing down/`; after `emit("exit",0)` `POST /api/build` starts.
  - `reset clears the lookup cache`: fake VADEMO list (inject `fetchImpl` into `registerVistaRoutes` via `createApp({ vademoFetch })`) answers `[A]` then `[A,B]`; `/lookup/VENDOR440?all=1` → 1 item; reset; again → 2 items.
- [ ] **Step 2: Run** `node --test test/teardown.test.js test/teardown-runner.test.js test/server.test.js` — Expected: FAIL.
- [ ] **Step 3: Implement**; `createApp` gains `{ agentDir = __dirname, repoRoot = ROOT, knownGoodRoot = KNOWN_GOOD_ROOT, vademoFetch = fetch }` so tests point everything at temp dirs.
- [ ] **Step 4: Run** `npm test` — Expected: PASS (same known exceptions).
- [ ] **Step 5: Commit** `feat: demo reset is a clean teardown of every phase, locally, on VADEMO and on IRIS`

### Task 10: Restore last good puts the REST service back

**Files:**
- Modify: `agent/restore-runner.js:33-67`
- Test: `agent/test/restore-runner.test.js`

**Interfaces:**
- Consumes: `vademoFromEnv`, `deployRestService`, `HARNESS_DIR` (Task 4).
- Produces: `restoreAll({ …, vademoImpl = () => vademoFromEnv(env) })`; `restore.api(kg)` = `deployRestService(vademoImpl(), { sourceDir: kg.dirs.rest || HARNESS_DIR })` then copy `site`; notes `"  REST service uploaded and compiled; web app /Harness/Equipment <created|updated>"` and, for an old copy, `"  this copy holds no REST classes — deployed them from harness/"`. Restore still never writes `implemented.json`.

- [ ] **Step 1: Write the failing tests**:
  - `restoring Phase 1 deploys the REST service from the copy, then the site`: `saveKnownGood("api", { dirs: { site, rest } })` → fake VADEMO saw PUTs for the three files with the copy's text, then `apiOut/index.html` is the copy's.
  - `an old Phase 1 copy without REST classes deploys them from harness/`: copy with only `site` → PUT bodies equal `harness/<name>` content; log has the note.
  - `restore never marks a layer built`: an `implemented.json` beside the run is byte-identical after `restoreAll`.
- [ ] **Step 2: Run** `node --test test/restore-runner.test.js` — Expected: FAIL.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run** `npm test` — Expected: PASS (same known exceptions).
- [ ] **Step 5: Commit** `feat: restore last good redeploys the VADEMO REST service with the entry form`

### Task 11: The Decide page follows the stage

**Files:**
- Modify: `capability-graph/decide.html` (`defaultTab` ~211, `renderRight` button rules ~265-275, `agendaHtml` 287-294, `openingMessages` 318-337, reset handler 473-484, boot 605-615)
- Test: `agent/test/decide-page.test.js`

**Interfaces:**
- Consumes: `/api/specs` `stage` (`layer:"api"`, `apiOutOfDate`), `/api/demo/reset` response, `/api/demo/reset/status`.
- Produces (page functions, exported to the test VM): `openingMessages(specs)`, `defaultTab(specs)`, `agendaHtml(specs, aiBuilt)`, `RESET_PROMPT`, `resetSummary(status)`.
  - Api stage opening, first message (exact lead): `**Where we are — Phase 1, the API layer: designed, not built.** The REST service on VADEMO (file 6914) and the Angular entry app are specified on the API tab; nothing is deployed yet.` Second message: `**Next: 🔨 Build on the API tab.** It deploys the REST service to VADEMO, proves the write path with a real test record in file 6914 (read back field by field), then publishes the entry app. Phase 2, the **Orchestrator** layer, opens after that build succeeds. You can review the form fields first — tell me which to include or omit.`
  - Orchestrator/AI stage openings keep today's text; the `write path is proven end-to-end` sentence appends ` (test record IEN <n>)` when `SPECS.layers.api` carries it — add `verifiedRecord` to the `/api/specs` api layer payload in `server.js:117`.
  - `apiOutOfDate` → a first opening message `**⚠ The API layer changed since it was built.** Press 🔨 Build on the API tab to rebuild Phase 1 — the production and AI builds stay disabled until then.`, and the same text as a banner on every tab.
  - `defaultTab`: `"api"` in the api stage, `"ai"` in the ai stage, else `"orchestrator"`.
  - Agenda: `API <span class="rdy">built ✓</span>` when built and not out of date, `API <span class="blk">changed since build</span>` when out of date, `API <b>not built</b> · 3 services proposed` otherwise; Orchestrator and AI show `waiting for Phase 1` in the api stage.
  - 🔨 Build production / 🔨 Build AI disabled with title `PHASE2_CLOSED`/`API_OUT_OF_DATE` text in the api stage / when out of date.
  - `RESET_PROMPT` (exact): `"DEMO RESET — this tears down every phase.\n\nThe REST service and its web app are removed from VADEMO, the IRIS production and the AI layer are removed from IRIS, the published apps and build logs are deleted, and every decision goes back to the defaults. Kept: the known-good copies (\"restore last good\" still works), a backup of your decisions, and the test records in file 6914.\n\nType  reset  to confirm:"`.
  - Reset handler: on `ok`, reload the specs and the chat (no `location.reload()` until the teardown ends), follow `/api/demo/reset/status` every 2 s with one line per result (`✅ VADEMO · class Harness.Equipment.REST.cls — removed`, `✗ … — failed: …`, `— … — absent`), ending `✅ Reset finished — nothing is built; Phase 1 is next.` or `✗ Reset finished with failures — <error>. Nothing is marked built; the next build replaces what is left.`; then reload the page.
  - Boot intro history line uses the stage: api → `Phase 1 (API) not built; working on Phase 1`.

- [ ] **Step 1: Write the failing tests** (`decide-page.test.js`, `apiSpecs(record, implemented)` as today):
  - `in the api stage the opening says Phase 1 is not built, offers the build, and opens the API tab`: `apiSpecs(rec(), emptyImplemented())` → text matches `/Phase 1, the API layer: designed, not built/` and `/🔨 Build on the API tab/`, does not match `/built and verified/`; `defaultTab(...) === "api"`.
  - `the orchestrator opening is only shown once Phase 1 is built`: `apiSpecs(rec(), IM)` → matches `/Phase 1 is built and verified/`.
  - `an out-of-date API layer is announced first`: implemented with `builtFrom: "x"` → first message matches `/changed since it was built/`.
  - `the agenda says API not built and later phases wait`: `agendaHtml(apiSpecs(rec(), emptyImplemented()), false)` matches `/API <b>not built<\/b>/` and `/waiting for Phase 1/`.
  - `the reset prompt says every phase is torn down and what is kept` — `RESET_PROMPT` matches `/tears down every phase/`, `/known-good/`, `/6914/`; `confirmReset` still requires typing `reset`.
  - `resetSummary lists every result and the verdict`: a status with one `failed` → contains `✗` line and `Reset finished with failures`.
  - Fix the existing AI/orchestrator opening tests to pass `IM` (Phase 1 built).
- [ ] **Step 2: Run** `node --test test/decide-page.test.js` — Expected: FAIL.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run** `npm test` — Expected: all PASS, no known exceptions left.
- [ ] **Step 5: Commit** `feat: the Decide page opens in Phase 1 after a reset and follows the teardown`

### Task 12: Live cycle on VADEMO and IRIS (needs the user's go-ahead — it writes to both)

**Files:** none changed unless a check fails (then fix in the owning task's files and add a test).

- [ ] **Step 1: Ask the user** before running anything: this writes a test record to 6914 and removes/redeploys the REST service and the IRIS layers.
- [ ] **Step 2: Start the server** `cd agent && npm start`; open `http://localhost:8899/capability-graph/decide.html`.
- [ ] **Step 3: Reset** (↺, type `reset`). Expected: chat opens in Phase 1 on the API tab; teardown lines end `✅ Reset finished`; `GET ${VADEMO_URL}/irishealth/Harness/Equipment/NextIEN` → 404; Atelier `GET /doc/Harness.Equipment.REST.cls` → 404; in IRIS `##class(Security.Applications).Exists("/equipmententry")` → 0, `GetProductionStatus` not `EquipmentEntry.Production`; `prototype/build/` absent.
- [ ] **Step 4: Reset again** immediately. Expected: every item `absent`, `✅ Reset finished`.
- [ ] **Step 5: 🔨 Build on the API tab.** Expected: verification table with 5 rows all ✅, `implemented.json` `api.built:true` with `verifiedRecord.ien`; `SELECT SERIAL_ FROM VISTA.EQUIPMENT_INV_6914 WHERE IEN = ?` returns `HT-…`; the published app saves a record through `/equipment`; the chat now opens Phase 2.
- [ ] **Step 6: Omit a form field in the chat.** Expected: banner `changed since it was built`; 🔨 Build production disabled; rebuild Phase 1 → banner gone.
- [ ] **Step 7: IRIS session count** — before and after a production build, in `%SYS`: `SELECT COUNT(*) FROM %SYS.ProcessQuery WHERE ClientIPAddress IS NOT NULL` (or the license count from `$SYSTEM.License.LUConsumed()`). If a build leaves more than 5 extra consumed license units that outlive 2 minutes, stop and report to the user with the numbers — do not change `iris.py` (it belongs to the interclaw skill).
- [ ] **Step 8: Report** each step's outcome to the user, including any failure verbatim.
