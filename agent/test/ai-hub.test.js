"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { graph, rec, IM } = require("./helpers");
const { generate } = require("../lib/specs");
const { TEMPLATES } = require("../lib/ai-templates");
const { aiClasses, agingSqlTemplate, fillFiscalYear, PKG, WEB_APP, CREDENTIALS, CONFIG_KEYS, TOKEN_EXPIRED } = require("../lib/ai-hub");

const inventory = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "capability-graph", "inventory-fields.json"), "utf8"));
const MODEL = "us.anthropic.example-model-v1:0";

// All four questions kept, so the JCAHO tool (whose own SQL reads WORK_ORDER_6920) is generated too.
const decided = {
  "AIQ.AgingOutFY": { keep: true, wording: "Which equipment ages out this FY?", params: { fiscalYear: 2030, capitalizedMeans: "INVESTMENT_CATEGORY = 1", useStatuses: ["ALL"] } },
  "AIQ.HighValueNoContract": { keep: true, wording: "Which high-value items have no contract?", params: { threshold: 50000, valueColumn: "TOTAL_ASSET_VALUE", useStatuses: ["ALL"] } },
  "AIQ.JCAHOPendingInspection": { keep: true, wording: "Which JCAHO items have a pending work order?", params: { workOrderStatusColumn: "STATUS", workOrderStatuses: ["ALL"], useStatuses: ["ALL"] } },
  "AIQ.CapitalPlanningTotals": { keep: true, wording: "What are the capital-planning totals?", params: { useStatuses: ["ALL"], valueColumns: ["TOTAL_ASSET_VALUE"], groupBy: "none" } },
};
const aiSpec = (aiQuestions = decided) => generate({ graph, record: rec({ aiQuestions }), implemented: IM, inventory }).ai;
const classes = (ai = aiSpec()) => aiClasses({ ai, inventory, model: MODEL });
const byName = list => Object.fromEntries(list.map(c => [c.name.replace(/\.cls$/, ""), c.text]));
// The ObjectScript string literal "a""b" → a"b; "x"_$char(10)_"y" → x\ny (how the generator writes multi-line SQL).
const unOs = expr => expr.split("_$char(10)_").map(p => p.trim().slice(1, -1).replace(/""/g, '"')).join("\n");

test("exports the package, web app, credential ids, config keys and the token-expired message", () => {
  assert.equal(PKG, "EquipmentAI");
  assert.equal(WEB_APP, "/equipmentai");
  assert.deepEqual(CREDENTIALS, { vademo: "EquipmentAIVademo", bedrock: "EquipmentAIBedrock" });
  assert.deepEqual(CONFIG_KEYS, ["vademoServer", "vademoPort", "vademoPath", "bedrockRegion"]);
  assert.equal(TOKEN_EXPIRED, "Bedrock token expired — update it in agent/.env and press 🔨 again");
});

test("generates the EquipmentAI classes in compile order, each one class in the package", () => {
  const list = classes();
  assert.deepEqual(list.map(c => c.name), [
    "EquipmentAI.Config.cls", "EquipmentAI.Vademo.cls", "EquipmentAI.Guard.cls", "EquipmentAI.Tools.cls",
    "EquipmentAI.Agent.cls", "EquipmentAI.Chat.cls", "EquipmentAI.REST.Dispatch.cls",
  ]);
  for (const c of list) assert.match(c.text, new RegExp(`^Class ${c.name.replace(/\.cls$/, "").replace(/\./g, "\\.")} `, "m"));
  assert.ok(list.every(c => !/EquipmentEntry/.test(c.text)), "AI classes never touch EquipmentEntry");
});

test("refuses an incomplete AI spec and a missing model", () => {
  const partial = aiSpec({ ...decided, "AIQ.AgingOutFY": { keep: true, wording: "x", params: {} } });
  assert.throws(() => classes(partial), /not complete/);
  assert.throws(() => aiClasses({ ai: aiSpec(), inventory }), /model/);
});

