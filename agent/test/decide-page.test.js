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
const { emptyImplemented, builtApi } = require("../lib/implemented");

const HTML = fs.readFileSync(path.join(__dirname, "..", "..", "capability-graph", "decide.html"), "utf8");
const SCRIPT = HTML.split("<script>")[1].split("</script>")[0];
const inventory = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "capability-graph", "inventory-fields.json"), "utf8"));

function page(extra) {
  const el = () => ({ style: {}, dataset: {}, classList: { toggle() {}, add() {}, remove() {} }, addEventListener() {}, appendChild() {}, remove() {}, insertAdjacentHTML() {} });
  const ctx = vm.createContext({
    document: { getElementById: el, querySelectorAll: () => [], createElement: el },
    location: { protocol: "http:" }, window: { open() {} }, localStorage: { getItem: () => null, setItem() {} },
    fetch: () => new Promise(() => {}),   // the boot waits forever: nothing is loaded
    setTimeout, setInterval, clearInterval, console, URL, Blob: function () {},
  });
  vm.runInContext(SCRIPT + "\n;globalThis.__page = { openingMessages, defaultTab, serverLooksOld, OLD_SERVER_NOTICE, RESET_PROMPT, resetSummary, nextResetStep" + (extra ? ", " + extra : "") + " };", ctx);
  return ctx.__page;
}

const pageWith = name => page(name);

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
  assert.match(text, /Phase 1[^\n]*Phase 2[^\n]*built and verified/);
  assert.match(text, /Phase 3/);
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
  assert.match(text, /Phase 2/);
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

test("the status line shows the orchestrator as built once the production is verified, and ready to build only before that", () => {
  const p = pageWith("agendaHtml");
  const built = p.agendaHtml(apiSpecs(rec(DONE), VERIFIED), false);
  assert.match(built, /Orchestrator <span class="rdy">built ✓<\/span>/);
  assert.doesNotMatch(built, /Orchestrator <span class="rdy">✓ ready to build/);
  const ready = p.agendaHtml(apiSpecs(rec(DONE), IM), false);
  assert.match(ready, /Orchestrator <span class="rdy">✓ ready to build<\/span>/);
});

test("after a chat turn the cards come first and the reply — with the next question — comes last", () => {
  const send = SCRIPT.slice(SCRIPT.indexOf("async function sendChat"), SCRIPT.indexOf("async function sendChat") + 1500);
  const reply = send.indexOf('addMsg("assistant",res.reply)');
  assert.ok(reply > 0, "the reply is added");
  assert.ok(send.indexOf("addEvidenceCard(res.evidence)") < reply, "evidence card before the reply");
  assert.ok(send.indexOf("addRecordedCards(res.recorded)") < reply, "recorded card before the reply");
});

test("the restore summary names each deliverable and its outcome, escaped", () => {
  const p = pageWith("restoreSummary");
  const html = p.restoreSummary({ state: "error", results: [
    { layer: "api", outcome: "restored", savedAt: "2026-10-21T10:00:00.000Z" },
    { layer: "orchestrator", outcome: "failed: compile errors: <b>x</b>" },
    { layer: "ai", outcome: "no good copy yet" },
  ] });
  assert.match(html, /Angular entry form[\s\S]*restored/);
  assert.match(html, /IRIS production[\s\S]*failed: compile errors: &lt;b&gt;x&lt;\/b&gt;/);
  assert.match(html, /AI chat interface[\s\S]*no good copy yet/);
  assert.match(html, /2026-10-21/);
  assert.match(SCRIPT, /res\.restore/, "the chat send handler follows a restore");
  assert.match(SCRIPT, /\/api\/restore\/status/);
});

