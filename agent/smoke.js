"use strict";
// Smoke test: exercises the Bedrock Converse tool-use loop + decision actuation, no UI.
const fs = require("fs");
const path = require("path");
const { runAgent, MODEL } = require("./lib/bedrock");
const { defaultDecisions, getState } = require("./lib/tools");

(async function () {
  const graph = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "capability-graph", "new-inventory-entry.json"), "utf8"));
  const decisions = defaultDecisions(graph);
  console.log("model:", MODEL);
  console.log("SIDE.PMSchedule before:", decisions.dec["SIDE.PMSchedule"]);

  const ctx = {
    graph, decisions,
    system: "You are the Decide-stage assistant. Use tools. Be concise. Disposition→target: Business Operation=BO, Event=async publish, Inline=in BP, Drop=none.",
  };

  const q = "In one sentence, what does the 'Event' disposition produce for the SIDE.Bulletin element? Then change SIDE.PMSchedule to Event.";
  const out = await runAgent(q, [], ctx);
  console.log("\n--- reply ---\n" + out.reply);
  console.log("\n--- tools called ---");
  out.toolTrace.forEach(t => console.log(" ", t.name, JSON.stringify(t.input), "→", JSON.stringify(t.result).slice(0, 120)));
  console.log("\nSIDE.PMSchedule after:", decisions.dec["SIDE.PMSchedule"]);
  console.log(decisions.dec["SIDE.PMSchedule"] === "Event" ? "\nPASS: agent applied the decision." : "\nNOTE: decision not flipped (check reply/tools).");
})().catch(e => { console.error("SMOKE ERROR:", e.message); process.exit(1); });
