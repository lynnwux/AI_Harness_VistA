"use strict";
// Generates the IRIS Interoperability production from the orchestrator layer spec (stub-first), following
// the interclaw skill's package convention: <Pkg>.Msg.* · <Pkg>.BS.* · <Pkg>.BPL.* · <Pkg>.BO.* · <Pkg>.Production.
// Real operations are dry-run until enabled; stubs are registered and never called. No hosts or credentials
// are generated — those are Management Portal settings.

const PKG = "EquipmentEntry";
const FRONT_DOOR = "EquipmentEntry Front Door", ORCHESTRATOR = "Register Equipment Orchestrator";
const VISTA_WRITE = "VistA Equipment Write", BULLETIN = "New Equipment Bulletin";
const WEB_APP = "/equipmententry";

const os = s => '"' + String(s == null ? "" : s).replace(/"/g, '""') + '"';                  // ObjectScript string literal
const xml = s => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const cls = (name, text) => ({ name: `${name}.cls`, text });

function message(name, base, doc, props) {
  return cls(`${PKG}.Msg.${name}`, [`Class ${PKG}.Msg.${name} Extends ${base}`, "{", "", `/// ${doc}`, "", ...props.map(p => `Property ${p};\n`), "}", ""].join("\n"));
}

function messages() {
  return [
    message("RegisterRequest", "Ens.Request", "The 6914 create request exactly as the Angular app posts it (see the API spec), carried as its JSON body.", ["Payload As %String(MAXLEN = \"\")"]),
    message("RegisterResponse", "Ens.Response", "Outcome of the register: the VistA write status, the new entry number, and a per-side-effect outcome (JSON).", ["Status As %String", "EquipmentIEN As %String", "Outcomes As %String(MAXLEN = \"\")"]),
    message("BulletinRequest", "Ens.Request", "What the new-equipment bulletin needs: the entry number, the write status and the create request.", ["EquipmentIEN As %String", "WriteStatus As %String", "Payload As %String(MAXLEN = \"\")"]),
    message("BulletinResponse", "Ens.Response", "The composed bulletin and what happened to it (sent | dry-run | failed).", ["Outcome As %String", "Recipients As %String(MAXLEN = \"\")", "Subject As %String(MAXLEN = \"\")", "Body As %String(MAXLEN = \"\")"]),
    message("StubRequest", "Ens.Request", "Request for a stub operation — registered in the production, not wired, so nothing sends it yet.", ["Payload As %String(MAXLEN = \"\")"]),
  ];
}

function service() {
  return cls(`${PKG}.BS.RegisterService`, `Include Ensemble

Class ${PKG}.BS.RegisterService Extends Ens.BusinessService
{

/// Front door: the REST dispatch (${WEB_APP}) hands each 6914 create request here, and it goes to the orchestrator.
Parameter ADAPTER;

Property TargetConfigName As Ens.DataType.ConfigName [ InitialExpression = ${os(ORCHESTRATOR)} ];

Parameter SETTINGS = "TargetConfigName:Basic";

Method OnProcessInput(pInput As %RegisteredObject, Output pOutput As %RegisteredObject) As %Status
{
    Quit ..SendRequestSync(..TargetConfigName, pInput, .pOutput)
}

}
`);
}

function vistaWrite() {
  return cls(`${PKG}.BO.VistAEquipmentWriteOperation`, `Include Ensemble

Class ${PKG}.BO.VistAEquipmentWriteOperation Extends Ens.BusinessOperation
{

/// Files the 6914 create through the Harness REST service on VistA (the API layer's POST /equipment).
/// Dry-run (the default) logs the request and files nothing. Server, URL and credentials are portal settings.
Parameter ADAPTER = "EnsLib.HTTP.OutboundAdapter";

Property Adapter As EnsLib.HTTP.OutboundAdapter;

Parameter INVOCATION = "Queue";

Property DryRun As %Boolean [ InitialExpression = 1 ];

Parameter SETTINGS = "DryRun:Basic";

Method Write(pRequest As ${PKG}.Msg.RegisterRequest, Output pResponse As ${PKG}.Msg.RegisterResponse) As %Status
{
    Set pResponse = ##class(${PKG}.Msg.RegisterResponse).%New()
    If ..DryRun {
        $$$LOGINFO("dry-run: the 6914 create request was not sent to VistA")
        Set pResponse.Status = "DRY-RUN", pResponse.EquipmentIEN = ""
        Quit $$$OK
    }
    Set tHttp = ##class(%Net.HttpRequest).%New()
    Set tHttp.ContentType = "application/json"
    Do tHttp.EntityBody.Write(pRequest.Payload)
    Set tSC = ..Adapter.SendFormDataArray(.tResp, "POST", tHttp)
    Quit:$$$ISERR(tSC) tSC
    Set tOut = ##class(%DynamicObject).%FromJSON(tResp.Data)
    Set pResponse.Status = tOut.%Get("status"), pResponse.EquipmentIEN = tOut.%Get("equipmentIEN")
    Quit $$$OK
}

XData MessageMap
{
<MapItems>
  <MapItem MessageType="${PKG}.Msg.RegisterRequest">
    <Method>Write</Method>
  </MapItem>
</MapItems>
}

}
`);
}

// The bulletin's |n| placeholders, filled from the form's own keys (the API spec's field → key map).
function placeholderCode(t, keyOf, faIsReal) {
  const get = f => (keyOf[f] ? `tIn.%Get(${os(keyOf[f])})` : '""');
  const L = [];
  for (const p of t.params) {
    if (p.source === "ien") L.push(`    Set p(${p.n}) = $select(pRequest.EquipmentIEN'="":pRequest.EquipmentIEN, 1:"(not filed: dry-run)")`);
    else if (p.source === "operatorIdentity") L.push(`    Set p(${p.n}) = $username  // no clerk identity reaches the production yet: this names the service account`);
    else if (p.field) L.push(`    Set p(${p.n}) = ${get(p.field)}${p.pointer ? "  // the pointer's IEN: no name lookup is wired yet" : ""}`);
    else if (p.capitalizedNX) {
      if (faIsReal) throw new Error("the FA document is a real operation, but the bulletin cannot report its outcome in this build");
      L.push(`    Set tCap = ${p.capitalizedNX.map(c => `(${get(c.field)}=${os(c.equals)})`).join("&&")}`);
      L.push(`    Set p(${p.n}) = $select(tCap:${os(p.text.capitalized)}, 1:${os(p.text.notCapitalized)})`);
      L.push(`    If tCap Set p(${p.n}) = p(${p.n})_" "_${os(p.text.notReported)}  // the FA document is a stub in this build`);
    } else L.push(`    Set p(${p.n}) = ""`);
    if (p.ifBlank) L.push(`    If p(${p.n})="" Set p(${p.n}) = ${os(p.ifBlank)}`);
  }
  return L.join("\n");
}

function bulletin(entry, keyOf, faIsReal) {
  const t = entry.template;
  return cls(`${PKG}.BO.NewEquipmentBulletinOperation`, `Include Ensemble

Class ${PKG}.BO.NewEquipmentBulletinOperation Extends Ens.BusinessOperation
{

/// The mandatory new-equipment bulletin (legacy BULL^ENEQ3, BULLETIN ${t.source}), sent as an email.
/// Dry-run (the default) composes and logs the email without sending it. Mail server and login are portal settings.
Parameter ADAPTER = "EnsLib.EMail.OutboundAdapter";

Property Adapter As EnsLib.EMail.OutboundAdapter;

Parameter INVOCATION = "Queue";

/// Who receives it: comma- or semicolon-separated addresses (recorded in the Decide chat).
Property Recipients As %String(MAXLEN = "");

Property DryRun As %Boolean [ InitialExpression = 1 ];

Parameter SETTINGS = "Recipients:Basic,DryRun:Basic";

Method Send(pRequest As ${PKG}.Msg.BulletinRequest, Output pResponse As ${PKG}.Msg.BulletinResponse) As %Status
{
    Set pResponse = ##class(${PKG}.Msg.BulletinResponse).%New()
    Set tIn = ##class(%DynamicObject).%FromJSON($select(pRequest.Payload="":"{}", 1:pRequest.Payload))
${placeholderCode(t, keyOf, faIsReal)}
    Set tSubject = ..Fill(${os(t.subject)}, .p)
    Set tLines = $listbuild(${t.body.map(os).join(", ")})
    Set tBody = ""
    For i=1:1:$listlength(tLines) { Set tBody = tBody_..Fill($list(tLines, i), .p)_$char(13,10) }
    Set pResponse.Subject = tSubject, pResponse.Body = tBody, pResponse.Recipients = ..Recipients
    If ..DryRun {
        $$$LOGINFO("dry-run bulletin to "_..Recipients_": "_tSubject)
        $$$LOGINFO(tBody)
        Set pResponse.Outcome = "dry-run"
        Quit $$$OK
    }
    Set tMail = ##class(%Net.MailMessage).%New()
    Set tMail.Subject = tSubject, tMail.From = ..Adapter.From
    Set tTo = $translate(..Recipients, ";", ",")
    For i=1:1:$length(tTo, ",") { Set r = $zstrip($piece(tTo, ",", i), "<>W") Do:r'="" tMail.To.Insert(r) }
    Do tMail.TextData.Write(tBody)
    Set tSC = ..Adapter.SendMail(tMail, .tFailed)
    Set pResponse.Outcome = $select($$$ISOK(tSC):"sent", 1:"failed")
    Quit tSC
}

ClassMethod Fill(pText As %String, ByRef p) As %String
{
    Set tOut = pText
    For n=1:1:${t.params.length} { Set tOut = $replace(tOut, "|"_n_"|", $get(p(n))) }
    Quit tOut
}

XData MessageMap
{
<MapItems>
  <MapItem MessageType="${PKG}.Msg.BulletinRequest">
    <Method>Send</Method>
  </MapItem>
</MapItems>
}

}
`);
}

function stubOperation() {
  return cls(`${PKG}.BO.StubOperation`, `Include Ensemble

Class ${PKG}.BO.StubOperation Extends Ens.BusinessOperation
{

/// A side effect registered in the production but not wired: nothing sends it a request yet.
/// Its Decision setting carries what it will implement once wired (see the orchestrator spec's stub list).
Parameter INVOCATION = "Queue";

Property Decision As %String(MAXLEN = "");

Parameter SETTINGS = "Decision:Basic";

Method Handle(pRequest As ${PKG}.Msg.StubRequest, Output pResponse As Ens.StringResponse) As %Status
{
    $$$LOGWARNING("stub - not wired: "_..Decision)
    Set pResponse = ##class(Ens.StringResponse).%New("stub - not wired")
    Quit $$$OK
}

XData MessageMap
{
<MapItems>
  <MapItem MessageType="${PKG}.Msg.StubRequest">
    <Method>Handle</Method>
  </MapItem>
</MapItems>
}

}
`);
}

function process(stubs) {
  const stubLines = stubs.map(e => ` do s.%Set(${os(e.name)}, "stub - not wired")`).join("\n");
  return cls(`${PKG}.BPL.RegisterProcess`, `Include Ensemble

Class ${PKG}.BPL.RegisterProcess Extends Ens.BusinessProcessBPL
{

/// Register equipment: file the 6914 entry in VistA, then send the mandatory new-equipment bulletin.
/// Stub operations are registered in the production and never called from here.

XData BPL [ XMLNamespace = "http://www.intersystems.com/bpl" ]
{
<process language='objectscript' request='${PKG}.Msg.RegisterRequest' response='${PKG}.Msg.RegisterResponse'>
<context>
  <property name='EquipmentIEN' type='%String' />
  <property name='WriteStatus' type='%String' />
  <property name='BulletinOutcome' type='%String' />
</context>
<sequence>
  <call name='Write to VistA' target='${VISTA_WRITE}' async='0'>
    <request type='${PKG}.Msg.RegisterRequest'>
      <assign property='callrequest.Payload' value='request.Payload' action='set' />
    </request>
    <response type='${PKG}.Msg.RegisterResponse'>
      <assign property='context.EquipmentIEN' value='callresponse.EquipmentIEN' action='set' />
      <assign property='context.WriteStatus' value='callresponse.Status' action='set' />
    </response>
  </call>
  <if name='Filed?' condition='(context.WriteStatus="OK")||(context.WriteStatus="DRY-RUN")'>
    <true>
      <call name='Send the new-equipment bulletin' target='${BULLETIN}' async='0'>
        <request type='${PKG}.Msg.BulletinRequest'>
          <assign property='callrequest.EquipmentIEN' value='context.EquipmentIEN' action='set' />
          <assign property='callrequest.WriteStatus' value='context.WriteStatus' action='set' />
          <assign property='callrequest.Payload' value='request.Payload' action='set' />
        </request>
        <response type='${PKG}.Msg.BulletinResponse'>
          <assign property='context.BulletinOutcome' value='callresponse.Outcome' action='set' />
        </response>
      </call>
    </true>
    <false>
      <assign property='context.BulletinOutcome' value='"skipped: the VistA write did not succeed"' action='set' />
    </false>
  </if>
  <code name='Outcomes'>
<![CDATA[
 set o={}
 set o.vistaWrite=context.WriteStatus
 set o.bulletin=context.BulletinOutcome
 set s={}
${stubLines}
 set o.stubs=s
 set response.Status=context.WriteStatus
 set response.EquipmentIEN=context.EquipmentIEN
 set response.Outcomes=o.%ToJSON()
]]>
  </code>
</sequence>
</process>
}

}
`);
}

function dispatch() {
  return cls(`${PKG}.REST.Dispatch`, `Class ${PKG}.REST.Dispatch Extends %CSP.REST
{

/// The production's front door on the web (${WEB_APP}): POST /equipment takes the 6914 create request as JSON.
Parameter CONTENTTYPE = "application/json";

XData UrlMap [ XMLNamespace = "http://www.intersystems.com/urlmap" ]
{
<Routes>
  <Route Url="/equipment" Method="POST" Call="Register" />
</Routes>
}

ClassMethod Register() As %Status
{
    Set tReq = ##class(${PKG}.Msg.RegisterRequest).%New()
    Set tReq.Payload = $select($isobject(%request.Content):%request.Content.Read(3641144), 1:"{}")
    Set tSC = ##class(Ens.Director).CreateBusinessService(${os(FRONT_DOOR)}, .tService)
    If $$$ISOK(tSC) Set tSC = tService.ProcessInput(tReq, .tResp)
    If $$$ISERR(tSC) {
        Set %response.Status = "500 Internal Server Error"
        Write {"status":"ERROR","error":($system.Status.GetErrorText(tSC))}.%ToJSON()
        Quit $$$OK
    }
    Set tOut = {"status":(tResp.Status),"equipmentIEN":(tResp.EquipmentIEN)}
    Set tOut.outcomes = ##class(%DynamicObject).%FromJSON($select(tResp.Outcomes="":"{}", 1:tResp.Outcomes))
    Write tOut.%ToJSON()
    Quit $$$OK
}

}
`);
}

function production(entry, stubs, bulletinLive) {
  const item = (name, category, className, poolSize, comment, settings = []) =>
    `  <Item Name="${xml(name)}" Category="${xml(category)}" ClassName="${className}" PoolSize="${poolSize}" Enabled="true" Foreground="false" Comment="${xml(comment)}" LogTraceEvents="false" Schedule="">\n`
    + settings.map(([k, v]) => `    <Setting Target="Host" Name="${k}">${xml(v)}</Setting>\n`).join("")
    + "  </Item>";
  const decision = e => (e.decision ? `${e.decision.mode}: ${e.decision.policy}` : `deferred — ${e.reason}`);
  const items = [
    item(FRONT_DOOR, "Front door", `${PKG}.BS.RegisterService`, 0, `POST ${WEB_APP}/equipment — the 6914 create request`, [["TargetConfigName", ORCHESTRATOR]]),
    item(ORCHESTRATOR, "Orchestrator", `${PKG}.BPL.RegisterProcess`, 1, "file the entry in VistA, then send the bulletin"),
    item(VISTA_WRITE, "Real operation", `${PKG}.BO.VistAEquipmentWriteOperation`, 1, "the 6914 create through the Harness REST service on VistA — dry-run until enabled", [["DryRun", "1"]]),
    item(BULLETIN, "Real operation", `${PKG}.BO.NewEquipmentBulletinOperation`, 1, `${entry.name} — mandatory; email from the legacy template — ${bulletinLive ? "sends through the deployment's mail server" : "dry-run until a mail server is configured"}`, [["Recipients", entry.target.recipients], ["DryRun", bulletinLive ? "0" : "1"]]),
    ...stubs.map(e => item(`${e.name} (stub)`, "Stub — not wired", `${PKG}.BO.StubOperation`, 1, `${e.name} — registered, not wired`, [["Decision", decision(e)]])),
  ];
  return cls(`${PKG}.Production`, `Class ${PKG}.Production Extends Ens.Production
{

XData ProductionDefinition [ XMLNamespace = "http://www.intersystems.com/production" ]
{
<Production Name="${PKG}.Production" LogGeneralTraceEvents="false">
  <Description>RegisterEquipment — generated from the orchestrator layer spec (stub-first). Real operations are dry-run until enabled; stubs are registered and not wired.</Description>
  <ActorPoolSize>1</ActorPoolSize>
${items.join("\n")}
</Production>
}

}
`);
}

// Classes in compile-friendly order: messages, hosts, the process, the web front door, the production.
// bulletinLive: the deployment has a mail server, so the bulletin sends (its server and login are IRIS settings).
function productionClasses({ orchestrator, api }, { bulletinLive = false } = {}) {
  if (!orchestrator.complete) throw new Error("the orchestrator spec is not complete — finish its missing items in the Decide chat first");
  const d = orchestrator.detail;
  const entry = d.built.find(e => e.id === "SIDE.Bulletin");
  if (!entry || !entry.template) throw new Error("the spec has no bulletin with a message template");
  const keyOf = Object.fromEntries(api.detail.pages.flatMap(p => p.fields).map(f => [String(f.fno), f.k]));
  const faIsReal = d.built.some(e => e.id === "SIDE.FinancialAsset");
  return [...messages(), service(), vistaWrite(), bulletin(entry, keyOf, faIsReal), stubOperation(), process(d.stubs), dispatch(), production(entry, d.stubs, bulletinLive)];
}

module.exports = { PKG, WEB_APP, FRONT_DOOR, BULLETIN, productionClasses };
