"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { runAgent, converse } = require("../lib/bedrock");

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

test("converse gives up after its timeout", async () => {
  const prev = process.env.AWS_BEARER_TOKEN_BEDROCK;
  process.env.AWS_BEARER_TOKEN_BEDROCK = "fake-token-for-test";
  // AbortSignal.timeout() uses an unref'd timer; keep the event loop alive so the signal fires.
  const keepAlive = setTimeout(() => {}, 500);
  try {
    const fetchImpl = (_url, opts) => new Promise((_resolve, reject) => {
      if (opts.signal.aborted) { reject(opts.signal.reason); return; }
      opts.signal.addEventListener("abort", () => reject(opts.signal.reason));
    });
    await assert.rejects(
      converse({ system: "s", messages: [] }, { fetchImpl, timeoutMs: 20 }),
      /timed out|aborted/i
    );
  } finally {
    clearTimeout(keepAlive);
    if (prev === undefined) delete process.env.AWS_BEARER_TOKEN_BEDROCK;
    else process.env.AWS_BEARER_TOKEN_BEDROCK = prev;
  }
});
