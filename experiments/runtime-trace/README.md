# Runtime-trace experiment (2026-11-09)

Can IRIS `%SYS.Trace` (`RtnLoad` + `GloRef`) improve Discovery for New Inventory Entry (`ENINVNEW` → `EQAD^ENEQ1`)?
Two traced runs of the user's VistA session (PID 15424), one control job on VADEMO, one control on the local
IRIS. Files: `NOTES.md` (API, permissions, what happened), `comparison.md` (vs the capability graph),
`runtime-trace.json` (normalized), `trace-rendering.txt` (readable), `state-evidence.json`; the raw traces are in
`raw/` (git-ignored). Scripts: `ctl.js`, `va.js`, `normalize.js`, probe `Harness.Experiment.RuntimeTrace.cls`
(deleted from VADEMO).

**Result: not proven on VADEMO.** The API is there, we have the privilege (`_SYSTEM`, `%All`), and the calls are
right. But VADEMO (IRIS 2026.1 Build 233U, Windows) recorded events for only the first 10–25 s of each trace, then
nothing, and a controlled job recorded no events at all. The same call on the local IRIS 2026.2 recorded every
event. So the workflow body (`EQAD`, `ASKSER`, `ADDEQ`, ScreenMan, the side effects) was never traced. The defensible
statement is:

> During New Inventory Entry on VADEMO, runtime tracing recorded only the sign-on and menu around the workflow:
> routines `XUP`, `%ZIS1`, `%ZIS3`, `DIC1`, `DIR`/`DIR1`/`DIRQ`, `XQ1` and `ENEQ1` (`EQMAD`/`EQMADX`), and global
> references `^DIC(19,28,0)`, `^%ZOSF("TYPE-AHEAD")`, `^rOBJ("XUP")`. No temporary structure was recorded. That
> confirms 3 elements of the static graph. State evidence, read independently, confirmed the record, serial,
> B/F/FC cross-references, entered-by/date, the work order when YES and its absence when NO. It also showed
> that 3 known branches (PM, FA, the duplicate-serial match) were not exercised. Process sampling and state found
> 2 items the graph lacks: the bulletin goes through TaskMan (`TASK^XMXBULL`), and the same routine has a second
> entry point (`EQMAD^ENEQ1`). Neither came from the trace itself.

## The ten questions

1. **Routines actually executed?** Not on VADEMO — only the first seconds were recorded. Where it records (locally),
   `RtnLoad` gives every call and return with stack level and arguments: yes.
2. **Globals actually referenced?** Same: full reference with subscripts, line, source line and database when it
   records; on VADEMO only 4 references were recorded.
3. **Routine context for references?** Yes, where recorded: `^DIC(19,28,0)` at `+137^DIC1` with its source line.
4. **`^TMP` / `^XTMP` / `^||`?** None recorded — the window didn't reach the workflow. `^GETPPGINFO` is available for
   PPG names (never values); untested against the session.
5. **Anything static missed?** Yes, though from process sampling and state, not the trace: the bulletin is queued
   to TaskMan (an async boundary, and TaskMan on VADEMO isn't running tasks), and `EQMAD^ENEQ1` converges on the
   same capability.
6. **Candidate service boundary from a temp structure?** No evidence either way.
7. **Signal-to-noise?** What was recorded was mostly Kernel/FileMan plumbing (sign-on, menu, reader). A run started
   at the Equipment menu avoids the sign-on noise. Filtering by routine namespace (`EN*`) would be needed.
8. **`RtnLines` selectively?** Not tried — the first experiment didn't succeed (prerequisite). Note the event is
   named `RtnLine` on this version.
9. **AI Hub Discovery tool/skill?** Not yet. The mechanics are small (start / stop / read-rows / state checks were
   about 200 lines), but the tool is only worth building once tracing records reliably on the target instance.
   `%SYS.ProcessQuery` sampling and independent state checks were the parts that produced evidence today.
10. **Smallest next step:**
    1. Find out why VADEMO stops recording: check `^PERFMON` / `%SYS.MONLBL` status there and rerun the 20-second
       `SelfTest` control; the same control on another 2026.1 Windows instance would separate the build from VADEMO's
       configuration.
    2. Once the control records, rerun scenario 2 with `RtnLoad, GloRef, GloSet, GloKill`, started from the
       Equipment menu.
    3. Only then wrap `Start` / `Stop` / `Rows` plus the state checks as a Discovery tool.
