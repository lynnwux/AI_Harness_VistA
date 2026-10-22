"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { vademoFromEnv } = require("../lib/vademo");

const ENV = { VADEMO_URL: "http://vademo:80", VADEMO_USER: "admin", VADEMO_PASSWORD: "fake-pass-secret-789" };
const BASE = `${ENV.VADEMO_URL}/api/atelier/v1/VISTA-DIEGO`;

// Fake fetch that records every call and answers per route prefix match.
function fakeFetch(routes) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ method: opts.method || "GET", url, opts, body: opts.body ? JSON.parse(opts.body) : undefined });
    const key = `${opts.method || "GET"} ${url}`;
    for (const [k, h] of Object.entries(routes))
      if (key.startsWith(k)) return typeof h === "function" ? h(url, opts) : h;
    throw new Error(`no fake route: ${key}`);
  };
  fn.calls = calls;
  return fn;
}
const okReply = (body, status = 200) => ({ status, json: async () => body, ok: status < 300 });

test("vademoFromEnv throws when connection not configured", () => {
  assert.throws(() => vademoFromEnv({}), /VADEMO connection not configured/);
  assert.throws(() => vademoFromEnv({ VADEMO_URL: "http://x" }), /VADEMO connection not configured/);
  assert.throws(() => vademoFromEnv({ VADEMO_URL: "http://x", VADEMO_USER: "u" }), /VADEMO connection not configured/);
});

test("putClass sends PUT to Atelier v1/VISTA-DIEGO with Authorization, AbortSignal, and line-split body", async () => {
  const fetch = fakeFetch({ [`PUT ${BASE}/doc/Harness.Setup.cls`]: okReply({}) });
  await vademoFromEnv(ENV, { fetchImpl: fetch }).putClass("Harness.Setup.cls", "line1\r\nline2\n");
  const { method, url, opts, body } = fetch.calls[0];
  assert.equal(method, "PUT");
  assert.equal(url, `${BASE}/doc/Harness.Setup.cls?ignoreConflict=1`);
  assert.ok(opts.headers.Authorization.startsWith("Basic "), "has Authorization");
  assert.ok(opts.signal, "has AbortSignal");
  assert.deepEqual(body, { enc: false, content: ["line1", "line2", ""] });
});

test("compile sends POST and throws when status.errors present", async () => {
  const fetch = fakeFetch({
    [`POST ${BASE}/action/compile`]: okReply({ status: { errors: [{ error: "syntax error at line 3" }] }, console: [] }),
  });
  const c = vademoFromEnv(ENV, { fetchImpl: fetch });
  await assert.rejects(() => c.compile(["Harness.Setup.cls"]), /compile errors:.*syntax error at line 3/);
  const { method, url, opts } = fetch.calls[0];
  assert.equal(method, "POST");
  assert.equal(url, `${BASE}/action/compile`);
  assert.ok(opts.headers.Authorization.startsWith("Basic "), "has Authorization");
  assert.ok(opts.signal, "has AbortSignal");
});

test("compile throws when console has ERROR lines", async () => {
  const fetch = fakeFetch({
    [`POST ${BASE}/action/compile`]: okReply({ status: { errors: [] }, console: ["INFO: start", "ERROR: bad class"] }),
  });
  await assert.rejects(
    () => vademoFromEnv(ENV, { fetchImpl: fetch }).compile(["X.cls"]),
    /compile errors:.*ERROR: bad class/,
  );
});

test("deleteClass on 404 returns absent", async () => {
  const fetch = fakeFetch({ [`DELETE ${BASE}/doc/Missing.cls`]: okReply({}, 404) });
  const { method, url, opts } = fetch.calls[0] || {};
  const r = await vademoFromEnv(ENV, { fetchImpl: fetch }).deleteClass("Missing.cls");
  assert.equal(r, "absent");
  assert.equal(fetch.calls[0].method, "DELETE");
  assert.equal(fetch.calls[0].url, `${BASE}/doc/Missing.cls`);
  assert.ok(fetch.calls[0].opts.signal, "has AbortSignal");
});

test("deleteClass on 200 returns deleted", async () => {
  const fetch = fakeFetch({ [`DELETE ${BASE}/doc/Harness.Setup.cls`]: okReply({}, 200) });
  assert.equal(await vademoFromEnv(ENV, { fetchImpl: fetch }).deleteClass("Harness.Setup.cls"), "deleted");
});

