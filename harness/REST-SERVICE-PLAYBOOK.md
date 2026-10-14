# Skill: stand up a faithful REST CRUD data service over a FileMan file

**Written for:** engineers reusing this pattern to modernize another VistA end-leaf option.
Reusable reference for building a REST data service that does real CRUD against a
FileMan file, faithful to the legacy DD. Proven for file **6914** (Equipment Inventory)
on VADEMO; the assets `Harness.Equipment.REST.cls` + `Harness.Setup.cls` in this folder
are the working templates — copy and re-point them at a new file.

## What this delivers
Browser → (dev proxy) → **`%CSP.REST` dispatch** → **fileman2class `%Save()`** → `^GLOBAL`.
`%Save()` routes through FileMan, so IEN allocation, cross-references, input transforms
and triggers all run for free. This is the seam the spec's "REST API data service" layer
describes.

## Prerequisites
- A **fileman2class projection** of the file exists (e.g. `VISTA.EQUIPMENTINV6914`, SQL
  table `VISTA.EQUIPMENT_INV_6914`). Confirm with `SELECT TOP 1 * FROM VISTA.<table>`.
- Atelier REST API reachable (VADEMO: port **80**, base
  `$VADEMO_URL/api/atelier/v1/VISTA-DIEGO`, HTTP Basic with `$VADEMO_USER` / `$VADEMO_PASSWORD` —
  see [VADEMO-ACCESS-PLAYBOOK.md](VADEMO-ACCESS-PLAYBOOK.md)).

## Steps

### 1. Pull the DD first — never guess
- Field numbers + labels: read the compiled class doc (`GET /doc/VISTA.<CLASS>.cls`),
  grep the `/// FileMan Field Label: '…' FileMan Field Number: '…'` comments.
- **Set-of-codes**: read each `EnumString` property's `VALUELIST` / `DISPLAYLIST` — these
  are the *only* correct enum codes. (We were burned guessing TYPE OF ENTRY as
  `NX/BS/ADP/VM`; the DD truth is `NX/BSE/EXP`.)
- Pointer targets: the property `Type` (e.g. `VISTA.MANUFACTURERLISTFILE6912`) gives the
  referenced class; its SQL table name usually differs (`MANUFACTURER_LIST_FILE6912`).
  Find real table names via
  `SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA='VISTA' AND TABLE_NAME LIKE '%…%'`.

### 2. Write the `%CSP.REST` dispatch class
- `Parameter HandleCorsRequest = 1;` (browser calls).
- `XData UrlMap` routes: `GET /NextIEN`, `POST /<Entity>`, `GET /<Entity>/:ien`, `DELETE /<Entity>/:ien`.
- **NextIEN** = `$Piece($Get(^GLOBAL(FILE,0)),"^",3)+1`.
- **Create/upsert**: `%OpenId(ien)` else `%New()` + set `.IEN`/`.01`; set scalar/number
  props; convert enums (step 3) and pointers (step 4); then `%Save()`.
- **FileMan env before `%Save()`** (a filing trigger needs them):
  `If '$Data(DUZ) Set DUZ=.5`, set `DT` (FileMan today), `U="^"`.

### 3. DD-correct enum conversion (display → internal)
Map incoming display values to internal codes using the DD `VALUELIST`/`DISPLAYLIST`
(pass through if already an internal code). Keep the maps in one helper (`Enum(field,val)`).
Unmappable → error, never silent blank (that was a LYNN bug).

### 4. Pointer resolution — the part LYNN skipped
fileman2class pointer properties are **object references**, so you must hand them an
**OREF**, not a bare IEN:
```
ClassMethod Ptr(class, table, col, val) As %RegisteredObject
{  // val may be an IEN or a display name
   If (+val>0) && $ClassMethod(class,"%ExistsId",+val) Set ien=+val
   ElseIf (col'="")&&(table'="") { /* SELECT TOP 1 IEN FROM table WHERE col=?  */ }
   Quit:(+ien'>0) "" Quit $ClassMethod(class,"%OpenId",+ien)
}
...
Set p=..Ptr("VISTA.MANUFACTURERLISTFILE6912","VISTA.MANUFACTURER_LIST_FILE6912","MFGS_FULL_LENGTH_NAME",d.manufacturer)  If p'="" Set e.MANUFACTURER=p
```
Verify with a join: `SELECT MANUFACTURER->MFGS_FULL_LENGTH_NAME FROM VISTA.<table> WHERE …`.

### 4b. Sub-file pointers (fields that point INTO a sub-file of the same file)
Some fields point not to a standalone file but into a **sub-file (multiple)** of the parent —
recognizable by the table name being a decimal extension of the parent file
(`NX_FUND6914_6` = file 6914.6, `NX_BOC6914_4` = 6914.4, `NX_SGL6914_3` = 6914.3). These need
different handling than a plain pointer:

