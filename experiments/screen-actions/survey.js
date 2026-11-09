"use strict";
// Read-only survey of ENJ screen pre/post-action code (file 6910.9, entries 6910.97) on VADEMO.
//   node --env-file=agent/.env experiments/screen-actions/survey.js [screenIEN,...]   (default 19,20,27 = ENEQ1-3)
// Writes raw/entries.json (the rows, git-ignored) and survey.json (what each entry's code does).
const fs = require("fs");
const path = require("path");
const { atelierBase } = require("../../agent/lib/vademo");

const url = (process.env.VADEMO_URL || "").replace(/\/+$/, "");
const auth = "Basic " + Buffer.from(process.env.VADEMO_USER + ":" + process.env.VADEMO_PASSWORD).toString("base64");
async function sql(query, parameters = []) {
  const r = await fetch(url + atelierBase() + "/action/query", {
    method: "POST", headers: { Authorization: auth, "Content-Type": "application/json" },
    body: JSON.stringify({ query, parameters }), signal: AbortSignal.timeout(60000),
  });
  const j = await r.json();
  if (j?.status?.errors?.length) throw new Error(j.status.errors[0].error);
  return j.result.content;
}

const uniq = a => [...new Set(a)];
function analyze(code) {
  if (!code) return null;
  return {
    keys: uniq([...code.matchAll(/\^XUSEC\("([^"]+)"/g)].map(m => m[1])),
    calls: uniq([...code.matchAll(/(?:\bD(?::[^ ]+)? |\$\$)([A-Z%][A-Z0-9]*\^[A-Z%][A-Z0-9]*)/g)].map(m => m[1])),
    directSets: uniq([...code.matchAll(/\$P\((\^[^,)]*(?:\([^)]*\))?),U,(\d+)\)=/g)].map(m => `${m[1]} piece ${m[2]}`)),
    reads: uniq([...code.matchAll(/\$D\((\^[A-Z]+\([^)]*\))\)|\$G\((\^[A-Z]+\([^)]*\))\)/g)].map(m => m[1] || m[2])),
    jumpsTo: uniq([...code.matchAll(/DJNX=(\d+)/g)].map(m => +m[1])),
    message: (code.match(/W [^"]*"([^"]+)"/) || [])[1] || null,
  };
}

(async () => {
  const screens = (process.argv[2] || "19,20,27").split(",").map(Number).filter(Boolean);
  const marks = screens.map(() => "?").join(",");
  const heads = await sql(`SELECT %ID AS ID, NAME FROM VISTA.ENG_DJ_SCREEN6910_9 WHERE %ID IN (${marks})`, screens);
  const rows = await sql(
    `SELECT ENG_DJ_SCREEN6910_9 AS SCREEN, IEN, ENTRY_NUM, LABEL, TYPE, RDONLY, PRE_ACTION_CODE, POST_ACTION_CODE
       FROM VISTA.SUB_ENTRY_DEFINITIONS6910_97 WHERE ENG_DJ_SCREEN6910_9 IN (${marks}) ORDER BY ENG_DJ_SCREEN6910_9, ENTRY_NUM`, screens);
  fs.mkdirSync(path.join(__dirname, "raw"), { recursive: true });
  fs.writeFileSync(path.join(__dirname, "raw", "entries.json"), JSON.stringify(rows, null, 1) + "\n");

  const name = Object.fromEntries(heads.map(h => [String(h.ID), h.NAME]));
  const withCode = rows.filter(r => r.PRE_ACTION_CODE || r.POST_ACTION_CODE).map(r => ({
    screen: `${r.SCREEN} ${name[r.SCREEN] || ""}`.trim(), entry: r.ENTRY_NUM, label: r.LABEL,
    pre: analyze(r.PRE_ACTION_CODE), post: analyze(r.POST_ACTION_CODE),
    code: { pre: r.PRE_ACTION_CODE || undefined, post: r.POST_ACTION_CODE || undefined },
  }));
  const all = k => uniq(withCode.flatMap(e => [...(e.pre?.[k] || []), ...(e.post?.[k] || [])]));
  const survey = {
    surveyedAtUTC: new Date().toISOString(), screens: heads, entries: rows.length, entriesWithCode: withCode.length,
    keys: all("keys"), calls: all("calls"), directSets: all("directSets"), entriesList: withCode,
  };
  fs.writeFileSync(path.join(__dirname, "survey.json"), JSON.stringify(survey, null, 1) + "\n");
  console.log(JSON.stringify({ entries: survey.entries, entriesWithCode: survey.entriesWithCode, keys: survey.keys, calls: survey.calls, directSets: survey.directSets }, null, 1));
})().catch(e => { console.error(String(e.message || e).replace(process.env.VADEMO_PASSWORD || "\u0000", "***")); process.exit(1); });
