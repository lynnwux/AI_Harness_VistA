"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { checkReply, correctionPrompt, buildIndex, groundedTurn } = require("../lib/grounding");

const graph = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "capability-graph", "new-inventory-entry.json"), "utf8"));
const check = (reply, opts = {}) => checkReply({ graph, reply, userMessage: opts.userMessage || "", record: opts.record || { oqPolicy: {} }, currentId: opts.currentId === undefined ? "OQ.WorkOrderPolicy" : opts.currentId });

// the reply from the 2026-10-14 screenshot: borrows the FA conditions and ENEQ3 for the work order
const BAD_WO = "① Incoming inspection work order\n\nIn the legacy, the routine calls `ENEQ3` to create an incoming inspection work order *automatically* when a new capitalized NX item is filed — no operator choice.\n\nMy recommendation: Keep it as Business rule (automatic, like the legacy). The legacy already decided this unconditionally for capitalized NX, so encoding that same logic in the BP is the least disruptive.";

test("flags the work-order reply that borrowed ENEQ3 and the FA conditions", () => {
  const r = check(BAD_WO);
  assert.equal(r.ok, false);
  assert.deepEqual(r.focus, ["OQ.WorkOrderPolicy"]);
  const terms = r.borrowed.map(b => b.term).sort();
  assert.deepEqual(terms, ["ENEQ3", "NX", "capitalized"]);
  assert.ok(r.borrowed.find(b => b.term === "NX").from.includes("OQ.FAConfirmation"));
});

test("passes a work-order reply that sticks to the work order's own evidence", () => {
  const r = check("For the incoming inspection work order, ENEQ1 ADDEQ asks the clerk 'Create an Incoming Inspection Work Order?' only when the site parameter ASK INCOMING INSPECTION W.O. (file 6910.2) is enabled; on YES, IIWO^ENWONEW3 creates the 6920 work order. There is no coded item-condition.");
  assert.equal(r.ok, true, JSON.stringify(r));
});

test("passes an FA reply that uses the FA item's own conditions", () => {
  const r = check("For the FA document to Austin: when TYPE OF ENTRY = NX and the item is capitalized, the ENFACS key holder is asked 'Do you wish to send an FA document to Austin' (default YES); YES runs ^ENFAACQ.", { currentId: "OQ.FAConfirmation" });
  assert.equal(r.ok, true, JSON.stringify(r));
});

test("a reply that names two items may use both items' evidence", () => {
  const r = check("Unlike the FA document to Austin, which depends on NX and capitalized, the incoming inspection work order has no item condition.");
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.focus.sort(), ["OQ.FAConfirmation", "OQ.WorkOrderPolicy"]);
});

test("flags a threshold that is in neither the evidence nor the developer's words", () => {
  const r = check("For the FA document to Austin, a Business rule could be: send if eligible AND cost > $X.", { currentId: "OQ.FAConfirmation" });
  assert.equal(r.ok, false);
  assert.deepEqual(r.thresholds, ["> $X"]);
  const r2 = check("For the incoming inspection work order, a rule could use cost ≥ $50,000.");
  assert.deepEqual(r2.thresholds, ["≥ $50,000"]);
  const r3 = check("For the incoming inspection work order, your rule uses cost ≥ $50,000.", { userMessage: "create it when cost ≥ $50,000" });
  assert.deepEqual(r3.thresholds, []);
});

test("falls back to the current item when the reply names none, and skips the check when there is none", () => {
  assert.equal(check("The legacy calls ENEQ3 here.").ok, false);
  assert.equal(check("The legacy calls ENEQ3 here.", { currentId: null }).ok, true);
});

test("shared vocabulary (entry routine, field names, the file) is never flagged", () => {
  const r = check("For the incoming inspection work order: EQAD^ENEQ1 files the record in file 6914; TYPE OF ENTRY and INVESTMENT CATEGORY are fields on the form.");
  assert.equal(r.ok, true, JSON.stringify(r));
});

test("the correction prompt names the borrowed terms, where they came from, and quotes the item's evidence", () => {
  const r = check(BAD_WO);
  const p = correctionPrompt(r, buildIndex(graph));
  assert.match(p, /ENEQ3/);
  assert.match(p, /capitalized/);
  assert.match(p, /no coded item-condition/);
  assert.match(p, /Incoming inspection work order/);
});

