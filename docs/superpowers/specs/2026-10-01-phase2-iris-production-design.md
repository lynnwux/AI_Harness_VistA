# Phase 2 — IRIS Interop Production (design)

**Date:** 2026-10-01
**Status:** STRUCTURAL TEMPLATE ONLY — not a source of decisions (2026-10-13)

> **Read this first.** Every decision in this document (§2's resolved questions, §5's rules
> including the `ENFACS` relocation and the ≥ 50,000 PM threshold, the side-effect dispositions)
> was made in the development session, **not by the user in the Decide chat**, and must not seed
> or bias the orchestrator spec. Decisions come only from the front-end Decide chat; the layer
> specs are generated from that record. Use this document only for **structure**: component
> kinds, the message-contract shape, fatal-vs-degraded pipeline semantics, the DryRun pattern,
> the deployment path into `iris-ai-hub`, and the verification steps.

**Scope:** the Phase 2 deliverable of the VistA Service Enablement Workbench — an IRIS
Interoperability production that orchestrates the downstream side effects of registering a
new equipment item in VistA file 6914.

---

## 1. Purpose

Phase 1 delivered a verified write path: an Angular front end that creates a file-6914 record
through `Harness.Equipment.REST` on VADEMO. Pointers, sub-file pointers (FUND / BOC / SGL),
set-of-codes, dates, numerics and bounded text all file correctly.

Phase 2 puts an orchestration layer in front of that write so the **side effects** the legacy
option performed are carried out under explicit, reviewed policy: PM-schedule enrollment, the
financial-asset document, and the new-equipment bulletin.

**Success criteria**

1. A `POST` to the production creates a real 6914 record (via the Phase 1 REST service) and
   returns its IEN.
2. Each side effect fires exactly when the decisions recorded in `spec.md` say it should.
3. Nothing reaches an external system until a human deliberately enables it.
4. The generated artifacts are traceable to `spec.md` — a reader can point at a class and name
   the decision that produced it.

**Audience for the artifact:** the implementer of this production (human or coding agent).

---

## 2. Constraints and governing decisions

These came from the Decide-stage session and are not re-opened here.

| Constraint | Source |
|---|---|
| **`spec.md` is the single source of truth.** Generate from it; the pre-existing `Equipment.*` production is reference only, never copied. | user decision |
| **Every outbound operation is dry-run by default.** Prove orchestration end to end with zero external effect, then enable operations individually. | user decision |
| **No local orchestration-state persistence.** `spec.md` does not specify it, so it is not built. | user decision |
| **Follow `spec.md`'s naming.** Where a generated name is mangled, fix the spec generator so `spec.md` declares a better name — do not hand-rename at build time. | user decision |
| Deploy into the **`INTEROP`** namespace of container **`iris-ai-hub`**; stopping the existing `Equipment.Production` is accepted. | user decision |
| VADEMO remains the **system of record**. The production never writes `^ENG(6914)` directly. | playbook precedent, retained on merit |

Resolved open questions driving the build:

| Question | Resolution | Consequence |
|---|---|---|
| `OQ.PMEnrollmentPolicy` | **Required input** + stated rule | rule *and* an operator opt-in flag |
| `OQ.FAConfirmation` | **Business rule** | fires automatically on eligibility, no prompt |
| `OQ.WorkOrderPolicy` | **Defer** | the work-order capability is **not built** |
| `RULE.FinancialEligibility` | **Modernized** — business conditions kept, `ENFACS` condition relocated to the security section and flagged for implementation | §5 |
| `SIDE.PMSchedule` | Integration → Jira | outbound Jira issue |
| `SIDE.FinancialAsset` | Business Operation | FA document |
| `SIDE.Bulletin` | Event | bulletin, always |

---

## 3. Components

Names follow `spec.md`. `Harness.Prod.*` is the package.

**Prerequisite — regenerate `spec.md` first.** `spec.md` currently derives operation names from
side-effect labels and emits mangled forms (`Op.Incominginspectionworkorder`,
`Op.PMscheduleenrollment`). Per the governing constraint, the fix belongs in the generator, not
in hand-renaming here. So step one of implementation is a one-line change to `specMD()` in
`capability-graph/decide.template.html` to emit PascalCase, then regenerate `spec.md`. The names
below are what the corrected generator produces, so code and spec agree.

