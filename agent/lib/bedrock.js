"use strict";
// Minimal AWS Bedrock Converse client + tool-use loop, bearer-token auth.
// Reuses the working config from the Equipment agent:
//   region us-east-1, model us.anthropic.claude-haiku-4-5-20251001-v1:0, Authorization: Bearer <token>.

const { TOOL_SPECS, runTool } = require("./tools");

const REGION = process.env.AWS_DEFAULT_REGION || "us-east-1";
const MODEL = process.env.BEDROCK_MODEL_ID || "us.anthropic.claude-haiku-4-5-20251001-v1:0";

async function converse({ system, messages, tools }) {
  const token = process.env.AWS_BEARER_TOKEN_BEDROCK;
  if (!token) throw new Error("AWS_BEARER_TOKEN_BEDROCK not set");
  const url = `https://bedrock-runtime.${REGION}.amazonaws.com/model/${encodeURIComponent(MODEL)}/converse`;
  const body = {
    system: [{ text: system }],
    messages,
    inferenceConfig: { maxTokens: 1200, temperature: 0.2 },
  };
  if (tools) body.toolConfig = { tools };
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Bedrock ${res.status}: ${(await res.text()).slice(0, 500)}`);
  return res.json();
}

// Run one agent turn: userText + prior text history, looping over tool calls.
// ctx = { graph, decisions, system }. Mutates ctx.decisions via tools.
async function runAgent(userText, history, ctx) {
  const messages = [];
  for (const h of history || []) {
    if (!h.text) continue;
    messages.push({ role: h.role === "assistant" ? "assistant" : "user", content: [{ text: h.text }] });
  }
  messages.push({ role: "user", content: [{ text: userText }] });

  const toolTrace = [];
  for (let i = 0; i < 6; i++) {
    const resp = await converse({ system: ctx.system, messages, tools: TOOL_SPECS });
    const out = resp.output.message;
    messages.push(out);
    if (resp.stopReason === "tool_use") {
      const results = [];
      for (const c of out.content || []) {
        if (c.toolUse) {
          const result = runTool(c.toolUse.name, c.toolUse.input || {}, ctx);
          toolTrace.push({ name: c.toolUse.name, input: c.toolUse.input, result });
          results.push({ toolResult: { toolUseId: c.toolUse.toolUseId, content: [{ text: JSON.stringify(result) }] } });
        }
      }
      messages.push({ role: "user", content: results });
      continue;
    }
    const text = (out.content || []).filter(c => c.text).map(c => c.text).join("\n").trim();
    return { reply: text || "(no text)", toolTrace };
  }
  return { reply: "(stopped: too many tool iterations)", toolTrace };
}

module.exports = { converse, runAgent, REGION, MODEL };
