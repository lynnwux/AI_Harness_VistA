"use strict";
// Generates the AI layer's ObjectScript classes (package EquipmentAI, IRIS AI Hub) from the AI layer spec and
// the inventory discovery file: the VADEMO client, the read-only SQL guard, the toolset (one tool per kept
// quick-access question plus RunQuery), the agent with its instructions and schema guide, the chat entry points
// and the REST dispatch. No host, login or token is generated: hosts are ^EquipmentAI.Config settings and
// secrets are Ens.Config.Credentials entries, both written at deploy time.

const { TEMPLATES } = require("./ai-templates");

const PKG = "EquipmentAI";
const WEB_APP = "/equipmentai";
const CREDENTIALS = { vademo: "EquipmentAIVademo", bedrock: "EquipmentAIBedrock" };
const CONFIG_KEYS = ["vademoServer", "vademoPort", "vademoPath", "bedrockRegion"];
const TOKEN_EXPIRED = "Bedrock token expired — update it in agent/.env and press 🔨 again";
// The brief's words, plus other statements a SELECT never contains.
const FORBIDDEN = ["INSERT", "UPDATE", "DELETE", "DROP", "ALTER", "CREATE", "GRANT", "CALL", "EXEC", "INTO", "TRUNCATE", "EXECUTE", "REVOKE", "MERGE"];
// Words that end a FROM clause at its own parenthesis depth.
const END_CLAUSE = ["WHERE", "GROUP", "ORDER", "HAVING", "UNION", "EXCEPT", "INTERSECT"];
// The built-in functions a general query may call; any other name followed by "(" is rejected (it could be a
// stored procedure in the default schema).
const FUNCTIONS = ["COUNT", "SUM", "AVG", "MIN", "MAX", "CAST", "CONVERT", "COALESCE", "NVL", "IFNULL", "ISNULL", "NULLIF", "UPPER", "LOWER", "LEFT", "RIGHT", "SUBSTRING", "LENGTH", "LTRIM", "RTRIM", "TRIM", "ROUND", "FLOOR", "CEILING", "ABS", "YEAR", "MONTH", "DAY", "CURRENT_DATE", "DATEDIFF", "DATEADD", "$PIECE", "$EXTRACT", "$LENGTH", "%EXACT", "%SQLUPPER", "%UPPER"];
// SQL words that may stand right before "(" without calling anything (IN (...), EXISTS (...), VARCHAR(20), ...).
const BEFORE_PAREN = ["SELECT", "FROM", "JOIN", "ON", "USING", "WHERE", "AND", "OR", "NOT", "IN", "EXISTS", "ANY", "ALL", "SOME", "AS", "BY", "TOP", "DISTINCT", "WHEN", "THEN", "ELSE", "CASE", "BETWEEN", "LIKE", "IS", "HAVING", "UNION", "EXCEPT", "INTERSECT", "VARCHAR", "CHAR", "CHARACTER", "NUMERIC", "DECIMAL"];
const YEARS = [1990, 2100]; // the fiscal-year range the Decide chat accepts (ai-templates validateOne)
const AGING = "AIQ.AgingOutFY";

