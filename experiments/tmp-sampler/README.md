# ^TMP sampling experiment (2026-11-09)

Can sampling a live VistA session's `^TMP($J)` (and its process state) add value to Discovery? Yes, as a
complement to static XINDEX, not as a trace. It found one business rule that neither the capability graph nor XINDEX
has.

## How it ran

- **Probe:** a throwaway class `Harness.Experiment.TmpSampler` (source here), deleted afterwards (404). It
  reads only the **shape** of `^TMP(<pid>)` and `^UTILITY(<pid>)`: subscript names to two levels, `$D`, and node
  counts (capped at 5,000), never values. It also reads `%SYS.ProcessQuery` (`Routine`, `State`,
  `LastGlobalReference`).
- **Sampler:** a background job polled every 250 ms and logged only changes, in `^IRIS.Temp.HarnessSampler`
  (IRISTEMP, cleared afterwards). It ran only against an interactive `|TRM|` process in VISTA-DIEGO.
- **Scenario:** PID 24468, New Inventory Entry. Serial 10102, ASSET VALUE 50001, FUNCTIONAL CLASS PC, inspection
  work order YES. 606 samples in 2.5 minutes, 17 changes logged (`raw/samples-24468.jsonl`, git-ignored).
- **Leftovers first:** the earlier session 15424 left nothing in `^TMP` or `^UTILITY`. Sign-off clears them (even
  with TaskMan down), so evidence must come from a live session.

## What it showed

| Time (UTC) | Routine at the prompt | Last global reference | `^TMP(24468,…)` | Reading |
|---|---|---|---|---|
| 16:19:05–16 | `DIC11`, `DIC1`, `XQ`, `XQ2` | `^DD(19,0,"DIC")`, `^DIC(19,12728,0)`, `^XMB(3.7,1,0)`, `^XUTL("XQO",38,…)` | — | sign-on and menu navigation (option lookups, mailbox check, menu cache) |
| 16:19:32 | `DIR` | `^%ZIS(2,231,7)` | — | a reader prompt before the form (terminal type 231 loaded) |
| 16:19:57 | `XGKB` | `^XUTL("XGKB")` | `"DJST"` 8 nodes | ScreenMan running |
| 16:20:16 | `XGKB` | | `"DJ",19` 20 nodes | screen **ENEQ1** (6910.9 IEN 19) displayed |
| 16:20:24 | **`ENJINJ3`** | **`^XUSEC("ENEDSPEX",1)`** | | **key check during the form** |
| 16:20:42 | `XGKB` | | `"DJ",19` + `20` = 43 nodes | screen **ENEQ2** (IEN 20) displayed; **ENEQ3 (27) never** |
| 16:20:45 | `DIR` | `^ENG(6910.2,13,0)` | `"DJST"` gone; `"DJ"` stays | "Create an Incoming Inspection Work Order" prompt (parameter entry 13) |
| 16:20:46 | `DIED` | `^ENG(6920,5439,1)` | | FileMan editing the new work order 5439 |
| 16:20:59 | `XQ` | `^XMB(3.7,1,0)` | `"DJ"` 43 nodes left until sign-off | back at the menu |

State, read separately: record IEN **489**, serial 10102, TOTAL ASSET VALUE 50001, PC. Work order **5439**
`RA261109-002` → 489. Bulletin task **6002676** `TASK^XMXBULL`, queued with status 1, not run (TaskMan is down).

## Structures

| Structure | Producer → consumer (evidence) | Class |
|---|---|---|
| `^TMP($J,"DJ",<screen IEN>,<entry #>)` | built by ScreenMan `EN^ENJ` / `ENJDPL` and read by `ENJINJ*` (XINDEX); one node per entry of each screen displayed — 20 for ENEQ1, 23 for ENEQ2. The 2 missing ENEQ2 entries (18 COMMENTS, 19 SPEX) are the word-processing fields. | **WORKFLOW_STATE** (form buffer). Not a service seam, but it shows **which screens actually ran** |
| `^TMP($J,"DJST",0|1)` | ScreenMan; killed when the form exits (`ENJ+26`) | **SCRATCH_STATE** |
| `^TMP($J,"BAD",…)` (FA validation) | known statically (`ENFAVAL` → `LISTP^ENFAXMTM`); not reachable here because user 1 holds no `EN*` keys (`ENFACS` would be needed — not granted) | not sampled |

## What it added to Discovery

1. **A rule hidden in data — DISCOVERY GAP CANDIDATE.** The sample at 16:20:24 caught `ENJINJ3` checking
   `^XUSEC("ENEDSPEX",DUZ)`. No `EN*` routine references `ENEDSPEX`, so XINDEX cannot see it, and the capability
   graph has no mention of it. The code is in screen ENEQ2's definition (file 6910.97):
   - entry 18 COMMENTS, post-action `I '$D(^XUSEC("ENEDSPEX",DUZ)) S DJNX=20`;
   - entry 19 SPEX, pre-action "You must hold key ENEDSPEX to edit this field."

   So **editing SPEX (specifications) requires key ENEDSPEX**, a field-level security rule executed by indirection.
   This is the class of evidence static analysis misses: code stored in FileMan data and run through `X`/`@`.
2. **Branch coverage per screen:** the `"DJ"` subscripts show the clerk saw ENEQ1 and ENEQ2, not ENEQ3.
3. **Prompt-by-prompt correlation:** each prompt maps to its routine and the data just touched: inspection prompt →
   `^ENG(6910.2,13)`, work-order edit → `^ENG(6920,5439)`.
4. **A static follow-up it points to:** scan every pre/post-action in the screen definitions (6910.97) for keys,
   globals and calls. That is a cheap, read-only SQL survey and would catch rules like ENEDSPEX without sampling.

## Limits

- **Snapshots, not a trace.** A structure built and killed between two samples is missed: no FileMan `DIE`/`DIC`
  scratch was caught. `LastGlobalReference` is a single reference, and it is useful because samples land while the
  process waits at a `READ`.
- **No producer.** Producers and consumers come from XINDEX and the source, not from the sample.
- **Values are real data.** Reading only names, `$D` and counts kept it safe; values were never read.
- **Interactive only.** Work done in TaskMan (the bulletin) runs under another `$J`.

## Verdict

Worth keeping as a **light, read-only Discovery check**:
- static XINDEX for the call graph and globals;
- a screen-action-code survey for rules stored in data;
- one sampled run per workflow, to confirm which screens and branches executed and to catch indirection
  (like ENEDSPEX).

The smallest reusable piece is `Shape(pid)` + `Proc(pid)` + the change-only sampling loop, about 100 lines.
