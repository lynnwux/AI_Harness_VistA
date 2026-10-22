"use strict";
// VADEMO Atelier v1 client: upload/compile/delete classes, run SQL, call the REST service.
// All remote calls accept a fetchImpl injection so tests never hit the network.
const { redact } = require("./iris-deploy");

function vademoFromEnv(env, { fetchImpl = fetch, timeoutMs = 30000 } = {}) {
  const url = (env.VADEMO_URL || "").replace(/\/+$/, "");
  const user = env.VADEMO_USER || "";
  const pass = env.VADEMO_PASSWORD || "";
  if (!url || !user || !pass)
    throw new Error("VADEMO connection not configured — set VADEMO_URL, VADEMO_USER and VADEMO_PASSWORD (see agent/.env.example)");
  const auth = "Basic " + Buffer.from(user + ":" + pass).toString("base64");
  const atelier = `${url}/api/atelier/v1/VISTA-DIEGO`;
  const secrets = [pass];

  // Generic Atelier call; always attaches auth + AbortSignal; redacts the password on network errors.
  async function callAtelier(method, pathStr, body) {
    const opts = { method, headers: { Authorization: auth }, signal: AbortSignal.timeout(timeoutMs) };
    if (body !== undefined) { opts.headers["Content-Type"] = "application/json"; opts.body = JSON.stringify(body); }
    try { return await fetchImpl(atelier + pathStr, opts); }
    catch (e) { throw new Error(redact(String(e.message || e), secrets)); }
  }

  // Upload a class document; strip \r so Windows line endings don't create empty tokens in IRIS.
  async function putClass(name, text) {
    await callAtelier("PUT", `/doc/${name}?ignoreConflict=1`, { enc: false, content: text.replace(/\r/g, "").split("\n") });
  }

  // Compile one or more classes in one round-trip; throws listing all status.errors and console ERRORs.
  async function compile(names) {
    const res = await callAtelier("POST", "/action/compile", names);
    const j = await res.json().catch(() => ({}));
    const errs = (j?.status?.errors || []).map(e => e.error || String(e));
    const consoleFails = (j?.console || []).filter(l => /ERROR/.test(l));
    if (errs.length || consoleFails.length)
      throw new Error(redact("compile errors: " + [...errs, ...consoleFails].join("; "), secrets));
  }

  // Delete a class document; HTTP 404 means it was already absent.
  async function deleteClass(name) {
    const res = await callAtelier("DELETE", `/doc/${name}`);
    return res.status === 404 ? "absent" : "deleted";
  }

  // Run a SQL query via Atelier; throws on status.errors (password redacted).
  async function query(sql, parameters = []) {
    const res = await callAtelier("POST", "/action/query", { query: sql, parameters });
    const j = await res.json().catch(() => ({}));
    if ((j?.status?.errors || []).length)
      throw new Error(redact("query error: " + j.status.errors.map(e => e.error || String(e)).join("; "), secrets));
    return j?.result?.content || [];
  }

  // Direct call to the deployed REST data service (for smoke-testing after deploy).
  async function rest(method, p, body) {
    const opts = { method, headers: { Authorization: auth }, signal: AbortSignal.timeout(timeoutMs) };
    if (body !== undefined) { opts.headers["Content-Type"] = "application/json"; opts.body = JSON.stringify(body); }
    let res;
    try { res = await fetchImpl(`${url}/irishealth/Harness/Equipment${p}`, opts); }
    catch (e) { throw new Error(redact(String(e.message || e), secrets)); }
    const json = await res.json().catch(() => null);
    return { status: res.status, json };
  }

  return { putClass, compile, deleteClass, query, rest };
}

module.exports = { vademoFromEnv };