const GOOD_WO = "For the incoming inspection work order, ENEQ1 ADDEQ asks the clerk only when the site parameter ASK INCOMING INSPECTION W.O. (file 6910.2) is enabled; on YES, IIWO^ENWONEW3 creates the 6920 work order.";
const fakeRun = replies => { const calls = []; const run = async (text, history) => { calls.push({ text, history }); return { reply: replies[calls.length - 1], toolTrace: [] }; }; return { run, calls }; };
const turn = run => groundedTurn({ run, message: "tell me about the work order", history: [], graph, record: { oqPolicy: {} }, currentId: "OQ.WorkOrderPolicy" });

test("a grounded reply passes through untouched, with one agent call", async () => {
  const f = fakeRun([GOOD_WO]);
  const out = await turn(f.run);
  assert.equal(out.reply, GOOD_WO);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(out.grounding, { ok: true, retried: false });
});

test("a borrowing reply is retried once with the item's evidence, and the developer sees the correction note", async () => {
  const f = fakeRun([BAD_WO, GOOD_WO]);
  const out = await turn(f.run);
  assert.equal(f.calls.length, 2);
  assert.match(f.calls[1].text, /^GROUNDING CHECK/);
  assert.deepEqual(f.calls[1].history.map(h => h.role), ["user", "assistant"]);
  assert.ok(out.reply.startsWith(GOOD_WO));
  assert.match(out.reply, /↻ Grounding check: a first draft borrowed ENEQ3/);
  assert.equal(out.grounding.ok, true);
  assert.equal(out.grounding.retried, true);
});

test("if the retry still borrows, the reply carries a visible warning", async () => {
  const f = fakeRun([BAD_WO, BAD_WO]);
  const out = await turn(f.run);
  assert.match(out.reply, /⚠ \*\*Grounding check:\*\* this reply still contains terms from other items' evidence/);
  assert.equal(out.grounding.ok, false);
});

test("the current item may be given as a side-effect id", () => {
  const r = checkReply({ graph, reply: "The legacy calls ENEQ3 here.", userMessage: "", record: { oqPolicy: {} }, currentId: "SIDE.WorkOrder" });
  assert.deepEqual(r.focus, ["OQ.WorkOrderPolicy"]);
  assert.equal(r.ok, false);
});

test("each turn returns the evidence for the item the reply is about, for the evidence card", async () => {
  const f = fakeRun([GOOD_WO]);
  const out = await turn(f.run);
  assert.deepEqual(out.evidence.map(e => e.id), ["OQ.WorkOrderPolicy"]);
  assert.ok(out.evidence[0].lines.some(l => /no coded item-condition/.test(l)));
});

// ── AI template grounding ─────────────────────────────────────────────────────

const inventory = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "capability-graph", "inventory-fields.json"), "utf8"));

test("buildIndex with inventory adds one group per AI template", () => {
  const ix = buildIndex(graph, inventory);
  const ids = ["AIQ.AgingOutFY", "AIQ.HighValueNoContract", "AIQ.JCAHOPendingInspection", "AIQ.CapitalPlanningTotals"];
  for (const id of ids) {
    const g = ix.groups.find(x => x.id === id);
    assert.ok(g, `group ${id} should exist`);
    assert.ok(g.aliasWords.length >= 1, `group ${id} should have alias words`);
    assert.ok(g.evidence.length >= 1, `group ${id} should have evidence lines`);
  }
  // existing capability-graph groups are still present
  assert.ok(ix.groups.some(g => g.id === "OQ.WorkOrderPolicy"), "orchestrator groups still present");
});

test("buildIndex without inventory does not add AI template groups", () => {
  const ix = buildIndex(graph);
  assert.ok(!ix.groups.some(g => g.id === "AIQ.HighValueNoContract"), "no AI groups without inventory");
});

test("checkReply flags $50,000 in a high-value reply when the user message never said it", () => {
  const ix = buildIndex(graph, inventory);
  const r = checkReply({
    graph, index: ix,
    reply: "For high-value assets without a service contract, $50,000 is a reasonable threshold.",
    userMessage: "",
    record: { oqPolicy: {} },
    currentId: "AIQ.HighValueNoContract",
  });
  assert.equal(r.ok, false);
  assert.deepEqual(r.thresholds, ["$50,000"]);
});

