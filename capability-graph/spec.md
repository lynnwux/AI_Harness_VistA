# Development Spec — RegisterEquipment
Source: New Inventory Entry · legacy EQAD^ENEQ1 (file 6914). Generated from the capability graph; every element traces to legacy evidence.

## Build phases
Build in layers — ship **Phase 1 for user feedback first**, then add the rest on top:
1. **Phase 1 — Angular front end + REST write to VistA.** The data-entry app that creates the file-6914 record. Independent of the side effects — **build & get feedback first**.
2. **Phase 2 — IRIS Interop production.** Orchestrates the downstream side effects (work order · PM · FA · bulletin) after the write. This is where the open questions & dispositions apply.
3. **Phase 3 — AI Hub tool.** Exposes the capability to the agent layer, on top of Phase 2.

> 🚫 **Phase 2 is blocked** until these open questions are resolved: Whether to create an incoming inspection work order; Whether to enroll the item in the PM program; Whether to actually send the FA document once eligible. **Phase 1 is unaffected** — it can build now.

## Phase 1 · Command & REST contract
- Command: `RegisterEquipment`
- `POST /equipment` — create; body = the request data contract below; returns the response contract below.
- `GET /equipment/next-ien` — returns `{ status, ien }`; the form pre-fetches this to show the IEN display-only (server re-allocates authoritatively on POST).
- `GET /lookup/{file}?q=<term>` — filtered search; returns `{ items: [{ ien, display }], total: N }` where `total` is the full file size (pre-filter).
- `GET /lookup/{file}?all=1` — full list; returns `{ items: [...all options...], total: N }`. Used on rail open (large pointers) and `<select>` load (small pointers).
- Files: `MANUFACTURER_LIST_FILE6912`, `EQUIPMENT_CATEGORY6911`, `VENDOR440`, `EQUIPMENT_INV_6914`, `CATEGORY_STOCK_NUMBER6917`, `ENG_SPACE6928`, `BUDGET_OBJECT_CODE420_2` (large, left-rail); `SERVICESECTION49`, `NX_FUND6914_6`, `NX_BOC6914_4`, `NX_SGL6914_3` (small, select).

## Phase 1 · REST request — data contract
**Operator-entered** — the form POSTs these:
```
SERIAL   [fld 5]
MANUFACTURER   [fld 1]
MFGR. EQUIPMENT NAME   [fld 3]
MODEL   [fld 4]
EQUIPMENT CATEGORY   [fld 6]
TYPE OF ENTRY   [fld 7]
ACQUISITION METHOD   [fld 20.1]
ACQUISITION DATE   [fld 13]
VENDOR POINTER   [fld 10]
ORIGINAL ASSET VALUE   [fld 31.5]
WARRANTY EXP. DATE   [fld 14]
REPLACING (ENTRY NUMBER)   [fld 51]
CATEGORY STOCK NUMBER   [fld 18]
SERVICE POINTER   [fld 21]
USE STATUS   [fld 20]
PARENT SYSTEM   [fld 2]
LOCATION   [fld 24]
LOCKOUT REQUIRED?   [fld 9]
CONDITION CODE   [fld 53]
STATION NUMBER   [fld 60]
VA PM NUMBER   [fld 25]
SERVICE CONTRACT   [fld 19.5]
SERVICE CONTRACT COST   [fld 19.6]
LOCAL IDENTIFIER   [fld 26]
PHYSICAL INVENTORY DATE   [fld 23]
JCAHO   [fld 27]
CONTROLLED ITEM?   [fld 33]
INVESTMENT CATEGORY   [fld 34]
FUND CONTROL POINT   [fld 35]
FUND   [fld 62]
BUDGET OBJECT CODE   [fld 61]
STANDARD GENERAL LEDGER   [fld 38]
EQUITY ACCOUNT   [fld 64]
SUBACCOUNT (A/O)   [fld 37]
```
**Server-populated** — set by the write, NOT on the form (do not add inputs for these):
```
ENTRY NUMBER   [fld .01]  — system-allocated IEN (= ENTRY NUMBER)
SERIAL_C (canonical)   [fld 5.1]  — canonical serial, derived from SERIAL (UPPERCASE, punctuation-stripped, 30 chars) — drives the FC duplicate index
ENTERED BY   [fld .5]  — filing user (DUZ)
DATE ENTERED   [fld .6]  — filing date/time
```
Query filters (from cross-references): `B`, `F`, `FC`.

