# Runtime-trace experiment — notes

Experiment only. Everything lives in `experiments/runtime-trace/`; nothing in the harness was changed.
Instance: VADEMO, `IRIS for Windows (x86-64) 2026.1 (Build 233U)`, namespace `VISTA-DIEGO`.

## %SYS.Trace on this instance (read from the class source over Atelier, then called)

| Method | Exists | Notes |
|---|---|---|
| `EventNames()` | yes | `$List` of 56 names, read at runtime from `^%SYS.MONLBL` (`Flist`; no source shipped) |
| `StartPID(pid, dir, events, maxsize)` | yes | needs `%Admin_Manage:USE`; `events` is a **`$List` of names** (`$lb("RtnLoad","GloRef")`); `maxsize` in MB (0 = no cap, max 2047); empty args → system defaults; does not wait for the file to appear |
| `StopPID(pid)` | yes | always returns OK |
| `PIDList()` | yes | `$List` of traced PIDs |
| `Display(file, flags)` | yes | writes to the current device; flags `d` databases, `n` SFNs, `s` source line, `w` wait/follow |
| `ReadFile(file, flags)` | yes | **class query, `[SqlProc]`** — the parsed rows behind `Display`; flags `s` (source line), `q` (quote subscripts) |
| `Get/SetDirectory`, `Get/SetEvents`, `Get/SetMaxSize`, `Validate*` | yes | the `Set*` methods change system-wide defaults (`^%SYS("TRACE",…)`) and need `%Admin_Manage:USE` — **not used**; the experiment passes dir/events/size per call |

- **System defaults here:** directory `""` (none set — `StartPID` with an empty `dir` would fail), max size `0` (no cap),
  default events `RtnLoad, GloRef, BlockWait, NCacheMiss, DirBlkRd, UpntBlkRd, BpntBlkRd, DataBlkRd, BdataBlkRd,
  MapBlkRd, OthBlkRd`.
- **Event names available (56):** `GloRef GloSet GloKill DirBlkRd … RefNoGlo KillNoData NetGloRef … RtnLine RtnLoad
  RtnFetch LockCom LockSucc LockFail LockName TermRead TermWrite …`. Note the event is **`RtnLine`** (singular) on this
  version. `GloSet` / `GloKill` exist separately, so a later run could tell writes from reads; this run used only
  `RtnLoad` + `GloRef` as specified, and `GloRef` does not say whether a reference was a read, a `$Order` or a set.
- **`RtnLoad` is special:** it records every subroutine `CALL` / `QUIT` (with stack level), not only routine loads,
  plus `ARG` records with the string arguments passed (hex-decoded by `ReadFile`) — e.g. the first run's `ARG … "XUP"`.
  So the trace can carry values the user typed; treat it as sensitive.
- **Trace file:** `iristrace_<pid>.txt` in the given directory. The directory must exist and be writable by the
  **traced** process. Comma-separated records: `START`, `STOP`, `HALT`, `CALL`, `QUIT`, `STACK`, `ARG`, and
  `<event#>,time,rsfn,rou+line,count,grefhex^sfn^collation^gstate`. Global references are hex-encoded and decoded by
  `ReadFile`; values are never written.
- **Permissions:** `StartPID` / `Set*` require `%Admin_Manage:USE`. The sandbox login (`_SYSTEM`, role `%All`) has it —
  confirmed with `$SYSTEM.Security.Check("%Admin_Manage","USE") = 1`. Nothing was granted or changed.
- **Size / rotation:** one cap per trace (`maxsize` MB); no rotation. This experiment used 50 MB.
- **`^TRACE`:** the interactive front end over the same API; not needed because `ReadFile` is callable over SQL.
- **`^GETPPGINFO`** exists in `%SYS` (`GETPPGINFO(pid, options, outputfile)`); lists a process's `^||` global names
  and block counts, never values. It must run in `%SYS` and writes to device 0, so the probe runs it as a background
  `JOB` (null principal device) with an output file.

## How the experiment ran it

There is no terminal access to VADEMO from here, so process B is the Atelier SQL server process: a throwaway probe
class `Harness.Experiment.RuntimeTrace` (source in this folder) was uploaded to `VISTA-DIEGO` and its `[SqlProc]`
methods are called through `/action/query` — the playbook's DDProbe pattern. It is deleted at the end.

- `node --env-file=agent/.env experiments/runtime-trace/ctl.js deploy | remove`
- `… ctl.js call Env | PrepareDir | Check <pid> | Start <pid> 50 | Status <pid> | Stop <pid> | PPG <pid>`
- `… ctl.js call Defined '["^ENG(6914,487,0)", …]'` and `… call Subs '^ENG(6914,487)' 50` — `$Data` and subscript names
  only, for roots `ENG XTMP TMP DIC XMB XUSEC DIE`; subscripts must be literals (no code in a reference)
- `… ctl.js fetch <pid> raw/<run>` — raw lines plus `ReadFile` rows (flags `qs`) to `raw/` (git-ignored)
- `va.js` — read-only Atelier `doc` / `sql` helper used for source, `%SYS.ProcessQuery` and state checks

Safety checks in the probe: `Start` refuses a PID that is not an interactive terminal (`|TRM|`) in `VISTA-DIEGO`,
the controller's own `$J`, or a PID already traced. Trace directory: `<mgr>\Temp\harness-runtime-trace\`, created for
the experiment and removed at cleanup.

