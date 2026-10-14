"use strict";
// AI layer spec: a frame until piece 3 designs it.
function buildAiSpec() {
  return { layer: "ai", builds: [], owns: [], uses: ["Orchestrator: the production front door"], needs: [], missing: [{ id: "AI", kind: "design", what: "AI layer not yet designed (piece 3)" }], complete: false, detail: {} };
}
function renderAi(spec) {
  return [
    "# AI layer spec — RegisterEquipment",
    "⏸ Not yet designed — piece 3. Offered only once the production is built and verified.",
    "", "## Builds", "- not yet designed",
    "", "## Owns", "- not yet designed",
    "", "## Uses (by reference)", ...spec.uses.map(u => `- ${u}`),
    "", "## Needs from lower layers", "- read endpoints for operational analytics — to be designed in piece 3",
    "",
  ].join("\n");
}
module.exports = { buildAiSpec, renderAi };