test("checkReply passes $50,000 in a high-value reply when the user said it", () => {
  const ix = buildIndex(graph, inventory);
  const r = checkReply({
    graph, index: ix,
    reply: "For high-value assets without a service contract, $50,000 is a reasonable threshold.",
    userMessage: "set the threshold to $50,000",
    record: { oqPolicy: {} },
    currentId: "AIQ.HighValueNoContract",
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.thresholds, []);
});

test("a recorded money param allows the same threshold in a subsequent reply", () => {
  const ix = buildIndex(graph, inventory);
  // Developer previously recorded threshold: 50000 — that value should unblock "$50,000"
  const r = checkReply({
    graph, index: ix,
    reply: "For high-value assets without a service contract, $50,000 is a reasonable threshold.",
    userMessage: "",
    record: { oqPolicy: {}, aiQuestions: { "AIQ.HighValueNoContract": { keep: true, params: { threshold: 50000 } } } },
    currentId: "AIQ.HighValueNoContract",
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.thresholds, []);
});

test("a reply that clearly names an AI question focuses its group via alias matching", () => {
  const ix = buildIndex(graph, inventory);

  // AIQ.AgingOutFY — "capitalized", "scheduled", "replacement", "fiscal" (4+ matches)
  const r1 = checkReply({ graph, index: ix,
    reply: "For capitalized items, look at those scheduled for replacement this fiscal year.",
    userMessage: "", record: { oqPolicy: {} }, currentId: null });
  assert.ok(r1.focus.includes("AIQ.AgingOutFY"), "AgingOutFY should be focused");

  // AIQ.HighValueNoContract — "high", "value", "service", "contract" (4 matches)
  const r2 = checkReply({ graph, index: ix,
    reply: "High-value assets that have no service contract need attention.",
    userMessage: "", record: { oqPolicy: {} }, currentId: null });
  assert.ok(r2.focus.includes("AIQ.HighValueNoContract"), "HighValueNoContract should be focused");

  // AIQ.JCAHOPendingInspection — "jcaho", "regulated", "items", "pending" (4+ matches)
  const r3 = checkReply({ graph, index: ix,
    reply: "JCAHO-regulated items with a pending inspection work order should be flagged.",
    userMessage: "", record: { oqPolicy: {} }, currentId: null });
  assert.ok(r3.focus.includes("AIQ.JCAHOPendingInspection"), "JCAHOPendingInspection should be focused");

  // AIQ.CapitalPlanningTotals — "capital", "planning", "totals", "counts", "asset", "values" (4+ matches)
  const r4 = checkReply({ graph, index: ix,
    reply: "Capital planning totals: the equipment counts and asset values.",
    userMessage: "", record: { oqPolicy: {} }, currentId: null });
  assert.ok(r4.focus.includes("AIQ.CapitalPlanningTotals"), "CapitalPlanningTotals should be focused");
});

test("capability-graph replies do not focus AI groups (false-positive prevention)", () => {
  const ix = buildIndex(graph, inventory);

  // The work-order reply matches 3 JCAHO alias words (inspection, work, order) — below need=4
  const woReply = "For the incoming inspection work order, ENEQ1 ADDEQ asks the clerk; IIWO^ENWONEW3 creates the 6920 work order.";
  const r1 = checkReply({ graph, index: ix, reply: woReply,
    userMessage: "", record: { oqPolicy: {} }, currentId: "OQ.WorkOrderPolicy" });
  assert.ok(!r1.focus.some(id => id.startsWith("AIQ.")), "no AI group should be focused by the work-order reply");
  assert.ok(r1.focus.includes("OQ.WorkOrderPolicy"), "orchestrator work-order group should still focus");

  // An unrelated orchestrator reply (mandatory bulletin) matches no AI alias words
  const r2 = checkReply({ graph, index: ix,
    reply: "The MailMan bulletin is mandatory: the legacy sends it unconditionally.",
    userMessage: "", record: { oqPolicy: {} }, currentId: "SIDE.Bulletin" });
  assert.ok(!r2.focus.some(id => id.startsWith("AIQ.")), "no AI group should be focused by a bulletin reply");
});
