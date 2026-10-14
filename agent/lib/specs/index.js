"use strict";
// The one generator: three input files (graph, decisions record, implemented services) → three layer
// specs, each as structured JSON plus markdown rendered from the same object.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { loadRecord } = require("../record");
const api = require("./api");
const orchestrator = require("./orchestrator");
const ai = require("./ai");

const ROOT = path.join(__dirname, "..", "..", "..");
const DEFAULT_PATHS = {
  graph: path.join(ROOT, "capability-graph", "new-inventory-entry.json"),
  decisions: path.join(ROOT, "agent", "decisions.json"),
  implemented: path.join(ROOT, "agent", "implemented.json"),
  specsDir: path.join(ROOT, "capability-graph", "specs"),
};
const LAYERS = ["api", "orchestrator", "ai"];

function canon(v) {
  if (Array.isArray(v)) return "[" + v.map(canon).join(",") + "]";
  if (v && typeof v === "object") return "{" + Object.keys(v).sort().map(k => JSON.stringify(k) + ":" + canon(v[k])).join(",") + "}";
  return JSON.stringify(v === undefined ? null : v);
}
const sha = v => crypto.createHash("sha256").update(canon(v)).digest("hex");

// The API spec hashes only what it may depend on, so orchestrator decisions never make it look stale.
function inputHashes(layer, { graph, record, implemented }) {
  if (layer === "api") return { graph: sha(graph), decisions: sha(api.dataSlice(graph, record)), implemented: sha((implemented && implemented.api) || []) };
  return { graph: sha(graph), decisions: sha(record), implemented: sha(implemented) };
}

function generate(inputs) {
  const { graph, record, implemented } = inputs;
  const specs = {
    api: api.buildApiSpec(graph, record, implemented),
    orchestrator: orchestrator.buildOrchestratorSpec(graph, record, implemented),
    ai: ai.buildAiSpec(),
  };
  for (const l of LAYERS) specs[l].inputs = inputHashes(l, inputs);
  return specs;
}

function render(layer, spec, inputs) {
  if (layer === "api") return api.renderApi(inputs.graph, inputs.record, spec);
  if (layer === "orchestrator") return orchestrator.renderOrchestrator(inputs.graph, inputs.record, spec);
  return ai.renderAi(spec);
}

function writeSpecs(dir, specs, inputs) {
  // render everything first, so a rendering error never leaves a half-written set of spec files
  const md = Object.fromEntries(LAYERS.map(l => [l, render(l, specs[l], inputs)]));
  fs.mkdirSync(dir, { recursive: true });
  for (const l of LAYERS) {
    fs.writeFileSync(path.join(dir, `${l}.json`), JSON.stringify(specs[l], null, 2) + "\n");
    fs.writeFileSync(path.join(dir, `${l}.md`), md[l]);
  }
  return md;
}

function stage(specs, implemented) {
  const o = specs.orchestrator;
  for (const kind of ["decide", "binding", "evidence", "target"]) {
    const m = o.missing.find(x => x.kind === kind);
    if (m) return { layer: "orchestrator", step: kind, next: m };
  }
  const unmet = o.needs.find(n => !n.met);
  if (unmet) return { layer: "orchestrator", step: "needs", next: unmet };
  const p = (implemented && implemented.orchestrator) || {};
  if (!(p.built && p.verified)) return { layer: "orchestrator", step: "ready", next: null };
  return { layer: "ai", step: "design", next: null };
}

const readJson = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { return fallback; } };

function loadInputs(paths = DEFAULT_PATHS, fallbackRecord) {
  return {
    graph: JSON.parse(fs.readFileSync(paths.graph, "utf8")),
    record: loadRecord(paths.decisions, fallbackRecord),
    implemented: readJson(paths.implemented, { api: [], orchestrator: { built: false, verified: false } }),
  };
}

module.exports = { DEFAULT_PATHS, LAYERS, canon, inputHashes, generate, render, writeSpecs, stage, loadInputs };