## Phase 1 · REST response — data contract
```
{ status, equipmentIEN, lifecycleStatus }
```
- `status` — `"OK"` or an error code/message.
- `equipmentIEN` — new IEN allocated in `^ENG(6914)`; drives the confirmation page.
- `lifecycleStatus` — outcome of the write (created / error).
> Phase 2 extends this response when those operations are built: `workOrderIEN` (6920 work order), `financialAssetId` (FA document to Austin).

## Phase 2 · Business rules & resolved open questions
- **FA-document eligibility** (Preserve): assert `TYPE OF ENTRY (fld 7) = NX  AND  capitalized (INVESTMENT CATEGORY, fld 34)  AND  key ENFACS held` → item becomes eligible for an FA document to Austin (user then confirms — see OQ.FAConfirmation)

## Phase 2 · Interop production (IRIS)
- Business Service: `EquipmentEntry.Service.REST` — `POST /equipment`
- Orchestrator BP: `EquipmentEntry.Process.Orchestrator`
- **Build scope:** implement only the items below marked for this phase; deferred items are explicitly out of this build.
- Business Operations:
  - `Op.Incominginspectionworkorder` — from `IIWO^ENWONEW3(IEN)` (derivedFrom SIDE.WorkOrder)
  - `Op.PMscheduleenrollment` — from `XNPMSE^ENEQPMP` (derivedFrom SIDE.PMSchedule)
  - `Op.FAdocumenttoAustin` — from `^ENFAACQ` (derivedFrom SIDE.FinancialAsset)
- Published events: `NewequipmentMailManbulletin`

## Phase 2 · Security / auth (side-effect gates)
These keys gate the Phase-2 side effects, not the Phase-1 write:
- `ENEDPM` → required role/scope: PM-schedule enrollment prompt
- `ENFACS` → required role/scope: FA-document generation

## Phase 3 · AI Hub agent tool
- Tool `RegisterEquipment`: registers a new equipment item. Input schema = the REST request above; invokes `POST /equipment`. Returns the new IEN + lifecycle status.

## Phase 1 · Front end (Angular)
- Angular 21 SPA (matches the existing Vista_Equipment stack); calls `POST /equipment` via `HttpClient` through the dev proxy.
- **Form-control convention:** set-of-codes fields → native `<select>` (dropdown); pointer/lookup fields with **≤ 60 rows** → `<select>` (populated via `GET /lookup/<file>?all=1`); pointer/lookup fields with **> 60 rows** → **left-rail lookup panel** (see below). Dates → date picker; numerics → number input. Each field below states its resolved control.
- **Option labels are a UX decision, not a mirror of VistA storage.** An option's label exists to let the operator *recognise the right entry*; it is chosen for helpfulness, not because it is how the field happens to be stored. The stored value is always the IEN, so the label is free to differ from the stored column. Three consequences:
  1. **Never show a bare code.** Coded reference sets store a terse code (`AMAF`, `3110`, `1750`) that means nothing on its own, while a description column sits alongside it. Render **`CODE — Description`**: FUND → `NX_FUND_CODE — BRIEF_DESCRIPTION` ("4014 — Canteen Service"); BUDGET OBJECT CODE → `CAPITALIZED_BUDGET_OBJECT_CODE — BOC_TITLE` ("3110 — TRANSPORTATION EQUIPMENT, PASSENGER VEHICLES"); STANDARD GENERAL LEDGER → `ACCOUNT — ACCOUNT_DESCRIPTION` ("1750 — NONEXPENDABLE EQUIPMENT").
  2. **Add a descriptor that aids recognition, even if sparsely populated.** LOCATION → `ROOM_NUMBER — FUNCTION_NAME` ("201 — OFFICE, PHYSICIAN"); where FUNCTION_NAME is blank the label degrades cleanly to the bare room number. A descriptor that helps on some rows and is omitted on the rest beats no descriptor at all.
  3. **Don't append a column just because it exists.** Verify it actually adds information. ENG_SPACE's `BUILDING_NUMBER` was rejected: room numbers already embed the building (`304-110` = room 304, bldg 110) in 229 of 234 rows, and no room number repeats — so appending it would restate the room and disambiguate nothing.
  When profiling a lookup file, list **all** its columns, then pick the label that a clerk would find most recognisable — don't settle for the storage column by default.
