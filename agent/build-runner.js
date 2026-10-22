"use strict";
/* Phase 1 build: deploy the REST service to VADEMO, prove the write path in file 6914,
   scaffold Angular → npm install → ng build → publish to prototype/build/.
   Driven from capability-graph/specs/api.json (the API layer spec). Streams progress to build-status.json.
   Invoked (detached) by POST /api/build. Takes minutes (fresh scaffold + install + compile). */
const fs = require("fs");
const path = require("path");
const { angularFiles, DEFAULT_COMPONENT_FILES } = require("./lib/angular-app");
const { buildAngularApp } = require("./lib/angular-build");
const { saveKnownGood: saveKnownGoodLib, KNOWN_GOOD_ROOT } = require("./lib/known-good");
const { DEFAULT_PATHS, loadInputs, inputHashes, designHash, canon } = require("./lib/specs");
const { PHASE1_SERVICES, emptyImplemented, apiRecord, builtApi } = require("./lib/implemented");
const { vademoFromEnv } = require("./lib/vademo");
const { deployRestService, REST_CLASSES, HARNESS_DIR } = require("./lib/rest-service");
const { verifyWritePath, runIdOf } = require("./lib/api-verify");
const { redact } = require("./lib/iris-deploy");
const { watchParent } = require("./lib/runner-control");

const ROOT = path.join(__dirname, "..");                    // repo root
const WORK_ROOT = path.join(__dirname, "_build");           // holds per-build workspaces
const OUT = path.join(ROOT, "prototype", "build");          // published site
const STATUS = path.join(__dirname, "build-status.json");

// Ordered phases with a rough typical duration (sec) and a % band; the bar
// interpolates within each phase by elapsed time so it moves during long steps.
const PHASES = [
  { key: "read",     label: "Reading spec",                              from: 0,  to: 3,   sec: 2 },
  { key: "deploy",   label: "Deploying the REST service to VADEMO",      from: 3,  to: 10,  sec: 30 },
  { key: "verify",   label: "Verifying the write path in file 6914",     from: 10, to: 18,  sec: 30 },
  { key: "work",     label: "Preparing workspace",                       from: 18, to: 20,  sec: 2 },
  { key: "scaffold", label: "Scaffolding Angular + installing deps",     from: 20, to: 68,  sec: 150 },
  { key: "generate", label: "Generating app from spec",                  from: 68, to: 72,  sec: 3 },
  { key: "build",    label: "Compiling (ng build)",                      from: 72, to: 97,  sec: 100 },
  { key: "publish",  label: "Publishing to /prototype/build/",           from: 97, to: 100, sec: 4 },
];
const TOTAL_SEC = PHASES.reduce((s, p) => s + p.sec, 0);

const readJson = (f, fb) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch (_) { return fb; } };

// The build reads ONLY the API layer spec, and refuses one generated from inputs that have since changed.
function buildConfig(specFile, paths = DEFAULT_PATHS) {
  const file = specFile || path.join(DEFAULT_PATHS.specsDir, "api.json");
  const spec = JSON.parse(fs.readFileSync(file, "utf8"));
  if (canon(inputHashes("api", loadInputs(paths))) !== canon(spec.inputs))
    throw new Error("api spec is stale — its inputs changed since it was generated; regenerate (POST /api/build does this) and retry");
  return spec.detail;
}

