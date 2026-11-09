# Screen-action survey (2026-11-09)

The New Inventory Entry form runs on Engineering's own screen handler (`EN^ENJ`). Each screen entry in
`6910.9` / `6910.97` can carry M code as a pre-action or post-action, and the handler runs that code by
indirection. XINDEX reads routines only, so it never sees this code. The `^TMP` sampler caught one rule hidden this
way (ENEDSPEX). This survey reads all of the code once, with no sampling.

## How it runs

```
node --env-file=agent/.env experiments/screen-actions/survey.js [screenIEN,...]   # default 19,20,27
```

- **Read-only:** two `SELECT` statements over Atelier SQL (`VISTA.ENG_DJ_SCREEN6910_9`, `VISTA.SUB_ENTRY_DEFINITIONS6910_97`).
  It runs no code on VADEMO and writes nothing there.
- **Output:**
  - `survey.json`: for each entry with code, its keys, calls, direct global sets, field jumps (`DJNX`) and message,
    plus the code itself;
  - `raw/entries.json`: all rows (git-ignored).
- **Screens:**
  - surveyed: ENEQ1 (19) → ENEQ2 (20) → ENEQ3 (27);
  - not surveyed: the `…D` screens are display versions, and ENEQNX1/2 belong to a separate flow.

## Result

53 entries, 21 with code.

| Finding | Where | Candidate in the graph |
|---|---|---|
| **Key ENEDSPEX** guards SPEX. A user without it skips past SPEX after COMMENTS, and landing on SPEX shows "You must hold key ENEDSPEX to edit this field." | 20/18 post, 20/19 pre | `DC.SEC.ENEDSPEX` |
| **Capitalized-asset lock.** `$$CHKFA^ENFAUTL` locks 9 fields; the message names the document needed (FAP, FR or FD). | 19/5, 19/8, 19/11, 20/15, 27/2–7 pre | `DC.RULE.FALockedFields` |
| **ACQ. METHOD gates ASSET VALUE and LEASE COST.** The clears are direct `$P(^(2),U,n)=""` sets that bypass FileMan; `VENPRE^ENLIB` repeats them. | 19/12–14 pre | `DC.RULE.LeaseAndAssetValue` |
| **CONTRACT COST** is offered only if the contract flag is Y; it is otherwise cleared with a direct set on `^(7)` piece 2. | 20/10 pre | already in the graph, except the direct set |
| **CMR change check.** `CMRDJPS^ENTIDD` backs out a CMR change while the equipment has an active IT assignment. | 19/8 post | `DC.RULE.CMRChangeCheck` |
| **Calls reached only from screen data:** `LAST^ENEQ3`, `VENPRE^ENLIB`, `CMRDJPS^ENTIDD`, `DISPM`/`DISPW^ENLIB3`, `$$CHKFA^ENFAUTL`, `$$GET1^DIQ`, `N^ENJDPL` | — | `DC.DEP.ScreenActionRoutines` |
| **Derived displays.** CSN shows MFGR EQPT NAME; BOC shows SGL; LIFE EXPECTANCY, REPLACEMENT DATE and SOURCE show stored values; PARENT SYSTEM copies node 9 piece 12. | various | (same) |

## Limits

- It reads the code; it cannot tell which branch runs for a given record. One sampled run per workflow
  (`experiments/tmp-sampler`) answers that.
- The extraction (keys, calls, sets) uses patterns. The code is kept next to each finding so that it can be read
  directly.
- It covers only the screens listed. A new workflow names its own screens from its option's routine (`EN^ENJ`
  calls).
