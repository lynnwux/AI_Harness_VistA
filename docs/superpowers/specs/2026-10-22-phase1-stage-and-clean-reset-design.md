# Decide page: a real Phase 1 stage and a clean demo reset — design

**Date:** 2026-10-22
**Status:** draft for review
**Scope:** the Decide stage (`capability-graph/decide.html`), the agent server behind it, the build/restore
runners, and the VADEMO REST service deploy. Builds on the layer-specs design (2026-10-13), the stub-first
production amendment (§4.5 there), and the AI layer design (2026-10-20).

---

## 1. Why

A demo reset is meant to put the Decide page back to the moment the workbench handed the capability over.
The workbench's job is to map the knowledge (the capability graph); **the Decide page is where design and
decisions happen, so nothing is built at hand-off — no REST endpoints and no Angular app.**

Today a reset does not do that. After a reset the page says *"Where we are — ✅ Phase 1 is built and
verified. The Angular app is published at /prototype/build/ …"* and goes straight to Phase 2, because:

- the reset clears only the orchestrator and AI flags (`agent/server.js` `/api/demo/reset`), never Phase 1;
- the stage function (`agent/lib/specs/index.js` `stage()`) has no Phase 1 stage — it always starts at the
  orchestrator;
- the opening message (`decide.html` `openingMessages`) and the chat system prompt (`server.js`) state
  "Phase 1 is built and verified" unconditionally;
- nothing ever records Phase 1 as built: `implemented.api` was seeded by hand, and the API build only
  publishes the Angular app;
- the reset leaves the published app, the VADEMO REST service, the IRIS production, the AI layer and a
  range of local and remote leftovers in place — some of which can stop the next build cycle.

**Success looks like:** press reset → the page is in Phase 1 with nothing built anywhere; press 🔨 Build →
the REST service is deployed to VADEMO, proven with a real record written to file 6914, and the Angular app is
published → only then does Phase 2 open. The cycle can be repeated any number of times without leftovers
from the previous cycle causing a refusal or a failure.

## 2. Goals, non-goals, anti-goals

**Goals**
1. After a reset nothing is built or deployed for any of the three layers, locally or remotely.
2. Phase 1 is a real stage: the page opens in it after a reset, and the API build deploys and verifies the
   REST service before it publishes the Angular app.
3. Phase 2 opens only after Phase 1 is built and verified (same gate shape as AI waiting for the production).
4. No leftover from one cycle can block or break the next: no stuck "running" flag, no orphaned runner, no
   stale cache, no debris directory, no half-swapped known-good copy, no duplicate-serial collision.
5. Every status the page or the chat shows comes from the record (`implemented.json`, status files), never
   from hard-coded text.

**Non-goals**
- Generating the REST service classes from the spec. The service is the existing hand-written
  `harness/Harness.Equipment6914.API.cls` + `harness/Harness.Equipment.REST.cls`; Phase 1 deploys them as-is.
