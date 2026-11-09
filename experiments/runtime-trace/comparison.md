# Runtime evidence vs the static capability graph — New Inventory Entry

Compared against `capability-graph/new-inventory-entry.json` (CAP.CreateEquipment). Two runs on PID 15424
(details in `NOTES.md`, data in `runtime-trace.json`). **Read this first:** on VADEMO the trace recorded events for
only the first 25 s (run 1) and 10 s (run 2) and then stopped recording, although tracing stayed active. A control
job on VADEMO recorded no events at all; the same call on the local IRIS 2026.2 recorded every event. So the runtime
column below covers sign-on and the menu around the workflow, **not** the `EQAD`/`ADDEQ` body. The state evidence
was read separately and covers the whole workflow.

Labels: **TRACE** = recorded by `%SYS.Trace`; **STATE** = read from VistA afterwards (SQL / `$Data`); **SAMPLE** =
`%SYS.ProcessQuery` taken mid-run.

## CONFIRMED BY RUNTIME

| Static element | Runtime evidence |
|---|---|
| `workflow.menuPath[0]` = EVE (Systems Manager Menu) | TRACE run 1: `GloRef ^DIC(19,28,0)` at `+137^DIC1` during sign-on; option 28 = EVE |
| Routine `ENEQ1` executes in this menu | TRACE run 2: stack at start `R+2^XQ1 → EQMAD+14^ENEQ1 → A+2^DIR`, then `QUIT at +56^ENEQ1` (the `Q` of `EQMADX`) |
| DEP.FileMan (reader / lookup) | TRACE: `DIR`, `DIR1`, `DIRQ`, `DIC1`, call `D C^DIC2` |

That is all the trace confirmed directly. Everything else confirmed below is STATE evidence:

| Static element | State evidence |
|---|---|
| DATA.6914 — a record is created | IEN 487 (run 1) and 488 (run 2) exist (`^ENG(6914,487,0)`, `^ENG(6914,488,0)`) |
| FLD.serial (node 1 piece 3) and FLD.serialC | SERIAL_ 10100 / 10101; SERIAL_C `"10100 "` / `"10101 "` |
| XREF.B, XREF.F, XREF.FC | `^ENG(6914,"B",487,487)`, `"F",10100,487`, `"FC","10100 ",487` — and the same for 488 — all `$D`=1. The FC key matches the graph's normalization note (upper-case, punctuation stripped, one trailing space). |
| FLD.enteredBy / FLD.dateEntered | ENTERED BY 1 (BLACK,JOHN), DATE ENTERED 3261109, on both records |
| FLD.totalAssetValue (field 12) | run 1: 50001 on node 2. Run 2: node 2 absent — no value stored, though the user reported entering 50001. |
| SIDE.WorkOrder fires on YES | run 1: work order 5438 `RA261109-001`, equipment 487 |
| SIDE.Bulletin is unconditional | a bulletin task was queued in **both** runs (6002674, 6002675) |

## STATIC ONLY

