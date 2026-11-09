"use strict";
// Read-only VADEMO helper for the runtime-trace experiment. Logins come from agent/.env.
//   node --env-file=agent/.env experiments/runtime-trace/va.js info
//   node --env-file=agent/.env experiments/runtime-trace/va.js doc <NAME.cls|NAME.int>
//   node --env-file=agent/.env experiments/runtime-trace/va.js sql "<SELECT ...>" [param ...]
const { atelierBase } = require("../../agent/lib/vademo");
const url = (process.env.VADEMO_URL || "").replace(/\/+$/, "");
const auth = "Basic " + Buffer.from(process.env.VADEMO_USER + ":" + process.env.VADEMO_PASSWORD).toString("base64");
const base = url + atelierBase().replace(/VISTA-DIEGO$/, encodeURIComponent(process.env.VA_NS || "VISTA-DIEGO"));
const root = base.replace(/\/v1\/VISTA-DIEGO$/, "");
async function call(method, full, body) {
  const opts = { method, headers: { Authorization: auth }, signal: AbortSignal.timeout(60000) };
  if (body !== undefined) { opts.headers["Content-Type"] = "application/json"; opts.body = JSON.stringify(body); }
  const r = await fetch(full, opts);
  const j = await r.json().catch(() => null);
  return { http: r.status, j };
}
(async () => {
  const [cmd, a, ...rest] = process.argv.slice(2);
  let out;
  if (cmd === "info") out = (await call("GET", root + "/")).j?.result?.content;
  else if (cmd === "doc") { const { http, j } = await call("GET", base + "/doc/" + encodeURIComponent(a)); out = http === 200 ? j.result.content.join("\n") : { http, errors: j?.status?.errors }; }
  else if (cmd === "sql") { const { j } = await call("POST", base + "/action/query", { query: a, parameters: rest }); out = j?.status?.errors?.length ? { errors: j.status.errors } : j?.result?.content; }
  console.log(typeof out === "string" ? out : JSON.stringify(out, null, 1));
})().catch(e => { console.error(String(e.message || e).replace(process.env.VADEMO_PASSWORD || "\u0000", "***")); process.exit(1); });
