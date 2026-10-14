# Workbench: three layer specs (piece 1 of 3) — design

**Date:** 2026-10-13
**Status:** draft for review
**Scope:** the VistA Service Enablement Workbench's Decide stage (`capability-graph/decide.html`
and the agent server behind it). Pieces 2 (orchestrator build) and 3 (AI layer) are separate
designs that consume what this piece produces.

---

## 1. Purpose

Today the Decide chat fills in one `spec.md` that mixes three build phases, and only the first
phase has a build. That caused three concrete failures:

- The chat jumped from "open questions resolved" to "move to Phase 3?" — there was no place to
  collect the production's integration details and nothing that builds the production.
- The chat summarised decisions from memory and reported decisions the user never made, because
  decision outcomes from the development session had been written into its instructions.
- The Phase 1 build works out its own configuration from the raw decisions, so what is built can
  drift from the spec the user reviewed.

This piece replaces the single spec with **three layer specs — API, Orchestrator, AI — generated
from one source of truth**, makes the chat work through one layer at a time from a computed list
of what is missing, and makes every recorded decision visible exactly as recorded.

**Success criteria**

1. Each layer's build reads only its own spec, and that spec is byte-for-byte the object the
   user reviewed.
2. A decision in a higher layer never changes a lower layer's spec.
3. The chat can only report what the record says; every change it records is shown to the user
   as generated from the record.
4. The orchestrator spec says exactly what is still missing before the production can be built.

---

## 2. Governing rules

These are fixed. They come from the user, not from this design.

| Rule | Consequence |
|---|---|
| **Decisions come only from the user in the front-end Decide chat.** Nothing authored in a development session may seed or bias them. | The chat's instructions describe the method only — never an outcome, threshold, or "worked answer". Specs are generated from the record alone. |
| **The truth is the legacy source code and the data dictionary**, not any earlier modern prototype (e.g. `Vista-Engineering-IRIS` / `Equipment.*`). | All legacy evidence in the graph cites a routine and line or a DD field. |
| **Dependencies point one way.** A lower layer never changes because of a higher layer's decision. | The API spec is built from the graph and Phase-1 decisions only. Higher specs list *needs* from lower layers; unmet needs block, they are never written back. |
| **Phase 1 is legacy discovery plus a REST service proposal.** | The API spec proposes a service for every write discovery found, regardless of later decisions. |
| **Side effects the legacy calls unconditionally are mandatory in the production** (today: the new-equipment bulletin). | Discovery surfaces it: the graph records `legacyInvocation: "unconditional"` with the citing call sites (`ENEQ1 ADDEQ`, `ENEQ3 EQMAS` line 56). The tools refuse Drop/Defer for such items. Only *how* they are implemented is decided in the chat. |
| **A notification's legacy message is its template.** | Discovery records the bulletin's subject, body, placeholders and recipients from BULLETIN file 3.6 and `BULL^ENEQ3`; the orchestrator spec shows it as the starting point for the modern message, with what each placeholder depends on. |
| **No secrets in specs or records.** | No field exists for credentials; they remain Management Portal settings. |

---

## 3. Architecture and data flow

```
 capability graph   ─┐                                          ┌─▶ specs/api.json + api.md ──────────▶ API build (existing 🔨)
 decisions record   ─┼─▶  agent/lib/specs/  (one generator)    ─┼─▶ specs/orchestrator.json + .md ────▶ production build (piece 2)
 implemented.json   ─┘    runs on every recorded change         │
                          and immediately before any build      └─▶ specs/ai.json + ai.md ─────────────▶ AI build (piece 3)
                                     │
                                     └─▶ missing list ─▶ chat (asks for the next item) · page (shows ▢ items)
```

**Inputs** — exactly three, all files:

| Input | Path | Holds | Written by |
|---|---|---|---|
| Capability graph | `capability-graph/new-inventory-entry.json` | legacy evidence only — including which side effects the legacy calls unconditionally, and the bulletin's message template | discovery |
| Decisions record | `agent/decisions.json` | what the user decided in the front-end chat | chat tools only |
| Implemented services | `agent/implemented.json` (new) | what actually exists and runs (built endpoints; later, production status) | builds / seeded |

