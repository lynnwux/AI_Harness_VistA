"use strict";
const fs = require("fs");
const path = require("path");
const { defaultDecisions } = require("../lib/tools");
const { normalize } = require("../lib/record");

const graph = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "capability-graph", "new-inventory-entry.json"), "utf8"));
const IM = {
  api: [
    { id: "write:6914", endpoint: "POST /equipment", what: "create a file-6914 record" },
    { id: "read:next-ien", endpoint: "GET /equipment/next-ien", what: "next IEN, display-only" },
    { id: "read:lookup", endpoint: "GET /lookup/{file}?q=", what: "pointer-file search" },
  ],
  entryForm: { built: true },
  orchestrator: { built: false, verified: false },
};
// a fresh, normalized default record with sections patched in, e.g. rec({ dec: { … }, oqPolicy: { … } })
function rec(patch) {
  const r = normalize(JSON.parse(JSON.stringify(defaultDecisions(graph))));
  for (const [k, v] of Object.entries(patch || {})) Object.assign(r[k], v);
  return r;
}
const se = id => graph.capabilities[0].sideEffects.find(s => s.id === id);

module.exports = { graph, IM, rec, se };
