"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { PHASE1_SERVICES, emptyImplemented, apiRecord, apiServices, builtApi } = require("../lib/implemented");

test("old array shape reads as not built", () => {
  const old = { api: PHASE1_SERVICES };
  assert.deepEqual(apiRecord(old), emptyImplemented().api);
  assert.deepEqual(apiServices(old), []);
});

test("apiServices returns the services only when built", () => {
  assert.deepEqual(apiServices({ api: builtApi() }).map(s => s.id), ["write:6914", "read:next-ien", "read:lookup"]);
  assert.deepEqual(apiServices({ api: { ...builtApi(), built: false } }), []);
});