**Generator** — `agent/lib/specs/` exports `generate({ graph, record, implemented })` returning
`{ api, orchestrator, ai }`. Each value is a structured object (§5) and a
`render(spec)` turns it into markdown. The server writes `capability-graph/specs/<layer>.json`
and `<layer>.md`:

- on server start,
- after every chat turn that changed the record,
- immediately before starting any build.

**Outputs are the only build inputs.** The structured JSON and the markdown come from the same
object, so what the user reviews is what is built. The browser no longer generates any spec.

**Decisions are written only by the chat tools.** `PUT /api/decisions` is removed from both the
page and the server (`GET` remains); the right pane is read-only. `POST /api/build` ignores any
request body and builds from the server's own record.

---

## 4. Layer spec content

Every layer spec has the same four sections:

| Section | Meaning |
|---|---|
| **Builds** | what this layer's build produces |
| **Owns** | contracts this layer defines — described only here |
| **Uses** | contracts from lower layers — by reference only, never restated |
| **Needs from lower layers** | services this layer requires; each marked met or **unmet** (unmet blocks this layer's build) |

### 4.1 API spec

- **Builds:** the REST data service on VADEMO and the Angular app (screens, fields, controls —
  the configuration `buildConfig()` in `agent/build-runner.js` derives today).
- **Owns:**
  - built services listed in `implemented.json` (today: `POST /equipment`,
    `GET /equipment/next-ien`, `GET /lookup/{file}`) with the 6914 request/response contract;
  - **proposed services** — one for every write discovery found in the legacy workflow. Each
    graph side effect with a `writes` block yields a proposal, e.g. *"write file 6920 (incoming
    inspection work order) — from `IIWO^ENWONEW3` — proposed, not built"*.
- **Uses / Needs:** none (bottom layer).
- **Never contains:** operator prompts for open questions, the side-effect list, or anything else
  derived from a higher layer's decisions. (Today's Phase 1 build includes both; they are
  removed — §7.)

### 4.2 Orchestrator spec

- **Builds:** the IRIS production in container `iris-ai-hub`, namespace `INTEROP`: a front door,
  the orchestrator, one operation per built side effect (the bulletin always), every outbound
  operation dry-run first.
- **Owns:** the production's front-door request/response, including a per-side-effect outcome;
  the rules (from resolved open questions, with field bindings).
