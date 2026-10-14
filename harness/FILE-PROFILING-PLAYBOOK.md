# Skill: profile a FileMan file for modernization

**Written for:** engineers turning a VistA FileMan file into a modernization-ready
manifest — the field list, controls, enums, pointers and screen layout that feed both
the spec and the REST data service. Prereq: [`VADEMO-ACCESS-PLAYBOOK.md`](VADEMO-ACCESS-PLAYBOOK.md).

Goal: for a target file (e.g. **6914**), produce everything a modern form + backend
need, all traced to the live DD — **derive facts, never guess them.**

## 1. Field manifest (numbers, names, storage)
- **Field numbers + labels**: `GET /doc/VISTA.<CLASS><FILE>.cls`; grep the
  `/// FileMan Field Label: '…'  FileMan Field Number: '…'` doc comments.
- **SQL/type view**: `SELECT Name, SqlFieldName, Type, Required FROM %Dictionary.CompiledProperty WHERE parent='VISTA.<CLASS><FILE>'`.
- **Node/piece storage** (for a backend that writes via raw FileMan): harvest
  `^DD(file,field,0)` piece 4 with a throwaway DDProbe class (see VADEMO playbook). Not
  needed if you write via the fileman2class projection.

Record each field as a graph node with `field`, `name`, `sqlField`, `access`, and
`provenance: derived` (promote to `verified` after a live round-trip).

## 2. Set-of-codes (enums) — pull, don't invent
For each `EnumString` property read `VALUELIST` (internal codes) and `DISPLAYLIST`
(labels) from the compiled class source:
```
Property TYPEOFENTRY As %Library.EnumString(VALUELIST=";NX;BSE;EXP", DISPLAYLIST=";NON-EXPENDABLE EQPT;BUILDING SERVICE EQPT;EXPENDABLE EQPT") …
```
Store as `enumValues: "NX=NON-EXPENDABLE EQPT; BSE=…"`. **Lesson:** guessing here cost us —
TYPE OF ENTRY was assumed `NX/BS/ADP/VM` but the DD truth is `NX/BSE/EXP`. Always read the DD.

## 3. Pointers → target + row count → UI control
For each pointer field, resolve the target and count its rows to pick the control:
- Target class = the property `Type` (e.g. `VISTA.MANUFACTURERLISTFILE6912`).
- Real table name via `INFORMATION_SCHEMA.TABLES` (class name ≠ table name).
- `SELECT COUNT(*) FROM VISTA.<table>` → **row count**.
- **Control rule:** ≤ ~60 rows → **dropdown** (embed the option list); larger →
  **autocomplete / type-ahead** backed by a search endpoint.
- Store `lookupTable`, `lookupCount`, and `pointsTo` on the field node; for small
  lookups also embed the actual `options` (pull `SELECT <val>, <displayCol> FROM …`).
- **Pitfall:** a wrong table name returns "table not found" and looks empty — verify the
  name before concluding a lookup file is unpopulated. (6914's pointer files all had
  real data; an early wrong-name query made them look empty.)
- Find the display column per file (`SELECT TOP 1 *`): usually `NAME`, sometimes
  `MFGS_FULL_LENGTH_NAME`, `ROOM_NUMBER`, etc.
- **Don't stop at the code column — look for its description.** List every column before
  choosing (`SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA='VISTA'
  AND TABLE_NAME='<T>' ORDER BY ORDINAL_POSITION`). Coded reference sets pair a terse code
  with a description, and a bare code is meaningless to a clerk — surface **`CODE — Description`**:
  | table | code column | description column |
  |---|---|---|
  | `NX_FUND6914_6` | `NX_FUND_CODE` | `BRIEF_DESCRIPTION` |
  | `NX_BOC6914_4` | `CAPITALIZED_BUDGET_OBJECT_CODE` | `BOC_TITLE` |
  | `NX_SGL6914_3` | `ACCOUNT` | `ACCOUNT_DESCRIPTION` |
  Note the two display modes this implies: **combine** (code + description, joined) vs
  **fallback** (first non-empty of several candidate name columns, e.g. `MFGS_FULL_LENGTH_NAME`
  then `MFGDIV`). Record which mode each lookup needs — the stored value is still the IEN.
- **The label is a UX choice, not the storage column.** Because the stored value is the IEN, the
  label is free to be whatever helps a clerk recognise the entry. Two rules that follow:
  - *Add a descriptor even if sparsely populated* — `ENG_SPACE6928` → `ROOM_NUMBER — FUNCTION_NAME`
    gives "201 — OFFICE, PHYSICIAN" on the 13 of 234 rows that have a function and degrades
    cleanly to the bare room number elsewhere. Helpful-sometimes beats never.
  - *But verify the extra column actually adds information* — `BUILDING_NUMBER` was **rejected**
    for the same file: 229 of 234 room numbers already embed the building (`304-110` = room 304,
    bldg 110) and no room number repeats, so appending it restates the room and disambiguates
    nothing. Check for redundancy (`WHERE ROOM_NUMBER LIKE '%'||BUILDING_NUMBER||'%'`) and for
    real ambiguity (`GROUP BY … HAVING COUNT(*)>1`) before combining.