async function main(deps = {}) {
  const {
    paths = DEFAULT_PATHS,
    statusFile = STATUS,
    outDir = OUT,
    workRoot = WORK_ROOT,
    knownGoodRoot = KNOWN_GOOD_ROOT,
    env = process.env,
    buildApp = buildAngularApp,
    now = () => new Date(),
  } = deps;
  const saveKG = deps.saveKnownGood || saveKnownGoodLib;

  const t0 = Date.now();
  let phaseIdx = -1, phaseStart = Date.now(), ticker = null;
  let status = { state: "starting", step: "", pct: 0, elapsedSec: 0, etaSec: TOTAL_SEC, startedAt: now().toISOString(), log: [], url: null, error: null, verification: [] };
  const save = () => { try { fs.writeFileSync(statusFile, JSON.stringify(status, null, 2)); } catch (_) {} };
  const log = line => { status.log.push(line); if (status.log.length > 400) status.log = status.log.slice(-400); save(); };
  const tick = () => {
    status.elapsedSec = Math.round((Date.now() - t0) / 1000);
    if (phaseIdx >= 0 && phaseIdx < PHASES.length) {
      const p = PHASES[phaseIdx], frac = Math.min(1, (Date.now() - phaseStart) / 1000 / p.sec);
      status.pct = Math.min(p.to - 0.5, p.from + frac * (p.to - p.from));
    }
    status.etaSec = Math.max(0, Math.round(TOTAL_SEC - status.elapsedSec));
    save();
  };
  const setStep = step => {
    const i = PHASES.findIndex(p => step.indexOf(p.label.split(" ")[0]) === 0 || step === p.label);
    if (i >= 0) { phaseIdx = i; phaseStart = Date.now(); status.pct = PHASES[i].from; }
    status.step = step; status.state = "building"; log("▶ " + step);
  };
  save(); // write "starting" before anything else

  ticker = setInterval(tick, 1000);
  try {
    setStep("Reading spec");
    const apiSpec = JSON.parse(fs.readFileSync(path.join(paths.specsDir, "api.json"), "utf8"));
    if (canon(inputHashes("api", loadInputs(paths))) !== canon(apiSpec.inputs))
      throw new Error("api spec is stale — its inputs changed since it was generated; regenerate (POST /api/build does this) and retry");
    const cfg = apiSpec.detail;
    log(`spec → ${cfg.pages.length} screens, ${cfg.pages.reduce((n, p) => n + p.fields.length, 0)} fields`);

    // A rebuild in flight is not the verified thing: clear the record before any VADEMO call
    const prevImpl = readJson(paths.implemented, emptyImplemented());
    if (apiRecord(prevImpl).built) {
      fs.writeFileSync(paths.implemented, JSON.stringify({ ...prevImpl, api: emptyImplemented().api }, null, 2));
    }

    // Lazy: missing setting becomes a status error, not a module-load crash
    const vademo = deps.vademo || vademoFromEnv(env);

    setStep("Deploying the REST service to VADEMO");
    const deploy = await deployRestService(vademo, { log });
    status.verification.push({ check: "REST service deployed", result: "ok" });
    status.verification.push({ check: `web app /Harness/Equipment ${deploy.webApp}`, result: "ok" });
    save();

    setStep("Verifying the write path in file 6914");
    const runId = runIdOf(now());
    const verify = await verifyWritePath(vademo, apiSpec, { runId, log });
    status.verification.push({ check: "GET next IEN", result: "ok" });
    status.verification.push({ check: `POST test record → IEN ${verify.ien}`, result: "ok" });
    status.verification.push({ check: `read back ${verify.rows.length} fields over SQL`, result: "ok" });
    save();
    log(`  test record IEN ${verify.ien}, serial ${verify.serial}`);

    setStep("Preparing workspace");
    const RUN_ID = now().toISOString().replace(/[:.]/g, "-");
    const WORK = path.join(workRoot, "run-" + RUN_ID);
    // Guarantee a clean start: sweep leftover workspaces. A dir still locked by a just-killed npm/ng
    // is skipped — harmless, because this run never touches it and the next sweep clears it.
    try {
      for (const d of fs.readdirSync(workRoot)) {
        const p = path.join(workRoot, d);
        if (p === WORK) continue;
        try { fs.rmSync(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); log("· removed old workspace " + d); }
        catch (_) { log("· old workspace " + d + " is in use — skipping (will sweep next build)"); }
      }
    } catch (_) { /* workRoot doesn't exist yet — nothing to sweep */ }
    fs.mkdirSync(WORK, { recursive: true });

    // Pin CLI to v20 — its Node engine (^22.12.0) is satisfied by this machine's Node 22.13.1.
    await buildApp({
      workRoot: WORK,
      name: "eqbuild",
      files: angularFiles(cfg),
      removeFiles: DEFAULT_COMPONENT_FILES,
      baseHref: "/prototype/build/",
      outDir,
      log,
      onPhase: p => {
        if      (p === "scaffold") setStep("Scaffolding Angular + installing deps");
        else if (p === "generate") setStep("Generating app from spec");
        else if (p === "build")    setStep("Compiling (ng build)");
        else if (p === "publish")  setStep("Publishing to /prototype/build/");
      },
    });
    // tidy this run's workspace now that its output is published (best-effort)
    try { fs.rmSync(WORK, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch (_) {}

    // copy REST_CLASSES to a temp dir so known-good has only those files (HARNESS_DIR has extras)
    const restDir = path.join(workRoot, "rest-" + RUN_ID);
    fs.mkdirSync(restDir, { recursive: true });
    for (const cls of REST_CLASSES) fs.copyFileSync(path.join(HARNESS_DIR, cls), path.join(restDir, cls));
    const verifiedRecord = { ien: verify.ien, serial: verify.serial, at: now().toISOString() };
    try {
      saveKG("api", { dirs: { site: outDir, rest: restDir }, meta: { url: "/prototype/build/", restClasses: REST_CLASSES } }, knownGoodRoot);
    } finally {
      // clean up on every path — saveKnownGood atomically copied the dir before this runs
      try { fs.rmSync(restDir, { recursive: true, force: true }); } catch (_) {}
    }
    // implemented.json is the last committed side effect: written only after known-good succeeds
    const freshImpl = readJson(paths.implemented, emptyImplemented());
    freshImpl.api = { ...builtApi(PHASE1_SERVICES, { verifiedRecord, builtFrom: designHash(apiSpec) }) };
    fs.writeFileSync(paths.implemented, JSON.stringify(freshImpl, null, 2));

    clearInterval(ticker); phaseIdx = -1;
    status.state = "done"; status.pct = 100; status.etaSec = 0; status.url = "/prototype/build/"; status.finishedAt = now().toISOString();
    log("  saved as the known-good entry form (restore last good)");
    status.step = "Done — built and published"; log("✅ Done — built and published"); save();
    return status;
  } catch (e) {
    clearInterval(ticker); phaseIdx = -1;
    status.state = "error"; status.error = redact(String(e.message || e), [env.VADEMO_PASSWORD].filter(Boolean)); status.etaSec = 0;
    save();
    log("✗ BUILD FAILED: " + status.error);
    return status;
  }
}

if (require.main === module) { watchParent(); main(); }

module.exports = { buildConfig, angularFiles, main, STATUS_FILE: STATUS };