- **Uses:** API: the 6914 create contract.
- **Needs from lower layers:** for each built side effect, the API service it requires (§4.4).
- **Deployment:** routing the Angular app's saves through the production is an orchestrator
  deployment step (the dev server's forwarding target changes); the app itself does not.

Per side effect, the orchestrator spec shows:

1. **Decision** — disposition and resolution, quoted verbatim from the record;
2. **Legacy evidence** — the routine, line, and what it actually does (from the graph);
3. **Target details** — recorded values, or ▢ items still missing;
4. **Dry-run** — on, until enabled in piece 2.
5. **Legacy message template** (notifications only) — subject, body, each placeholder's source,
   legacy recipients, and a ⚠ note for every placeholder whose value depends on something
   outside the notification (another side effect's outcome, operator identity). It is the
   starting point the chat offers for the `content` and `recipients` details, never a decision.

Deferred side effects are listed under *Not built*, with the recorded reason. Security keys
(`ENEDPM`, `ENFACS`) appear as recorded, with the operator-identity gap stated: no clerk
identity reaches the pipeline, so key checks cannot yet be enforced.

### 4.3 AI spec

The four sections exist and are marked *not yet designed (piece 3)*. **Uses:** the orchestrator
front door. **Needs:** read endpoints for analytics — to be designed in piece 3.

### 4.4 Missing items (▢)

The generator produces `missing: [{ layer, id, what }]`. Item types:

| Applies to | ▢ items |
|---|---|
| Open question with no recorded resolution | "decide" |
| Open question resolved as Business rule / Required input | "bind the policy's data words to fields" until `ruleBindings[oq]` is recorded |
| Built side effect that writes a VistA file (`targetKind: vistaWrite`) | `writePath` (how it is written), `fields` (which fields and values), `operatorValues` (where values the clerk used to type now come from) |
| Built side effect that notifies (`targetKind: notification`) | `channel`, `recipients` (no default), `content` |
| Built side effect with disposition **Integration** (external system) | `system`, `endpoint`, `trigger`, `mapping`, `settings` (non-secret) |

**Which keys apply.** If the side effect's disposition is **Integration**, the external-system
keys apply; otherwise the keys for its graph `targetKind`. Every target also records `via`
(`vista` | `iris` | `external`) — where the work is performed.

**Needs.** A built side effect with a graph `writes` block, or whose recorded target has
`via: "vista"`, needs an API service. The need is **met** only if `implemented.json` lists that
service; otherwise it is **unmet** and shown as *"requires Phase 1 work — not decidable here"*.

**Field bindings** are validated against the API spec's 6914 request contract (operator-entered
and server-populated fields not omitted): a rule may only use data the orchestrator actually
receives. A word that has no field there is itself an unmet need.

---

## 5. Data shapes

### `agent/decisions.json`

```jsonc
{
  "dec":          { "<nodeId>": "<disposition | open-question mode>" },
  "oqPolicy":     { "OQ.x": "the policy statement, or for Defer the reason" },
  "scope":        { "SIDE.x": "Build now" | "Defer" },
  "targets":      { "SIDE.x": { "via": "vista|iris|external", "<detail key>": "<value>" } },
  "ruleBindings": { "OQ.x": { "<word in the policy>": "<DD field number>" } }
}
```

- An open question **blocks** when `oqPolicy[id]` is empty. The untouched default (mode `Defer`,
  no text) therefore blocks; a Defer chosen in the chat records its reason and does not.
- `targets` replaces `integration` (currently empty) — it holds target details for any built side
  effect, not only external integrations. Only the keys in §4.4 for that side effect's kind are
  accepted.

### `agent/implemented.json`

```json
{ "api": [
    { "id": "write:6914",    "endpoint": "POST /equipment",         "what": "create a file-6914 record" },
    { "id": "read:next-ien", "endpoint": "GET /equipment/next-ien", "what": "next IEN, display-only" },
    { "id": "read:lookup",   "endpoint": "GET /lookup/{file}?q=",   "what": "pointer-file search" } ],
  "orchestrator": { "built": false, "verified": false } }
```

Service ids are what needs match against: a side effect that writes file *F* needs
`write:F`; one whose target is `via: "vista"` without a write needs `call:<routine>`; a
Required-input question needs `prompt:<question id>`. Piece 2 updates `orchestrator`. The AI layer is offered only when `built` and `verified` are both
true.

### `capability-graph/specs/<layer>.json`

```jsonc
{
  "layer": "api | orchestrator | ai",
  "inputs": { "graph": "<sha256>", "decisions": "<sha256>", "implemented": "<sha256>" },
  "builds": [ ... ], "owns": [ ... ], "uses": [ ... ],
  "needs":  [ { "what": "...", "from": "api", "met": false } ],
  "missing": [ { "id": "...", "what": "..." } ],
  "complete": false,
  "detail": { /* layer-specific; for api = the Angular build config: capability, command, pages */ }
}
```

`inputs` hashes make staleness detectable: a build refuses to start if the hashes do not match
the current input files.

### Graph additions — legacy evidence

Each side effect gains `targetKind`, `legacyInvocation` (`"unconditional"` when every path through
the option calls it — mandatory in the production — otherwise `"conditional"`), and an evidence
list of `{ routine, line, says }`, read from the routine source on VADEMO (Atelier
`GET /doc/<ROUTINE>.int`). A notification also gains `messageTemplate` — `{ source, sender,
subject, body[], params: [{ n, value, ifBlank?, dependsOn? }], recipients }` — read from its
BULLETIN file 3.6 entry; `dependsOn` names another side effect or `operatorIdentity`.

| Side effect | Source | Evidence to capture |
|---|---|---|
| `SIDE.WorkOrder` (`vistaWrite`, file 6920) | `IIWO^ENWONEW3` (line 5) | shop chosen from site incoming-inspection section → item's responsible shop → temp section, clerk asked if blank or holds `ENEDPM`; fields written: 6 = `Incoming Inspection`, 17 = `AVERAGE`, 32 = `PENDING`/`IN PROGRESS` by shop, 10 = `TODAY` for receiving shops, 6920.035 = `I1`, 18 = equipment, 3 = location (from 6914 fld 24); clerk-entered 16 technician, 7 contact, 8 phone, 40 comments |
| `SIDE.Bulletin` (`notification`, **unconditional**: `ENEQ1 ADDEQ` `S DA=ENNXL D BULL^ENEQ3`; `ENEQ3 EQMAS` line 56) — template from BULLETIN 3.6 `EN NEW EQUIPMENT` (IEN 114): subject `NEW EQUIPMENT: ENTRY #|1|`, 9 body lines, params 1–7; `|7|` depends on the FA step, `|2|` on operator identity; MailMan also delivers to the bulletin's own groups (`CLICKAAH`) | `BULL^ENEQ3` (line 60) | bulletin `EN NEW EQUIPMENT`, sender `AEMS/MERS`; recipients = mail group `EN NEW EQUIPMENT <station>` else `EN NEW EQUIPMENT`, each counted only if it exists **and has at least one member** (`CHKMGRP`, MAIL GROUP file 3.8); **not sent if neither qualifies**; content = IEN, entering user's name (from `DUZ`), equipment name, category, service, station, "Item is [NOT] capitalized NX. It was [NOT] reported to FAP." |
| `SIDE.PMSchedule` (`vistaWrite`, sub-file 6914.04) | `ENEQPMP` (lines 12–34) | the item's equipment category's standard PM schedule (`^ENG(6911,cat,4)`) is offered; if the clerk accepts it is copied to `^ENG(6914,ien,4)`; gated by key `ENEDPM` plus a prompt; no value or capitalization condition |
| `SIDE.FinancialAsset` (`vistaWrite`, file 6915.2) | `^ENFAACQ` (read 2026-10-13) | validates the item via `^ENFAVAL` into temporary global `^TMP($J,"BAD",ien)` and aborts on any problem; creates an FA DOCUMENT LOG entry in 6915.2; fills STATION NUMBER if blank, normalizes TOTAL ASSET VALUE (fld 12, node 2 piece 3) to two decimals and stores it on the code sheet; adjusts the FAP balance; transmits the code sheet via `^ENFAXMT`; may create an adjustment voucher |

---

## 6. The chat and recording

**Order.** The server derives the chat's stage from the orchestrator spec's missing list and
`implemented.json`, and puts the stage and the next missing item into the chat's instructions:

1. open questions → 2. field bindings → 3. target details per built side effect →
4. unmet needs — reported as "requires Phase 1 work", not decided in this stage →
5. only when `missing` is empty **and** every need is met: *"Orchestrator spec complete — ready
   for the production build."*

The AI layer is never offered until `implemented.orchestrator.built && verified`.

**Every item follows show → explain → ask → record**: quote the legacy evidence, explain it in
plain language (decomposing compound conditions), ask how the user wants to modernize it, record
the answer and name what departs from the legacy.

**Tools** (`agent/lib/tools.js`):

| Tool | Behaviour |
|---|---|
| `getState` | returns the record view: every disposition, recorded resolutions with policy text, each side effect's status, the missing list, needs, current stage. The chat must call it before any summary or status claim. |
| `resolveOpenQuestion` | records mode + policy (for Defer, the reason). Sets the gated side effect's scope: Defer → out of the build; otherwise → in. |
| `setDisposition` / `setBuildScope` | refuse Drop / Defer for any side effect discovery marked `legacyInvocation: "unconditional"`. |
| `setTarget` (replaces `setIntegration`) | records target details; never changes a disposition; accepts only the keys valid for that side effect's kind. |
| `bindRuleTerms` (new) | records `{ word: field }` for a resolved open question; each field must exist in the API spec's request contract. |

**Decision cards.** The server snapshots the record before each chat turn and diffs it after.
`POST /api/agent/chat` returns `recorded: [{ id, label, field, before, after }]`; the page renders
one card per change. Cards come from the record, never from the chat's text.

**Instructions hygiene.** The system prompt contains the method, the current stage, the next
missing item, and the record view. It must never contain a decision outcome, threshold, or
example answer.

---

## 7. Page and Phase 1 build changes

**`capability-graph/decide.html`**

- Right pane: three tabs — **API · Orchestrator · AI** — each showing the server-generated
  markdown with ▢ items and its own download button (replaces "⬇ spec.md").
- Layer status line replaces "x/3 open questions resolved", e.g. *API ✓ built · Orchestrator:
  4 items missing, 1 unmet need · AI: not started*.
- 🔨 Build and ⏹ Stop live on the API tab. Orchestrator and AI tabs show no build control until
  pieces 2 and 3.
- **Single file.** `decide.template.html` becomes the only `decide.html`; the embedded-graph copy
  and the `file://` fallback are removed (the served page already fetches the graph, and the chat
  requires the server).

**`agent/build-runner.js`**

- Reads `capability-graph/specs/api.json` (its `detail`) instead of deriving from the graph and
  decisions. Refuses to start if the spec's input hashes are stale.
- Per the one-way rule, the generated app no longer includes Required-input prompts or the
  side-effect list. With current decisions only the side-effect list disappears.

**Retired:** `capability-graph/spec.md` (stale combined snapshot of 2026-10-01).

---

## 8. Error handling

- **Generation fails** (invalid graph or record): the last good spec files are kept; the page and
  chat show the reason; builds refuse to start.
- **Stale spec:** a build whose spec hashes do not match current inputs refuses to start.
- **Incomplete orchestrator spec:** piece 2's build must refuse to start while `missing` is
  non-empty or any need is unmet. Stated here so the contract exists before piece 2 does.
- **Tool refusals:** Drop/Defer of a mandatory item; a binding to a field outside the API request
  contract; a target key outside the allowed set. Each returns a reason the chat must relay.
- **Record writes** go to a temporary file then rename, so a crash cannot leave a half-written
  record.

---

## 9. Testing

Node's built-in test runner (`node --test`), no new dependencies. Fixtures: the current graph
and hand-built decision records.

1. **One-way rule:** varying any open-question, side-effect, target, or binding decision leaves
   `api.json` byte-identical.
2. **No leaked outcomes:** with PM deferred, the orchestrator spec contains no `50,000` and no PM
   rule; every rule, threshold, and policy string in any spec appears verbatim in the record; the
   generated chat instructions contain no policy string at all except those quoted from the record.
3. **Blocking:** untouched open question blocks; Defer with reason does not; Business rule with
   empty policy blocks.
4. **Mandatory:** `setDisposition(SIDE.Bulletin, Drop)` and `setBuildScope(SIDE.Bulletin, Defer)`
   are refused.
5. **Missing list:** a built work order lists `writePath`, `fields`, `operatorValues`, and the
   binding for its rule; recording them clears each; deferred side effects appear as not built.
6. **Needs:** the work order's 6920 write is unmet while `implemented.api` lacks it, met once added.
7. **Decision cards:** a known before/after record produces exactly the expected change list.
8. **Phase 1 equivalence:** the app generated from `api.json` matches today's generated files
   except for the two removed parts.
9. **Manual (browser):** three tabs render; a card appears after a decision; the chat walks one
   open question and one target detail.

---

## 10. Consequences for the current record

With today's decisions (work order = Business rule *"Create incoming inspection work order if
TYPE OF ENTRY = NX OR cost ≥ $50,000"*; PM and FA = Defer without a reason), the first generated
orchestrator spec will show:

- PM and FA as **undecided** until redecided in the chat;
- the work order needing field bindings (*TYPE OF ENTRY*, *cost*) and its target details;
- an **unmet need**: the 6920 write service is proposed in the API spec but not built — the
  production cannot be built until that Phase 1 work is done;
- the bulletin — mandatory because discovery found the legacy calls it unconditionally — needing
  channel, recipients and content, shown with its legacy template and two ⚠ notes: with FA
  deferred, `|7|` would always say "It was NOT reported to FAP" for capitalized NX items; and `|2|`
  ("entered by") would name the service account until operator identity exists.

---

## 11. Out of scope

- Piece 2 (the production build and its 🔨) and piece 3 (the AI layer).
- Building any proposed API service — that is Phase 1 work, decided separately.
- Operator authentication (blocks enforcing `ENEDPM`/`ENFACS` and makes `ENTERED BY` truthful).
- A `Modernize` rule disposition.
- Other pages with embedded graph copies (`decide-classic.html`, `graph.html`, `map.html`) and
  `workbench-demo.html` — unchanged.