test("Config reads ^EquipmentAI.Config and the two Ens.Config.Credentials ids — no value is generated", () => {
  const t = byName(classes())["EquipmentAI.Config"];
  assert.match(t, /ClassMethod Get\(key As %String\) As %String/);
  assert.match(t, /\^EquipmentAI\.Config\(key\)/);
  assert.match(t, /"EquipmentAIVademo"/);
  assert.match(t, /"EquipmentAIBedrock"/);
  assert.match(t, /Ens\.Config\.Credentials/);
});

test("Vademo.Query posts to the configured server, port and path with the stored login and throws on errors", () => {
  const t = byName(classes())["EquipmentAI.Vademo"];
  assert.match(t, /ClassMethod Query\(sql As %String\) As %DynamicArray/);
  for (const k of ["vademoServer", "vademoPort", "vademoPath"]) assert.match(t, new RegExp(`Get\\("${k}"\\)`));
  assert.match(t, /VademoLogin/);
  assert.match(t, /StatusCode/);
  assert.match(t, /status\.errors/);
  assert.match(t, /\$\$\$ThrowStatus/);
});

test("Tools declares exactly one <Tool> per kept question plus RunQuery, each with a method of that name", () => {
  const t = byName(classes())["EquipmentAI.Tools"];
  assert.match(t, /^Class EquipmentAI\.Tools Extends %AI\.ToolSet/m);
  assert.match(t, /XData Definition \[ XMLNamespace = "http:\/\/www\.intersystems\.com\/ai\/toolset" \]/);
  const tools = [...t.matchAll(/<Tool Name="([^"]+)" Method="([^"]+)">/g)].map(m => [m[1], m[2]]);
  assert.deepEqual(tools, [["AgingOutFY", "AgingOutFY"], ["HighValueNoContract", "HighValueNoContract"], ["JCAHOPendingInspection", "JCAHOPendingInspection"], ["CapitalPlanningTotals", "CapitalPlanningTotals"], ["RunQuery", "RunQuery"]]);
  for (const [, m] of tools) assert.match(t, new RegExp(`ClassMethod ${m}\\(`));
  assert.match(t, /ClassMethod RunQuery\(sql As %String\) As %String/);
  assert.match(t, /ClassMethod HighValueNoContract\(\) As %String/);

  // a dropped question has no tool
  const fewer = byName(classes(aiSpec({ ...decided, "AIQ.HighValueNoContract": { keep: false } })))["EquipmentAI.Tools"];
  assert.doesNotMatch(fewer, /HighValueNoContract/);
  assert.equal([...fewer.matchAll(/<Tool /g)].length, 4);
});

test("AgingOutFY defaults fiscalYear to the decided year", () => {
  const t = byName(classes())["EquipmentAI.Tools"];
  assert.match(t, /ClassMethod AgingOutFY\(fiscalYear As %Integer = 2030\) As %String/);
  const other = byName(classes(aiSpec({ ...decided, "AIQ.AgingOutFY": { ...decided["AIQ.AgingOutFY"], params: { ...decided["AIQ.AgingOutFY"].params, fiscalYear: 2034 } } })))["EquipmentAI.Tools"];
  assert.match(other, /ClassMethod AgingOutFY\(fiscalYear As %Integer = 2034\) As %String/);
});

test("each fixed tool runs exactly the spec's SQL; the aging SQL is the template's with FileMan bounds recomputed", () => {
  const ai = aiSpec();
  const t = byName(classes(ai))["EquipmentAI.Tools"];
  for (const q of ai.detail.questions.filter(q => q.id !== "AIQ.AgingOutFY")) {
    const m = new RegExp(`ClassMethod ${q.id.slice(4)}\\(\\) As %String\\n\\{\\n    Quit \\.\\.Run\\("${q.id.slice(4)}", (.+)\\)\\n\\}`).exec(t);
    assert.ok(m, `no fixed-SQL body for ${q.id}`);
    assert.equal(unOs(m[1]), q.sql);
  }
  // the aging template: placeholders for the bounds, filled the way the class fills them
  const aging = ai.detail.questions.find(q => q.id === "AIQ.AgingOutFY");
  const tpl = agingSqlTemplate(aging, inventory);
  assert.match(tpl, /\{FYSTART\}/);
  assert.match(tpl, /\{FYEND\}/);
  assert.equal(fillFiscalYear(tpl, 2030), aging.sql, "the decided year gives exactly the spec's SQL");
  const fy2032 = fillFiscalYear(tpl, 2032);
  assert.match(fy2032, />= 3311001\b/);
  assert.match(fy2032, /<= 3320930\b/);
  assert.equal(fy2032, TEMPLATES.find(x => x.id === "AIQ.AgingOutFY").sql({ ...aging.params, fiscalYear: 2032 }, inventory));
  // the class carries that template and the same formula
  const body = /ClassMethod AgingOutFYSQL\(fiscalYear As %String\) As %String\n\{\n([\s\S]*?)\n\}/.exec(t);
  assert.ok(body, "AgingOutFYSQL is generated");
  assert.match(body[1], /\(fiscalYear - 1 - 1700\) \* 10000 \+ 1001/);
  assert.match(body[1], /\(fiscalYear - 1700\) \* 10000 \+ 930/);
  const lit = /\$replace\(\$replace\((.+), "\{FYSTART\}", tStart\), "\{FYEND\}", tEnd\)/.exec(body[1]);
  assert.ok(lit);
  assert.equal(unOs(lit[1]), tpl);
});

