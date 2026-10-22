"use strict";
// The last known-good copy of each deliverable: saved at the end of a fully successful build, put back by
// "restore last good". Copies hold only generated files and plain facts — logins and hosts come from agent/.env
// at restore time.
const fs = require("fs");
const path = require("path");

const LAYERS = ["api", "orchestrator", "ai"];
const KNOWN_GOOD_ROOT = path.join(__dirname, "..", "_known-good");
const CREDENTIAL = /\b(password|passwd|pwd|secret|token|api[_-]?key|bearer|authorization)\s*[:=]/i;
const RETRY_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);

// Synchronous sleep via Atomics.wait (avoids async, works in main thread)
const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// renameSync with retry for transient Windows locks; impl is injectable for tests
function renameRetry(from, to, impl) {
  for (let i = 1; ; i++) {
    try { impl(from, to); return; }
    catch (e) { if (!RETRY_CODES.has(e.code) || i >= 10) throw e; sleep(50 * i); }
  }
}

// Copy each named source dir into <root>/<layer>/<name>, replacing the previous copy only once the new one is complete.
function saveKnownGood(layer, { dirs = {}, meta = {}, _rename } = {}, root = KNOWN_GOOD_ROOT) {
  if (!LAYERS.includes(layer)) throw new Error(`unknown layer "${layer}" — one of ${LAYERS.join(", ")}`);
  if (Object.values(meta).some(v => CREDENTIAL.test(String(v)))) throw new Error("refused: a known-good copy never holds a credential");
  const rename = (a, b) => renameRetry(a, b, _rename || fs.renameSync);
  const final = path.join(root, layer), staging = `${final}.new-${process.pid}-${Date.now()}`;
  fs.mkdirSync(staging, { recursive: true });
  try {
    for (const [name, src] of Object.entries(dirs)) {
      if (!fs.existsSync(src)) throw new Error(`${layer}: ${name} source ${src} does not exist`);
      fs.cpSync(src, path.join(staging, name), { recursive: true });
    }
    fs.writeFileSync(path.join(staging, "meta.json"), JSON.stringify({ ...meta, layer, savedAt: new Date().toISOString(), dirs: Object.keys(dirs) }, null, 2) + "\n");
  } catch (e) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw e;
  }
  const old = `${final}.old-${process.pid}-${Date.now()}`;
  let movedToOld = false;
  try {
    if (fs.existsSync(final)) { rename(final, old); movedToOld = true; }
    rename(staging, final);
  } catch (e) {
    fs.rmSync(staging, { recursive: true, force: true });
    if (movedToOld) {
      // Restore previous good copy using the retrying rename; if even that fails, leave .old in place and name it
      try { rename(old, final); }
      catch (putBackErr) { throw new Error(`${e.message}; put-back also failed (${putBackErr.message}) — previous copy stranded at ${old}`); }
    }
    throw e;
  }
  fs.rmSync(old, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  return readKnownGood(layer, root);
}

function readKnownGood(layer, root = KNOWN_GOOD_ROOT) {
  const dir = path.join(root, layer), metaFile = path.join(dir, "meta.json");
  if (fs.existsSync(metaFile)) {
    const meta = JSON.parse(fs.readFileSync(metaFile, "utf8"));
    return { meta, dir, dirs: Object.fromEntries((meta.dirs || []).map(n => [n, path.join(dir, n)])) };
  }
  // Fall back to newest .old-* debris left by a failed swap (put-back stranded)
  if (!fs.existsSync(root)) return null;
  const fallback = fs.readdirSync(root)
    .filter(n => n.startsWith(`${layer}.old-`))
    .map(n => ({ p: path.join(root, n), ts: parseInt(n.split("-").pop(), 10) || 0 }))
    .filter(({ p }) => fs.existsSync(path.join(p, "meta.json")))
    .sort((a, b) => b.ts - a.ts)[0];
  if (!fallback) return null;
  const meta = JSON.parse(fs.readFileSync(path.join(fallback.p, "meta.json"), "utf8"));
  return { meta, dir: fallback.p, dirs: Object.fromEntries((meta.dirs || []).map(n => [n, path.join(fallback.p, n)])) };
}

module.exports = { LAYERS, KNOWN_GOOD_ROOT, saveKnownGood, readKnownGood };
