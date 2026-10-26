"use strict";
// npm run preflight — checks every dependency a reset or a build needs and prints what is not ready.
// Exit code 0 when nothing fails (warnings allowed), 1 otherwise.
const { runPreflight, formatReport } = require("./lib/preflight");

runPreflight().then(results => {
  console.log(formatReport(results));
  if (results.some(r => r.status === "fail")) process.exitCode = 1;
}, e => { console.error("preflight could not run: " + (e.message || e)); process.exitCode = 1; });
