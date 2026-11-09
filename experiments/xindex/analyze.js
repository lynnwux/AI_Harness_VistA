"use strict";
// Tag-level reachability over the XINDEX index, compared with the capability graph.
//   node experiments/xindex/analyze.js [entry=EQAD^ENEQ1]
// Writes static-index.json (reachable call graph, globals, boundary calls) and prints a summary.
const fs = require("fs");
const path = require("path");

const dir = __dirname;
const idx = JSON.parse(fs.readFileSync(path.join(dir, "raw", "closure-EN.json"), "utf8"));
const graph = require("../../capability-graph/new-inventory-entry.json");
const entry = process.argv[2] || "EQAD^ENEQ1";

const R = idx.routines;
const callerTag = ref => ref.replace(/^[!*~]+/, "").replace(/[!*~]+$/, "").split("+")[0];
const refs = v => (v || "").split(",").map(s => s.trim()).filter(Boolean).map(s => s.replace(/^[!*~]+/, ""));
const node = (tag, rtn) => `${tag}^${rtn}`;

// edges: caller tag node -> [{to, line, kind}]
const edges = new Map();
const add = (from, to, line, kind) => { if (!edges.has(from)) edges.set(from, []); edges.get(from).push({ to, line, kind }); };
for (const [rtn, r] of Object.entries(R)) {
  for (const [tag, lines] of Object.entries(r.I || {})) {
    if (tag.startsWith("@")) continue;
    const t = tag.replace(/^\$\$/, "").split("+")[0];
    for (const l of refs(lines)) add(node(callerTag(l), rtn), node(t, rtn), `${l}^${rtn}`, "internal");
  }
  for (const [key, lines] of Object.entries(r.X || {})) {
    const [p, t0 = ""] = key.split(" ");
    const prog = p.split("(")[0];
    const t = t0.replace(/^\$\$/, "").split("+")[0] || prog;
    for (const l of refs(lines)) add(node(callerTag(l), rtn), node(t, prog), `${l}^${rtn}`, t0.startsWith("$$") ? "extrinsic" : "external");
  }
}

// BFS from the entry tag; routines outside the index are boundary nodes (not expanded).
const reach = new Map([[entry, { depth: 0, via: null }]]);
const queue = [entry], boundary = new Map();
while (queue.length) {
  const n = queue.shift();
  const rtn = n.split("^")[1];
  if (!R[rtn]) continue;
  for (const e of edges.get(n) || []) {
    const tr = e.to.split("^")[1];
    if (!R[tr]) { if (!boundary.has(e.to)) boundary.set(e.to, []); boundary.get(e.to).push(e.line); }
    if (!reach.has(e.to)) { reach.set(e.to, { depth: reach.get(n).depth + 1, via: e.line }); if (R[tr]) queue.push(e.to); }
  }
}
const reachedTags = [...reach.keys()].filter(n => R[n.split("^")[1]]);
const tagsByRtn = {};
for (const n of reachedTags) { const [t, r] = n.split("^"); (tagsByRtn[r] ||= new Set()).add(t); }

// Globals referenced from reached tags (root + first subscript as XINDEX keys them), with set/kill flags.
const globals = new Map();
for (const [rtn, tags] of Object.entries(tagsByRtn)) {
  for (const [g, lines] of Object.entries(R[rtn].G || {})) {
    for (const raw of (lines || "").split(",").map(s => s.trim()).filter(Boolean)) {
      const l = raw.replace(/^[!~]+/, "");
      if (!tags.has(callerTag(l))) continue;
      const k = g.replace(/"$/, "");
      if (!globals.has(k)) globals.set(k, { set: false, kill: false, lines: [] });
      const o = globals.get(k);
      if (/\*/.test(l)) o.set = true;
      if (/!/.test(l.slice(l.length - 2))) o.kill = true;
      o.lines.push(l.replace(/[!*~]+$/, "") + "^" + rtn + (/\*/.test(l) ? " (set)" : "") + (/!$/.test(l.replace(/\*$/, "")) ? " (kill)" : ""));
    }
  }
}
const naked = [];
for (const [rtn, tags] of Object.entries(tagsByRtn))
  for (const [g, lines] of Object.entries(R[rtn].N || {}))
    for (const l of refs(lines)) if (tags.has(callerTag(l))) naked.push(`${g} at ${l.replace(/[!*~]+$/, "")}^${rtn}`);

const isTemp = g => /^\^(TMP|XTMP|UTILITY|\|\|)/.test(g);

// The capability graph's routine and global references, extracted from its text (same as the runtime experiment).
const gtext = JSON.stringify(graph);
const gTags = new Set([...gtext.matchAll(/\b([A-Z%][A-Z0-9]*)\^([A-Z%][A-Z0-9]{1,7})\b/g)].map(m => node(m[1], m[2])));
const gRtns = new Set([...gtext.matchAll(/\^([A-Z%][A-Z0-9]{1,7})\b/g)].map(m => m[1]));
const gGlobals = new Set([...gtext.matchAll(/\^([A-Z%][A-Z0-9]*)\(([^,)"\\]+|\\"[^\\]+\\")/g)].map(m => `^${m[1]}(${m[2].replace(/\\"/g, '"')}`));
const routinesReached = new Set(Object.keys(tagsByRtn));
const boundaryRtns = new Set([...boundary.keys()].map(n => n.split("^")[1]));

const out = {
  entry, generatedAt: new Date().toISOString(),
  source: "Toolkit ^XINDEX (7.3) on VADEMO via SETUP^XINDX7 / BEG^XINDEX; index of the EN* routines reachable from ENEQ1",
  indexed: { routines: Object.keys(R).length, missing: idx.missing },
  reached: {
    tags: reachedTags.length,
    routines: [...routinesReached].sort(),
    tagsByRoutine: Object.fromEntries(Object.entries(tagsByRtn).sort().map(([r, s]) => [r, [...s].sort()])),
    path: Object.fromEntries(reachedTags.sort().map(n => [n, reach.get(n)])),
  },
  boundaryCalls: Object.fromEntries([...boundary].sort().map(([k, v]) => [k, [...new Set(v)]])),
  globals: Object.fromEntries([...globals].sort().map(([k, v]) => [k, { ...v, temporary: isTemp(k), inGraph: [...gGlobals].some(x => x.startsWith(k) || k.startsWith(x)) }])),
  nakedReferences: naked,
  comparison: {
    graphTagsFound: [...gTags].filter(n => reach.has(n)).sort(),
    graphTagsNotReached: [...gTags].filter(n => !reach.has(n)).sort(),
    routinesNotInGraph: [...routinesReached].filter(r => !gRtns.has(r)).sort(),
    boundaryRoutinesNotInGraph: [...boundaryRtns].filter(r => !gRtns.has(r)).sort(),
    globalsNotInGraph: [...globals.keys()].filter(k => ![...gGlobals].some(x => x.startsWith(k) || k.startsWith(x))).sort(),
    graphGlobals: [...gGlobals].sort(),
  },
};
fs.writeFileSync(path.join(dir, "static-index.json"), JSON.stringify(out, null, 1) + "\n");
console.log(JSON.stringify({ reachedTags: reachedTags.length, routines: out.reached.routines, comparison: out.comparison }, null, 1));