- **Sub-file pointers** — a field pointing INTO a sub-file (multiple) of the same file, not a
  standalone file. Detect by the table name being a **decimal extension of the parent**
  (`NX_FUND6914_6` = file 6914.6, `NX_BOC6914_4` = 6914.4, `NX_SGL6914_3` = 6914.3). The 6914
  field stores the **sub-file IEN**, not the code — so profile the lookup with **value = IEN,
  display = the code** (confirm on a populated record: `SELECT FUND, FUND->NX_FUND_CODE …`).
  These are fully fileable, just differently — see REST-SERVICE-PLAYBOOK §4b (4-slash internal set).

## 3b. The THREE sources of dropdown / option values — and how to surface each
A modern form's pickers get their values from **three different places**. Know which is which,
because the surfacing recipe differs:

| # | Source | Which fields | How to surface the values | Where it lands |
|---|--------|--------------|---------------------------|----------------|
| 1 | **Set-of-codes (enum)** | `EnumString` props (TYPE OF ENTRY, USE STATUS, YES/NO…) | Read the compiled-class `VALUELIST` (codes) + `DISPLAYLIST` (labels); store as `enumValues:"code=label; …"` | Rendered **inline** on each field's spec line |
| 2 | **Small pointer lookup (≤ ~60 rows)** | pointer fields whose target table is small (SERVICE 54, FUND, BOC, SGL) | `SELECT <valueCol>, <displayCol> FROM VISTA.<table> [WHERE DEACTIVATED_DATE IS NULL]`; store the rows as `options:[{value,label}]` on the node | **Embedded** in the spec's "Lookup option sets" section |
| 3 | **Large pointer lookup (> ~60 rows)** | MANUFACTURER 5175, VENDOR 2627, CATEGORY 600, STOCK# 4013, LOCATION, SUBACCOUNT, self-ref | Do NOT pull the list; only record `lookupTable`+`lookupCount`. The built app queries it **at runtime** via `GET /lookup/{file}?q=` | **Named** in the REST contract; fetched live |

