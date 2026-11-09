"use strict";
// XINDEX experiment controller. Logins come from agent/.env.
//   node --env-file=agent/.env experiments/xindex/xctl.js deploy | remove
//   node --env-file=agent/.env experiments/xindex/xctl.js run <roots> <prefix> <max> <out.json>
const fs = require("fs");
const path = require("path");
const { vademoFromEnv } = require("../../agent/lib/vademo");

const CLASS = "Harness.Experiment.XIndex.cls";
const va = vademoFromEnv(process.env, { timeoutMs: 180000 });

(async () => {
  const [cmd, roots, prefix, max, out] = process.argv.slice(2);
  if (cmd === "deploy") {
    await va.putClass(CLASS, fs.readFileSync(path.join(__dirname, CLASS), "utf8"));
    await va.compile([CLASS]);
    console.log("deployed " + CLASS);
  } else if (cmd === "remove") {
    console.log(CLASS + ": " + await va.deleteClass(CLASS));
  } else if (cmd === "run") {
    const rows = await va.query("SELECT Harness_Experiment.XIndex_Run(?,?,?) AS j", [roots, prefix, Number(max)]);
    const j = typeof rows[0].j === "string" ? JSON.parse(rows[0].j) : rows[0].j;
    fs.writeFileSync(out, JSON.stringify(j, null, 1));
    if (j.error) throw new Error(JSON.stringify(j));
    console.log(JSON.stringify({ routines: Object.keys(j.routines).length, missing: j.missing, capped: j.capped, seconds: j.seconds }));
  } else throw new Error("usage: deploy | remove | run <roots> <prefix> <max> <out.json>");
})().catch(e => { console.error(e.message); process.exit(1); });
