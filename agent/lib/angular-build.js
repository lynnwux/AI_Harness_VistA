"use strict";
// Shared Angular scaffold + build + publish for build-runner.js and ai-runner.js.
// `buildAngularApp` runs all four phases; build-runner.js drives phase-progress via the optional
// `onPhase` callback so its status.json progress tracking is unchanged.
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

/**
 * Scaffold an Angular app, write generated files, compile, and publish.
 *
 * @param {object}   opts
 * @param {string}   opts.workRoot     Parent directory for the scaffold workspace (must exist)
 * @param {string}   opts.name         Angular project name (folder created under workRoot)
 * @param {object}   opts.files        Map of repo-relative path → file content to write
 * @param {string[]} opts.removeFiles  Default component file names to delete from src/app/
 * @param {string}   opts.baseHref     Base href for `ng build` (e.g. "/prototype/build/")
 * @param {string}   opts.outDir       Destination directory for the compiled browser bundle
 * @param {function} [opts.log]        Line-by-line output callback (defaults to no-op)
 * @param {function} [opts.onPhase]    Called at the start of each phase with a string key:
 *                                     "scaffold" | "generate" | "build" | "publish"
 */
async function buildAngularApp({ workRoot, name, files, removeFiles, baseHref, outDir, log, onPhase }) {
  const logger = log    || (() => {});
  const phase  = onPhase || (() => {});
  const app    = path.join(workRoot, name);

  function run(cmd, args, cwd) {
    return new Promise((resolve, reject) => {
      logger("$ " + cmd + " " + args.join(" ") + (cwd ? "   (in " + path.basename(cwd) + ")" : ""));
      const p = spawn(cmd, args, { cwd: cwd || workRoot, shell: true, env: process.env });
      p.stdout.on("data", d => String(d).split(/\r?\n/).forEach(l => l.trim() && logger(l.trim().slice(0, 200))));
      p.stderr.on("data", d => String(d).split(/\r?\n/).forEach(l => l.trim() && logger(l.trim().slice(0, 200))));
      p.on("close", code => code === 0 ? resolve() : reject(new Error(cmd + " exited " + code)));
      p.on("error", reject);
    });
  }

  // Phase 1: scaffold
  phase("scaffold");
  await run("npx", ["-y", "@angular/cli@20", "new", name,
    "--routing=false", "--style=css", "--skip-git", "--skip-tests", "--defaults", "--ssr=false"], workRoot);

  // Phase 2: write generated files and remove the default component stubs
  phase("generate");
  for (const [rel, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(app, rel), content);
  }
  if (removeFiles && removeFiles.length) {
    const appDir = path.join(app, "src", "app");
    for (const f of removeFiles) {
      try { fs.rmSync(path.join(appDir, f), { force: true }); } catch (_) {}
    }
  }

  // Phase 3: compile
  phase("build");
  await run("npx", ["ng", "build", "--base-href", baseHref, "--output-path", "dist"], app);

  // Phase 4: publish to outDir
  phase("publish");
  fs.rmSync(outDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  const browser = path.join(app, "dist", "browser");
  const src = fs.existsSync(browser) ? browser : path.join(app, "dist");
  fs.cpSync(src, outDir, { recursive: true });
}

module.exports = { buildAngularApp };