- **Left-rail lookup panel** (large pointer fields, > 60 rows): when the operator focuses a large-pointer field a collapsible panel slides in from the left alongside the form. Behaviour:
  - **Header shows total count**: e.g. "MANUFACTURER (5,175)" so the operator knows the full size of the list before filtering.
  - **On open (empty filter): loads ALL options** and shows them in a scrollable list — the operator can scroll through the full list without typing anything. This mirrors the VistA `??` full-list browse.
  - **On typing: live-filters** the full list client-side (no extra network call once loaded); shows matching rows only.
  - Selecting a row fills the field and collapses the panel. Escape also closes the panel.
  - `GET /lookup/<file>?all=1` is used on open to load the full option set; response format is `{ items: [{ ien, display }], total: N }`. Filtered searches (`?q=<term>`) return the same format.
  - Keyboard-navigable (arrow keys to move highlight, Enter to pick).
- Container component `register-equipment` drives a **multi-step wizard**. **Rule: each legacy ScreenMan screen becomes one Angular page** — preserving the operator's screen-by-screen entry flow. A **confirmation page is always appended** as the final step.

### Page 1 — Equipment Identity & Acquisition  _(← ScreenMan screen 1 of 3)_
- **ENTRY NUMBER** `[fld .01]` — display-only (system-allocated IEN)
- **MANUFACTURER** `[fld 1]` — left-rail lookup panel — 5175 rows from `MANUFACTURER_LIST_FILE6912` · `GET /lookup` · e.g. `1` — Sargent & Greenleaf, Inc.
- **MFGR. EQUIPMENT NAME** `[fld 3]` — text
- **MODEL** `[fld 4]` — text
- **SERIAL** `[fld 5]` — text
- **EQUIPMENT CATEGORY** `[fld 6]` — left-rail lookup panel — 600 rows from `EQUIPMENT_CATEGORY6911` · `GET /lookup` · e.g. `1` — X-RAY GENERATOR #A201
- **CATEGORY STOCK NUMBER** `[fld 18]` — left-rail lookup panel — 4013 rows from `CATEGORY_STOCK_NUMBER6917` · `GET /lookup` · e.g. `1` — 1005-000667
- **TYPE OF ENTRY** `[fld 7]` — select (dropdown) — options: NX=NON-EXPENDABLE EQPT; BSE=BUILDING SERVICE EQPT; EXP=EXPENDABLE EQPT
- **ACQUISITION METHOD** `[fld 20.1]` — select (dropdown) — options: C=CONSTRUCTED; G=GIFT/BEQUEST/DONATION; L=LEASED; M=CAPITAL LEASE; O=OTHER; P=PURCHASED; R=TRANSFERRED; T=TRADED; X=EXCESS; 1=ON LOAN TO VAMC
- **ACQUISITION DATE** `[fld 13]` — date picker
- **VENDOR POINTER** `[fld 10]` — left-rail lookup panel — 2627 rows from `VENDOR440` · `GET /lookup` · e.g. `1` — OMNIS COMPUTER SUPPLIES
- **ORIGINAL ASSET VALUE** `[fld 31.5]` — number
- **WARRANTY EXP. DATE** `[fld 14]` — date picker
- **REPLACING (ENTRY NUMBER)** `[fld 51]` — left-rail lookup panel — 289 rows from `EQUIPMENT_INV_6914` · `GET /lookup` · e.g. `6` — AUTOMATIC DOOR

### Page 2 — Ownership & Location  _(← ScreenMan screen 2 of 3)_
- **SERVICE POINTER** `[fld 21]` — select (dropdown) — 54 options from `SERVICESECTION49`, fetched via `GET /lookup` · e.g. `1046` — ACCOUNTS RECEIVABLE
- **USE STATUS** `[fld 20]` — select (dropdown) — options: 1=IN USE; 2=OUT OF SERVICE; 3=LOANED OUT; 4=TURNED IN; 5=LOST OR STOLEN
- **PARENT SYSTEM** `[fld 2]` — left-rail lookup panel — 289 rows from `EQUIPMENT_INV_6914` · `GET /lookup` · e.g. `6` — AUTOMATIC DOOR
- **LOCATION** `[fld 24]` — left-rail lookup panel — 234 rows from `ENG_SPACE6928` · `GET /lookup` · e.g. `33` — 201 — OFFICE, PHYSICIAN
- **LOCKOUT REQUIRED?** `[fld 9]` — select (dropdown) — options: YES; NO
- **CONDITION CODE** `[fld 53]` — select (dropdown) — options: 1=LIKE NEW; 2=GOOD; 3=POOR
- **STATION NUMBER** `[fld 60]` — String(3-5)
- **VA PM NUMBER** `[fld 25]` — String(9-10)
- **SERVICE CONTRACT** `[fld 19.5]` — select (dropdown) — options: YES; NO
- **SERVICE CONTRACT COST** `[fld 19.6]` — number · _shown only when SERVICE CONTRACT=YES_
- **LOCAL IDENTIFIER** `[fld 26]` — String(3-15)
- **PHYSICAL INVENTORY DATE** `[fld 23]` — date picker
- **JCAHO** `[fld 27]` — select (dropdown) — options: YES; NO

