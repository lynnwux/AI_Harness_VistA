"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { runAgent } = require("../lib/bedrock");

const toolUse = n => ({ stopReason: "tool_use", output: { message: { role: "assistant", content: [{ toolUse: { toolUseId: "t" + n, name: "getState", input: {} } }] } } });
const ctx = { system: "s", graph: require("./helpers").graph, decisions: require("./helpers").rec() };

test("a turn that records many answers has room to finish: the loop allows at least 12 tool rounds", async () => {
  let n = 0;
  const fake = async () => (++n <= 11 ? toolUse(n) : { stopReason: "end_turn", output: { message: { role: "assistant", content: [{ text: "done" }] } } });
  const out = await runAgent("go", [], ctx, { converseImpl: fake });
  assert.equal(out.reply, "done");
});

test("when the tool rounds run out, the reply says what was recorded instead of a bare stop message", async () => {
  const fake = async () => toolUse(1);
  const out = await runAgent("go", [], ctx, { converseImpl: fake });
  assert.doesNotMatch(out.reply, /^\(stopped/);
  assert.match(out.reply, /ran out of steps/i);
  assert.match(out.reply, /continue/i);
  assert.ok(out.toolTrace.length >= 12);
});
