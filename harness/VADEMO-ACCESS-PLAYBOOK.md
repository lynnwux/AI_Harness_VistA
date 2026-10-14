# Skill: work with VADEMO directly via the Atelier REST API

**Written for:** engineers who need to read/query/deploy against the live VADEMO
VistA sandbox. This is the substrate under every other harness skill — the DD survey,
the capability graph, and the REST data service all sit on top of it.

## Connection
- Host: the VADEMO sandbox — **`$VADEMO_URL`** (e.g. `http://<vademo-host>`), **port 80**
  (NOT 52773 — the management port is closed; Atelier is served on the same port as the
  CSP web apps).
- Atelier v1 base: **`$VADEMO_URL/api/atelier/v1/VISTA-DIEGO`**
  (namespace `VISTA-DIEGO`, instance IRISHEALTH).
- Auth: HTTP **Basic** with the sandbox account — **`$VADEMO_USER` / `$VADEMO_PASSWORD`**.
  Never write the host or credentials into a committed file; keep them in the git-ignored
  `agent/.env` (template: `agent/.env.example`).
- Node one-liner header: `Authorization: "Basic " + Buffer.from(process.env.VADEMO_USER + ":" + process.env.VADEMO_PASSWORD).toString("base64")`.

## Core operations

### Run SQL (read anything)
`POST /action/query` body `{"query":"SELECT …"}` → `result.content` is the row array;
`status.errors[0].error` on failure.
```
SELECT TOP 5 IEN, SERIAL_ FROM VISTA.EQUIPMENT_INV_6914 WHERE SERIAL_ IS NOT NULL
```
- Cross-file joins use FileMan pointer arrows: `MANUFACTURER->MFGS_FULL_LENGTH_NAME`.
- Find real table names: `SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA='VISTA' AND TABLE_NAME LIKE '%…%'`.
- Parameters: pass `{"query":"… ?","parameters":[val]}` to avoid quote-escaping.

### Read routine / class source
`GET /doc/<NAME>.int` (routine) or `GET /doc/<PKG>.<CLASS>.cls` (class) →
`result.content` is an array of source lines. Use this to trace `EQAD^ENEQ1`, read a
fileman2class projection, or grep `/// FileMan Field Label: … Field Number: …` comments.

### Upload + compile a class
```
PUT  /doc/<Pkg>.<Class>.cls?ignoreConflict=1   body {"enc":false,"content":[<lines>]}
POST /action/compile                            body ["<Pkg>.<Class>.cls"]
```
Check `status.errors` on both. (Split file on "\n", strip "\r" first.)

### Call a ClassMethod from outside IRIS
Mark it `[ SqlProc ]`, then call via SQL:
`SELECT <Schema>.<ShortClass>_<Method>(args)` where **schema = package with dots→underscores**.
- `Harness.Setup` class, method `CreateWebApp` → `SELECT Harness.Setup_CreateWebApp()`.
- `Harness.Equipment.REST` → schema `Harness_Equipment`, so `SELECT Harness_Equipment.REST_<Method>()`.

### Delete a class
`DELETE /doc/<Pkg>.<Class>.cls`.

## Reading globals / the DD without a class
When you need `^DD(file,field,0)` node/piece detail that isn't on the compiled class,
upload a tiny throwaway **DDProbe** class with a `[ SqlProc, ProcedureBlock = 0 ]` method
that `$Order`s over `^DD(file,…)` and returns JSON, call it via SQL, then `DELETE` it.
(Pattern used to harvest the 6914 storage map; delete it when done — don't leave probes.)

## Gotchas (all hit in practice)
- **Port 80, not 52773.**
- **`[ ProcedureBlock = 0 ]`** on any ClassMethod using FileMan public vars (`DUZ`/`DT`/`U`),
  `$namespace` swaps, or by-reference arrays — else compile error `#1038 Private variable not allowed`.
- **SqlProc schema naming**: package dots become underscores; the function is
  `<schema>.<ShortClass>_<Method>`. Getting this wrong → `SQLCODE -359 function does not exist`.
- **Class name ≠ SQL table name** (`VISTA.MANUFACTURERLISTFILE6912` class vs
  `VISTA.MANUFACTURER_LIST_FILE6912` table). A wrong table name reads as "empty" and misleads.
- **CSP app name ≠ URL**: apps live under the gateway alias `/irishealth`
  (app `/FileMan/Lynn` → `http://host/irishealth/FileMan/Lynn/…`).
- **Security config** (`Security.Applications`) lives in `%SYS` — a SqlProc must
  `New $namespace` then `Set $namespace="%SYS"` to touch it.
- **Writes are real.** `%Save()` / `FILE^DICN` create actual records in the sandbox
  global. Use junk serials for tests and clean them up (`DELETE`), and confirm before
  running anything that writes.

## Sanity check
```
GET  /irishealth/Harness/Equipment/NextIEN            # a deployed REST app responds
POST /action/query  {"query":"SELECT COUNT(*) FROM VISTA.EQUIPMENT_INV_6914"}
```

## Related skills
- [`FILE-PROFILING-PLAYBOOK.md`](FILE-PROFILING-PLAYBOOK.md) — turn a file into a modernization manifest.
- [`REST-SERVICE-PLAYBOOK.md`](REST-SERVICE-PLAYBOOK.md) — stand up a CRUD REST service over a file.