test("every tool result carries rowCount and truncated, capped at the spec's row cap, and is stored in ^||EquipmentAI.Last", () => {
  const list = byName(classes());
  const t = list["EquipmentAI.Tools"];
  assert.match(t, /Parameter ROWCAP = 200;/);
  assert.match(t, /"rowCount"/);
  assert.match(t, /"truncated"/);
  assert.match(t, /\^\|\|EquipmentAI\.Last = /);
  assert.match(t, /Guard\)\.Check\(sql\)/);
  assert.match(t, /Guard\)\.Cap\(/);
  const g = list["EquipmentAI.Guard"];
  assert.match(g, /ClassMethod Cap\(sql As %String\) As %String/);
  assert.match(g, /Parameter ROWCAP = 200;/);
  assert.match(g, /\.\.#ROWCAP \+ 1/);
});

test("the guard's allow-list equals inventory.allowList exactly — never WORK_ORDER_6920, even with the JCAHO tool generated", () => {
  const list = byName(classes());
  const g = list["EquipmentAI.Guard"];
  const m = /Parameter ALLOWLIST = "([^"]*)";/.exec(g);
  assert.ok(m);
  assert.deepEqual(m[1].split(","), inventory.allowList);
  assert.ok(!m[1].split(",").includes("VISTA.WORK_ORDER_6920"));
  assert.ok(!m[1].split(",").includes("VISTA.NEW_PERSON200"));
  assert.match(list["EquipmentAI.Tools"], /WORK_ORDER_6920/, "the JCAHO tool's own SQL still reads it");
});