Key points:
- **valueCol vs displayCol.** `value` is what the backend files (an **IEN** for a top-level pointer like SERVICE → `1046`, or a **code** for the 6914 sub-file pickers FUND/BOC/SGL → `4014`/`2335`/`1524`); `label` is the human display (`NAME`, `BRIEF_DESCRIPTION`, `ACCOUNT_DESCRIPTION`, …). Find the display column with `SELECT TOP 1 *`.
- **The ≤60 threshold** is the single switch between #2 (embed) and #3 (runtime). Set it once (`DROPDOWN_MAX`).
- **Enums (#1) are NOT pointer lookups** — never query a table for them; they come from the DD `VALUELIST`/`DISPLAYLIST` only.
- **Staleness.** #2 is a point-in-time snapshot baked into the graph — re-run the `SELECT` to refresh if the site's pick-list changes. #3 is always live. #1 changes only if the DD changes.

## 4. Screen layout (`formScreens[]`)
The compiled class does NOT carry ScreenMan layout. Derive `formScreens[]` (which fields
on screen 1/2/3, in order) from observed ScreenMan navigation screenshots or `^DD` form
files, so the generated UI can render one wizard page per legacy screen + a confirmation
page. Keep the data model flat; layout is derived, single-sourced here.

## 5. Live verification
Confirm the manifest against real records:
`SELECT TOP N IEN, <fields>, <ptr>-><displayCol> FROM VISTA.<table> WHERE …`.
Promote any field confirmed against a live value from `derived` → `verified`.

## 6. Temporary globals as candidate service boundaries
When a routine **reads many persistent globals** (`^ENG`, `^DIQ`, `^VA(…)`, etc.) and then
**writes a structured temporary global** — `^TMP`, `^UTILITY`, `^CACHE`, or a job-scoped
`^%ZTEMP` variant — that is subsequently **consumed by UI code, an RPC, or a report**, treat
that write as a **candidate service boundary.**

### Why this matters
The legacy programmer already solved the aggregation problem you are trying to rediscover
from raw globals. The temporary global's structure is the "materialized answer" — it tells you
exactly which fields, at what granularity, the downstream consumer actually needs. Reading that
structure is faster and more reliable than reconstructing the join logic from scratch.

Temporary globals may therefore be one of the **most useful shortcuts** in a VistA profiling
exercise: they reveal both *what* to expose and *how it is shaped*, already validated by decades
of production use.

### Detection pattern
Look in the routine for:
- Multiple `S ^TMP($J,…)=…` or `S ^UTILITY($J,…)=…` writes inside a loop over `^ENG(file,ien,…)`.
- A subscript scheme that mirrors the target record: `^TMP($J,"EQUIP",ien,node)=value`
  keyed by IEN is a direct hint at the service contract.
- A downstream RPC or `EN^ROUTINE` entry that opens with `K ^TMP($J,tag)` (cleanup) followed by a
  read of those same nodes — confirm the producer/consumer pair.

### How to use it during profiling
1. **Read the subscript schema.** List every `^TMP($J,tag,…)` subscript level and the value stored
   at each leaf. This is the proto-response shape for your service method.
2. **Match each leaf to a DD field.** `^ENG(6914,ien,0)` piece-2 → EQUIPMENT NAME, etc. Where the
   routine transforms (date arithmetic, pointer de-ref, concatenation), note it — the service must
   reproduce the transformation, not raw storage.
3. **Check what is NOT in the temp global.** Absence is intentional: the legacy code decided the
   consumer did not need those fields. Treat omissions as `Omit` candidates in your spec unless you
   have positive evidence the consumer needs them.
4. **Carry the shape into the capability graph.** Add a `tempGlobal` node with `tag`, `schema` (each
   leaf as a name→source mapping), and `consumedBy` (the RPC, option, or report that reads it).
   Set `provenance: derived`; promote to `verified` once you confirm both the producer and consumer
   in a live namespace.

### Naming and cleanup conventions to watch for
- `$J` (job number) isolation: each process gets its own copy; no cross-process caching.
- Explicit `KILL` at the start of the producer (idempotent re-run) vs `KILL` at the end of the
  consumer (the global is ephemeral by convention). If neither kills it, you have a leak — and
  likely a pre-computed cache that a service could legitimately cache too.
- `^CACHE` (namespace-global, not job-scoped): shared across processes — read/write with care;
  a service should reproduce the invalidation logic.

### Example (6914 Equipment Entry)
`ENEQ2 BLDLST` builds `^TMP($J,"ENLOC",ien)` — one subscript per LOCATION record — consumed
by the "Change Location" ScreenMan screen. The subscript schema (`ROOM^BLDG^FUNCTION`) maps to
`ENG_SPACE6928.ROOM_NUMBER`, `BUILDING_NUMBER`, `FUNCTION_NAME` — exactly the columns the
modern `ENG_SPACE6928` lookup (§3) ended up using, with the same decision to surface
`ROOM_NUMBER — FUNCTION_NAME` as the display and drop `BUILDING_NUMBER` (redundant). The temp
global validated the column choice before the SQL analysis confirmed it independently.

## 7. Read intent as policy
When legacy code **expresses intent**, record it as a **legacy policy that most likely carries
over** to the modern version — not as "optional" just because a human can override it. Signals:
- a prompt whose **default answer performs the action** (`S DIR("B")="YES"`);
- code that **flags the non-compliant case** (a message saying the action did *not* happen);
- **DD description text** that states the rule;
- a **catch-up path** for items that skipped the action (batch or "report later" callers).

Record three things, separately: the **policy** (what should happen), the **mechanism** (how the
legacy carries it out — prompt, key, routine), and the **override** (the exception path: who can
take it, and what happens afterwards). The open question is then *how to treat the override*,
never *whether the policy exists*.

### Example (FA document, `ENEQ1 ADDEQ`)
- **Policy:** capitalized NX equipment is reported to FAP — DD fld 61: *"Only capitalized assets
  are to be recorded in the Fixed Assets Package."*
- **Mechanism:** for TYPE OF ENTRY = NX and INVESTMENT CATEGORY = 1, the ENFACS key holder is
  asked *"Do you wish to send an FA document to Austin"* with **default YES**; YES runs `^ENFAACQ`.
- **Override:** a NO. The new-equipment bulletin then flags *"It was NOT reported to FAP"*
  (`ENEQ3` lines 93–96), and the item can be reported later (`^ENFAACQ` is also called from
  `ENEQ2`, `ENFAXMTM`, and in batch by CMR or station).

Reading the default-YES prompt as "sending is optional" is the mistake this section prevents.

---

## Output
A set of field nodes (+ `enumValues`, `lookupTable`/`lookupCount`/`options`, `pointsTo`,
`formScreens`) ready to drop into the capability graph. Downstream this drives:
- the spec's data contract + control conventions,
- the dropdown option sets embedded in the spec,
- the REST data service's enum conversion + pointer resolution
  ([`REST-SERVICE-PLAYBOOK.md`](REST-SERVICE-PLAYBOOK.md)).

## Worked example (file 6914)
84 DD fields → 34 operator-entered; enums corrected to DD truth
(TYPE OF ENTRY `NX/BSE/EXP`, USE STATUS `1..5`, INVESTMENT `1/A/0`, EQUITY `3299/3210/3402`);
pointer files + counts: MANUFACTURER 5175, CATEGORY 600, STOCK# 4013, VENDOR 2627,
LOCATION 234, SUBACCOUNT 325, SERVICE 54 (dropdown), FUND/BOC/SGL = 6914 sub-files (deferred).