test("the demo reset is a small icon in the top bar, needs the word 'reset' typed, then calls the route", () => {
  assert.match(HTML, /Layer Map<\/button>\s*<button[^>]*id="resetBtn"[^>]*>↺<\/button>/, "an icon-only button next to Layer Map");
  assert.match(HTML, /id="resetBtn"[^>]*title="[^"]*[Dd]emo reset/, "the tooltip says what it is");
  assert.doesNotMatch(HTML, /\.demo-reset\{[^}]*position:fixed/, "no longer floating over the chat");
  const p = pageWith("confirmReset");
  assert.equal(p.confirmReset(() => "reset"), true);
  assert.equal(p.confirmReset(() => "  RESET "), true);
  assert.equal(p.confirmReset(() => "yes"), false);
  assert.equal(p.confirmReset(() => ""), false);
  assert.equal(p.confirmReset(() => null), false, "Cancel");
  const h = SCRIPT.slice(SCRIPT.indexOf('getElementById("resetBtn").onclick')).slice(0, 900);
  assert.match(h, /confirmReset\(/);
  assert.match(h, /\/api\/demo\/reset/);
  assert.doesNotMatch(SCRIPT, /location\.reload\(/, "the page is redrawn in place, never reloaded");
});

test("the status line shows the AI layer as built only when the stage says so, not from a leftover build status", () => {
  const p = pageWith("agendaHtml");
  const reset = apiSpecs(rec(), IM);   // what a demo reset leaves
  assert.doesNotMatch(p.agendaHtml(reset, true), /AI <span class="rdy">built ✓/, "a stale 'done' AI status must not show built");
  const done = apiSpecs(rec({ ...DONE, aiQuestions: ALL_KEPT }), { ...VERIFIED, ai: { built: true, verified: true } });
  assert.match(p.agendaHtml(done, true), /AI <span class="rdy">built ✓/);
});

test("in the api stage the opening says Phase 1 is not built, offers the build, and opens the API tab", () => {
  const p = page();
  const s = apiSpecs(rec(), emptyImplemented());
  assert.equal(s.stage.layer, "api", "stage is api");
  const text = p.openingMessages(s).join("\n\n");
  assert.match(text, /Phase 1, the API layer: designed, not built/);
  assert.match(text, /🔨 Build on the API tab/);
  assert.doesNotMatch(text, /built and verified/);
  assert.equal(p.defaultTab(s), "api");
});

test("the orchestrator opening is only shown once Phase 1 is built", () => {
  const p = page();
  const s = apiSpecs(rec(), IM);
  const text = p.openingMessages(s).join("\n\n");
  assert.match(text, /Phase 1 is built and verified/);
});

test("an out-of-date API layer is announced first", () => {
  const p = page();
  const ood = { ...IM, api: builtApi(undefined, { builtFrom: "x" }) };
  const s = apiSpecs(rec(), ood);
  assert.ok(s.stage.apiOutOfDate, "stage has apiOutOfDate");
  const text = p.openingMessages(s).join("\n\n");
  assert.match(text, /changed since it was built/);
  // out-of-date message is first (before the orchestrator text)
  assert.ok(text.indexOf("changed since it was built") < text.indexOf("Orchestrator"), "ood warning precedes orchestrator text");
});

test("the agenda says API not built and later phases wait", () => {
  const p = pageWith("agendaHtml");
  const s = apiSpecs(rec(), emptyImplemented());
  const html = p.agendaHtml(s, false);
  assert.match(html, /API <b>not built<\/b>/);
  assert.match(html, /waiting for Phase 1/);
});

test("the reset prompt says every phase is torn down and what is kept", () => {
  const p = page();
  assert.match(p.RESET_PROMPT, /tears down every phase/);
  assert.match(p.RESET_PROMPT, /known-good/);
  assert.match(p.RESET_PROMPT, /6914/);
  // confirmReset still requires the word reset
  const p2 = pageWith("confirmReset");
  assert.equal(p2.confirmReset(() => "reset"), true);
  assert.equal(p2.confirmReset(() => "yes"), false);
});

test("resetSummary lists every result and the verdict", () => {
  const p = page();
  const s = {
    state: "error", error: "VADEMO unreachable",
    results: [
      { where: "VADEMO", item: "Harness.Equipment.REST.cls", outcome: "removed" },
      { where: "IRIS", item: "package EquipmentEntry", outcome: "failed: timeout" },
    ],
  };
  const html = p.resetSummary(s);
  assert.match(html, /✅.*VADEMO.*removed/s);
  assert.match(html, /✗.*IRIS.*failed: timeout/s);
  assert.match(html, /Reset finished with failures/);
});

test("nextResetStep: done/error/idle terminate; tearing-down retries; consecutive failures gate at 5", () => {
  const p = page();
  assert.equal(p.nextResetStep({ state: "done" }, 0), "done");
  assert.equal(p.nextResetStep({ state: "error" }, 0), "done");
  assert.equal(p.nextResetStep({ state: "idle" }, 0), "done", "idle is terminal");
  assert.equal(p.nextResetStep({ state: "tearing down" }, 0), "retry");
  assert.equal(p.nextResetStep({ state: "starting" }, 0), "retry");
  assert.equal(p.nextResetStep(null, 4), "retry", "4 failures → retry");
  assert.equal(p.nextResetStep(null, 5), "fail", "5th failure → fail");
});

test("the orchestrator opening names the test record by its IEN", () => {
  const p = page();
  const s = apiSpecs(rec(), IM);
  s.layers.api.verifiedRecord = { ien: 4711, serial: "SN-1", at: "2026-10-22T10:00:00Z" };
  const text = p.openingMessages(s).join("\n\n");
  assert.match(text, /\(test record IEN 4711\)/);
  assert.doesNotMatch(text, /\[object Object\]/);
});

// The page with a DOM that keeps children and a fetch that answers per route, so the boot and the handlers run.
const GRAPH_FILE = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "capability-graph", "new-inventory-entry.json"), "utf8"));
function livePage(routes) {
  const els = {}, reloads = [];
  const mk = id => ({ id, style: {}, dataset: {}, children: [], _html: "", textContent: "", classList: { toggle() {}, add() {}, remove() {} }, addEventListener() {}, insertAdjacentHTML() {},
    appendChild(c) { this.children.push(c); c.parent = this; return c; }, remove() { if (this.parent) this.parent.children = this.parent.children.filter(x => x !== this); },
    get innerHTML() { return this._html; }, set innerHTML(v) { this._html = v; this.children = []; } });
  const byId = id => els[id] || (els[id] = mk(id));
  const fetch = async (url, opts = {}) => {
    const key = `${opts.method || "GET"} ${String(url).split("?")[0]}`, h = routes[key];
    if (!h) throw new Error("no route " + key);
    const body = typeof h === "function" ? h() : h;
    return { ok: true, json: async () => body, text: async () => JSON.stringify(body) };
  };
  const ctx = vm.createContext({
    document: { getElementById: byId, querySelectorAll: () => [], createElement: () => mk(null) },
    location: { protocol: "http:", reload: () => reloads.push(1) }, window: { open() {} }, localStorage: { getItem: () => null, setItem() {} },
    prompt: () => "reset", fetch, setTimeout, setInterval, clearInterval, console, URL, Blob: function () {},
  });
  vm.runInContext(SCRIPT + "\n;globalThis.__page = { openPage, tab: () => TAB, history: () => chatHistory };", ctx);
  const chat = () => byId("chatMsgs").children.map(c => c._html || c.textContent);
  return { p: ctx.__page, byId, reloads, chat };
}
const settle = () => new Promise(r => setTimeout(r, 30));
const PAGE_ROUTES = specs => ({ "GET new-inventory-entry.json": GRAPH_FILE, "GET /api/specs": specs,
  "GET /api/build/production/status": { state: "idle" }, "GET /api/build/ai/status": { state: "idle" } });