| Class | Kind | Produced by |
|---|---|---|
| `Harness.Prod.Production` | `Ens.Production` | — |
| `Harness.Prod.Service.REST` | `EnsLib.REST.Service` | spec: Business Service |
| `Harness.Prod.Process.Orchestrator` | `Ens.BusinessProcess` | spec: Orchestrator BP |
| `Harness.Prod.Rule.PMEnrollment` | `Ens.Rule.Definition` | `OQ.PMEnrollmentPolicy` |
| `Harness.Prod.Rule.FAEligibility` | `Ens.Rule.Definition` | `RULE.FinancialEligibility` |
| `Harness.Prod.Op.Base` | abstract `Ens.BusinessOperation` | the DryRun constraint |
| `Harness.Prod.Op.VistaWrite` | operation | Phase 1 write path |
| `Harness.Prod.Op.PMScheduleEnrollment` | operation | `SIDE.PMSchedule` |
| `Harness.Prod.Op.FADocumentToAustin` | operation | `SIDE.FinancialAsset` |
| `Harness.Prod.Op.Bulletin` | operation | `SIDE.Bulletin` |
| `Harness.Prod.Msg.RegisterRequest` | `Ens.Request` | request contract |
| `Harness.Prod.Msg.RegisterResponse` | `Ens.Response` | response contract |

**Deliberately absent**

- **No work-order operation.** `OQ.WorkOrderPolicy` is `Defer`.
- **No `OrchestrationStatus` table.** Not in `spec.md`.
- **No compensation/rollback framework.** See §5 — ordering makes it unnecessary.

---

## 4. Message contract

`RegisterRequest` carries the Phase 1 operator payload plus the one new operator input:

```
payload        the full Phase 1 request body, verbatim
enrollInPM     operator opt-in flag (OQ.PMEnrollmentPolicy = Required input)
```

The payload is held as a stream, **not** a capped `%String`. (The reference implementation used
`%String(MAXLEN = 8192)` for a 35-field body — a latent truncation bug to avoid.)

`RegisterResponse`:

```
equipmentIEN       IEN allocated in ^ENG(6914)
lifecycleStatus    created | error
pmTicketId         Jira issue key, or "" when not enrolled
financialAssetId   FA document id, or "" when not eligible
sideEffectLog      per-operation outcome: fired | skipped | dry-run | degraded
```

`sideEffectLog` exists so a caller can tell *why* nothing happened — rule said no, versus
dry-run, versus a failure that was degraded. Without it, "no Jira ticket" is ambiguous.

---

## 5. Pipeline

`Harness.Prod.Process.Orchestrator`, synchronous throughout.

| # | Step | On failure |
|---|---|---|
| 0 | `VistaWrite` → `Harness.Equipment.REST` | **FATAL** — abort, return error |
| 1 | evaluate `PMEnrollment` + `FAEligibility` | **FATAL** — abort |
| 2 | `PMScheduleEnrollment` if rule true **OR** `enrollInPM` | degraded |
| 3 | `FADocumentToAustin` if FA eligibility true | degraded |
| 4 | `Bulletin` — unconditional | degraded |

**Fatal** = the record would be invalid or unidentifiable without it; abort and surface the error.
**Degraded** = the 6914 record is already valid and complete; log the outcome in
`sideEffectLog`, continue, let a human or a retry fix it.

**Why no compensation logic.** The only fatal steps are 0 and 1, and they run *before* any
side effect. If either fails, nothing external has happened, so there is nothing to undo.
Every later step is additive and independently degradable. This is a property of the ordering,
not a mechanism — it is recorded here so that no one later adds a rollback framework the design
does not need. If a future step ever has to run *before* the write, this reasoning expires.

### Rules

`Harness.Prod.Rule.PMEnrollment` — from the recorded policy
*"Enroll in PM program if TYPE OF ENTRY = NX AND ASSET VALUE ≥ 50,000 AND INVESTMENT CATEGORY =
CAPITALIZED/ACCOUNTABLE. For all other equipment, operator may opt in."*