const os = s => '"' + String(s == null ? "" : s).replace(/"/g, '""') + '"';                  // ObjectScript string literal
const osLines = s => String(s).split("\n").map(os).join("_$char(10)_");                       // multi-line text, newlines kept
const xml = s => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const line = s => String(s == null ? "" : s).replace(/\s+/g, " ").trim();                     // one line of text
const md = s => line(s).replace(/\{/g, "(").replace(/\}/g, ")");                              // safe inside an XData block
const cls = (name, text) => ({ name: `${name}.cls`, text });
const method = id => id.replace(/^AIQ\./, "");

// FileMan bounds of a federal fiscal year: Oct 1 of N-1 through Sep 30 of N, as (year-1700)*10000+mmdd.
const fyBounds = year => ({ start: (year - 1 - 1700) * 10000 + 1001, end: (year - 1700) * 10000 + 930 });

// The aging question's SQL from its own template, with the two FileMan bounds as {FYSTART}/{FYEND} placeholders —
// so the tool can answer another fiscal year without a second, hand-written query.
function agingSqlTemplate(question, inventory) {
  const t = TEMPLATES.find(x => x.id === AGING);
  const year = Number(question.params.fiscalYear);
  const sql = t.sql({ ...question.params, fiscalYear: year }, inventory);
  const { start, end } = fyBounds(year);
  if (sql.split(String(start)).length !== 2 || sql.split(String(end)).length !== 2) throw new Error("the aging SQL does not carry its fiscal-year bounds exactly once");
  const tpl = sql.replace(String(start), "{FYSTART}").replace(String(end), "{FYEND}");
  if (fillFiscalYear(tpl, year) !== question.sql) throw new Error("the aging SQL template does not reproduce the spec's SQL");
  return tpl;
}

// What EquipmentAI.Tools.AgingOutFYSQL does in ObjectScript (same formula), for tests and the build's checks.
function fillFiscalYear(tpl, year) {
  const { start, end } = fyBounds(Number(year));
  return tpl.replace("{FYSTART}", String(start)).replace("{FYEND}", String(end));
}

function config() {
  return cls(`${PKG}.Config`, `/// Settings for the AI layer. Non-secret settings (${CONFIG_KEYS.join(", ")}) live in ^${PKG}.Config;
/// secrets live in Ens.Config.Credentials. Both are written at deploy time — nothing here holds a value.
Class ${PKG}.Config [ Abstract ]
{

/// Credential with the read-only VADEMO login (username and password).
Parameter VADEMOCREDENTIAL = ${os(CREDENTIALS.vademo)};

/// Credential whose password is the Bedrock bearer token.
Parameter BEDROCKCREDENTIAL = ${os(CREDENTIALS.bedrock)};

/// A non-secret setting ("" when it is not set).
ClassMethod Get(key As %String) As %String
{
    Quit $get(^${PKG}.Config(key))
}

/// The secret of a stored credential ("" when it is missing); its username comes back in user.
ClassMethod Secret(id As %String, Output user As %String) As %String
{
    Set user = ""
    Set tCred = ##class(Ens.Config.Credentials).%OpenId(id)
    Quit:'$isobject(tCred) ""
    Set user = tCred.Username
    Quit tCred.Password
}

/// The VADEMO login: returns its password, user by reference.
ClassMethod VademoLogin(Output user As %String) As %String
{
    Quit ..Secret(..#VADEMOCREDENTIAL, .user)
}

/// The Bedrock bearer token.
ClassMethod BedrockToken() As %String
{
    Quit ..Secret(..#BEDROCKCREDENTIAL)
}

}
`);
}

function vademo() {
  return cls(`${PKG}.Vademo`, `/// Read-only SQL on VADEMO through the Atelier SQL API.
Class ${PKG}.Vademo [ Abstract ]
{

/// Runs sql on VADEMO: POST vademoPath on vademoServer:vademoPort (from ^${PKG}.Config) with the login stored in
/// the ${CREDENTIALS.vademo} credential. Returns the rows (one object per row); throws on a connection, HTTP or SQL error.
ClassMethod Query(sql As %String) As %DynamicArray
{
    Set tServer = ##class(${PKG}.Config).Get("vademoServer"), tPort = ##class(${PKG}.Config).Get("vademoPort"), tPath = ##class(${PKG}.Config).Get("vademoPath")
    If (tServer = "") || (tPath = "") {
        $$$ThrowStatus($$$ERROR($$$GeneralError, "VistA is not configured here: ^${PKG}.Config has no vademoServer or vademoPath"))
    }
    Set tSecret = ##class(${PKG}.Config).VademoLogin(.tUser)
    Set tHttp = ##class(%Net.HttpRequest).%New()
    Set tHttp.Server = tServer, tHttp.Timeout = 30, tHttp.ContentType = "application/json"
    Set:tPort'="" tHttp.Port = tPort
    If tUser '= "" {
        Do tHttp.SetHeader("Authorization", "Basic "_$translate($system.Encryption.Base64Encode($zconvert(tUser_":"_tSecret, "O", "UTF8")), $char(13, 10)))
    }
    Do tHttp.EntityBody.Write($zconvert({"query": (sql)}.%ToJSON(), "O", "UTF8"))
    $$$ThrowOnError(tHttp.Post(tPath))
    Set tStatus = tHttp.HttpResponse.StatusCode, tBody = ""
    Try { Set tBody = ##class(%DynamicObject).%FromJSON(tHttp.HttpResponse.Data) } Catch { Set tBody = "" }
    If $isobject(tBody) && $isobject(tBody.status) && $isobject(tBody.status.errors) && tBody.status.errors.%Size() {
        Set tErr = tBody.status.errors.%Get(0)
        $$$ThrowStatus($$$ERROR($$$GeneralError, "VistA rejected the query: "_$select($isobject(tErr): tErr.error, 1: tErr)))
    }
    If tStatus '= 200 {
        $$$ThrowStatus($$$ERROR($$$GeneralError, "VistA answered HTTP "_tStatus))
    }
    If '$isobject(tBody) || '$isobject(tBody.result) || '$isobject(tBody.result.content) {
        $$$ThrowStatus($$$ERROR($$$GeneralError, "VistA returned an unexpected response"))
    }
    Quit tBody.result.content
}

}
`);
}

function guard(allowList, rowCap) {
  if (allowList.some(t => !/^VISTA\.[A-Z0-9_]+$/.test(t))) throw new Error("the inventory allow-list must hold schema-qualified VISTA table names");
  return cls(`${PKG}.Guard`, `/// The read-only guard for the general question path (RunQuery): one SELECT over allow-listed tables only.
/// The text it checks — comments removed — is the text that runs (see Cap), so a comment can never hide anything.
Class ${PKG}.Guard [ Abstract ]
{

/// The tables a general question may read: inventory-fields.json's allowList, schema-qualified.
Parameter ALLOWLIST = ${os(allowList.join(","))};

/// The most rows any result returns to the chat; Cap asks for one more, to detect truncation.
Parameter ROWCAP = ${rowCap};

/// Never allowed anywhere in a query: whole words, any case, string literals included.
Parameter FORBIDDEN = ${os(FORBIDDEN.join(","))};

/// Words that end a FROM clause at its own parenthesis depth.
Parameter ENDCLAUSE = ${os(END_CLAUSE.join(","))};

/// The only functions a query may call (a name followed by "(").
Parameter FUNCTIONS = ${os(FUNCTIONS.join(","))};

/// SQL words that may stand before "(" without being a function call.
Parameter BEFOREPAREN = ${os(BEFORE_PAREN.join(","))};

/// "" when sql is a single read-only SELECT over allow-listed tables; otherwise the reason it is rejected.
ClassMethod Check(sql As %String) As %String
{
    Set tText = ..Strip(sql, .tWhy)
    Quit:tWhy'="" tWhy
    Set tWhy = ..Forbidden(tText)
    Quit:tWhy'="" tWhy
    Set tN = ..Tokens(tText, .tTok)
    Quit:tN=0 "the query is empty"
    Quit:tTok(1)'="SELECT" "only a SELECT is allowed (the query starts with "_tTok(1)_")"
    Set tAllow = $listfromstring($zconvert(..#ALLOWLIST, "U")), tCalls = $listfromstring(..#FUNCTIONS_","_..#BEFOREPAREN)
    For i=1:1:tN {
        Set t = tTok(i), tNext = $get(tTok(i + 1)), tNumber = ($translate(t, "0123456789.") = "") && (t?.E1N.E)
        If t = """" {
            Set tWhy = "quoted names (""..."") are not allowed: use the plain names from the schema guide"
            Quit
        }
        If 'tNumber && (($extract(t) = ".") || ($extract(t, *) = ".") || (t [ "..")) {
            Set tWhy = "a name may not start or end with a dot ("_t_")"
            Quit
        }
        If 'tNumber && (t [ ".") && (tNext = "(") {
            Set tWhy = "calling "_t_"() is not allowed"
            Quit
        }
        If 'tNumber && ..IsName($extract(t)) && (tNext = "(") && '$listfind(tCalls, t) {
            Set tWhy = t_"() is not an allowed function (allowed: "_$translate(..#FUNCTIONS, ",", " ")_")"
            Quit
        }
        If t = "FROM" {
            Set tWhy = ..FromList(.tTok, i + 1, tAllow)
            Quit:tWhy'=""
        }
        If (t = "JOIN") && (tNext '= "(") && '$listfind(tAllow, tNext) {
            Set tWhy = ..NotTable(tNext)
            Quit
        }
    }
    Quit tWhy
}

/// sql without its comments (each becomes a space). pWhy is set when the text cannot be read safely: an
/// unterminated string, quoted name or comment, a ; outside a string, //, a stray */, or -> (an implicit join).
ClassMethod Strip(sql As %String, Output pWhy As %String) As %String
{
    Set pWhy = "", tOut = "", tLen = $length(sql), i = 1
    While i <= tLen {
        Set c = $extract(sql, i), c2 = $extract(sql, i, i + 1)
        If (c = "'") || (c = """") {
            Set j = ..QuoteEnd(sql, i)
            If j = 0 {
                Set pWhy = "the query has an unterminated "_$select(c = "'": "string", 1: "quoted name")
                Quit
            }
            Set tOut = tOut_$extract(sql, i, j), i = j + 1
            Continue
        }
        If c2 = "--" {
            Set j = i + 2
            While (j <= tLen) && ($char(10, 13) '[ $extract(sql, j)) { Set j = j + 1 }
            Set tOut = tOut_" ", i = j
            Continue
        }
        If c2 = "/*" {
            Set j = $find(sql, "*/", i + 2)
            If j = 0 {
                Set pWhy = "the query has an unterminated /* comment"
                Quit
            }
            Set tOut = tOut_" ", i = j
            Continue
        }
        If c2 = "//" { Set pWhy = "// is not allowed in a query" Quit }
        If c2 = "*/" { Set pWhy = "the query has a stray */" Quit }
        If c2 = "->" { Set pWhy = "implicit joins (->) are not allowed: join an allow-listed table explicitly" Quit }
        If c = ";" { Set pWhy = "only one statement is allowed (found ; outside a string)" Quit }
        Set tOut = tOut_c, i = i + 1
    }
    Quit $select(pWhy = "": tOut, 1: "")
}

/// Position of the quote that closes the string or quoted name opening at i (a doubled quote is an escape), or 0.
ClassMethod QuoteEnd(sql As %String, i As %Integer) As %Integer
{
    Set q = $extract(sql, i), j = i + 1, tLen = $length(sql)
    While j <= tLen {
        If $extract(sql, j) = q {
            Quit:$extract(sql, j + 1)'=q
            Set j = j + 1
        }
        Set j = j + 1
    }
    Quit $select(j <= tLen: j, 1: 0)
}

/// The first forbidden word in the text, as a reason, or "".
ClassMethod Forbidden(pText As %String) As %String
{
    Set tList = $listfromstring(..#FORBIDDEN), tWord = "", tWhy = ""
    For i=1:1:$length(pText) + 1 {
        Set c = $extract(pText, i)
        If (c?1AN) || (c = "_") { Set tWord = tWord_c Continue }
        If (tWord '= "") && $listfind(tList, $zconvert(tWord, "U")) {
            Set tWhy = $zconvert(tWord, "U")_" is not allowed: the chat is read-only"
            Quit
        }
        Set tWord = ""
    }
    Quit tWhy
}

/// Splits the comment-free text into tokens: names (upper case, dots kept), ' for a string, "" for a quoted name,
/// and single characters. Returns the count.
ClassMethod Tokens(pText As %String, Output pTok) As %Integer
{
    Kill pTok
    Set n = 0, i = 1, tLen = $length(pText)
    While i <= tLen {
        Set c = $extract(pText, i)
        If (c = " ") || (c?1C) { Set i = i + 1 Continue }
        If (c = "'") || (c = """") {
            Set j = ..QuoteEnd(pText, i)
            Set:j=0 j = tLen
            Set n = n + 1, pTok(n) = c, i = j + 1
            Continue
        }
        If ..IsName(c) {
            Set j = i + 1
            While (j <= tLen) && ..IsName($extract(pText, j)) { Set j = j + 1 }
            Set n = n + 1, pTok(n) = $zconvert($extract(pText, i, j - 1), "U"), i = j
            Continue
        }
        Set n = n + 1, pTok(n) = c, i = i + 1
    }
    Quit n
}

ClassMethod IsName(c As %String) As %Boolean [ CodeMode = expression ]
{
(c '= "") && ((c?1AN) || ("_%$.#@" [ c))
}

/// Walks one FROM clause from token p, at its own parenthesis depth, until WHERE, GROUP, ORDER, HAVING, UNION,
/// EXCEPT, INTERSECT, the ")" that closes its level, or the end. The token after FROM, after every JOIN and after
/// every comma at this level must be an allow-listed table or "(" — a subquery (checked by its own FROM) or a
/// parenthesized table expression (walked here). Everything else at this level (aliases, ON/USING conditions) is
/// skipped, and parentheses inside it are skipped whole.
ClassMethod FromList(ByRef pTok, p As %Integer, pAllow As %List) As %String
{
    Set tEnd = $listfromstring(..#ENDCLAUSE), tWhy = "", tExpect = 1
    For {
        Set t = $get(pTok(p))
        If t = "" {
            Set:tExpect tWhy = "a table name is missing after FROM, JOIN or a comma"
            Quit
        }
        If tExpect {
            Set tExpect = 0
            If t = "(" {
                If $get(pTok(p + 1)) '= "SELECT" {
                    Set tWhy = ..FromList(.pTok, p + 1, pAllow)
                    Quit:tWhy'=""
                }
                Set p = ..Close(.pTok, p)
                Continue
            }
            If '$listfind(pAllow, t) {
                Set tWhy = ..NotTable(t)
                Quit
            }
            Set p = p + 1
            Continue
        }
        Quit:(t = ")")||$listfind(tEnd, t)
        If t = "(" {
            Set p = ..Close(.pTok, p)
            Continue
        }
        Set:(t = ",")||(t = "JOIN") tExpect = 1
        Set p = p + 1
    }
    Quit tWhy
}

/// The token position just after the ")" that matches the "(" at p.
ClassMethod Close(ByRef pTok, p As %Integer) As %Integer
{
    Set tDepth = 0
    For {
        Set t = $get(pTok(p)), p = p + 1
        Set:t="(" tDepth = tDepth + 1
        Set:t=")" tDepth = tDepth - 1
        Quit:(tDepth = 0)||(t = "")
    }
    Quit p
}

/// Why token t may not stand where a table belongs.
ClassMethod NotTable(t As %String) As %String [ CodeMode = expression ]
{
$select(t = "": "a table name is missing after FROM, JOIN or a comma", ..IsName($extract(t)): t_" is not an allow-listed table: use a schema-qualified table from the schema guide, e.g. VISTA.EQUIPMENT_INV_6914", 1: "only an allow-listed table may follow FROM, JOIN or a comma in a FROM list (found "_t_")")
}

/// sql, comments removed, asking for at most ROWCAP + 1 rows so a result over the cap shows as truncated.
/// TOP goes into the outer SELECT (IRIS rejects ORDER BY inside a wrapping SELECT * FROM (...)); an existing
/// TOP at or under the limit is kept. In a UNION, TOP caps the first SELECT — the caller still cuts at ROWCAP.
ClassMethod Cap(sql As %String) As %String
{
    Set tMax = ..#ROWCAP + 1
    Set tText = ..Strip(sql, .tWhy)
    Set:tWhy'="" tText = sql
    Set m = ##class(%Regex.Matcher).%New("(?is)^\\s*SELECT\\b\\s*((?:%[A-Z]+\\s+)*)((?:DISTINCT(?:\\s+BY\\s*\\([^)]*\\))?|ALL)\\s+)?(?:TOP\\s*(\\(\\s*\\d+\\s*\\)|\\d+|ALL\\b)\\s*)?", tText)
    Quit:'m.Locate() tText
    Set tTop = $translate(m.Group(3), "() ")
    Set tTop = $select((tTop?1.N) && (tTop <= tMax): +tTop, 1: tMax)
    Quit "SELECT "_m.Group(1)_m.Group(2)_"TOP "_tTop_" "_$extract(tText, m.End, *)
}

}
`);
}

function quickTool(q) {
  const name = method(q.id);
  if (q.id === AGING) return null; // generated by agingTool
  return `/// ${line(q.wording)}
ClassMethod ${name}() As %String
{
    Quit ..Run(${os(name)}, ${osLines(q.sql)})
}
`;
}

function agingTool(q, inventory) {
  const year = Number(q.params.fiscalYear);
  return `/// ${line(q.wording)} — fiscalYear defaults to the decided year (${year}).
ClassMethod AgingOutFY(fiscalYear As %Integer = ${year}) As %String
{
    Set:fiscalYear="" fiscalYear = ${year}
    Set tSQL = ..AgingOutFYSQL(fiscalYear)
    Quit:tSQL="" ..Fail("AgingOutFY", "fiscalYear must be a whole year from ${YEARS[0]} to ${YEARS[1]}, not "_fiscalYear)
    Quit ..Run("AgingOutFY", tSQL)
}

/// The aging question's SQL for a fiscal year: the spec's template SQL with its FileMan bounds recomputed —
/// FY N runs Oct 1 of N-1, (N-1-1700)*10000+1001, through Sep 30 of N, (N-1700)*10000+930. "" for a bad year.
ClassMethod AgingOutFYSQL(fiscalYear As %String) As %String
{
    Quit:'((fiscalYear?4N) && (fiscalYear >= ${YEARS[0]}) && (fiscalYear <= ${YEARS[1]})) ""
    Set tStart = (fiscalYear - 1 - 1700) * 10000 + 1001, tEnd = (fiscalYear - 1700) * 10000 + 930
    Quit $replace($replace(${osLines(agingSqlTemplate(q, inventory))}, "{FYSTART}", tStart), "{FYEND}", tEnd)
}
`;
}

function toolDescription(q) {
  const base = `${line(q.wording)} Runs the developer's decided query on VistA and returns its columns and rows (at most 200, with rowCount and truncated).`;
  return q.id === AGING ? `${base} Optional fiscalYear: the federal fiscal year (Oct 1 to Sep 30), default ${Number(q.params.fiscalYear)}; pass another year only when the user names one.` : base;
}

function tools(questions, rowCap, inventory) {
  const decls = questions.map(q => `  <Tool Name="${method(q.id)}" Method="${method(q.id)}">\n    <Description>${xml(toolDescription(q))}</Description>\n  </Tool>`);
  decls.push(`  <Tool Name="RunQuery" Method="RunQuery">\n    <Description>${xml(`Runs one read-only SELECT over the allow-listed VISTA tables in the schema guide (schema-qualified, e.g. VISTA.EQUIPMENT_INV_6914) and returns its columns and rows (at most ${rowCap}, with rowCount and truncated). Anything else is rejected by the guard.`)}</Description>\n  </Tool>`);
  const methods = questions.map(q => (q.id === AGING ? agingTool(q, inventory) : quickTool(q)));
  return cls(`${PKG}.Tools`, `/// The chatbot's tools: one per kept quick-access question (its decided SQL), plus RunQuery for general
/// questions (guarded). Every tool returns { tool, sql, columns, rows, rowCount, truncated, error? } as JSON
/// and keeps it in ^||${PKG}.Last for the chat's reply.
Class ${PKG}.Tools Extends %AI.ToolSet
{

/// The most rows a tool returns.
Parameter ROWCAP = ${rowCap};

XData Definition [ XMLNamespace = "http://www.intersystems.com/ai/toolset" ]
{
<ToolSet>
${decls.join("\n")}
</ToolSet>
}

${methods.join("\n")}
/// A general question's SQL, run only when the guard allows it.
ClassMethod RunQuery(sql As %String) As %String
{
    Set tWhy = ##class(${PKG}.Guard).Check(sql)
    Quit:tWhy'="" ..Fail("RunQuery", "rejected by the read-only guard: "_tWhy, sql)
    Quit ..Run("RunQuery", sql)
}

/// Runs sql on VistA (asking for ROWCAP + 1 rows) and returns the tool result, cut at ROWCAP rows.
ClassMethod Run(pTool As %String, pSQL As %String) As %String [ Private ]
{
    Set tOut = {"tool": (pTool), "sql": (pSQL), "columns": [], "rows": [], "rowCount": 0, "truncated": false}
    Try {
        Set tRows = ##class(${PKG}.Vademo).Query(##class(${PKG}.Guard).Cap(pSQL))
        Set tIter = tRows.%GetIterator()
        While tIter.%GetNext(.tKey, .tRow) {
            If tOut.rows.%Size() = ..#ROWCAP {
                Do tOut.%Set("truncated", 1, "boolean")
                Quit
            }
            Do tOut.rows.%Push(tRow)
        }
        If tOut.rows.%Size() && $isobject(tOut.rows.%Get(0)) {
            Set tCols = tOut.rows.%Get(0).%GetIterator()
            While tCols.%GetNext(.tCol) { Do tOut.columns.%Push(tCol) }
        }
        Set tOut.rowCount = tOut.rows.%Size()
    } Catch e {
        Do tOut.%Set("error", e.DisplayString())
    }
    Quit ..Keep(tOut)
}

/// A tool result that ran nothing.
ClassMethod Fail(pTool As %String, pError As %String, pSQL As %String = "") As %String [ Private ]
{
    Quit ..Keep({"tool": (pTool), "sql": (pSQL), "columns": [], "rows": [], "rowCount": 0, "truncated": false, "error": (pError)})
}

ClassMethod Keep(pOut As %DynamicObject) As %String [ Private ]
{
    Set tJSON = pOut.%ToJSON()
    Set ^||${PKG}.Last = tJSON
    Quit tJSON
}

}
`);
}

// ── The agent's instructions: rules + a schema guide generated from the inventory ────────────────────────────

function meaning(text) {
  const t = md(text);
  if (!t) return "";
  const first = (/^(.+?[.!?])(\s|$)/.exec(t) || [null, t])[1];
  return first.length > 200 ? first.slice(0, 199).trimEnd() + "…" : first;
}

function columnLine(c, nameOf) {
  let s = `- ${c.field ? `${c.column} — ${md(c.ddName)}` : c.column}`;
  const m = meaning(c.meaning);
  if (m) s += `: ${m}`;
  if (c.type === "DATE") s += " (a FileMan date)";
  if (c.codes && c.codes.length) s += ` Codes: ${c.codes.map(([k, l]) => `${md(k)} = ${md(l)}`).join(", ")}.`;
  if (c.pointsTo) s += c.nameColumn ? ` Pointer to file ${c.pointsTo} — use ${c.nameColumn} for the name.` : ` Pointer to file ${c.pointsTo} (an entry number; there is no name column).`;
  if (nameOf[c.column]) s += ` The name for ${nameOf[c.column]}.`;
  return s;
}

function schemaGuide(inventory) {
  const L = [];
  for (const q of inventory.allowList) {
    const t = inventory.tables[q.replace(/^VISTA\./, "")];
    if (!t) throw new Error(`the inventory has no columns for allow-listed table ${q}`);
    const nameOf = Object.fromEntries(t.columns.filter(c => c.nameColumn).map(c => [c.nameColumn, c.column]));
    L.push("", `### ${q} — FileMan file ${t.file}`);
    for (const c of t.columns) L.push(columnLine(c, nameOf));
  }
  return L.join("\n");
}

function instructions(questions, inventory, rowCap) {
  const eq = (inventory.tables.EQUIPMENT_INV_6914 || { columns: [] }).columns;
  const names = ["EQUIPMENT_CATEGORY", "SERVICE_POINTER", "LOCATION", "VENDOR_POINTER"].map(p => (eq.find(c => c.column === p) || {}).nameColumn).filter(Boolean);
  const quick = questions.map(q => `- \`${method(q.id)}\` — ${md(q.wording)}${q.id === AGING ? ` Its fiscalYear defaults to ${Number(q.params.fiscalYear)}; pass another year only when the user names one.` : ""}`);
  return `# VistA equipment inventory assistant

You answer questions about the equipment inventory in VistA: FileMan file 6914 (EQUIPMENT INV.) and the files it points to. The data is live VistA data that you reach only through your tools.

## Rules — follow every one

1. Answer only from a tool result. Every number, name, date and total in your answer must come from a query you ran for this question: never estimate, never guess, and never fill a gap from general knowledge.
2. When a question matches a quick-access question below, call its tool. For any other question, write one read-only SELECT and call \`RunQuery\`.
3. When a tool returns an error: if it says \"rejected by the read-only guard\" or \"VistA rejected the query\", the query itself was wrong — correct the SQL and call \`RunQuery\` again (twice at most). Any other error means VistA could not be reached: say so plainly and stop — do not retry and do not answer another way.
4. Show names, not pointer entry numbers: select a pointer's name column — ${names.join(", ")} and the others the schema guide names ("use … for the name"). For a coded column, show the code's meaning from the guide.
5. A result holds at most ${rowCap} rows. When \`truncated\` is true, say that only the first ${rowCap} rows are shown and the full list is longer — never present it as complete. Count and total with COUNT(*) and SUM(…) in SQL, not by counting rows.
6. You are read-only: you never change VistA. \`RunQuery\` takes one SELECT statement (no semicolon) over the allow-listed tables of the schema guide, written schema-qualified (e.g. VISTA.EQUIPMENT_INV_6914); anything else is rejected. Write FROM only before table names (no TRIM(… FROM …) or EXTRACT(… FROM …)), join tables explicitly (no ->), use plain unquoted names, and call only these functions: ${FUNCTIONS.join(", ")}.
7. Dates are FileMan dates (YYYMMDD, where YYY is the year minus 1700): compare them as CAST(column AS INTEGER) against (year − 1700) × 10000 + month × 100 + day. The federal fiscal year N runs from October 1 of N − 1 through September 30 of N.
8. Be brief: lead with the count or total, then a markdown table of the rows that matter.

## Quick-access questions

${quick.join("\n")}

## Schema guide (the allow-listed tables)
${schemaGuide(inventory)}`;
}

function agent(model, questions, inventory, rowCap) {
  const text = instructions(questions, inventory, rowCap);
  if (/[{}]/.test(text)) throw new Error("the agent instructions may not contain braces"); // they would end the XData block
  return cls(`${PKG}.Agent`, `/// The equipment inventory chatbot, generated from the AI layer spec. Its Bedrock provider (region and token) is
/// attached at run time by ${PKG}.Chat from ^${PKG}.Config and the ${CREDENTIALS.bedrock} credential.
Class ${PKG}.Agent Extends %AI.Agent
{

Parameter PROVIDER = "bedrock";

Parameter MODEL = ${os(model)};

Parameter TOOLSETS = "${PKG}.Tools";

XData INSTRUCTIONS [ MimeType = text/markdown ]
{
${text}
}

}
`);
}

function chat(questions) {
  const quickCalls = questions.map((q, i) => {
    const name = method(q.id);
    const kw = i === 0 ? "If" : "} ElseIf";
    if (q.id === AGING) {
      const year = Number(q.params.fiscalYear);
      return `    ${kw} tId = "AgingOutFY" {
        Set:fiscalYear="" fiscalYear = ${year}
        Set tJSON = ##class(${PKG}.Tools).AgingOutFY(fiscalYear), tAsked = tAsked_" (fiscal year "_fiscalYear_")"`;
    }
    return `    ${kw} tId = ${os(name)} {
        Set tJSON = ##class(${PKG}.Tools).${name}()`;
  });
  const wordings = questions.map(q => `${os(method(q.id))}: ${os(line(q.wording))}`).join(", ");
  return cls(`${PKG}.Chat`, `/// The chat's entry points. Sessions follow the AI Hub pattern: the %AI.Agent.Session id and its exported context
/// are kept in ^${PKG}.Sessions(sessionId). Both entry points return
/// { reply, tool, sql, columns, rows, rowCount, truncated, error?, sessionId } — the data part is the last tool result.
Class ${PKG}.Chat [ Abstract ]
{

/// What the chat says when Bedrock refuses the token.
Parameter TOKENEXPIRED = ${os(TOKEN_EXPIRED)};

/// A chat turn: the agent answers message in the session, calling its tools.
ClassMethod Reply(sessionId As %String, message As %String) As %DynamicObject
{
    Kill ^||${PKG}.Last
    Set tReply = "", tError = ""
    Try {
        If $zstrip(message, "<>W") = "" {
            Set tError = "the message is empty"
        } Else {
            Set tAgent = ..Agent(), tSession = ..Session(.sessionId, tAgent)
            Set tReply = ..Ask(tAgent, tSession, message)
            Do ..Keep(sessionId, tSession)
        }
    } Catch e {
        Set tError = ..Failure(e)
    }
    Quit ..Result(sessionId, tReply, tError)
}

/// A quick-access question (id with or without "AIQ."): runs its tool directly, then has the agent word that result.
/// fiscalYear applies to AgingOutFY only ("" = the decided year).
ClassMethod Quick(sessionId As %String, id As %String, fiscalYear As %String = "") As %DynamicObject
{
    Kill ^||${PKG}.Last
    Set tId = $select($extract(id, 1, 4) = "AIQ.": $extract(id, 5, *), 1: id)
    Set tAsked = ..Wording(tId)
    If tAsked = "" {
        Return ..Result(sessionId, "", "there is no quick-access question "_id)
    }
${quickCalls.length ? quickCalls.join("\n") + "\n    }" : '    Set tJSON = "{}"'}
    Set tResult = ##class(%DynamicObject).%FromJSON(tJSON)
    If tResult.%IsDefined("error") {
        Return ..Result(sessionId, "VistA could not be reached for this question: "_tResult.error, "")
    }
    Set tReply = "", tError = ""
    Try {
        Set tAgent = ..Agent(), tSession = ..Session(.sessionId, tAgent)
        Set tAsk = "Quick-access question: "_tAsked_$char(10)_"Its tool "_tId_" has already run and its result is below. Word the answer from this result alone; do not call a tool."_$char(10, 10)_tJSON
        Set tReply = ..Ask(tAgent, tSession, tAsk)
        Do ..Keep(sessionId, tSession)
    } Catch e {
        Set tError = ..Failure(e)
    }
    Set ^||${PKG}.Last = tJSON
    Quit ..Result(sessionId, tReply, tError)
}

/// The decided wording of a quick-access question ("" when there is none).
ClassMethod Wording(id As %String) As %String [ CodeMode = expression ]
{
$case(id, ${wordings ? wordings + ", " : ""}: "")
}

/// A ready agent: the Bedrock provider from the bedrockRegion setting and the ${CREDENTIALS.bedrock} token.
ClassMethod Agent() As ${PKG}.Agent
{
    Set tToken = ##class(${PKG}.Config).BedrockToken()
    If tToken = "" {
        $$$ThrowStatus($$$ERROR($$$GeneralError, "no Bedrock token is stored (credential ${CREDENTIALS.bedrock})"))
    }
    Set tRegion = ##class(${PKG}.Config).Get("bedrockRegion")
    If tRegion = "" {
        $$$ThrowStatus($$$ERROR($$$GeneralError, "the Bedrock region is not configured (^${PKG}.Config bedrockRegion)"))
    }
    Set tAgent = ##class(${PKG}.Agent).%New()
    Set tAgent.Provider = ##class(%AI.Provider).Create("bedrock", {"region": (tRegion), "bearer_token": (tToken)})
    $$$ThrowOnError(tAgent.%Init())
    Return tAgent
}

/// The session for pId (a new id when it is empty): the stored one with its context restored, or a new one.
ClassMethod Session(ByRef pId As %String, pAgent As ${PKG}.Agent) As %AI.Agent.Session
{
    Set:$get(pId)="" pId = $system.Util.CreateGUID()
    Set pId = $extract(pId, 1, 200)
    Set tStored = $get(^${PKG}.Sessions(pId))
    If tStored '= "" {
        Set tSession = ##class(%AI.Agent.Session).Load(tStored, pAgent.Provider)
        If $isobject(tSession) {
            // Load alone gives an empty context: restore it from the export
            Set tExport = $get(^${PKG}.Sessions(pId, "export"))
            If tExport '= "" { $$$ThrowOnError(tSession.Import(tExport)) }
            Return tSession
        }
    }
    Set tSession = pAgent.CreateSession({"temperature": 0})
    $$$ThrowOnError(tSession.%Save())
    Set ^${PKG}.Sessions(pId) = tSession.%Id()
    Return tSession
}

/// Saves the session and its exported context.
ClassMethod Keep(pId As %String, pSession As %AI.Agent.Session)
{
    Set tExport = pSession.Export()
    Set:tExport'="" ^${PKG}.Sessions(pId, "export") = tExport
    $$$ThrowOnError(pSession.%Save())
}

/// One agent turn; long sessions are summarized first, keeping the 8 most recent messages.
ClassMethod Ask(pAgent As ${PKG}.Agent, pSession As %AI.Agent.Session, pText As %String) As %String
{
    If pSession.MessageCount() > 20 { Do pSession.Summarize(pAgent.Provider, "", 8) }
    Set tResp = pAgent.Chat(pSession, pText)
    Quit $select($isobject(tResp): tResp.Content, 1: "")
}

/// The error text of a failed turn: the fixed token message when Bedrock refused the login.
ClassMethod Failure(e As %Exception.AbstractException) As %String
{
    Set tText = e.DisplayString()
    Quit $select(..IsAuthFailure(tText): ..#TOKENEXPIRED, 1: tText)
}

ClassMethod IsAuthFailure(pText As %String) As %Boolean
{
    Quit $locate(pText, "(?i)(expired|unauthori[sz]ed|forbidden|authenticat|security token|invalid (bearer|token|api key)|access ?denied|no bedrock token|(http|status|code)\\D{0,4}40[13]\\b)") > 0
}

/// The reply with the last tool result.
ClassMethod Result(sessionId As %String, pReply As %String, pError As %String = "") As %DynamicObject
{
    Set tLast = $get(^||${PKG}.Last)
    If tLast '= "" {
        Set tData = ##class(%DynamicObject).%FromJSON(tLast)
    } Else {
        Set tData = {"tool": "", "sql": "", "columns": [], "rows": [], "rowCount": 0, "truncated": false}
    }
    Set tOut = {"reply": (pReply), "tool": (tData.tool), "sql": (tData.sql), "columns": (tData.columns), "rows": (tData.rows), "rowCount": (tData.rowCount)}
    Do tOut.%Set("truncated", tData.truncated, "boolean")
    Set tError = $select(pError '= "": pError, 1: tData.%Get("error"))
    Do:tError'="" tOut.%Set("error", tError)
    Do:$get(sessionId)'="" tOut.%Set("sessionId", sessionId)
    Quit tOut
}

}
`);
}

function dispatch() {
  return cls(`${PKG}.REST.Dispatch`, `/// The chat's web front door (${WEB_APP}): POST /chat { sessionId, message }, POST /quick/:id { sessionId, fiscalYear },
/// and POST /guard { sql } → { ok, reason } (the build's verification uses it).
Class ${PKG}.REST.Dispatch Extends %CSP.REST
{

Parameter CONTENTTYPE = "application/json";

Parameter CHARSET = "utf-8";

/// What the chat says when Bedrock refuses the token.
Parameter TOKENEXPIRED = ${os(TOKEN_EXPIRED)};

XData UrlMap [ XMLNamespace = "http://www.intersystems.com/urlmap" ]
{
<Routes>
  <Route Url="/chat" Method="POST" Call="Chat" />
  <Route Url="/quick/:id" Method="POST" Call="Quick" />
  <Route Url="/guard" Method="POST" Call="Guard" />
</Routes>
}

ClassMethod Chat() As %Status
{
    Try {
        Set tIn = ..Body()
        Set tOut = ##class(${PKG}.Chat).Reply(tIn.%Get("sessionId"), tIn.%Get("message"))
    } Catch e {
        Set tOut = ..Failed(e)
    }
    Write tOut.%ToJSON()
    Quit $$$OK
}

ClassMethod Quick(id As %String) As %Status
{
    Try {
        Set tIn = ..Body()
        Set tOut = ##class(${PKG}.Chat).Quick(tIn.%Get("sessionId"), id, tIn.%Get("fiscalYear"))
    } Catch e {
        Set tOut = ..Failed(e)
    }
    Write tOut.%ToJSON()
    Quit $$$OK
}

ClassMethod Guard() As %Status
{
    Try {
        Set tWhy = ##class(${PKG}.Guard).Check(..Body().%Get("sql"))
        Set tOut = {"ok": false, "reason": (tWhy)}
        Do tOut.%Set("ok", tWhy = "", "boolean")
    } Catch e {
        Set %response.Status = "400 Bad Request"
        Set tOut = {"ok": false, "reason": ("the request body is not JSON: "_e.DisplayString())}
    }
    Write tOut.%ToJSON()
    Quit $$$OK
}

/// The request's JSON body ({} when there is none).
ClassMethod Body() As %DynamicObject
{
    If '$isobject(%request.Content) || (%request.Content.Size = 0) {
        Return {}
    }
    Return ##class(%DynamicObject).%FromJSON(%request.Content)
}

/// An unexpected failure in the chat's result shape; a refused Bedrock login reads as the fixed token message.
ClassMethod Failed(e As %Exception.AbstractException) As %DynamicObject
{
    Set tText = e.DisplayString()
    Set:##class(${PKG}.Chat).IsAuthFailure(tText) tText = ..#TOKENEXPIRED
    Quit {"reply": "", "tool": "", "sql": "", "columns": [], "rows": [], "rowCount": 0, "truncated": false, "error": (tText)}
}

}
`);
}

// Classes in compile order: settings, the VADEMO client, the guard, the tools, the agent, the chat, the web front door.
// ai: the AI layer spec (or its detail); inventory: inventory-fields.json; model: the Bedrock model id.
function aiClasses({ ai, inventory, model }) {
  if (!model) throw new Error("no Bedrock model id was given for the AI layer");
  if (!inventory) throw new Error("the inventory (inventory-fields.json) is required for the AI layer");
  if (ai && ai.complete === false) throw new Error("the AI layer spec is not complete — finish its missing items in the Decide chat first");
  const d = (ai && ai.detail) || ai;
  if (!d || !Array.isArray(d.questions) || d.questions.some(q => !q.sql)) throw new Error("the AI layer spec is not complete — a kept question has no SQL");
  const rowCap = Number(d.general && d.general.rowCap) || 200;
  return [config(), vademo(), guard(inventory.allowList, rowCap), tools(d.questions, rowCap, inventory), agent(model, d.questions, inventory, rowCap), chat(d.questions), dispatch()];
}

// The guard's regression suite: every case must come back from EquipmentAI.Guard.Check (POST /guard) as `allowed`.
// The AI build replays this list live. kind groups the cases by the bypass they try.
const E = "VISTA.EQUIPMENT_INV_6914", S = "VISTA.ENG_SPACE6928", C = "VISTA.EQUIPMENT_CATEGORY6911";
const GUARD_CASES = [
  // plain reads and case
  { kind: "plain", allowed: true, sql: `SELECT IEN FROM ${E}` },
  { kind: "plain", allowed: true, sql: `SELECT COUNT(*) AS n FROM ${E}` },
  { kind: "plain", allowed: true, sql: "SELECT 1" },
  { kind: "plain", allowed: true, sql: `SELECT TOP 5 IEN FROM ${E}\nORDER BY IEN DESC` },
  { kind: "plain", allowed: true, sql: `SELECT IEN FROM ${E}\tWHERE\tIEN=1` },
  { kind: "plain", allowed: true, sql: `SELECT IEN FROM ${E} WHERE IEN > .5 AND IEN < 5.` },
  { kind: "plain", allowed: true, sql: `SELECT SERVICE_POINTER_NAME, COUNT(*) FROM ${E} GROUP BY SERVICE_POINTER_NAME, USE_STATUS ORDER BY 2 DESC` },
  { kind: "plain", allowed: false, sql: "" },
  { kind: "plain", allowed: false, sql: "SELECT IEN FROM" },
  { kind: "case", allowed: true, sql: "select ien from vista.equipment_inv_6914 where use_status = '1'" },
  { kind: "case", allowed: false, sql: "sElEcT IEN FROM VISTA.EQUIPMENT_INV_6914 wHeRe 1=1 uNiOn select ID from security.users" },
  { kind: "case", allowed: false, sql: `select ien from ${E}; dElEtE from ${E}` },
  // statements and forbidden words
  { kind: "statement", allowed: false, sql: `DELETE FROM ${E}` },
  { kind: "statement", allowed: false, sql: `SELECT IEN FROM ${E}; DELETE FROM ${E}` },
  { kind: "statement", allowed: false, sql: `SELECT IEN FROM ${E};` },
  { kind: "statement", allowed: false, sql: `UPDATE ${E} SET USE_STATUS = '4'` },
  { kind: "statement", allowed: false, sql: "CALL VISTA.SomeProc()" },
  { kind: "statement", allowed: false, sql: `DEL/**/ETE FROM ${E}` },
  { kind: "statement", allowed: false, sql: `SELECT 1 FROM ${E}; DEL/**/ETE FROM ${E}` },
  { kind: "forbidden-word", allowed: false, sql: `SELECT IEN FROM ${E} WHERE MFGR__EQUIPMENT_NAME = 'please delete'` },
  { kind: "forbidden-word", allowed: false, sql: `SELECT IEN FROM ${E} WHERE %INSERT = 1` },
  { kind: "into", allowed: false, sql: `SELECT IEN INTO :x FROM ${E}` },
  { kind: "into", allowed: false, sql: `SELECT IEN INTO VISTA.COPY FROM ${E}` },
  // comments
  { kind: "comment", allowed: true, sql: `/* leading comment */ SELECT IEN FROM ${E} -- trailing` },
  { kind: "comment", allowed: true, sql: `SELECT IEN FROM ${E} WHERE MFGR__EQUIPMENT_NAME = 'a' -- ' ; DELETE FROM ${E}` },
  { kind: "comment", allowed: false, sql: `SELECT IEN FROM ${E} /* ; */ ; DROP TABLE X` },
  { kind: "comment", allowed: false, sql: `SELECT IEN FROM ${E} -- \n; DELETE FROM ${E}` },
  { kind: "comment", allowed: false, sql: `SELECT IEN FROM ${E} /* unterminated` },
  { kind: "comment", allowed: false, sql: `SELECT IEN FROM ${E} // ; DELETE` },
  { kind: "comment", allowed: false, sql: `SELECT IEN FROM ${E} */` },
  { kind: "comment", allowed: false, sql: `SELECT IEN FROM ${E} /**/, VISTA.NEW_PERSON200` },
  // string-literal tricks
  { kind: "string-literal", allowed: true, sql: `SELECT IEN FROM ${E} WHERE MFGR__EQUIPMENT_NAME = 'a;b -- c /* d'` },
  { kind: "string-literal", allowed: true, sql: `SELECT IEN FROM ${E} WHERE MFGR__EQUIPMENT_NAME = 'it''s'` },
  { kind: "string-literal", allowed: true, sql: `SELECT IEN FROM ${E} WHERE MFGR__EQUIPMENT_NAME = '/*' AND MODEL = '*/'` },
  { kind: "string-literal", allowed: true, sql: `SELECT IEN FROM ${E} WHERE MFGR__EQUIPMENT_NAME LIKE '%BED%' ORDER BY IEN, MFGR__EQUIPMENT_NAME` },
  { kind: "string-literal", allowed: false, sql: `SELECT IEN FROM ${E} WHERE MFGR__EQUIPMENT_NAME = 'open` },
  { kind: "string-literal", allowed: false, sql: `SELECT IEN FROM ${E} WHERE MFGR__EQUIPMENT_NAME = 'it''s' AND MODEL = 'a''; DELETE'` },
  { kind: "string-literal", allowed: false, sql: `SELECT IEN FROM ${E} WHERE MFGR__EQUIPMENT_NAME = '' ; SELECT 1` },
  { kind: "string-literal", allowed: false, sql: `SELECT IEN FROM ${E} WHERE MFGR__EQUIPMENT_NAME = '--' ; DROP TABLE X` },
  { kind: "string-literal", allowed: false, sql: `SELECT IEN FROM ${E} WHERE MFGR__EQUIPMENT_NAME = 'x''' UNION SELECT IEN FROM VISTA.NEW_PERSON200` },
  { kind: "string-literal", allowed: false, sql: `SELECT IEN FROM ${E} WHERE MFGR__EQUIPMENT_NAME = 'x\\' UNION SELECT IEN FROM VISTA.NEW_PERSON200 --'` },
  // comma-separated FROM lists, with and without aliases
  { kind: "comma-list", allowed: true, sql: `SELECT e.IEN FROM ${E} AS e, ${S} s WHERE s.IEN = e.LOCATION` },
  { kind: "comma-list", allowed: true, sql: `SELECT e.IEN FROM ${E} e, ${S} s, ${C} c WHERE s.IEN = e.LOCATION AND c.IEN = e.EQUIPMENT_CATEGORY` },
  { kind: "comma-list", allowed: false, sql: `SELECT IEN FROM ${E}, %Dictionary.ClassDefinition` },
  { kind: "comma-list", allowed: false, sql: `SELECT IEN FROM ${E} e, ${S} s, Security.Users u` },
  { kind: "comma-list", allowed: false, sql: `SELECT IEN FROM ${E} x %INORDER, %Dictionary.ClassDefinition` },
  { kind: "comma-list", allowed: false, sql: `SELECT IEN FROM ${E} LEFT, %Dictionary.ClassDefinition` },
  { kind: "comma-list", allowed: false, sql: `SELECT n.* FROM ${E} AS e, VISTA.NEW_PERSON200 n` },
  { kind: "comma-list", allowed: false, sql: `SELECT IEN FROM ${E},` },
  // JOIN variants
  { kind: "join", allowed: true, sql: `SELECT e.IEN, c.NAME FROM ${E} e JOIN ${C} c ON c.IEN = e.EQUIPMENT_CATEGORY` },
  { kind: "join", allowed: true, sql: `SELECT a FROM ${E} e LEFT JOIN ${S} s ON s.IEN = e.LOCATION` },
  { kind: "join", allowed: true, sql: `SELECT a FROM ${E} e LEFT OUTER JOIN ${S} s ON (s.IEN = e.LOCATION AND s.IEN IN (1, 2)) INNER JOIN ${C} c ON c.IEN = e.EQUIPMENT_CATEGORY WHERE e.IEN > 0` },
  { kind: "join", allowed: true, sql: `SELECT e.IEN FROM (${E} e JOIN ${S} s ON s.IEN = e.LOCATION)` },
  { kind: "join", allowed: false, sql: `SELECT e.IEN FROM ${E} e JOIN VISTA.NEW_PERSON200 p ON p.IEN = e.ENTERED_BY` },
  { kind: "join", allowed: false, sql: `SELECT e.IEN FROM ${E} e LEFT OUTER JOIN VISTA.WORK_ORDER_6920 w ON w.EQUIPMENT_ID = e.IEN` },
  { kind: "join", allowed: false, sql: `SELECT * FROM ${E} a JOIN ${E} b ON a.ID = b.ID, VISTA.NEW_PERSON200 n` },
  { kind: "join", allowed: false, sql: `SELECT * FROM ${E} a JOIN ${S} b USING (IEN), VISTA.NEW_PERSON200 n` },
  { kind: "join", allowed: false, sql: `SELECT IEN FROM (%Dictionary.ClassDefinition c JOIN ${E} e ON 1=1)` },
  { kind: "join", allowed: false, sql: `SELECT IEN FROM (${E} e, VISTA.NEW_PERSON200 n)` },
  { kind: "join", allowed: false, sql: `SELECT IEN FROM ${E} e CROSS JOIN Security.Users u` },
  // subqueries in FROM, WHERE and the select list
  { kind: "subquery-from", allowed: true, sql: `SELECT x.n FROM (SELECT COUNT(*) AS n FROM ${E}) x` },
  { kind: "subquery-from", allowed: true, sql: `SELECT x.n FROM (SELECT COUNT(*) AS n FROM ${E}) x, ${S} s` },
  { kind: "subquery-from", allowed: false, sql: `SELECT * FROM (SELECT Name FROM %Dictionary.ClassDefinition) x` },
  { kind: "subquery-from", allowed: false, sql: `SELECT * FROM (SELECT IEN FROM ${E}) s, VISTA.NEW_PERSON200` },
  { kind: "subquery-where", allowed: true, sql: `SELECT IEN FROM ${E} WHERE IEN IN (SELECT EQUIPMENT_ID FROM VISTA.CMR6914_1)` },
  { kind: "subquery-where", allowed: false, sql: `SELECT IEN FROM ${E} WHERE IEN IN (SELECT ID FROM %Dictionary.ClassDefinition)` },
  { kind: "subquery-where", allowed: false, sql: `SELECT IEN FROM ${E} WHERE EXISTS (SELECT 1 FROM ${S} s JOIN Security.Users u ON 1=1)` },
  { kind: "subquery-where", allowed: false, sql: `SELECT IEN FROM ${E} WHERE IEN IN (SELECT IEN FROM ${S} s, VISTA.NEW_PERSON200 n)` },
  { kind: "subquery-select", allowed: true, sql: `SELECT (SELECT COUNT(*) FROM ${S}) AS rooms, IEN FROM ${E}` },
  { kind: "subquery-select", allowed: false, sql: `SELECT (SELECT COUNT(*) FROM VISTA.NEW_PERSON200) AS people, IEN FROM ${E}` },
  { kind: "subquery-select", allowed: false, sql: `SELECT (SELECT MAX(Name) FROM %Dictionary.ClassDefinition), IEN FROM ${E}` },
  // UNION and friends
  { kind: "union", allowed: true, sql: `SELECT IEN FROM ${E} UNION SELECT IEN FROM ${S}` },
  { kind: "union", allowed: false, sql: `SELECT IEN FROM ${E} UNION SELECT Name FROM %Dictionary.ClassDefinition` },
  { kind: "union", allowed: false, sql: `SELECT IEN FROM ${E} UNION ALL SELECT IEN FROM VISTA.NEW_PERSON200` },
  { kind: "union", allowed: false, sql: `SELECT IEN FROM ${E} EXCEPT SELECT IEN FROM VISTA.WORK_ORDER_6920` },
  // names: schema-less, quoted, dotted, implicit joins
  { kind: "schema-less", allowed: false, sql: "SELECT IEN FROM EQUIPMENT_INV_6914" },
  { kind: "schema-less", allowed: false, sql: `SELECT IEN FROM ${E} e JOIN ENG_SPACE6928 s ON 1=1` },
  { kind: "quoted", allowed: false, sql: 'SELECT IEN FROM "VISTA"."EQUIPMENT_INV_6914"' },
  { kind: "quoted", allowed: false, sql: `SELECT n.* FROM ${E} "e", VISTA.NEW_PERSON200 n` },
  { kind: "quoted", allowed: false, sql: `SELECT n.* FROM ${E} AS "e", VISTA.NEW_PERSON200 n` },
  { kind: "quoted", allowed: false, sql: `SELECT * FROM (SELECT IEN FROM ${E}) "s", VISTA.NEW_PERSON200` },
  { kind: "quoted", allowed: false, sql: `SELECT * FROM (${E} "e", VISTA.NEW_PERSON200)` },
  { kind: "quoted", allowed: false, sql: `SELECT IEN AS "Equipment" FROM ${E}` },
  { kind: "dots", allowed: false, sql: `SELECT IEN FROM VISTA . EQUIPMENT_INV_6914` },
  { kind: "dots", allowed: false, sql: `SELECT IEN FROM ${E} . X` },
  { kind: "implicit-join", allowed: false, sql: `SELECT ENTERED_BY->SSN FROM ${E}` },
  // function and procedure calls
  { kind: "function", allowed: true, sql: `SELECT SUM(TOTAL_ASSET_VALUE), MAX(CAST(REPLACEMENT_DATE AS INTEGER)), COALESCE(MIN(IEN), 0) FROM ${E}` },
  { kind: "function", allowed: true, sql: `SELECT UPPER(LEFT(MFGR__EQUIPMENT_NAME, 3)), CAST(IEN AS VARCHAR(20)), $PIECE(MODEL, '-', 1), %EXACT(MODEL) FROM ${E} WHERE IEN IN (1, 2) AND NOT EXISTS (SELECT 1 FROM ${S})` },
  { kind: "function", allowed: true, sql: `SELECT DISTINCT TOP 10 YEAR(CURRENT_DATE), ROUND(AVG(TOTAL_ASSET_VALUE), 2) FROM ${E}` },
  { kind: "function", allowed: false, sql: `SELECT SomeProc() FROM ${E}` },
  { kind: "function", allowed: false, sql: `SELECT IEN FROM ${E} WHERE IEN = MyFunc (IEN)` },
  { kind: "function", allowed: false, sql: `SELECT %SYSTEM.SQL.Functions_Foo(1) FROM ${E}` },
  { kind: "function", allowed: false, sql: `SELECT VISTA.Proc(1) FROM ${E}` },
  { kind: "function", allowed: false, sql: `SELECT IEN FROM ${E} WHERE IEN = %SYSTEM_SQL.Foo()` },
  { kind: "function", allowed: false, sql: `SELECT $SYSTEM(1) FROM ${E}` },
  // CTEs
  { kind: "cte", allowed: false, sql: `WITH x AS (SELECT 1 FROM ${E}) SELECT * FROM x` },
  { kind: "cte", allowed: false, sql: `WITH x AS (SELECT IEN FROM ${E}) SELECT IEN FROM ${E}` },
];

module.exports = { PKG, WEB_APP, CREDENTIALS, CONFIG_KEYS, TOKEN_EXPIRED, GUARD_CASES, aiClasses, agingSqlTemplate, fillFiscalYear };
