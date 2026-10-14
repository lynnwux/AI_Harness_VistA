"use strict";
/* Real naive build: scaffold Angular → npm install → ng build → publish to prototype/build/.
   Driven from capability-graph/specs/api.json (the API layer spec). Streams progress to build-status.json.
   Invoked (detached) by POST /api/build. Takes minutes (fresh scaffold + install + compile). */
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { angularFiles, DEFAULT_COMPONENT_FILES } = require("./lib/angular-app");
const { DEFAULT_PATHS, loadInputs, inputHashes, canon } = require("./lib/specs");
const API_SPEC = path.join(DEFAULT_PATHS.specsDir, "api.json");

const ROOT = path.join(__dirname, "..");                    // repo root
const WORK_ROOT = path.join(__dirname, "_build");           // holds per-build workspaces
const RUN_ID = new Date().toISOString().replace(/[:.]/g, "-");
const WORK = path.join(WORK_ROOT, "run-" + RUN_ID);         // fresh, unique per build → guaranteed clean start
const APP = path.join(WORK, "eqbuild");
const OUT = path.join(ROOT, "prototype", "build");          // published site
const STATUS = path.join(__dirname, "build-status.json");

// Ordered phases with a rough typical duration (sec) and a % band; the bar
// interpolates within each phase by elapsed time so it moves during long steps.
const PHASES = [
  { key: "read",     label: "Reading spec",                          from: 0,  to: 3,   sec: 2 },
  { key: "work",     label: "Preparing workspace",                   from: 3,  to: 5,   sec: 2 },
  { key: "scaffold", label: "Scaffolding Angular + installing deps", from: 5,  to: 60,  sec: 150 },
  { key: "generate", label: "Generating app from spec",              from: 60, to: 64,  sec: 3 },
  { key: "build",    label: "Compiling (ng build)",                  from: 64, to: 96,  sec: 100 },
  { key: "publish",  label: "Publishing to /prototype/build/",       from: 96, to: 100, sec: 4 },
];
const TOTAL_SEC = PHASES.reduce((s, p) => s + p.sec, 0);
const t0 = Date.now();
let phaseIdx = -1, phaseStart = Date.now(), ticker = null;
let status = { state: "starting", step: "", pct: 0, elapsedSec: 0, etaSec: TOTAL_SEC, startedAt: new Date().toISOString(), log: [], url: null, error: null };
function save() { try { fs.writeFileSync(STATUS, JSON.stringify(status, null, 2)); } catch (e) {} }
function log(line) { status.log.push(line); if (status.log.length > 400) status.log = status.log.slice(-400); save(); }
function tick() {
  status.elapsedSec = Math.round((Date.now() - t0) / 1000);
  if (phaseIdx >= 0 && phaseIdx < PHASES.length) {
    const p = PHASES[phaseIdx], frac = Math.min(1, (Date.now() - phaseStart) / 1000 / p.sec);
    status.pct = Math.min(p.to - 0.5, p.from + frac * (p.to - p.from));
  }
  status.etaSec = Math.max(0, Math.round(TOTAL_SEC - status.elapsedSec));
  save();
}
function setStep(step) {
  const i = PHASES.findIndex(p => step.indexOf(p.label.split(" ")[0]) === 0 || step === p.label);
  if (i >= 0) { phaseIdx = i; phaseStart = Date.now(); status.pct = PHASES[i].from; }
  status.step = step; status.state = "building"; log("▶ " + step);
}
function run(cmd, args, cwd) {
  return new Promise((resolve, reject) => {
    log("$ " + cmd + " " + args.join(" ") + (cwd ? "   (in " + path.relative(ROOT, cwd) + ")" : ""));
    const p = spawn(cmd, args, { cwd: cwd || WORK, shell: true, env: process.env });
    p.stdout.on("data", d => String(d).split(/\r?\n/).forEach(l => l.trim() && log(l.trim().slice(0, 200))));
    p.stderr.on("data", d => String(d).split(/\r?\n/).forEach(l => l.trim() && log(l.trim().slice(0, 200))));
    p.on("close", code => code === 0 ? resolve() : reject(new Error(cmd + " exited " + code)));
    p.on("error", reject);
  });
}

