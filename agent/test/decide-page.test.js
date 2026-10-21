"use strict";
// The Decide page's own logic (capability-graph/decide.html), run in a VM with a stub DOM: the opening messages
// and the default tab follow the stage, and an out-of-date server is announced.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { graph, rec, IM } = require("./helpers");
const { generate, render, stage } = require("../lib/specs");

const HTML = fs.readFileSync(path.join(__dirname, "..", "..", "capability-graph", "decide.html"), "utf8");
const SCRIPT = HTML.split("<script>")[1].split("</script>")[0];
const inventory = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "capability-graph", "inventory-fields.json"), "utf8"));

function page() {
  const el = () => ({ style: {}, dataset: {}, classList: { toggle() {}, add() {}, remove() {} }, addEventListener() {}, appendChild() {}, remove() {}, insertAdjacentHTML() {} });
  const ctx = vm.createContext({
    document: { getElementById: el, querySelectorAll: () => [], createElement: el },
    location: { protocol: "http:" }, window: { open() {} }, localStorage: { getItem: () => null, setItem() {} },
    fetch: () => new Promise(() => {}),   // the boot waits forever: nothing is loaded
    setTimeout, setInterval, clearInterval, console, URL, Blob: function () {},
  });
  vm.runInContext(SCRIPT + "\n;globalThis.__page = { openingMessages, defaultTab, serverLooksOld, OLD_SERVER_NOTICE };", ctx);
  return ctx.__page;
}

// /api/specs as the server builds it
function apiSpecs(record, implemented, inv = inventory) {
  const inputs = { graph, record, implemented, inventory: inv };
  const specs = generate(inputs);
  const layer = l => ({ md: render(l, specs[l], inputs), complete: specs[l].complete, missing: specs[l].missing, needs: specs[l].needs, owns: specs[l].owns });
  return { error: null, notice: null, stage: stage(specs, implemented), layers: { api: layer("api"), orchestrator: layer("orchestrator"), ai: layer("ai") } };
}
const DONE = { dec: { "OQ.WorkOrderPolicy": "Defer", "OQ.PMEnrollmentPolicy": "Defer", "OQ.FAConfirmation": "Defer" },
               oqPolicy: { "OQ.WorkOrderPolicy": "later", "OQ.PMEnrollmentPolicy": "later", "OQ.FAConfirmation": "later" },
               targets: { "SIDE.Bulletin": { recipients: "x@va.gov" } } };
const VERIFIED = { ...IM, orchestrator: { built: true, verified: true } };
const ALL_KEPT = {
  "AIQ.AgingOutFY":             { keep: true, wording: "Ages out?",   params: { fiscalYear: 2031, capitalizedMeans: "INVESTMENT_CATEGORY = 1", useStatuses: ["ALL"] } },
  "AIQ.HighValueNoContract":    { keep: true, wording: "High value?", params: { threshold: 50000, valueColumn: "TOTAL_ASSET_VALUE", useStatuses: ["ALL"] } },
  "AIQ.JCAHOPendingInspection": { keep: true, wording: "JCAHO?",      params: { workOrderStatusColumn: "STATUS", workOrderStatuses: ["ALL"], useStatuses: ["ALL"] } },
  "AIQ.CapitalPlanningTotals":  { keep: true, wording: "Totals?",     params: { useStatuses: ["ALL"], valueColumns: ["TOTAL_ASSET_VALUE"], groupBy: "none" } },
};

test("the page script parses", () => { assert.doesNotThrow(() => new Function(SCRIPT)); });

test("in the AI stage the opening says the production is built and verified, lists the AI items, and opens the AI tab", () => {
  const p = page();
  const s = apiSpecs(rec(DONE), VERIFIED);
  assert.equal(s.stage.layer, "ai");
  const text = p.openingMessages(s).join("\n\n");
  assert.doesNotMatch(text, /working on the \*\*Orchestrator\*\* layer/);
  assert.doesNotMatch(text, /ready for the production build/);
  assert.match(text, /production[^\n]*built and verified/i);
  assert.match(text, /\*\*AI\*\* layer/);
  assert.match(text, /Still to decide for the AI layer/);
  assert.ok(text.includes(s.layers.ai.missing[0].what), "the first AI item is named");
  assert.equal(p.defaultTab(s), "ai");
});

test("a complete AI spec is ready for 🔨 Build AI; a verified one points at the chat app", () => {
  const p = page();
  const ready = apiSpecs(rec({ ...DONE, aiQuestions: ALL_KEPT }), VERIFIED);
  assert.equal(ready.stage.step, "ready");
  assert.match(p.openingMessages(ready).join("\n"), /ready for 🔨 Build AI/);
  const built = { ...VERIFIED, ai: { built: true, verified: true } };
  const done = apiSpecs(rec({ ...DONE, aiQuestions: ALL_KEPT }), built);
  assert.equal(done.stage.step, "done");
  assert.match(p.openingMessages(done).join("\n"), /AI layer is built and verified/);
  assert.equal(p.defaultTab(done), "ai");
});

test("in the orchestrator stage the opening is the orchestrator's and the orchestrator tab opens", () => {
  const p = page();
  const s = apiSpecs(rec(), IM);
  assert.equal(s.stage.layer, "orchestrator");
  const text = p.openingMessages(s).join("\n\n");
  assert.match(text, /\*\*Orchestrator\*\* layer/);
  assert.doesNotMatch(text, /Build AI/);
  assert.equal(p.defaultTab(s), "orchestrator");
  assert.match(p.openingMessages({ error: "x" }).join(""), /could not be generated/);
});

test("an out-of-date server is announced: the AI status is not JSON, or /api/specs has the old AI shape", () => {
  const p = page();
  const fresh = apiSpecs(rec(DONE), VERIFIED);
  assert.equal(p.serverLooksOld(fresh, true), false);
  assert.equal(p.serverLooksOld(fresh, false), true, "/api/build/ai/status answered HTML");
  const old = JSON.parse(JSON.stringify(fresh));
  old.layers.ai = { md: "# AI layer spec — RegisterEquipment\n⏸ Not yet designed — piece 3.", complete: false, missing: [{ id: "AI", kind: "design", what: "AI layer not yet designed (piece 3)" }], needs: [], owns: [] };
  assert.equal(p.serverLooksOld(old, true), true);
  assert.equal(p.serverLooksOld({ error: "unreachable" }, true), false, "an unreachable server has its own message");
  assert.match(p.OLD_SERVER_NOTICE, /restart the workbench server \(npm start\)/i);
  // the page shows the notice and boots on the stage's tab
  assert.match(SCRIPT, /serverLooksOld\(SPECS, AI_STATUS_JSON\)/);
  assert.match(SCRIPT, /OLD_SERVER_NOTICE/);
  assert.match(SCRIPT, /TAB\s*=\s*defaultTab\(SPECS\)/);
});

test("agent/README.md documents the AI layer and says to restart the server after updating", () => {
  const md = fs.readFileSync(path.join(__dirname, "..", "README.md"), "utf8");
  for (const s of ["/api/build/ai", "/api/build/ai/status", "/ai/chat", "/ai/quick/:id", "ai-runner.js", "discover-inventory.js",
                   "VADEMO_URL_FROM_IRIS", "VADEMO_READ_USER", "VADEMO_READ_PASSWORD", "AWS_BEARER_TOKEN_BEDROCK", "restart the workbench server"]) {
    assert.ok(md.includes(s), s);
  }
});
