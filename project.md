# VistA SE Harness

An AI-assisted workbench for service-enabling legacy VistA. It maps what a legacy workflow actually does — menu
option, routines, FileMan fields, business rules, side effects — into a capability graph of evidence. A developer
then decides, in a chat grounded in that evidence, how each part is modernized. The harness generates a spec for
each layer from those decisions, builds each layer from its spec alone, and verifies what it built against VistA on
the same sandbox data. The long-form vision is in `VistA_Service_Enablement_Workbench_Summary.md`.

*Status as of 2026-11-09.*

---

## Intent

- **Evidence, not assumption.** Discovery records only what the legacy system shows: the installed data dictionaries,
  routine source, menu setup, screen definitions. Each item carries its provenance and evidence.
- **The developer decides.** The legacy leaves some choices to a human (policies, side-effect wiring, what to keep).
  Those are made only in the Decide chat, and recorded in one decisions record — never seeded by a design document
  or by the build.
- **Specs are generated, builds are mechanical.** Three layer specs (API, Orchestrator, AI) are generated from the
  graph, the decisions and what is built. A build reads only its own layer's spec.
- **Verified against the legacy.** Every build proves its result on the VistA sandbox — a real record written and read
  back, a production dry-run, chatbot answers compared with VistA — not with unit tests alone.
- **Dependencies point one way.** A decision in a higher layer never changes a lower one; an orchestrator need the API
  does not meet is reported as an unmet need for Phase 1 work.

## First capability: New Inventory Entry (Engineering, file 6914)

Menu option `ENINVNEW` → `EQAD^ENEQ1`; the ScreenMan-style screens `ENEQ1`–`ENEQ3` (file 6910.9) drive the entry
into the Equipment Inventory file **#6914**. The capability graph is
`capability-graph/new-inventory-entry.json`:

- **38 form fields** across 3 screens, each with its FileMan field, SQL column and evidence;
- **3 open questions** the legacy leaves to a human — work-order policy, PM-schedule enrollment policy, the clerk's
  override on the fixed-asset (FA) report;
- **4 side effects** — work order, PM schedule, financial-asset document, new-equipment bulletin (an email);
- **1 coded business rule** — FA reporting of capitalized NX equipment;
- **13 discovery candidates** (`discoveryCandidates`) — findings from the discovery checks below, each with its
  method and evidence, waiting to be promoted into real items in the Decide chat.

`workbench-demo.html` is the knowledge map handed to the Decide stage; `capability-graph/graph.html` and `map.html`
show the graph and the layer map.

## Discovery

The graph was first built by reading routines, data dictionaries and screens by hand. Three read-only checks on
VADEMO now find what that reading missed. Each one is an experiment under `experiments/`; its probe class was
deleted from VADEMO after use.