// The build reads ONLY the API layer spec, and refuses one generated from inputs that have since changed.
function buildConfig(specFile = API_SPEC, paths = DEFAULT_PATHS){
  const spec = JSON.parse(fs.readFileSync(specFile, "utf8"));
  if (canon(inputHashes("api", loadInputs(paths))) !== canon(spec.inputs)) throw new Error("api spec is stale — its inputs changed since it was generated; regenerate (POST /api/build does this) and retry");
  return spec.detail;
}

async function main(){
  ticker = setInterval(tick, 1000);
  try{
    setStep("Reading spec (capability-graph/specs/api.json)");
    const cfg = buildConfig();
    log(`spec → ${cfg.pages.length} screens, ${cfg.pages.reduce((n,p)=>n+p.fields.length,0)} fields`);

    setStep("Preparing workspace");
    // Guarantee a clean start for EVERY iteration: this build gets its own fresh workspace,
    // and we best-effort sweep any leftover ones. A dir still locked by a just-killed npm/ng
    // (Windows EBUSY after Stop) is skipped — harmless, because this run never touches it and
    // the next sweep clears it. The build therefore ALWAYS begins in an empty directory.
    try {
      for (const d of fs.readdirSync(WORK_ROOT)) {
        const p = path.join(WORK_ROOT, d);
        if (p === WORK) continue;
        try { fs.rmSync(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); log("· removed old workspace " + d); }
        catch (e) { log("· old workspace " + d + " is in use — skipping (will sweep next build)"); }
      }
    } catch (e) { /* _build doesn't exist yet — nothing to sweep */ }
    fs.mkdirSync(WORK, { recursive: true });

    // Pin CLI to v20 — its Node engine (^22.12.0) is satisfied by this machine's
    // Node 22.13.1; @latest (v21) needs >=22.22.3 which this box doesn't have.
    setStep("Scaffolding Angular project (npx @angular/cli@20 new)");
    await run("npx", ["-y", "@angular/cli@20", "new", "eqbuild", "--routing=false", "--style=css", "--skip-git", "--skip-tests", "--defaults", "--ssr=false"], WORK);

    setStep("Generating app from spec");
    writeAngularApp(cfg);

    setStep("Compiling (ng build) — this is the long part");
    await run("npx", ["ng", "build", "--base-href", "/prototype/build/", "--output-path", "dist"], APP);

    setStep("Publishing to /prototype/build/");
    fs.rmSync(OUT, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
    const browser = path.join(APP, "dist", "browser");
    const src = fs.existsSync(browser) ? browser : path.join(APP, "dist");
    fs.cpSync(src, OUT, { recursive: true });
    // tidy this run's workspace now that its output is published (best-effort — the
    // start-of-build sweep is the real guarantee, so a locked dir here is harmless).
    try { fs.rmSync(WORK, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch (e) {}

    clearInterval(ticker); phaseIdx = -1;
    status.state = "done"; status.pct = 100; status.etaSec = 0; status.url = "/prototype/build/"; status.finishedAt = new Date().toISOString();
    status.step = "Done — built and published"; log("✅ Done — built and published"); save();
  }catch(e){
    clearInterval(ticker); phaseIdx = -1;
    status.state = "error"; status.error = String(e.message || e); status.etaSec = 0; save();
    log("✗ BUILD FAILED: " + status.error);
  }
}
if (require.main === module) main();

// ---- generate the Angular source (standalone component wizard) from the config ----

// remove default component files if present (avoid confusion; main.ts imports ./app/app)
function writeAngularApp(cfg){
  for (const [rel, content] of Object.entries(angularFiles(cfg))) fs.writeFileSync(path.join(APP, rel), content);
  const appDir = path.join(APP, "src", "app");
  DEFAULT_COMPONENT_FILES.forEach(f=>{ try{ fs.rmSync(path.join(appDir,f),{force:true}); }catch(e){} });
}

module.exports = { buildConfig, angularFiles };