```
typeOfEntry = "NX"  AND  originalAssetValue >= 50000  AND  investmentCategory = "1"
    → "enroll"
otherwise
    → "operatorChoice"      ← orchestrator then honours enrollInPM
```

Two returns rather than enroll/skip, because the policy has two distinct branches: the rule
*mandates* enrollment, or it *defers to the operator*. Collapsing them would lose the opt-in.

`Harness.Prod.Rule.FAEligibility` — from `RULE.FinancialEligibility`, **modernized** (see below)

```
typeOfEntry = "NX"  AND  investmentCategory = "1"
    → "eligible"
otherwise
    → "notEligible"
```

Field names come from the Phase 1 contract (`originalAssetValue`, `investmentCategory`), and
`investmentCategory = "1"` is the DD-correct internal code for CAPITALIZED/ACCOUNTABLE.

#### The `ENFACS` condition is relocated, not dropped

The legacy rule, observed in `ENEQ1 ADDEQ` (`determinacy: coded`, confidence 0.88):

```objectscript
I $D(^XUSEC("ENFACS",DUZ)),$P(^ENG(6914,ENNXL,0),U,4)="NX",$P($G(^(8)),U,2)
```

— three conditions: ENFACS key held, TYPE = NX, capitalized. **No dollar threshold** (the
`≥ 50,000` belongs to the PM policy, not this rule).

The key check is **deliberately removed from the business rule** and recorded instead as a
security requirement under *Phase 2 · Security / auth (side-effect gates)*:
`ENFACS → required role/scope: FA-document generation`.

Rationale: authorization is a cross-cutting concern, not a business-rule condition. The legacy
conflated the two because MUMPS had nowhere else to put it. "Is this item FA-eligible?" and
"is this user allowed to generate FA documents?" are different questions that belong in
different layers, and keeping them fused would mean the rule class silently acts as an access
control.

This also avoids a dishonest implementation. `^XUSEC("ENFACS",DUZ)` is keyed on the individual
clerk's `DUZ`, and **no operator identity currently flows through the pipeline** — the Angular
app has no login, the proxy uses one service credential, and `Harness.Equipment.REST` defaults
`If '$Data(DUZ) Set DUZ = .5`. So neither replicating the key table nor calling VADEMO could
evaluate the real condition; both would check a service account. Simulating it would produce a
rule that looks like an authorization control but is not one.

**Consequence to track:** until authentication exists, FA eligibility is evaluated on business
conditions only, and the security gate is unenforced. `sideEffectLog` records that the ENFACS
control was not evaluated, so no reader mistakes this for an enforced check. Operator
authentication is a Phase 1 gap worth its own decision — it would also make `ENTERED BY` (fld
.5) truthful, which currently records `.5` rather than the clerk.

---

## 6. DryRun

`Harness.Prod.Op.Base`:

```objectscript
Property DryRun As %Boolean [ InitialExpression = 1 ];
Parameter SETTINGS = "DryRun:Safety";
```

Every operation extends it and, when `DryRun` is set, logs the exact call it would have made —
target endpoint and full payload — then returns a valid synthetic response so the pipeline
continues and can be observed end to end.

| Operation | Live behaviour | Dry-run behaviour |
|---|---|---|
| `VistaWrite` | `POST` to `Harness.Equipment.REST` | `GET /equipment/next-ien`; returns a real, plausible IEN **without writing** |
| `PMScheduleEnrollment` | real Jira issue | logs the issue it would create |
| `FADocumentToAustin` | see below | logs the document it would transmit |
| `Bulletin` | real notification | logs the message and recipient |

Defaults: **all four `DryRun = 1`.** Each is flipped independently in the Management Portal
(`Safety` category). Dry-run `VistaWrite` is what makes the whole pipeline exercisable with
zero writes to VADEMO and zero external traffic.

**`FADocumentToAustin` has no real endpoint.** No FAP/iFAMS target exists in this environment.
The operation is wired into the pipeline for real (the decision says Business rule), but its
live path logs the transmission it *would* perform rather than calling an invented endpoint.
This is labelled as simulated in `sideEffectLog`, so the distinction between "transmitted" and
"would transmit" is never silently lost.

**Bulletin recipient has no default.** It is a required setting; with it unset the operation
degrades and says so. (The reference implementation hard-coded a real individual's address and
emailed them on every single registration — precisely the failure this avoids.)