- Building any *proposed* API service (e.g. the 6920 work-order write) — still separate Phase 1 work.
- Deleting 6914 records. Test records written by the Phase 1 build stay (the user's decision, "for now").
- Clearing Mailpit, the dev mail catcher.

**Anti-goals** (failure even if it "works")
- A reset that reports success while something it was meant to remove is still there.
- Any text claiming a layer is built when the record says it is not.
- Deleting the known-good copies — "restore last good" must still work after a reset.
- Removing anything on VADEMO or IRIS that the harness did not create (only `Harness.Equipment*` and its web
  app on VADEMO; only `EquipmentEntry.*`, `EquipmentAI.*` and their settings on IRIS).

## 3. Decisions made by the user (2026-10-22)

| # | Decision |
|---|---|
| U1 | After a reset **no REST endpoints are built** — every API service shows as *proposed*. |
| U2 | A reset **removes the published Angular app** (`prototype/build/`) and the API build log. |
| U3 | **Phase 2 opens only after the Phase 1 build succeeds.** |
| U4 | Phase 1 = **building the REST services and the Angular front end.** |
| U5 | The Phase 1 build is proven by **creating a real test record in file 6914 through the REST service** (and reading it back). |
| U6 | The test record is **left in 6914** after verification. |
| U7 | A reset **removes the REST service classes and their web application from VADEMO.** |
| U8 | A reset is a **clean teardown** of the IRIS side too: stop the production and remove the production and AI classes, web applications, settings, credentials and stored conversations. Known-good copies stay. |
| U9 | **Nothing left behind may prevent the next build cycle.** |
| U10 | The test record is checked **in full by reading it back over Atelier SQL** from `VISTA.EQUIPMENT_INV_6914`; the REST classes stay as-is. |
| U11 | Changing a Phase 1 decision after Phase 1 is built **marks Phase 1 out of date**: it stays built and later phases stay open, but the page says "API changed since build — rebuild" and the production and AI builds refuse until Phase 1 is rebuilt. |
| U12 | Reset also **deletes the old spike class `Harness.EquipmentAPI`** from VADEMO if present; no build redeploys it. |

## 4. The cycle

```
reset ─► Phase 1 (api) ─🔨 Build─► Phase 2 (orchestrator) ─🔨 Build production─► Phase 3 (ai) ─🔨 Build AI─► done
  ▲                                                                                                            │
  └───────────────────────────────────────────────── reset ◄───────────────────────────────────────────────────┘
```

### 4.1 Stage

`stage()` gains a Phase 1 stage ahead of the orchestrator:

- `{ layer: "api", step: "build", next: null }` while Phase 1 is not built **and** verified.
- Once it is, the existing orchestrator → AI stages follow unchanged.
- **Out of date (U11):** Phase 1 is out of date when the API spec's current input hash differs from the one
  recorded at build time (§4.2). The stage does not move back; instead the stage object carries
  `apiOutOfDate: true`, the API tab and agenda show *API changed since build — rebuild*, and the production and
  AI build routes refuse with that message. Rebuilding Phase 1 clears it.

The API spec stays `complete: true` from the start (it has no missing list — its defaults are buildable).
The developer *may* review it in the chat before building (form fields Include/Omit; the "Input requirements
& validation" section the spec already marks for developer review), but nothing is required.
*(Builder's/our call: no forced walk-through, because the user described Phase 1 as "building the REST
services and the Angular front end".)*

### 4.2 The record

`implemented.api` changes shape to match the other layers *(our call)*:

```json
"api": { "built": false, "verified": false, "services": [], "verifiedRecord": null, "builtFrom": null }
```

- `builtFrom` — the API spec's input hash at build time; drives *out of date* (§4.1). It must not feed the
  API spec's own input hash (that would make the spec stale the moment it is built).
- **A failed Phase 1 build clears `built`/`verified`** — once it has started redeploying, what is deployed is
  no longer the verified thing *(our call)*. A failure before step 2 (e.g. stale spec) changes nothing.

- `services` — the three endpoints (`write:6914`, `read:next-ien`, `read:lookup`, same entries as today),
  written only by a successful Phase 1 build.
- `verifiedRecord` — `{ ien, serial, at }` of the test record that proved the write path.
- Every reader of `implemented.api` (API spec `owns.built`/`proposed`, orchestrator needs, input hashes,
  `loadInputs` fallback, tests) moves to `implemented.api.services`. A file still in the old array shape is
  read as "not built" (no services), so the next build simply records the new shape.

After a reset the API spec shows **Owns — built services: none**, and all three endpoints under
*proposed*, next to the existing proposed writes from discovery. The proposed list therefore becomes: the
three Phase 1 endpoints + the discovered side-effect writes.

### 4.3 The Phase 1 build (🔨 Build on the API tab)

One run, in this order (the REST part first, so a VADEMO problem fails in seconds, not after the
multi-minute Angular build):

1. **Read the spec** — regenerate; refuse a stale API spec (as today).
2. **Deploy the REST service to VADEMO** (namespace `VISTA-DIEGO`):
   - upload and compile `Harness.Setup.cls`, `Harness.Equipment6914.API.cls`, `Harness.Equipment.REST.cls`
     over Atelier (`PUT /doc/<cls>?ignoreConflict=1`, `POST /action/compile`);
   - **create or update** the web application `/Harness/Equipment` (dispatch `Harness.Equipment.REST`,
     namespace `VISTA-DIEGO`) through a `Harness.Setup` SqlProc called over Atelier SQL. Today's
     `CreateWebApp` skips an existing app; it must correct a wrong one instead.
3. **Verify the write path** against the VADEMO REST endpoints the server's `/equipment` proxy forwards to
   (`/irishealth/Harness/Equipment/…` — the runner calls them directly, so it needs no running server *(our call)*):
   - `GET /equipment/next-ien` answers;
   - `POST /equipment` with a test record built from the API spec's request contract. Its SERIAL is
     unique per run (e.g. `HARNESS-TEST-<run timestamp>`) so kept records from earlier cycles never trip the
     legacy duplicate-serial check;
   - the record is read back **over Atelier SQL** from `VISTA.EQUIPMENT_INV_6914` (the same query channel the
     server already uses for lookups) and **every posted field** is compared with what was posted, mapping
     form values to storage: set-of-codes → internal code, dates → FileMan dates, pointers and sub-file pointers
     (fund, BOC, SGL) → IENs (U10). The REST service's own `GET /equipment/<ien>` must also answer for the IEN.
   The test record is **left in place** (U6). Its values are valid for every included field type; pointer
   values are picked from live lookup rows.
4. **Build and publish the Angular app** to `prototype/build/` (as today).
5. **Record** — only when 2–4 all succeeded: `implemented.api = { built: true, verified: true, services,
   verifiedRecord }`; save the known-good copy (site **and** the three REST class sources).

The build log shows each step with its outcome, ending with a verification table (endpoint → result) in the
style of the AI build. Any failure stops the run and records nothing.

### 4.4 Demo reset — a clean teardown

Reset becomes a **job** like restore (remote work takes time): `POST /api/demo/reset` starts it, the page
follows `/api/demo/reset/status`, and the chat shows one line per item with ✅ / ✗. The typed-`reset`
confirmation stays; its text is rewritten to say every phase is torn down and only the known-good copies and
the decisions backup are kept.

**Before tearing down:** stop any running build, production build, AI build or restore (killing the whole
process tree), and kill an orphaned runner left from a previous server process (§4.6).

**Remote — VADEMO (`VISTA-DIEGO`)**
- delete the web application `/Harness/Equipment` (new `Harness.Setup` SqlProc, e.g. `DeleteWebApp`);
- delete `Harness.Equipment.REST.cls` and `Harness.Equipment6914.API.cls` (`DELETE /doc/<cls>`), and the old
  spike class `Harness.EquipmentAPI.cls` if present (U12) — an absent class counts as removed;
- `Harness.Setup.cls` stays — it is the tool that creates and deletes the web app *(our call)*;
- 6914 records stay (U6).

**Remote — IRIS (`iris-ai-hub`, namespace `INTEROP`)**
- stop and clean `EquipmentEntry.Production` (only if it is the one running — never stop another production);
- purge the production's messages and event log;
- delete the 12 `EquipmentEntry.*` classes and the 7 `EquipmentAI.*` classes;
- delete the web applications `/equipmententry` and `/equipmentai`;
- delete the `Ens_Config.DefaultSettings` rows for `EquipmentEntry.Production`;
- delete the credentials `EquipmentEntryBulletinSMTP`, `EquipmentAIVademo`, `EquipmentAIBedrock`;
- kill `^EquipmentAI.Config` and `^EquipmentAI.Sessions`, and delete the `%AI.Agent.Session` rows the AI layer
  created.

**Local**
- decisions back to the defaults (a backup is kept, as today; only the newest 5 backups are kept *(our call)*);
- `implemented.json` → nothing built for any layer;
- delete `prototype/build/`, `prototype/chat/`;
- delete the status files: `build-status.json`, `production-status.json`, `ai-status.json`,
  `restore-status.json`;
- delete the build workspaces: `agent/_build/*`, `agent/_production/run-*`, `agent/_production/ai-run-*`,
  leftover `%TEMP%/eqchat-*`;
- delete half-swapped known-good debris (`_known-good/<layer>.new-*`, `.old-*`) — **never** the known-good
  copies themselves;
- delete `decisions.json.tmp` and `interclaw-servers.json` (regenerated by each run);
- server memory: clear the lookup cache, re-read the inventory file, regenerate the specs.

**Partial failure.** Each item is attempted even if an earlier one fails (e.g. VADEMO unreachable). Local
reset always completes. The reset ends `done` only if every item succeeded; otherwise `error`, naming
exactly what could not be removed — never a blanket success (anti-goal). The page still opens in Phase 1,
because the record says nothing is built; and every build tolerates what a failed teardown left behind
(§4.6), so a partial reset never blocks the next cycle.

### 4.5 Restore last good

Restore puts back the last known-good copy of each layer, now including Phase 1's REST service:

- **api:** upload and compile the three REST classes from the known-good copy, create-or-update the web app,
  copy the site back to `prototype/build/`;
- orchestrator and AI: as today.

Restore does **not** mark any layer built (as today), so after a reset + restore the page is still in Phase 1.
A known-good copy saved before this change has no REST classes; restoring it deploys them from `harness/`
instead *(our call)*.

### 4.6 Nothing from one cycle blocks the next (U9)

From the inventory of what a cycle leaves behind (2026-10-22). Each item is a requirement:

| Leftover / hazard | Requirement |
|---|---|
| Production, AI and restore runs make network calls with no timeout and have no Stop; one hung call keeps a "running" flag set, so reset, restore and later builds are refused until a server restart. | Every remote call in every runner has a timeout. Every runner can be stopped (tree kill), and reset stops them (§4.4). |
| The API build runner is spawned detached; after a server restart it keeps running unseen and collides with the next build on `prototype/build/`, its status file and the known-good copy. A cancel can be overwritten by the runner's 1-second ticker. | Each runner watches its parent (the server) and kills its own process tree when the parent is gone, so no runner outlives a server restart *(our call — a pid file risks killing an unrelated process after PID reuse)*. A stop kills the tree first and only then marks the run cancelled, so a cancelled run never writes a non-terminal state afterwards. |
| A hung chat turn blocks the server's one-at-a-time queue, so builds and reset wait behind it forever. | The model call has a timeout; a timed-out turn ends with an error and releases the queue. |
| `inventory-fields.json` is read once at server start but re-read by the AI build's stale check → every AI build fails as "stale" after the file changes. | The server re-reads the inventory on regenerate (and on reset). |
| Lookup lists from VADEMO are cached for the server's lifetime. | Reset clears the cache. |
| Web apps (`/Harness/Equipment`, `/equipmententry`, `/equipmentai`) are created only if missing, so a wrong one is never fixed. | Builds create **or update** them. |
| Known-good swaps can leave `.new-*` / `.old-*` directories; a missing `meta.json` makes restore report "no good copy". | Reset removes the debris; the swap stays atomic. |
| Workspaces under `agent/_production/` are never cleaned; a locked `_build/run-*` (Windows EBUSY) is skipped. | Each build sweeps its own old workspaces (as the API build does); reset removes them all. |
| Kept 6914 test records share a serial → duplicate-serial check on the next verification. | Test serial unique per run (§4.3). |
| Each `iris.py` call opens a new IRIS web session with no logout (~15 per production build), holding licenses until they time out. | The builder confirms whether this can exhaust licenses across repeated cycles and, if so, ends the sessions. |
| `iris.py` ignores `IRIS_USERNAME` and logs in as `superuser` unless the server entry has `username`. | VADEMO is reached with Node `fetch` + Basic auth from `agent/.env` (the channel the server and the 2026-10-22 probe already use), never through `iris.py` — so neither the username gotcha nor `interclaw-servers.json` collisions apply to it *(our call)*. |
| Mailpit keeps old bulletin emails. | The production verification matches only the email sent by its own run. |

### 4.7 Page and chat

- **Opening message** is chosen by stage. In the api stage: *Phase 1 — the REST service on VADEMO and the
  Angular entry app are designed but not built*, plus what 🔨 Build will do (deploy, prove with a test
  record in 6914, publish the app) and that Phase 2 opens after it. When Phase 1 is out of date, the opening
  message and the guide say so before anything else. The two existing messages stay for the
  orchestrator and AI stages; the "Phase 1 is built and verified … write path proven" sentence is shown only
  when `implemented.api` says so, and may cite the verified record's IEN.
- **System prompt:** the "API layer … is built and verified" sentence becomes stage-dependent. In the api
  stage the guide explains the API spec, takes Phase 1 decisions (Include/Omit) if asked, and points to
  🔨 Build; it does not start or offer orchestrator decisions.
- **Tools:** while the stage is `api`, orchestrator- and AI-layer record tools refuse with a message saying
  Phase 2 opens after the Phase 1 build. API-layer tools (field Include/Omit) work in every stage.
- **Agenda line:** `API not built` / `API built ✓`; Orchestrator and AI show *waiting for Phase 1* while
  the stage is api.
- **Buttons:** 🔨 Build production and 🔨 Build AI stay disabled until their stage is reached (as today, but
  the gate now includes Phase 1).
- The reset follows its job status and reloads specs, stage and opening messages when it finishes.

## 5. Constraints

- VADEMO credentials and host come only from `agent/.env` (`VADEMO_URL`, `VADEMO_USER`, `VADEMO_PASSWORD`);
  never written into any file the harness saves (known-good copies, status files, server entries other than
  the git-ignored `interclaw-servers.json`).
- VADEMO is reached over Atelier REST v1 at `$VADEMO_URL/api/atelier/v1/VISTA-DIEGO` (v2 unverified there);
  web apps live in `%SYS` and are managed only through `Harness.Setup` SqlProcs.
- IRIS teardown goes through the existing two channels (Atelier via `iris.py`, `docker exec … iris session`).
- Node's built-in test runner, no new dependencies; remote calls are injectable so tests never touch VADEMO
  or IRIS.

## 6. Risks to settle first

1. ~~Can the VADEMO user create, update and delete a `%SYS` web application through a SqlProc, and delete
   classes over Atelier?~~ **Settled 2026-10-22 by a throwaway probe** (`Harness.ProbeDelete` +
   `/Harness/ProbeDelete`, both removed afterwards): upload, compile, create, `Security.Applications.Modify`,
   `Delete` and `DELETE /doc` all succeeded. The `.env` login runs as `_SYSTEM` with role `%All`.
2. **Which `%AI.Agent.Session` rows belong to the AI layer** — teardown must delete only those.

## 7. Left to the builder

- Exact SqlProc names and signatures in `Harness.Setup`; status-file shapes for the reset job; message
  wording; how the test record's field values are chosen from the request contract (valid for every
  included field type, including pointers and set-of-codes); timeout values; pid-file location.
