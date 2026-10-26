---
name: reset-preflight
description: Use when the user is about to press the Decide page's reset, a 🔨 Build (API, production or AI) or "restore last good", asks whether the workbench environment is ready, or a reset or build just failed with connection errors (dockerDesktopLinuxEngine, iris session failed, VADEMO answered HTTP 404, ECONNREFUSED, fetch failed).
---

# Reset preflight

## Overview

A reset tears down VADEMO, the `iris-ai-hub` IRIS container and local files in one go, and a build needs most of the same pieces. If one is down, the run fails part-way. Run the preflight first; it checks every dependency and says what to fix.

## How to run it

```bash
cd agent && npm run --silent preflight
```

Exit code 0 means READY (warnings allowed); 1 means at least one check failed.

## Reporting

- Show the user the preflight table as printed, then one line: **ready to reset/build**, or **not ready** plus each ✗ check's fix.
- Explain every ⚠ in a few words. A container that is running but `unhealthy` is IRIS in `alert` state, usually from expired root certificates in its trust store. It doesn't block anything when the IRIS session check passes.
- `–` (skipped) checks depend on an earlier ✗: fix that one first.
- Never trigger the reset, a build or a restore yourself. The user presses the button.

## Common failures

| Check | Usual cause | Fix |
|---|---|---|
| Docker | Docker Desktop not running | Start Docker Desktop; wait for *Engine running* |
| iris-ai-hub container | container stopped | Start it in Docker Desktop, or `docker start iris-ai-hub` |
| VADEMO (VistA) | VADEMO down, or its web routing moved | Check VADEMO is up; set `VADEMO_ATELIER_PATH` in `agent/.env` (default `/irishealth/api/atelier`) |
| Workbench server | server not started | `cd agent && npm start` |
| Nothing running | a build, restore or reset is mid-run | Wait, or stop it from the Decide page |
| Settings | a key missing from `agent/.env` | Add it (see `agent/.env.example`) |

After fixing, run the preflight again before the user resets.
