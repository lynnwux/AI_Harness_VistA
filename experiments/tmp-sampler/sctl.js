"use strict";
// ^TMP sampler controller. Logins come from agent/.env.
//   node --env-file=agent/.env experiments/tmp-sampler/sctl.js deploy | remove
//   node --env-file=agent/.env experiments/tmp-sampler/sctl.js call <Method> [args...]
//   node --env-file=agent/.env experiments/tmp-sampler/sctl.js fetch <pid> <out.jsonl>
const fs = require("fs");
const path = require("path");
const { vademoFromEnv } = require("../../agent/lib/vademo");

const CLASS = "Harness.Experiment.TmpSampler.cls";
const va = vademoFromEnv(process.env, { timeoutMs: 120000 });

async function call(method, args = []) {
  const rows = await va.query(`SELECT Harness_Experiment.TmpSampler_${method}(${args.map(() => "?").join(",")}) AS j`, args);
  const j = rows[0].j;
  return typeof j === "string" ? JSON.parse(j) : j;
}

(async () => {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === "deploy") {
    await va.putClass(CLASS, fs.readFileSync(path.join(__dirname, CLASS), "utf8"));
    await va.compile([CLASS]);
    console.log("deployed " + CLASS);
  } else if (cmd === "remove") {
    console.log(CLASS + ": " + await va.deleteClass(CLASS));
  } else if (cmd === "call") {
    console.log(JSON.stringify(await call(rest[0], rest.slice(1)), null, 1));
  } else if (cmd === "fetch") {
    const [pid, out] = rest;
    const lines = [];
    let from = 1, last;
    for (;;) {
      last = await call("Fetch", [pid, from, 200]);
      lines.push(...last.lines);
      if (last.lines.length < 200) break;
      from += 200;
    }
    fs.writeFileSync(out, lines.join("\n") + "\n");
    console.log(JSON.stringify({ lines: lines.length, running: last.running, done: last.done }));
  } else throw new Error("usage: deploy | remove | call <Method> [args] | fetch <pid> <out.jsonl>");
})().catch(e => { console.error(e.message); process.exit(1); });