### Page 3 — Financial  _(← ScreenMan screen 3 of 3)_
- **CONTROLLED ITEM?** `[fld 33]` — select (dropdown) — options: YES; NO
- **INVESTMENT CATEGORY** `[fld 34]` — select (dropdown) — options: 1=CAPITALIZED/ACCOUNTABLE; A=NOT CAPITALIZED/ACCOUNTABLE; 0=EXPENSED/OPTIONALLY ACCOUNTABLE
- **FUND CONTROL POINT** `[fld 35]` — String(3-30)
- **FUND** `[fld 62]` — select (dropdown) — 22 options from `NX_FUND6914_6`, fetched via `GET /lookup` · e.g. `2` — 4014 — Canteen Service
- **BUDGET OBJECT CODE** `[fld 61]` — select (dropdown) — 15 options from `NX_BOC6914_4`, fetched via `GET /lookup` · e.g. `16` — 2335 — SOFTWARE
- **STANDARD GENERAL LEDGER** `[fld 38]` — select (dropdown) — 9 options from `NX_SGL6914_3`, fetched via `GET /lookup` · e.g. `9` — 1524 — PROPERTY PENDING DISPOSAL
- **EQUITY ACCOUNT** `[fld 64]` — select (dropdown) — options: 3299=MEDICAL; 3210=NON-MEDICAL; 3402=DONATED
- **SUBACCOUNT (A/O)** `[fld 37]` — left-rail lookup panel — 325 rows from `BUDGET_OBJECT_CODE420_2` · `GET /lookup` · e.g. `1001` — 1001 Administrative Personnel not Otherwise Classified

### Page 4 — Confirmation & Submit
- Read-only summary of every entered field, grouped under the page headings above — the operator reviews before committing.
- **Submit** → `POST /equipment`; show "Saving…", then the new **IEN + lifecycle status**, or an error banner on failure.
- Blocked side-effect prompts (resolve in Decide first): Whether to create an incoming inspection work order; Whether to enroll the item in the PM program; Whether to actually send the FA document once eligible.

- Form uses template-driven bindings (`FormsModule`), matching the existing Vista_Equipment stack.
- Fetch the next IEN up front (`GET /equipment/next-ien`) so page 1 can show it display-only; the POST allocates authoritatively server-side.
- Validation is DEVELOPER-REVIEWED, not assumed — see "Input requirements & validation" below. Server (FileMan) remains the source of truth.

## Phase 1 · Input requirements & validation ==developer review==
What the legacy actually enforces — at the DD (field definition) and routine (runtime) level. **Confirm whether the modern app should keep each, tighten it under current regulation/policy, or relax it. None of this is auto-applied.**
- **Required (DD):** none — every operator field is optional at the DD level (ENTRY NUMBER is system-allocated). Making any field mandatory is a modern-policy choice.
- **Length bounds (DD):** STATION NUMBER 3–5; VA PM NUMBER 9–10; LOCAL IDENTIFIER 3–15; FUND CONTROL POINT 3–30.
- **Set-of-codes — value must be one of the listed options:** TYPE OF ENTRY, ACQUISITION METHOD, USE STATUS, LOCKOUT REQUIRED?, CONDITION CODE, SERVICE CONTRACT, JCAHO, CONTROLLED ITEM?, INVESTMENT CATEGORY, EQUITY ACCOUNT.
- **Pointer — must resolve to a real entry:** MANUFACTURER → 6912, EQUIPMENT CATEGORY → 6911, VENDOR POINTER → 440, REPLACING (ENTRY NUMBER) → 6914, CATEGORY STOCK NUMBER → 6917, SERVICE POINTER → 49, PARENT SYSTEM → 6914, LOCATION → 6928, FUND → NXFUND, BUDGET OBJECT CODE → NXBOC, STANDARD GENERAL LEDGER → NXSGL, SUBACCOUNT (A/O) → 4202.
- **Dates — FileMan date validity:** DATE ENTERED, ACQUISITION DATE, WARRANTY EXP. DATE, PHYSICAL INVENTORY DATE.
- **SERIAL (routine `ASKSER`):** OPTIONAL — ASKSER lets the clerk press <return> to skip. On a matching canonical serial (FC index: UPPERCASE, punctuation-stripped, 30 chars) it lists existing matches and asks to reconfirm (default NO); a duplicate is ALLOWED on override. Not enforced-unique.
- **Modern validation = your call.** e.g. should SERIAL become *required* and/or *hard-unique* (the legacy is neither)? should any optional field be mandatory under current policy? The legacy behavior above is the baseline to review, not a mandate.

