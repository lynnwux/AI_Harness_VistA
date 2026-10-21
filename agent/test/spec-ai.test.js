"use strict";
const test   = require("node:test");
const assert = require("node:assert/strict");
const fs     = require("fs");
const path   = require("path");
const { graph, rec, IM } = require("./helpers");
const { buildAiSpec, renderAi } = require("../lib/specs/ai");
const { generate, inputHashes, stage } = require("../lib/specs");
const { sqlFor, TEMPLATES } = require("../lib/ai-templates");

const inventory = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "..", "capability-graph", "inventory-fields.json"), "utf8")
);

// Orchestrator is done
const IM_orch_done = { ...IM, orchestrator: { built: true, verified: true } };
const IM_ai_done   = { ...IM_orch_done, ai: { built: true, verified: true } };

// inputs helper that includes inventory
const inputsWithInv = (record, implemented = IM) => ({ graph, record, implemented, inventory });
const inputsNoInv   = (record, implemented = IM) => ({ graph, record, implemented, inventory: null });

// A fully decided aiQuestions section — three kept, one dropped.
const fullyDecidedAiQ = {
  "AIQ.AgingOutFY": {
    keep: true,
    wording: "Which equipment ages out this FY?",
    params: { fiscalYear: 2030, capitalizedMeans: "INVESTMENT_CATEGORY = 1", useStatuses: ["ALL"] },
  },
  "AIQ.HighValueNoContract": {
    keep: true,
    wording: "Which high-value items have no contract?",
    params: { threshold: 50000, valueColumn: "TOTAL_ASSET_VALUE", useStatuses: ["ALL"] },
  },
  "AIQ.JCAHOPendingInspection": {
    keep: false,
  },
  "AIQ.CapitalPlanningTotals": {
    keep: true,
    wording: "What are the capital-planning totals?",
    params: { useStatuses: ["ALL"], valueColumns: ["TOTAL_ASSET_VALUE"], groupBy: "none" },
  },
};

// ── 1. empty aiQuestions ────────────────────────────────────────────────────────

test("empty aiQuestions gives four 'keep' missing items", () => {
  const spec = buildAiSpec(graph, rec(), IM, inventory);
  const keeps = spec.missing.filter(m => m.kind === "keep");
  assert.equal(keeps.length, 4);
  assert.ok(TEMPLATES.every(t => keeps.some(m => m.id === t.id)));
  assert.equal(spec.complete, false);
});

// ── 2. fully decided record is complete ────────────────────────────────────────