test("query returns rows from result.content", async () => {
  const fetch = fakeFetch({
    [`POST ${BASE}/action/query`]: okReply({ status: { errors: [] }, result: { content: [{ r: "created: /Harness/Equipment" }] } }),
  });
  const rows = await vademoFromEnv(ENV, { fetchImpl: fetch }).query("SELECT Harness.Setup_CreateWebApp() AS r");
  assert.deepEqual(rows, [{ r: "created: /Harness/Equipment" }]);
  assert.ok(fetch.calls[0].opts.headers.Authorization.startsWith("Basic "), "has Authorization");
  assert.ok(fetch.calls[0].opts.signal, "has AbortSignal");
});

test("errors never carry the password", async () => {
  // fake answers with the password in the error body — thrown message must redact it
  const pass = ENV.VADEMO_PASSWORD;
  const fetch = fakeFetch({
    [`POST ${BASE}/action/query`]: okReply({ status: { errors: [{ error: `auth failed: ${pass}` }] } }),
  });
  let msg = "";
  try { await vademoFromEnv(ENV, { fetchImpl: fetch }).query("SELECT 1"); } catch (e) { msg = e.message; }
  assert.ok(msg.length > 0, "error was thrown");
  assert.ok(!msg.includes(pass), `password leaked in: ${msg}`);
  assert.match(msg, /\*\*\*/);
});

test("putClass throws when VADEMO rejects the upload", async () => {
  const fetch = fakeFetch({ [`PUT ${BASE}/doc/Harness.Setup.cls`]: okReply({ status: { errors: [] } }, 500) });
  await assert.rejects(() => vademoFromEnv(ENV, { fetchImpl: fetch }).putClass("Harness.Setup.cls", "x"), /upload Harness\.Setup\.cls: VADEMO answered HTTP 500/);
  const fetch2 = fakeFetch({ [`PUT ${BASE}/doc/Harness.Setup.cls`]: okReply({ status: { errors: [{ error: "ERROR #16005: bad doc" }] } }) });
  await assert.rejects(() => vademoFromEnv(ENV, { fetchImpl: fetch2 }).putClass("Harness.Setup.cls", "x"), /#16005: bad doc/);
});

test("deleteClass throws on 403, and removeRestService reports that class failed", async () => {
  const fetch = fakeFetch({ [`DELETE ${BASE}/doc/`]: okReply({}, 403) });
  const c = vademoFromEnv(ENV, { fetchImpl: fetch });
  await assert.rejects(() => c.deleteClass("Harness.Equipment.REST.cls"), /delete Harness\.Equipment\.REST\.cls: VADEMO answered HTTP 403/);
  const { removeRestService } = require("../lib/rest-service");
  const out = await removeRestService(c);
  const cls = out.filter(r => r.item.startsWith("class "));
  assert.equal(cls.length, 3);
  for (const r of cls) assert.match(r.outcome, /^failed: .*HTTP 403/, `${r.item} → ${r.outcome}`);
});

test("query on a 401 HTML answer throws a clear message", async () => {
  const html = { status: 401, ok: false, json: async () => { throw new SyntaxError("Unexpected token <"); } };
  const fetch = fakeFetch({ [`POST ${BASE}/action/query`]: html });
  let msg = "";
  try { await vademoFromEnv(ENV, { fetchImpl: fetch }).query("SELECT 1"); } catch (e) { msg = e.message; }
  assert.match(msg, /VADEMO answered HTTP 401 \(not JSON\)/);
  const fetch2 = fakeFetch({ [`POST ${BASE}/action/compile`]: { status: 200, ok: true, json: async () => { throw new SyntaxError("<html>"); } } });
  await assert.rejects(() => vademoFromEnv(ENV, { fetchImpl: fetch2 }).compile(["X.cls"]), /VADEMO answered HTTP 200 \(not JSON\)/);
});

test("a 500 body echoing the password is redacted", async () => {
  const pass = ENV.VADEMO_PASSWORD;
  const fetch = fakeFetch({ [`POST ${BASE}/action/compile`]: okReply({ status: { errors: [{ error: `login ${pass} refused` }] } }, 500) });
  let msg = "";
  try { await vademoFromEnv(ENV, { fetchImpl: fetch }).compile(["X.cls"]); } catch (e) { msg = e.message; }
  assert.match(msg, /HTTP 500/);
  assert.ok(!msg.includes(pass), `password leaked in: ${msg}`);
  assert.match(msg, /\*\*\*/);
});
