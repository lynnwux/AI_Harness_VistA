"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { graph, rec, IM } = require("./helpers");
const { buildApiSpec, renderApi } = require("../lib/specs/api");
const { PHASE1_SERVICES, emptyImplemented, builtApi } = require("../lib/implemented");

test("the API spec's detail is the Angular build config from the graph and data-field decisions", () => {
  const spec = buildApiSpec(graph, rec(), IM);
  assert.equal(spec.layer, "api");
  assert.equal(spec.detail.command, "RegisterEquipment");
  assert.deepEqual(spec.detail.pages.map(p => p.title), ["Equipment Identity & Acquisition", "Ownership & Location", "Financial"]);
  assert.equal(spec.detail.pages.flatMap(p => p.fields).length, 35);
});

test("omitting a field removes it from the pages and the request contract", () => {
  const spec = buildApiSpec(graph, rec({ dec: { "FLD.serial": "Omit" } }), IM);
  assert.ok(!spec.detail.pages.flatMap(p => p.fields).some(f => f.k === "serial"));
  assert.ok(!spec.request.some(f => f.id === "FLD.serial"));
});

test("discovery proposes a service for every legacy write that is not built", () => {
  assert.deepEqual(buildApiSpec(graph, rec(), IM).owns.proposed.map(p => p.id), ["write:6920", "write:6914.04", "write:6915.2"]);
  const im2 = { ...IM, api: builtApi([...PHASE1_SERVICES, { id: "write:6920", endpoint: "POST /work-orders", what: "x" }]) };
  assert.deepEqual(buildApiSpec(graph, rec(), im2).owns.proposed.map(p => p.id), ["write:6914.04", "write:6915.2"]);
});

test("the API markdown carries every Phase 1 line of the retired spec.md", () => {
  const md = renderApi(graph, rec(), buildApiSpec(graph, rec(), IM)).split("\n");
  const expected = fs.readFileSync(path.join(__dirname, "fixtures", "spec-phase1.md"), "utf8")
    .split("\n").filter(l => l.trim() && !/UPPERCASE/.test(l));
  assert.deepEqual(expected.filter(l => !md.includes(l)), []);
});

test("the API markdown states the canonical serial as ASKSER builds it and carries no Phase 2/3 content", () => {
  const md = renderApi(graph, rec(), buildApiSpec(graph, rec(), IM));
  assert.match(md, /one trailing space appended, cut to 30 characters/);
  assert.doesNotMatch(md, /UPPERCASE|Phase 2|Phase 3|Blocked side-effect prompts/);
  assert.match(md, /^## Owns — proposed services \(from legacy discovery, not built\)$/m);
});

test("the API spec lists the Phase 1 endpoints as proposed until built", () => {
  const emptySpec = buildApiSpec(graph, rec(), emptyImplemented());
  assert.deepEqual(emptySpec.owns.built, []);
  const emptyProposedIds = emptySpec.owns.proposed.map(p => p.id);
  assert.ok(PHASE1_SERVICES.every(s => emptyProposedIds.includes(s.id)), "all Phase 1 ids in proposed when nothing built");

  const builtSpec = buildApiSpec(graph, rec(), IM);
  const builtIds = builtSpec.owns.built.map(s => s.id);
  const proposedIds = builtSpec.owns.proposed.map(p => p.id);
  assert.ok(PHASE1_SERVICES.every(s => builtIds.includes(s.id)), "Phase 1 ids in built when built");
  assert.ok(!PHASE1_SERVICES.some(s => proposedIds.includes(s.id)), "Phase 1 ids not in proposed when built");

  // "- none" appears under the built header when nothing is built
  const md = renderApi(graph, rec(), emptySpec).split("\n");
  const builtIdx = md.findIndex(l => l === "## Owns — built services");
  assert.ok(builtIdx >= 0, "built-services header found");
  assert.equal(md[builtIdx + 1], "- none");
});