**KNOWN CAPABILITY — BRANCH NOT EXERCISED** (backed by state or the user's answers, not by the trace):

- SIDE.WorkOrder in run 2 — the user answered NO; no `WORK_ORDER_6920` row for 488 / serial 10101.
- SIDE.PMSchedule (`XNPMSE^ENEQPMP`, `DINV^ENEQPMP3`) — no PM prompt reported (it is gated on key `ENEDPM`).
- SIDE.FinancialAsset (`^ENFAACQ`) — no FA prompt reported; the record was not entered as NX + capitalized
  (RULE.FinancialEligibility not triggered).
- ASKSER duplicate-match branch — the serials were new, so no match list was expected.

**NOT OBSERVED — TRACE GAP** (expected to run, but past the point where recording stopped): `EQAD^ENEQ1`, `ASKSER`,
`ADDEQ`, `ENR`, `FILE^DICN`, `UP^XLFSTR`, `EN^ENJ` (ScreenMan — the process was seen in `XGKB` by SAMPLE), `^DIE`,
`IIWO^ENWONEW3` (run 1), `BULL^ENEQ3`, `^ENG(6914,0)` counter, `^ENG(6914,"FC",…)` `$Order`, `^XUSEC("ENEDPM",DUZ)`,
`^ENG(6910.2,"B","ASK INCOMING INSPECTION W.O.")`. These are not discovery failures, and not confirmations either.

## RUNTIME ONLY

| Item | Evidence | Label |
|---|---|---|
| **New-equipment bulletin is asynchronous**: `BULL^ENEQ3` queues TaskMan task `TASK^XMXBULL` ("MailMan: Bulletin EN NEW EQUIPMENT", option ENINVNEW); the graph has `BULL^ENEQ3` but no TaskMan, `XMXBULL` or queueing | SAMPLE: run 1 mid-workflow `LastGlobalReference = ^%ZTSCH(5865129210,6002674)`; STATE: tasks 6002674 / 6002675 in file 14.4, status 1, Job 0 | **DISCOVERY GAP CANDIDATE** · **ASYNC WORK DETECTED — REQUIRES FOLLOW-UP TRACE** |
| TaskMan on VADEMO is not running queued tasks (all tasks since $H 67834 are status 1, Job 0), so the bulletin is queued but never delivered | STATE | environment finding (affects the Phase 2 bulletin comparison, not the graph) |
| Entry point `EQMAD^ENEQ1` (Multiple Inventory Entry) — a sibling of `EQAD` in the same routine, reaching the same `ASKSER`/`ADDEQ` | TRACE run 2 stack | **DISCOVERY GAP CANDIDATE** (a second workflow converging on CAP.CreateEquipment — the convergence the long-form vision asks about) |
| Kernel sign-on and menu plumbing: `XUP`, `XQ1`, `%ZIS1`, `%ZIS3`, `^%ZOSF("TYPE-AHEAD")`, `^rOBJ("XUP")` | TRACE | infrastructure; not capability evidence |

## TEMPORARY / INTERMEDIATE STRUCTURES OBSERVED

None. No `^TMP`, `^XTMP`, `^UTILITY` or `^||` reference was recorded — the recorded window ended before the
workflow body. This is **no evidence either way**, not evidence of absence. `^GETPPGINFO` was confirmed available
(`%SYS`) but was not run against the user's session. No producer → structure → consumer chain and no
**CANDIDATE SERVICE SEAM** can be stated from this experiment.

## Correlation of user actions with runtime events

| User action | Runtime | Confidence |
|---|---|---|
| `D ^XUP` at the programmer prompt | TRACE run 1 +11.9 s: `CALL` with `ARG "XUP"`, `^rOBJ("XUP")`, `RtnLoad ^XUP` | direct |
| Sign-on / primary-menu lookup | TRACE run 1 +24.6 s: `^DIC(19,28,0)` (EVE) at `+137^DIC1` | likely; which keystroke is not recorded |
| Answered NO to "Enter multiple equipment inventory items" (option 2 had been chosen) | TRACE run 2: `DIR` returns into `ENEQ1`, `QUIT at +56^ENEQ1` (`EQMADX`) | supported by source; the answer itself is not in the trace |
| Inspection W.O. YES (run 1) / NO (run 2) | STATE only: WO 5438 for 487; none for 488 | state, not trace |
| Record saved → bulletin | SAMPLE `^%ZTSCH(…,6002674)`; STATE task 6002674 | state + sample |

## State verification summary (independent of the trace)

| Check | Run 1 (IEN 487) | Run 2 (IEN 488) |
|---|---|---|
| 6914 record exists | yes | yes |
| SERIAL stored as entered | 10100 | 10101 |
| B / F / FC cross-references | all present | all present |
| ENTERED BY / DATE ENTERED | 1 / 3261109 | 1 / 3261109 |
| TOTAL ASSET VALUE (fld 12) | 50001 | **not stored** (node 2 absent) |
| Inspection W.O. | answered YES → WO 5438 exists | answered NO → none (declined side effect did not occur) |
| Bulletin | queued, task 6002674 (not run) | queued, task 6002675 (not run) |

## Ambiguities

- Why event recording stops on VADEMO (build 2026.1 233U on Windows vs the working 2026.2 container) is not known.
- Run 1 ends mid-record (`…DIC2+0,0,7x`) and run 2's last `QUIT` has line `+22676^XQ1`, which `XQ1` does not have — both
  look like the writer's state breaking just before recording stops.
- `GloRef` alone does not mark sets vs reads; `GloSet` / `GloKill` exist and should be added when recording works.
- Run 2's missing asset value may be a data-entry slip or a save problem; worth a look by the user, outside this
  experiment.
