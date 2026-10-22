"use strict";
// Shared controls for all runners: kill a process tree, watch the parent, wrap fetch with a timeout,
// sweep old workspace directories.
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

// Kill the process tree rooted at pid (synchronous). Ignores "not found" / ESRCH errors.
function killTree(pid, { spawnSyncImpl = spawnSync, platform = process.platform } = {}) {
  try {
    if (platform === "win32") spawnSyncImpl("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
    else process.kill(-pid, "SIGKILL");
  } catch (_) {}
}

// Poll the parent process; call onGone() exactly once when it is no longer alive.
// Returns a stop() function that cancels the watcher (useful in tests).
function watchParent({
  ppid = process.ppid,
  intervalMs = 2000,
  isAlive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } },
  onGone = () => killTree(process.pid),
} = {}) {
  let fired = false;
  const iv = setInterval(() => {
    if (!isAlive(ppid) && !fired) { fired = true; clearInterval(iv); onGone(); }
  }, intervalMs);
  iv.unref();
  return () => clearInterval(iv);
}

// Wrap fetchImpl so every call gets an AbortSignal that fires after ms milliseconds.
function timedFetch(fetchImpl, ms) {
  return (url, opts) => fetchImpl(url, { ...opts, signal: AbortSignal.timeout(ms) });
}

// Remove every entry of dir that is not in the keep list (by basename), skipping locked ones.
// Returns the names that were successfully removed.
function sweepWorkspaces(dir, { keep = [] } = {}) {
  const keepSet = new Set(keep.map(k => path.basename(k)));
  let removed = [];
  let entries;
  try { entries = fs.readdirSync(dir); } catch (_) { return []; }
  for (const entry of entries) {
    if (keepSet.has(entry)) continue;
    try { fs.rmSync(path.join(dir, entry), { recursive: true, force: true }); removed.push(entry); }
    catch (_) {}   // locked / busy — skip
  }
  return removed;
}

module.exports = { killTree, watchParent, timedFetch, sweepWorkspaces };
