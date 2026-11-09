"use strict";
// Trace controller for the runtime-trace experiment (process B side). Logins come from agent/.env.
//   node --env-file=agent/.env experiments/runtime-trace/ctl.js deploy | remove
//   node --env-file=agent/.env experiments/runtime-trace/ctl.js call <Method> [args...]
//   node --env-file=agent/.env experiments/runtime-trace/ctl.js fetch <pid> <outDir>   (raw lines + parsed rows)
const fs = require("fs");
const path = require("path");
const { vademoFromEnv } = require("../../agent/lib/vademo");

const CLASS = "Harness.Experiment.RuntimeTrace.cls";
const va = vademoFromEnv(process.env, { timeoutMs: 120000 });

async function call(method, args = []) {
  const ph = args.map(() => "?").join(",");
  const rows = await va.query(`SELECT Harness_Experiment.RuntimeTrace_${method}(${ph}) AS j`, args);
  const j = rows[0].j;
  return typeof j === "string" ? JSON.parse(j) : j;
}

async function pages(method, pid, key, count) {
  const all = [];
  let from = 1, last;
  for (;;) {
    last = await call(method, [pid, from, count]);
    if (last.error) throw new Error(method + ": " + last.error);
    all.push(...last[key]);
    if (!last.more) break;
    from += count;
  }
  return { items: all, last };
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
    const [pid, outDir] = rest;
    fs.mkdirSync(outDir, { recursive: true });
    const raw = await pages("Raw", pid, "lines", 20000);
    fs.writeFileSync(path.join(outDir, `iristrace_${pid}.raw.txt`), raw.items.join("\n") + "\n");
    const parsed = await pages("Rows", pid, "rows", 2000);
    const cols = ["event", "text", "tOffsetUs", "level", "count", "lineAndRoutine", "routineLoc", "srcLine", "globalRef", "globalLoc"];
    const rows = parsed.items.map(r => Object.fromEntries(cols.map((c, i) => [c, r[i]])));
    fs.writeFileSync(path.join(outDir, `iristrace_${pid}.rows.json`), JSON.stringify(rows, null, 0).replace(/\},\{/g, "},\n{"));
    console.log(JSON.stringify({ rawLines: raw.items.length, rows: rows.length, end: parsed.last.end, stopReason: parsed.last.stopReason }));
  } else {
    throw new Error("usage: deploy | remove | call <Method> [args] | fetch <pid> <outDir>");
  }
})().catch(e => { console.error(e.message); process.exit(1); });