## Phase 1 · Look & feel (design system)
Adopt the **U.S. Web Design System (USWDS v3) with the VA.gov theme** — this is a federal VA application, so the visual language must match VA.gov (reference: the Million Veteran Program site). Recommended: the `@department-of-veterans-affairs/component-library` (VA design system) or `@uswds/uswds` for tokens + components.
- **Color tokens:** header/footer band navy `#112e51`; accent section band blue `#2a5599` (lighter `#4a6ba5`); primary action (buttons/links) `#0071bc`, hover/active `#205493`; page background `#f1f1f1`; content surfaces white `#ffffff`; ink `#1b1b1b`, muted `#5b616b`, borders `#d6d7d9`; crisis/error red `#e31c3d`.
- **Typography:** serif headings (`Bitter` / `Merriweather`), sans body (`Source Sans Pro`); base 16–17px, line-height 1.5; bold section headings.
- **Layout:** centered container (max-width ~1000px); top utility bar (Contact Us / Sign In) → navy primary nav → content in alternating white / blue section bands; white cards with 1px `#d6d7d9` border + subtle shadow; generous vertical rhythm.
- **App shell:** keep it minimal — just a navy app header showing the app title. Do NOT add a VA masthead/"official website" strip, a crisis-line banner, footer link columns, or a contact/phone block; this is an internal data-entry tool, only the VA visual language (color, type, components) is wanted.
- **Form components (USWDS):** labels **bold, above** each control; large inputs (≥44px touch target), 2px border, focus ring `#0071bc`; wizard steps → USWDS **Step indicator** (numbered, current highlighted); primary Next/Submit = solid primary button, Back = outline button; lookup combobox / left-rail → USWDS **combo box**, enum selects → USWDS **dropdown**; confirmation → USWDS **Summary box**; success → green alert, errors → red alert.
- **Accessibility:** Section 508 / WCAG 2.1 AA — semantic landmarks, every control labeled, visible focus, ≥4.5:1 text contrast, fully keyboard-navigable wizard and lookups.

## Acceptance criteria — differential vs. legacy
- Creates a record in `^ENG(6914)` with a new IEN (next-IEN = `$P(^ENG(6914,0),"^",3)+1`).
- Files SERIAL (field 5) and maintains the `F` + `FC` cross-references; `FC` uses the canonicalized serial (UPPERCASE, punctuation stripped, 30 chars) for duplicate detection.
- Incoming inspection work order occurs per its disposition (Business Operation).
- PM-schedule enrollment occurs per its disposition (Business Operation).
- FA document to Austin occurs per its disposition (Business Operation).
- New-equipment MailMan bulletin occurs per its disposition (Event).
- Rule holds: TYPE OF ENTRY (fld 7) = NX  AND  capitalized (INVESTMENT CATEGORY, fld 34)  AND  key ENFACS held.
- Given identical sandbox input, target output & state match the legacy option on all of the above.

## Traceability
- `RegisterEquipment` ← CAP.CreateEquipment, OPT.ENINVNEW, EQAD^ENEQ1
- `Op.Incominginspectionworkorder` ← SIDE.WorkOrder (CAP.CreateInspectionWorkOrder)
- `Op.PMscheduleenrollment` ← SIDE.PMSchedule
- `Op.FAdocumenttoAustin` ← SIDE.FinancialAsset (CAP.SendFinancialAssetDocument)