test("openPage redraws the page in place: Phase 1 tab, a fresh chat with the overview and the opening", async () => {
  const specs = apiSpecs(rec(), emptyImplemented());
  const w = livePage(PAGE_ROUTES(specs));
  await settle();
  w.byId("chatMsgs").appendChild({ _html: "a stale message" });
  w.p.openPage();
  await settle();
  const msgs = w.chat();
  assert.ok(!msgs.some(m => m.includes("a stale message")), "the old chat is cleared");
  assert.match(msgs[0], /What we're building/);
  assert.ok(msgs.some(m => /Phase 1, the API layer: designed, not built/.test(m)), "the Phase 1 opening");
  assert.equal(w.p.tab(), "api");
  assert.equal(w.p.history().length, 1, "the chat history starts again from the intro");
});

test("a reset whose spec generation failed after the teardown started shows the error and follows the teardown to its verdict", async () => {
  const specs = apiSpecs(rec(), emptyImplemented());
  const w = livePage({ ...PAGE_ROUTES(specs),
    "POST /api/demo/reset": { ok: false, error: "spec generation failed: boom", local: [], teardown: { started: true, statusUrl: "/api/demo/reset/status" } },
    "GET /api/demo/reset/status": { state: "error", error: "1 item failed", results: [{ where: "VADEMO", item: "class Harness.Equipment.REST.cls", outcome: "failed: HTTP 403" }] } });
  await settle();
  w.byId("chatMsgs").appendChild({ _html: "before the reset" });
  await w.byId("resetBtn").onclick();
  await settle();
  const msgs = w.chat(), last = msgs[msgs.length - 1];
  assert.deepEqual(w.reloads, [], "never reloads");
  assert.ok(!msgs.some(m => m.includes("before the reset")), "the page was redrawn");
  assert.ok(msgs.some(m => /Phase 1, the API layer: designed, not built/.test(m)), "opens in Phase 1");
  assert.doesNotMatch(msgs.join("\n"), /refused/);
  assert.match(last, /spec generation failed: boom/, "the error is shown");
  assert.match(last, /class Harness\.Equipment\.REST\.cls — failed: HTTP 403/, "the verdict names the failed item");
  assert.match(last, /Reset finished with failures/);
  assert.equal(w.byId("resetBtn").disabled, false);
});

test("a reset refused before any teardown says so and leaves the page", async () => {
  const w = livePage({ ...PAGE_ROUTES(apiSpecs(rec(), IM)), "POST /api/demo/reset": { ok: false, error: "busy" } });
  await settle();
  await w.byId("resetBtn").onclick();
  const msgs = w.chat();
  assert.match(msgs[msgs.length - 1], /Demo reset refused: busy/);
  assert.equal(w.p.tab(), "orchestrator");
});

test("every ending of an API build refreshes the specs", () => {
  const h = SCRIPT.slice(SCRIPT.indexOf('getElementById("buildBtn").onclick'));
  assert.match(h.slice(0, h.indexOf("\n", h.indexOf("const reset="))), /const reset=\(\)=>\{[^\n]*loadSpecs\(\)/);
});

test("a build that moves the stage to another layer moves the page on: a new layer, or the AI layer finishing", () => {
  const p = page("stageMoved, historyNote");
  assert.equal(p.stageMoved({ layer: "orchestrator", step: "ready" }, { layer: "ai", step: "keep" }), true);
  assert.equal(p.stageMoved({ layer: "api", step: "build" }, { layer: "orchestrator", step: "decide" }), true);
  assert.equal(p.stageMoved({ layer: "ai", step: "ready" }, { layer: "ai", step: "done" }), true);
  assert.equal(p.stageMoved({ layer: "orchestrator", step: "ready" }, { layer: "orchestrator", step: "ready" }), false);
  assert.equal(p.stageMoved(null, { layer: "ai", step: "keep" }), true);
});

test("the chat history note names the stage the page is on, so the guide never works from a stale intro", () => {
  const p = page("historyNote");
  const ai = apiSpecs(rec(DONE), VERIFIED);
  assert.match(p.historyNote(ai, "stage changed"), /^\[stage changed: Phase 1 \(API\) and Phase 2 \(production\) built\+verified; working on Phase 3, the AI layer; stage=ai\//);
  assert.match(p.historyNote(apiSpecs(rec(), emptyImplemented()), "intro"), /^\[intro: Phase 1 \(API\) not built; working on Phase 1; stage=api\/build/);
});

test("after a successful build the page moves on: the stage's tab, its opening, and a history note — the chat is kept", async () => {
  const added = [];
  const el = () => ({ style: {}, dataset: {}, classList: { toggle() {}, add() {}, remove() {} }, addEventListener() {}, appendChild() {}, remove() {}, insertAdjacentHTML() {}, set innerHTML(v) { this._h = v; }, get innerHTML() { return this._h || ""; } });
  const ai = apiSpecs(rec(DONE), VERIFIED);
  const ctx = vm.createContext({
    document: { getElementById: el, querySelectorAll: () => [], createElement: el },
    location: { protocol: "http:" }, window: { open() {} }, localStorage: { getItem: () => null, setItem() {} },
    fetch: url => (/\/api\//.test(String(url)) ? Promise.resolve({ json: async () => (String(url).includes("/api/specs") ? ai : { state: "idle" }), text: async () => "{}" }) : new Promise(() => {})),   // the boot's graph fetch never answers
    setTimeout, setInterval, clearInterval, console, URL, Blob: function () {},
  });
  vm.runInContext(SCRIPT + "\n;addMsg=(role,text)=>__added.push(text);globalThis.__page = { moveOn, tab: () => TAB, history: () => chatHistory, setHistory: h => { chatHistory = h; } };", Object.assign(ctx, { __added: added }));
  const p = ctx.__page;
  p.setHistory([{ role: "user", text: "earlier turn" }]);
  added.length = 0;
  const moved = await p.moveOn({ layer: "orchestrator", step: "ready" });
  assert.equal(moved, true);
  assert.equal(p.tab(), "ai");
  assert.ok(added.some(m => /Phase 2 \(the IRIS production\) are built and verified/.test(m)), added.join("\n---\n"));
  const h = p.history();
  assert.equal(h[0].text, "earlier turn", "the conversation is kept");
  assert.match(h[h.length - 1].text, /^\[stage changed: .*working on Phase 3, the AI layer/);
  added.length = 0;
  assert.equal(await p.moveOn({ layer: "ai", step: "keep" }), false, "no move when the stage stayed");
  assert.equal(added.length, 0);
});