## Runs

| | Run 1 | Run 2 |
|---|---|---|
| Scenario | NewInventoryEntry-runtime-001 | NewInventoryEntry-runtime-002 |
| PID (from the user's `W $J`, confirmed via `%SYS.ProcessQuery`: `|TRM|`, VISTA-DIEGO, `_SYSTEM`) | 15424 | 15424 |
| Controller job | 14284 | 14284 |
| Started (UTC) | 2026-11-09 15:24:43.409 | 2026-11-09 15:38:28.298 |
| Stopped (UTC) | 2026-11-09 15:34:48.574 (`StopPID`) | ≈ 15:42:20 (the user's `HALT`; `PIDList` empty at 15:42:22) |
| Events | RtnLoad, GloRef | RtnLoad, GloRef |
| Started from | programmer prompt (sign-on `D ^XUP` included) | the Equipment menu (no sign-on) |
| Trace file | `C:\InterSystems\IRISHealth\mgr\Temp\harness-runtime-trace\iristrace_15424.txt` | same (recreated) |
| User inputs | serial 10100; 14 ASSET VALUE 50001; 20 FUNCTIONAL CLASS PC; inspection W.O. YES | serial 10101; same, but inspection W.O. NO |
| Records in the file | 17 (no STOP; ends mid-record) | 22 (ends with HALT) |
| Span with events | 0–24.6 s of ~10 min | 0–9.9 s of ~4 min |

## Operational observations

- **Run 1 stopped recording after 25 seconds.** The file holds 17 records (583 bytes): `START`, the `D ^XUP` call,
  `XUP`, `%ZIS3`, `%ZIS1`, `DIC1`, and a `RtnLoad` of `DIC2` cut off mid-record (`38,…,DIC2+0,0,7x`). For the next
  ~10 minutes of the workflow nothing more was written, although `PIDList()` still listed the PID and the process
  kept running (it was later seen in `DIR` and `XQ`). After `StopPID` and a keystroke the file was unchanged and has
  no `STOP` record (`ReadFile` ends with "Unexpected end of file"). Cause not determined.
- The file size reported while tracing matched the content read back, so this is not a Windows size-reporting lag.
- **Run 2 (started inside the menu, ended by the user's `HALT`) behaved the same way:** 22 records — the stack at start,
  the `DIR` answer returning out of `EQMAD^ENEQ1` (the Multiple Inventory Entry prompt) into `XQ1` — all within
  3.5 ms, then one `QUIT` at +9.9 s with an implausible line number (`+22676^XQ1`), then nothing until `HALT` four
  minutes later. Polling every 15 s showed the file stuck at 551–553 bytes while the process ran ScreenMan
  (`XGKB`) and returned to `XQ`. The `HALT` record was written, so tracing was still active; events were simply not
  recorded. It is not buffering: the halt added 8 bytes, not the workflow.
- **Control on VADEMO (`SelfTest`):** a background job started by the probe made 40 `$$GET1^DIQ(6914,487,5)` calls and
  40 `$D(^ENG(6914,"FC"))` references over 20 s while traced. File: `START`, one `STACK`, the final `QUIT`, `HALT` — no
  `CALL`, `RtnLoad` or `GloRef` at all. So the gap is not VistA- or terminal-specific.
- **Control on the local `iris-ai-hub`** (`IRIS for UNIX … 2026.2.0AI (Build 162U)`): the same `StartPID($J, dir,
  $lb("RtnLoad","GloRef"), 5)` on an `iris session` process, 20 iterations of `$D(^%SYS("TRACE"))` and a method call,
  gave 171 rows — 20 `GloRef`, 21 `RtnLoad`, 21 `CALL` / `QUIT`, 84 `ARG`, `STOP`. The API use is correct; event
  recording on VADEMO's 2026.1 Windows build is what fails. Open: whether it is the build, Windows, or something
  configured on VADEMO (e.g. another monitor such as `^PERFMON` / `^%SYS.MONLBL` holding the same counters). Next
  check: `^PERFMON` / `%SYS.MONLBL` status on VADEMO and the same control on a second 2026.1 Windows instance.
- `GloRef` records give the full reference with subscripts (`^DIC(19,28,0)`, `^%ZOSF("TYPE-AHEAD")`), the line
  (`+137^DIC1`), the source line (flag `s`) and the database (`^^c:\intersystems\irishealth\mgr\vista-diego\`). Routine
  fetches show as `^rOBJ("XUP")`. Where it records, the context is good.
- No `^TMP`, `^XTMP` or `^||` reference was recorded in either run (the recorded window did not reach the workflow), and
  `^GETPPGINFO` was not run against the user's session — there was no point at which the trace showed the workflow's
  temporary state worth sampling.
- **Cleanup:** both trace files and the directory were deleted on VADEMO (`Cleanup`), `PIDList()` is empty, and the
  probe class was deleted (`GET /doc/…` → 404). Local copies are in `raw/` (git-ignored).
- `%SYS.ProcessQuery` (`Routine`, `State`, `LastGlobalReference`) is readable over SQL and was useful on its own: mid-run
  it showed the process at a `DIR` prompt with last reference `^%ZTSCH(5865129210,6002674)` — the TaskMan schedule.
