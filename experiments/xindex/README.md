# XINDEX experiment (2026-11-09)

Can Toolkit's `^XINDEX` (option XUINDEX, `%Index of Routines`) add to the static capability graph for New Inventory
Entry? Yes. It is read-only, fast and complete, and it confirms the graph while adding concrete evidence the graph
lacks: secondary writes, look-up files, FileMan/Kernel API boundaries, a temporary structure's producer and consumer.

## How it ran

- A throwaway probe `Harness.Experiment.XIndex` (source here) ran XINDEX on VADEMO in a background job, through the API
  documented in `XINDX7` (`D SETUP^XINDX7`, lines into `^UTILITY($J,1,rtn,0,n,0)`, `D BEG^XINDEX`). It started at
  `ENEQ1` and followed every called routine whose name starts with `EN`. Calls outside `EN*` (FileMan, Kernel,
  MailMan) are kept as boundary calls and not expanded. The probe was deleted afterwards (404).
- **Writes:** only XINDEX's own `^UTILITY($J)` scratch and the result handed back through `^IRIS.Temp.HarnessXIndex`
  (IRISTEMP), both killed. "Save parameters in ROUTINE file" stays off (`INP(7)=0`), so file 9.8 is untouched.
- **Result:** 54 routines indexed in 0.18 s. Two that are called, `ENZWO1` and `ENZWO2` (site hooks called from
  `ENWOD2`), are not installed; neither is on this workflow's path.
- **Pitfalls hit:**
  - `LOAD^XINDEX` loads source through `^%ZOSF("LOAD")` (`ZLOAD`), which broke the calling frame. The lines are
    read with `$TEXT` instead.
  - After XINDEX runs, sequential-file writes in the job fail intermittently with `<WRITE>`, so the result is
    returned through a temp global.
- `analyze.js` turns XINDEX's per-routine index (tags, internal and external calls with the calling line, globals
  with set/kill flags, naked references) into **tag-level reachability from `EQAD^ENEQ1`**: 75 tags in 25 routines.
  It writes `static-index.json`.

## Confirmed

All **19** `TAG^ROUTINE` references in the graph (`EQAD`, `ASKEDM`, `ASKSER`, `ADDEQ`, `ENR` `^ENEQ1`; `FILE^DICN`,
`GET1^DIQ`, `UP^XLFSTR`, `ZIS^ENUTL`, `EN^ENJ`, `XNPMSE^ENEQPMP`, `DINV^ENEQPMP3`, `IIWO^ENWONEW3`, `WONUM`/`WOFILL`
`^ENWONEW`, `BULL^ENEQ3`, `CHKFA^ENFAUTL`, `AVP^ENFAAV`, `ADJBAL^ENFABAL`) are reachable from `EQAD^ENEQ1`. None
is unreachable. Every global in the graph appears in the reached code with matching lines. For example, `^ENG(6914)`
is set by `ENR` / `ADDEQ`, and `^ENG(6910.2)` is read at `ADDEQ+36..39`.

## What it adds — candidates for the graph, by side effect

| Where | New static evidence (line) | Kind |
|---|---|---|
| SIDE.FinancialAsset | `ADJBAL^ENFABAL` **sets FAP BALANCES `^ENG(6915.9)`** through `UPDATE^DIE` (`ADJBAL+18..31`) | a second persistent write of the FA side effect — not in the graph |
| SIDE.FinancialAsset | reads FAP DOCUMENT COUNTERS `^ENG(6915.1)` (`SETUP+5^ENFAACQ`) and FD DOCUMENT LOG `^ENG(6915.5)` (`CHKFA+8^ENFAUTL`) | look-up files |
| SIDE.FinancialAsset | `DEL^ENFAACQ` → `DIK` removes the FA log entry when the document is not completed | compensating action |
| SIDE.FinancialAsset | `^ENFAVAL` → `BAD^ENFAACQ` **writes** `^TMP($J,"BAD",<equip DA>,n)` + count; `VALEQ` checks it; `LISTP^ENFAXMTM` **reads** it, shows it, then kills `^TMP($J)` | **INTERMEDIATE_VIEW** (the graph's evidence text mentions `VALEQ`/`^TMP($J,"BAD")`; this adds the producer `ENFAVAL`, the consumer `ENFAXMTM` and the kill). **CANDIDATE SERVICE SEAM:** *validate equipment for an FA document → list of problems* — the modern service would reproduce `ENFAVAL`'s checks, not read `^TMP` |
| SIDE.WorkOrder | `IIWO^ENWONEW3` reads ENGINEERING SECTION LIST `^DIC(6922)`, `^ENG("EMP")` and NEW PERSON `^VA(200)`, and writes with `UPDATE^DIE` / `WP^DIE`; `WONUM^ENWONEW` uses `%DT` + `FILE^DICN` | dependencies of the work order |
| SIDE.Bulletin | `BULL^ENEQ3` reads `^VA(200)`, SERVICE/SECTION `^DIC(49)`, `^ENG(6911)`; `CHKMGRP` uses `FIND1^DIC` / `LIST^DIC`; hands off with **`XMB^XMB` at `BULL+38`** | static side of the async boundary the runtime experiment found (task `TASK^XMXBULL`) |
| SIDE.PMSchedule | `XNPMSE^ENEQPMP` **sets** `^ENG(6914)` (`XNPMSE+3`) — the PM schedule lives on the equipment record; `ENEQPMP1`, `MNTH^ENLIB1`, reads `^ENG(6914.2)`, `^DIC(6922)` | write location of the PM side effect |
| DEP.ENJ (ScreenMan) | `EN^ENJ` → `ENJC2`, `ENJDPL`, `ENJINJ`/`1`/`2`/`3`, `ENJINQ`, `ENJPARAM`; reads screens `^ENG(6910.9)`, `^DD`, terminal types `^%ZIS(2)`; `^TMP($J,"DJ")` / `"DJST"` | infrastructure, **SCRATCH_STATE** |
| Boundaries | `DIE`, `DIC`, `DICN`, `DIK`, `DIQ`, `DIR`, `DIWP`, `DIALOG`, `%DT`, `%ZIS`, `%ZISS`, `XMB`, `XLFSTR` | FileMan / Kernel / MailMan APIs the workflow depends on |

## Limits

- XINDEX is static. It cannot resolve indirection (`@`, `X` of a variable, `$$` through a variable) or tell which
  branch runs. For example, it lists the FA path, but not whether a given entry takes it.
- It keys globals by root and first subscript (`^ENG(6914`, `^TMP($J`). For the subscripts, the source line has to
  be read, as done above for `^TMP($J,"BAD")`.
- Fall-through from one tag into the next is not an edge; the reachability is a slight under-count.

## Files

`analyze.js`, `static-index.json` (reachable tags with the call that reached each, globals with set/kill and lines,
boundary calls, comparison), `Harness.Experiment.XIndex.cls`, `xctl.js`. `raw/closure-EN.json` (the full XINDEX output)
and `_src/` (routine source) are git-ignored.