No credential or token is ever written into source or committed. Secrets are Management Portal
host settings only.

---

## 7. Exposure and deployment

**Exposure.** `Harness.Prod.Service.REST` is an `EnsLib.REST.Service` published as web app
`/harness/equipment`, reachable at `http://localhost:9092/harness/equipment`.

Not an `EnsLib.HTTP.InboundAdapter` on a dedicated port: inside the container the web port is
`52773` and the host publishes `9092 → 52773`, so an in-container listener on any other port is
unreachable from the host without changing the container's port mappings.

**Deployment.** The Atelier REST API returns 403 for the `INTEROP` namespace, so deployment uses
the path that provably works in this container:

```bash
docker cp <Class>.cls iris-ai-hub:/tmp/
docker exec iris-ai-hub bash -c \
  'echo "do \$system.OBJ.Load(\"/tmp/<Class>.cls\",\"ck\")" | iris session iris -U INTEROP'
```

wrapped in `harness/deploy-phase2.sh`, which loads all classes, creates the web app, stops
`Equipment.Production`, and starts `Harness.Prod.Production`.

**Front-end wiring.** The Angular app needs no change. The node dev server repoints `POST
/equipment` from VADEMO to the AIHUB production, which becomes the front door; VADEMO stays the
system of record behind it. `GET /lookup/*` and `GET /equipment/next-ien` continue to go
straight to VADEMO.

```
Angular → node proxy → AIHUB /harness/equipment → Harness.Equipment.REST → ^ENG(6914)
                              (production)              (VADEMO)
```

---

## 8. Verification

1. **Dry-run pipeline.** Submit a registration with all operations dry-run. Expect: no 6914
   record created, no external traffic, and an Event Log entry per operation showing the exact
   call each would have made.
2. **Rule coverage.** Four submissions — NX/≥50k/capitalized (expect `enroll`); the same with
   value below 50k (expect `operatorChoice`); `operatorChoice` with `enrollInPM` true and false
   (expect enrolled / not enrolled). Assert against `sideEffectLog`.
3. **Live write, side effects still dry.** Enable `VistaWrite` only. Confirm a real 6914 record
   with correct pointers, sub-files and enums (the Phase 1 field-class check), while no external
   system is touched.
4. **Degraded isolation.** With `VistaWrite` live, force a side-effect operation to fail.
   Confirm the 6914 record still exists, the response still returns its IEN, and the failure
   appears in `sideEffectLog`.
5. **Deferred capability absent.** Confirm no work-order operation exists in the production and
   nothing writes `^ENG(6920)`.

---

## 9. Follow-ups (out of scope here)

- **`Defer` is treated as blocking.** `getState()` reports `OQ.WorkOrderPolicy` as blocking
  Phase 2 even though `Defer` is a decision to *exclude* the capability, not an absence of one.
  The spec banner will therefore keep showing Phase 2 blocked. The blocking predicate should
  distinguish "unresolved" from "resolved as excluded".
- **Local orchestration state.** Omitted by decision. If Phase 3's AI Hub tools need to join
  VADEMO data against workflow outcomes, that is a `spec.md` change first.
- **Operator authentication.** No clerk identity flows through the pipeline (§5). This blocks
  enforcing the `ENFACS` gate and makes `ENTERED BY` record `.5` instead of the real user. Its
  own decision, probably its own phase.
- **Rule dispositions cannot express "modernized".** The Decide tooling offers only
  `Preserve | Inline | Drop` for rules, so a decision like this one — keep the business
  conditions, relocate the security condition — has no vocabulary and ends up recorded as
  `Preserve`, which is now untrue. Add a `Modernize` disposition that requires the modified
  condition plus a rationale, so the provenance trail stays trustworthy.
- **The Decide chat should drive this pattern explicitly:** surface what the legacy code
  actually does (with the MUMPS evidence), explain it, then ask the developer how to modernize
  it — rather than presenting a disposition menu and treating `Preserve` as the default. This
  FA rule is the worked example: the chat should have shown the `ENEQ1 ADDEQ` line, explained
  the three conditions, and asked which to keep, change, or relocate.

(The spec-generator name fix is *in* scope — see §3.)