test("fully decided record is complete and rendered markdown contains filled SQL for each kept question", () => {
  const r = rec({ aiQuestions: fullyDecidedAiQ });
  const spec = buildAiSpec(graph, r, IM, inventory);
  assert.equal(spec.missing.length, 0, "missing: " + JSON.stringify(spec.missing));
  assert.equal(spec.complete, true);

  const md = renderAi(spec);
  assert.match(md, /^# AI layer spec — Equipment inventory chatbot/m);

  // Each kept question's SQL should appear in a fenced block
  const keptIds = ["AIQ.AgingOutFY", "AIQ.HighValueNoContract", "AIQ.CapitalPlanningTotals"];
  for (const id of keptIds) {
    const t = TEMPLATES.find(t => t.id === id);
    const aq = fullyDecidedAiQ[id];
    const sql = sqlFor(t, aq.params, inventory);
    assert.ok(md.includes(sql), `rendered markdown missing SQL for ${id}`);
  }
});

// ── 3. dropped question absent from detail.questions ──────────────────────────

test("a question with keep: false is absent from detail.questions", () => {
  const r = rec({ aiQuestions: fullyDecidedAiQ });
  const spec = buildAiSpec(graph, r, IM, inventory);
  const ids = spec.detail.questions.map(q => q.id);
  assert.ok(!ids.includes("AIQ.JCAHOPendingInspection"), "dropped question must be absent");
  assert.ok(ids.includes("AIQ.AgingOutFY"), "kept question must be present");
});

// ── 4. aiQuestions isolation in inputHashes ────────────────────────────────────

test("changing aiQuestions does not change orchestrator or api input hashes, but does change ai hash", () => {
  const base  = inputsWithInv(rec());
  const withQ = inputsWithInv(rec({ aiQuestions: fullyDecidedAiQ }));

  assert.deepEqual(inputHashes("api", base), inputHashes("api", withQ), "api hash must not change");
  assert.deepEqual(inputHashes("orchestrator", base), inputHashes("orchestrator", withQ), "orchestrator hash must not change");
  assert.notDeepEqual(inputHashes("ai", base), inputHashes("ai", withQ), "ai hash must change");
});

// ── 5. stage walk: orchestrator-verified → keep → ready → done ────────────────

// A record where orchestrator decisions are complete (no orchestrator missing items).
const orchDecided = {
  dec: { "OQ.WorkOrderPolicy": "Business rule" },
  oqPolicy: { "OQ.WorkOrderPolicy": "a rule", "OQ.PMEnrollmentPolicy": "later", "OQ.FAConfirmation": "later" },
  targets: { "SIDE.Bulletin": { recipients: "eng@example.org" } },
};

test("stage walks: orchestrator-verified → 'keep' → 'ready' → 'done'", () => {
  // After orchestrator is built and verified, with inventory, stage moves to AI layer.
  // Empty aiQuestions → first missing is "keep".
  const specsKeep = generate(inputsWithInv(rec(orchDecided), IM_orch_done));
  const stKeep = stage(specsKeep, IM_orch_done);
  assert.equal(stKeep.layer, "ai");
  assert.equal(stKeep.step, "keep");

  // Fully decided aiQuestions but orchestrator not yet verified → still orchestrator
  const specsOrchNotDone = generate(inputsWithInv(rec({ ...orchDecided, aiQuestions: fullyDecidedAiQ }), IM));
  assert.notEqual(stage(specsOrchNotDone, IM).layer, "ai");

  // Fully decided + orchestrator done but ai not yet built → "ready"
  const specsReady = generate(inputsWithInv(rec({ ...orchDecided, aiQuestions: fullyDecidedAiQ }), IM_orch_done));
  const stReady = stage(specsReady, IM_orch_done);
  assert.equal(stReady.layer, "ai");
  assert.equal(stReady.step, "ready");

  // ai built and verified → "done"
  const specsDone = generate(inputsWithInv(rec({ ...orchDecided, aiQuestions: fullyDecidedAiQ }), IM_ai_done));
  const stDone = stage(specsDone, IM_ai_done);
  assert.equal(stDone.layer, "ai");
  assert.equal(stDone.step, "done");
});

// ── 6. no inventory → discovery missing ──────────────────────────────────────

test("generate with inventory: null reports a 'discovery' missing item in the AI spec", () => {
  const spec = generate(inputsNoInv(rec())).ai;
  assert.ok(spec.missing.some(m => m.kind === "discovery"), "must have a 'discovery' missing item");
  assert.equal(spec.complete, false);
});

// ── 7. recorded-but-invalid param → 'param' missing; spec never complete ──────

test("a recorded-but-invalid param is a 'param' missing item and spec is not complete (ruling 1)", () => {
  // AIQ.JCAHOPendingInspection: workOrderStatuses set to bogus codes (invalid for STATUS column)
  const badAiQ = {
    "AIQ.AgingOutFY":             { keep: false },
    "AIQ.HighValueNoContract":    { keep: false },
    "AIQ.JCAHOPendingInspection": {
      keep: true,
      wording: "JCAHO pending inspection?",
      params: {
        workOrderStatusColumn: "STATUS",
        workOrderStatuses: ["BOGUS_CODE"],  // invalid for STATUS column
        useStatuses: ["ALL"],
      },
    },
    "AIQ.CapitalPlanningTotals":  { keep: false },
  };
  const r = rec({ aiQuestions: badAiQ });
  const spec = buildAiSpec(graph, r, IM, inventory);

  // Must have a "param" missing for workOrderStatuses with the validation error in 'what'
  const paramMissing = spec.missing.filter(m => m.kind === "param");
  assert.ok(paramMissing.length > 0, "must have at least one 'param' missing item");
  const woMissing = paramMissing.find(m => m.key === "workOrderStatuses");
  assert.ok(woMissing, "workOrderStatuses must be a missing param");
  assert.ok(typeof woMissing.what === "string" && woMissing.what.length > 0, "what must contain the validation error");

  // Spec must not be complete
  assert.equal(spec.complete, false);

  // sqlFor would throw for this question's params
  const t = TEMPLATES.find(t => t.id === "AIQ.JCAHOPendingInspection");
  assert.throws(
    () => sqlFor(t, badAiQ["AIQ.JCAHOPendingInspection"].params, inventory),
    /invalid params/
  );
});

// ── 8. shape: detail fields ────────────────────────────────────────────────────

test("buildAiSpec detail has the required fields", () => {
  const spec = buildAiSpec(graph, rec(), IM, inventory);
  assert.equal(spec.layer, "ai");
  assert.ok(Array.isArray(spec.builds) && spec.builds.length);
  assert.ok(Array.isArray(spec.needs) && spec.needs.length === 1);
  assert.equal(spec.needs[0].service, "read:lookup");
  const d = spec.detail;
  assert.equal(d.container, "iris-ai-hub");
  assert.equal(d.namespace, "INTEROP");
  assert.equal(d.package, "EquipmentAI");
  assert.ok(Array.isArray(d.general.allowList));
  assert.equal(d.general.rowCap, 200);
  assert.ok(Array.isArray(d.questions));
});

test("the general path's allow-list is the inventory's (schema-qualified), the one the guard enforces, and is rendered that way", () => {
  const spec = buildAiSpec(graph, rec({ aiQuestions: fullyDecidedAiQ }), IM, inventory);
  assert.deepEqual(spec.detail.general.allowList, inventory.allowList);
  assert.ok(!spec.detail.general.allowList.includes("VISTA.WORK_ORDER_6920"));
  const line = renderAi(spec).split("\n").find(l => l.startsWith("- Allow-list:"));
  assert.equal(line, `- Allow-list: ${inventory.allowList.map(t => `\`${t}\``).join(", ")}.`);
  assert.ok(!/WORK_ORDER_6920|NEW_PERSON200/.test(line));
  assert.deepEqual(buildAiSpec(graph, rec(), IM, null).detail.general.allowList, []);
});