1. **The field stores the sub-file IEN, not the code.** Confirm by inspecting a populated
   record: `SELECT FUND, FUND->NX_FUND_CODE FROM VISTA.<table> WHERE FUND IS NOT NULL` →
   e.g. `FUND="2"` resolves to code `4014`. So the dropdown's option **value must be the
   sub-file IEN** (display = the code), i.e. the lookup returns `{ien:<subfileIEN>, display:<code>}`.
2. **fileman2class `%Save()` on a pointer-into-subfile is awkward** — don't fight it. File it
   with a **direct FileMan internal set after `%Save()`**: build a DR string with the field
   number and a **4-slash** (bypasses input transform, writes the internal value = the IEN):
   ```
   Set DR="62////"_(+fundIEN)_";61////"_(+bocIEN)_";38////"_(+sglIEN)
   Set DIE="^ENG(6914,", DA=e.IEN  Do ^DIE          // after e.%Save() created the record
   ```
3. **The method must be `[ ProcedureBlock = 0 ]`** to use the FileMan publics `DIE`/`DA`/`DR`
   (else compile error `#1038 Private variable not allowed`).

Verify with the join (`FUND->NX_FUND_CODE` etc.). This closes the loop: the front end exposes
all options (pointer OR sub-file) — a display concern — and the sub-file ones now persist too.

### 5. Dates
`YYYY-MM-DD` → FileMan internal `(YYYY-1700)MMDD`.

### 6. Create the CSP web application (exposes the service)
A compiled class isn't reachable until a web-app maps a URL to it. Clone an existing
REST app's security so auth/CORS match a known-good app:
```
New $namespace  Set $namespace="%SYS"
Do ##class(Security.Applications).Get("/FileMan/Lynn",.p)   // clone LYNN
Set p("DispatchClass")="Harness.Equipment.REST", p("NameSpace")="VISTA-DIEGO", p("CookiePath")="/Harness/Equipment"
Set sc=##class(Security.Applications).Create("/Harness/Equipment",.p)
```
Run it once via a `[ SqlProc ]` bootstrap: `SELECT Harness.Setup_CreateWebApp()`.
- **App name ≠ URL**: the app `/Harness/Equipment` is served under the gateway alias
  `/irishealth`, i.e. `http://host/irishealth/Harness/Equipment/…`. List apps with
  `SELECT Name,DispatchClass,NameSpace FROM Security.Applications WHERE DispatchClass<>''` (in `%SYS`).

### 7. Deploy
- Upload: `PUT /doc/<Class>.cls?ignoreConflict=1` body `{"enc":false,"content":[lines]}`.
- Compile: `POST /action/compile` body `["<Class>.cls"]`.

## Gotchas (all hit during the 6914 build)
- **`[ ProcedureBlock = 0 ]`** on any ClassMethod that uses FileMan public vars
  (`DUZ`/`DT`/`U`), swaps `$namespace`, or passes arrays by reference — else compile
  error `#1038 Private variable not allowed`.
- **App name vs URL path** — see step 6.
- **Pointers need an OREF** (`%OpenId`), not an integer IEN — see step 4.
- **Auth**: cloned app is `authe=64` (password). For a browser demo either (a) front it
  with a dev proxy that adds Basic auth server-side (see `agent/server.js`, matches
  Vista_Equipment's `proxy.conf.json`), or (b) enable unauthenticated on the sandbox app.
- **Side effects**: a faithful create only files the record. Legacy side effects
  (work order / PM / financial doc / bulletin) are separate operations — leave them OFF
  unless explicitly modeled.

## Verify + clean up
- Round-trip: `POST` then `GET /<Entity>/:ien`; confirm resolved names/codes with SQL joins.
- Sandbox hygiene: delete test records via `DELETE /<Entity>/:ien` when done.

## Reusable assets in this folder
- `Harness.Equipment.REST.cls` — the dispatch + CRUD + enum/pointer/date helpers (file 6914).
- `Harness.Setup.cls` — web-app bootstrap (`CreateWebApp`, `Describe`, `ListRest`).
- Proxy wiring: `agent/server.js` (`/equipment*` → the VADEMO REST service).

## Related skills (do these first)
- [`VADEMO-ACCESS-PLAYBOOK.md`](VADEMO-ACCESS-PLAYBOOK.md) — connect, query, upload/compile, call SqlProcs.
- [`FILE-PROFILING-PLAYBOOK.md`](FILE-PROFILING-PLAYBOOK.md) — get the field list, DD enums, pointer targets this service needs.