| Check | What it finds | Experiment |
|---|---|---|
| **XINDEX** (VistA's own cross-referencer, run through `XINDX7`) | the static call graph from the entry point and the globals each tag sets, kills and reads; the FileMan/Kernel APIs it calls | `experiments/xindex` |
| **Screen-action survey** (SQL over `6910.9` / `6910.97`) | M code stored in the screen definitions and run by indirection, which XINDEX cannot follow — keys, FA locks, direct global sets, hidden calls | `experiments/screen-actions` |
| **One sampled run per workflow** (the shape of `^TMP($J)` plus the process's routine and last global reference, polled every 250 ms) | which screens and branches ran, and which data each prompt touched; it caught the ENEDSPEX key check | `experiments/tmp-sampler` |

What they added, in the graph's `discoveryCandidates`:
- **Rules held in screen data:**
  - key ENEDSPEX guards SPEX;
  - nine fields on a capitalized asset change only through an FA document;
  - ACQ. METHOD gates ASSET VALUE and LEASE COST, cleared by direct global sets that bypass FileMan;
  - a CMR change is backed out while the equipment has an active IT assignment.
- **More of each side effect:**
  - the FA document also writes FAP BALANCES (6915.9), and its validation passes a problem list through
    `^TMP($J,"BAD")` (a candidate service seam);
  - the bulletin is handed to TaskMan;
  - the work order and PM schedule have their own look-up files.
- **A second workflow on the same save:** Multiple Inventory Entry (`ENIN-ENTER-MULTI` → `EQMAD^ENEQ1`).

Candidates are kept out of the spec inputs, so adding one never makes a build out of date. A full runtime trace
(`%SYS.Trace`, `experiments/runtime-trace`) was also tried: it records only a few seconds of events on VADEMO, so the
sampled run takes its place.

## How it works

1. **Decide** — `capability-graph/decide.html`, served by `agent/server.js` on `http://localhost:8899`. Left: a chat
   guide (Claude Haiku 4.5 on AWS Bedrock) that takes one item at a time, quotes the legacy evidence, and records each
   decision through tools; a card shows exactly what was recorded. Right: the three layer specs, regenerated live.
2. **Build, phase by phase** — each phase opens only after the one before it is built and verified:

| Phase | Layer | Built from its spec | Verified by | Status |
|---|---|---|---|---|
| 1 | **API** | REST service `Harness.Equipment.REST` on VADEMO (`/irishealth/Harness/Equipment`) + the Angular entry form (`/prototype/build/`) | a real test record in 6914, read back field by field over SQL | Done |
| 2 | **Orchestrator** | IRIS Interoperability production `EquipmentEntry.Production` in `iris-ai-hub` / INTEROP | one dry-run request: the VistA write stays dry-run, the bulletin email sends for real, unwired side effects stay stubs | Done |
| 3 | **AI** | `EquipmentAI.*` on IRIS AI Hub — an agent with 4 quick-access questions and read-only general SQL behind a guard — plus the Angular chat app (`/prototype/chat/`) | each quick question vs VistA (and, for the high-value question, vs raw values checked row by row), a count question, 159 guard cases, a 3-turn conversation | Done |

The four AI quick-access questions: equipment ageing out in a fiscal year; high-value equipment without a service
contract; JCAHO equipment with a pending inspection; capital-planning totals.

### Around the builds

- **Demo reset** (↺ in the Decide top bar) — a clean teardown on VADEMO, IRIS and locally; the page reopens in
  Phase 1 with nothing built. `npm run preflight` (and the `reset-preflight` skill) checks Docker, IRIS, VADEMO and
  Bedrock first.
- **Restore last good** — every verified build keeps a known-good copy; typing `restore last good` in the chat puts
  all three layers back.
- **Chat ↔ record sync** — the record is the truth. The server corrects a reply that claims what the record does not
  show (nothing recorded, a refused recording, an ungrounded threshold, a "ready" claim while items are missing, a
  change the message did not ask for), re-runs a turn that claimed a recording without making one, and logs every
  correction to `agent/desync-log.jsonl`. A grounding check keeps replies within the current item's evidence.
- **Builds use the current code** — a spec written by a server running older code is regenerated before a build
  reads it, and the Decide page asks for a server restart when the code changed since start.

Details: `agent/README.md`, `harness/README.md` and the playbooks in `harness/`; designs and plans in
`docs/superpowers/`.

## Systems

| System | Role |
|---|---|
| **VADEMO** — VistA instance `VISTA-DIEGO`, reached at `/irishealth` (Atelier `/irishealth/api/atelier`, overridable with `VADEMO_ATELIER_PATH`) | the legacy system: discovery, the REST service, test records, the chatbot's data |
| **`iris-ai-hub`** — local Docker IRIS, namespace INTEROP | the production and the AI layer |
| **AWS Bedrock** — `us.anthropic.claude-haiku-4-5-20251001-v1:0` | the Decide guide and the chatbot |

Hosts, logins and tokens live only in `agent/.env` (git-ignored); see `agent/.env.example`.

## Open items

- **Rebuild needed:** the form's asset value was corrected to TOTAL ASSET VALUE (field 12, not 31.5), and the
  chatbot now compares amounts with `CAST`. Rebuild Phase 1 (🔨 Build), then the AI layer (🔨 Build AI).
- Phase 1 test records written before the field-12 fix hold their asset value in field 31.5; they are kept as is.
- Older 6914 records store amounts as text with cents (`115748.20`). The chatbot's guard requires
  `CAST(column AS DECIMAL(15,2))` for comparing, sorting, MIN and MAX on 12 money columns. Only the high-value quick
  question has a row-by-row reference check so far; the other three could get one.
- In the production, only the bulletin is wired; the work order, PM schedule and FA document stay stubs until their
  targets are decided and built, and the verification's VistA write is a dry-run.
- The Decide guide runs on Bedrock behind the `runAgent()` seam; moving it to IRIS AI Hub (`%AI.Agent`) is planned.
- **Discovery candidates** are not yet shown in the Decide chat. Promoting one (into a field, rule, security item,
  side-effect evidence or a second workflow) is still a manual edit of the graph, and the promoted item then goes
  through the chat like any other.
- **TaskMan on VADEMO is not running tasks**, so the legacy bulletin is queued and never sent there. The
  production's bulletin email does not depend on TaskMan.
- **`%SYS.Trace` on VADEMO** stops recording events a few seconds after it starts; the same calls work on the local
  `iris-ai-hub`. Not yet checked: the `^PERFMON` / `%SYS.MONLBL` state, and a second Windows 2026.1 instance.
- From the long-form vision, not started: more Engineering workflows (Inventory Edit, Display Equipment Record, PM
  schedule, PMI recording) to show where workflows converge on shared capabilities — Multiple Inventory Entry is the
  first one found; differential verification by replaying captured scenarios.

---

## Planned — not started: supply-chain workflows

Earlier milestones for the same harness, kept as stated. Nothing has been built for them yet.

### Glove Inventory Review (read-only)

Identify exact glove catalog items, inspect their inventory-point records, and surface discrepancies between GIP
quantities and the linked supply station's last-reported quantities. No inventory records are changed.

- **VistA elements:** #441 Item Master (catalog identity — medium vs large nitrile gloves), #445 Generic Inventory
  (inventory-point quantities, units, relationships), #445.2 Inventory Transaction (for the second milestone).
- **Key routine:** **PRCPRDIS**, which compares GIP quantities with those last reported by a linked supply station,
  for secondary inventory points with that linkage. Discovery starts at the **PRCP SS QTY DISCREPANCIES** option,
  which may need an adapter rather than being callable as an API.
- **Synthetic fixture:** one secondary inventory point with medium and large nitrile examination gloves; GIP
  12 boxes, station last report 9 boxes. Resolve the item identifiers from File #441, not hardcoded.
- **Workflow:** select an authorized inventory point → search "nitrile gloves" → explicitly select the size →
  review inventory point, unit of issue, GIP quantity, last station quantity and reporting time → show the
  difference without assuming which count is authoritative → link the answer to the VistA records and the legacy
  comparison output. A chat may start the search; a small table suits selection and review.
- **Harness assignment:** discover the option and PRCPRDIS dependencies (menu setup, user context, called routines,
  FileMan definitions, output formatting); build a structured discrepancy inquiry for one authorized secondary
  inventory point; preserve legacy discrepancy semantics and units; evaluate against the existing report on identical
  sandbox data.

| Case | Expected behavior |
|------|------------------|
| Medium and large gloves both exist | Results keep separate item identities |
| GIP 12 boxes; station 9 boxes | Same discrepancy as the legacy PRCPRDIS report |
| Quantities match | Same inclusion/exclusion as the legacy report |
| Supply-station data is missing | Legacy behavior — do not substitute zero |
| User lacks inventory-point access | Access denied |
| Inquiry completes | No business inventory records changed |

### Supply-Movement Transaction

Investigate the glove replenishment workflow: the distribution-order lifecycle, **PRCPOPL** for processing and
**PRCPOPP** for posting. Trace the complete lifecycle and its side effects before writing any spec. PRCPESTO maintains
storage locations but has not been verified to reassign an individual item to a bin — do not use it as a write-back
spec without confirmation.

---

## Development Notes

- Field and global definitions must come from the installed data dictionaries — and a field's meaning from the
  legacy screen or routine that uses it, not its name. (The form's "ASSET VALUE" was first matched by name to
  field 31.5; the screen definition showed it is field 12.)
- Code can live in FileMan data (screen pre/post-actions, input transforms) and run by indirection, where XINDEX does
  not see it. For every new workflow, survey its screens' code and sample one run, as well as running XINDEX.
- The harness evaluates services against legacy output on identical sandbox data — not unit tests in isolation. A
  check that runs the same SQL on both sides proves nothing about that SQL; compare with an independent reading of
  the raw data.
- Decisions are made only in the Decide chat and stored in `agent/decisions.json`. Neither it nor
  `agent/implemented.json` is committed — they are the live state of the demo.
- Writes to VADEMO or IRIS happen through the builds, a restore or a reset. Anything else needs the user's
  go-ahead. Test records in file 6914 are kept.
- After changing code in `agent/`, restart the workbench server (`npm start` in `agent/`); the Decide page warns
  when it is running older code.
- Generated ObjectScript is only compiled on IRIS, so its tests check the generated text: in a postcondition
  (`Quit:cond`, `Continue:cond`) any spaces must sit inside one pair of parentheses.
- **Every new HTML page gets its own favicon, created with the page.** Embed it as an inline SVG data URI in the `<head>` (`<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,…">`), so no extra file has to be served. Match the existing icons (`capability-graph/decide.html`, `workbench-demo.html`): a 32×32 viewBox, a dark rounded tile (`#141b24`, `rx='7'`) and the page palette — blue `#3d9cf5`, green `#7ee787`, light `#e6edf3` — with one simple motif for what the page is. URL-encode `#` as `%23`, `<` as `%3C`, `>` as `%3E` and use single quotes inside the SVG. For a generated page, put the icon in its template (`*.template.html`). Check it reads at 16 px.