test("the guard checks comments, statements, SELECT, forbidden words and every FROM/JOIN table", () => {
  const g = byName(classes())["EquipmentAI.Guard"];
  assert.match(g, /ClassMethod Check\(sql As %String\) As %String/);
  assert.match(g, /Parameter FORBIDDEN = "INSERT,UPDATE,DELETE,DROP,ALTER,CREATE,GRANT,CALL,EXEC,INTO,TRUNCATE/);
  assert.match(g, /"--"/);
  assert.match(g, /"\/\*"/);
  assert.match(g, /";"/);
  assert.match(g, /"SELECT"/);
  assert.match(g, /"FROM"/);
  assert.match(g, /"JOIN"/);
});

test("the agent: bedrock, the given model, the toolset, rules and a schema guide naming every pointer's name column", () => {
  const t = byName(classes())["EquipmentAI.Agent"];
  assert.match(t, /^Class EquipmentAI\.Agent Extends %AI\.Agent/m);
  assert.match(t, /Parameter PROVIDER = "bedrock";/);
  assert.match(t, new RegExp(`Parameter MODEL = "${MODEL.replace(/\./g, "\\.")}";`));
  assert.match(t, /Parameter TOOLSETS = "EquipmentAI\.Tools";/);
  assert.match(t, /XData INSTRUCTIONS \[ MimeType = text\/markdown \]/);
  assert.match(t, /EQUIPMENT_CATEGORY_NAME/);
  assert.match(t, /never estimate/);
  assert.match(t, /truncated/);
  assert.match(t, /VistA could not be reached/);
  assert.match(t, /read-only/i);
  // every pointer column on an allow-listed table names its name column
  for (const q of inventory.allowList) {
    const tbl = inventory.tables[q.replace(/^VISTA\./, "")];
    assert.ok(t.includes(`### ${q}`), `guide has a section for ${q}`);
    for (const c of tbl.columns.filter(c => c.nameColumn)) assert.ok(t.includes(`use ${c.nameColumn} for the name`), `${q}.${c.column}`);
  }
  assert.match(t, /- EQUIPMENT_CATEGORY — EQUIPMENT CATEGORY[^\n]*use EQUIPMENT_CATEGORY_NAME for the name/);
  // codes are spelled out
  const use = inventory.tables.EQUIPMENT_INV_6914.columns.find(c => c.column === "USE_STATUS");
  assert.ok(t.includes(use.codes.map(([c, l]) => `${c} = ${l}`).join(", ")));
  // non-allow-listed tables are not described
  assert.ok(!t.includes("### VISTA.NEW_PERSON200") && !t.includes("### VISTA.WORK_ORDER_6920"));
  // nothing in the XData can close the block early
  const xdata = /XData INSTRUCTIONS \[ MimeType = text\/markdown \]\n\{\n([\s\S]*)\n\}\n\n/.exec(t)[1];
  assert.ok(!/[{}]/.test(xdata));
});

test("Chat: Reply and Quick follow the session pattern and return the last tool result", () => {
  const t = byName(classes())["EquipmentAI.Chat"];
  assert.match(t, /ClassMethod Reply\(sessionId As %String, message As %String\) As %DynamicObject/);
  assert.match(t, /ClassMethod Quick\(sessionId As %String, id As %String, fiscalYear As %String = ""\) As %DynamicObject/);
  assert.match(t, /%AI\.Agent\.Session\)\.Load\(/);
  assert.match(t, /\.Import\(/);
  assert.match(t, /\.Export\(\)/);
  assert.match(t, /\^EquipmentAI\.Sessions\(/);
  assert.match(t, /%AI\.Provider\)\.Create\("bedrock", \{"region": \(/);
  assert.match(t, /"bearer_token": \(tToken\)/);
  assert.match(t, /Get\("bedrockRegion"\)/);
  assert.match(t, /BedrockToken\(\)/);
  assert.match(t, /\.%Init\(\)/);
  assert.match(t, /pAgent\.Chat\(pSession, pText\)/);
  assert.match(t, /\^\|\|EquipmentAI\.Last/);
  assert.ok(t.includes(TOKEN_EXPIRED));
  for (const id of ["AgingOutFY", "HighValueNoContract", "JCAHOPendingInspection", "CapitalPlanningTotals"]) assert.match(t, new RegExp(`##class\\(EquipmentAI\\.Tools\\)\\.${id}\\(`));
});

test("the REST dispatch: POST /chat, /quick/:id, /guard and the exact token-expired message", () => {
  const t = byName(classes())["EquipmentAI.REST.Dispatch"];
  assert.match(t, /^Class EquipmentAI\.REST\.Dispatch Extends %CSP\.REST/m);
  assert.match(t, /<Route Url="\/chat" Method="POST" Call="Chat" \/>/);
  assert.match(t, /<Route Url="\/quick\/:id" Method="POST" Call="Quick" \/>/);
  assert.match(t, /<Route Url="\/guard" Method="POST" Call="Guard" \/>/);
  assert.ok(t.includes("Bedrock token expired — update it in agent/.env and press 🔨 again"));
  assert.match(t, /"ok"/);
  assert.match(t, /"reason"/);
});

test("nothing generated holds a host, an account or a credential", () => {
  // \b_SYSTEM\b: legitimate 6914 column names (PARENT_SYSTEM, UTILITY_SYSTEMS6918_1) contain "_SYSTEM" (Task 1 ruling)
  for (const c of classes()) assert.doesNotMatch(c.text, /password\s*=|172\.17\.|\b_SYSTEM\b|bearer_token"\s*:\s*"[^"(]|localhost|https?:\/\/(?!www\.intersystems\.com)/i, c.name);
});
