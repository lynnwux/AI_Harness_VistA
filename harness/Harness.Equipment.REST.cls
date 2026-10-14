/// Harness REST data service for file 6914 (Engineering Equipment Inventory).
/// Accepts the Service Enablement Workbench spec contract (our field names),
/// converts set-of-codes via the LIVE DD (VALUELIST/DISPLAYLIST), resolves
/// pointer fields to IENs, and does CRUD through the fileman2class projection
/// VISTA.EQUIPMENTINV6914 (%Save routes through FileMan → IEN + B/F/FC xrefs).
/// Side effects (work order / PM / FA-to-Austin / bulletin) are NOT invoked.
/// VADEMO sandbox only. Modeled on ISC.Demo.VA.REST.LYNN.ServiceDispatch.
Class Harness.Equipment.REST Extends %CSP.REST
{

Parameter HandleCorsRequest = 1;

XData UrlMap [ XMLNamespace = "http://www.intersystems.com/urlmap" ]
{
<Routes>
<Route Url="/NextIEN" Method="GET" Call="GetNextIEN" Cors="true"/>
<Route Url="/Equipment6914" Method="POST" Call="SaveEquipment6914" Cors="true"/>
<Route Url="/Equipment6914/:ien" Method="GET" Call="GetEquipment6914" Cors="true"/>
<Route Url="/Equipment6914/:ien" Method="DELETE" Call="DeleteEquipment6914" Cors="true"/>
</Routes>
}

ClassMethod GetNextIEN() As %Status
{
	Set %response.ContentType = "application/json"
	Set h = $Get(^ENG(6914,0))
	If h = "" Write {"status":"error","message":"^ENG(6914,0) not found"}.%ToJSON() Quit $$$OK
	Write {"status":"ok","ien":($Piece(h,"^",3)+1)}.%ToJSON()
	Quit $$$OK
}

ClassMethod GetEquipment6914(ien As %Integer) As %Status
{
	Set %response.ContentType = "application/json"
	Set e = ##class(VISTA.EQUIPMENTINV6914).%OpenId(+ien)
	If '$IsObject(e) {
		Set %response.Status = "404 Not Found"
		Write {"status":"error","message":("IEN "_ien_" not found")}.%ToJSON()
		Quit $$$OK
	}
	Set o = {}
	Set o.status = "ok"
	Set o.ien = e.IEN
	Set o.entryNumber = e.ENTRYNUMBER
	Set o.serial = e.SERIAL
	Set o.model = e.MODEL
	Set o.mfgrEquipmentName = e.MFGREQUIPMENTNAME
	Set o.typeOfEntry = e.TYPEOFENTRY
	Set o.useStatus = e.USESTATUS
	Set o.stationNumber = e.STATIONNUMBER
	Write o.%ToJSON()
	Quit $$$OK
}

/// Create/upsert a 6914 record from the spec-contract JSON body.
ClassMethod SaveEquipment6914() As %Status [ ProcedureBlock = 0 ]
{
	Set %response.ContentType = "application/json"
	Try {
		Set d = ##class(%DynamicObject).%FromJSON(%request.Content)
		// --- allocate / open ---
		Set ien = +d.%Get("entryNumber")
		If ien '> 0 Set ien = $Piece($Get(^ENG(6914,0)),"^",3)+1
		Set e = ##class(VISTA.EQUIPMENTINV6914).%OpenId(ien)
		If '$IsObject(e) {
			Set e = ##class(VISTA.EQUIPMENTINV6914).%New()
			Set e.IEN = ien
			Set e.ENTRYNUMBER = ien
		}
		// --- scalars / free text ---
		If d.serial '= "" Set e.SERIAL = d.serial
		If d.model '= "" Set e.MODEL = d.model
		If d.mfgrEquipmentName '= "" Set e.MFGREQUIPMENTNAME = d.mfgrEquipmentName
		If (d.vaPmNumber '= "") && ($Length(d.vaPmNumber) >= 9) Set e.VAPMNUMBER = d.vaPmNumber
		If d.localIdentifier '= "" Set e.LOCALIDENTIFIER = d.localIdentifier
		If d.stationNumber '= "" Set e.STATIONNUMBER = d.stationNumber
		If d.fundControlPoint '= "" Set e.FUNDCONTROLPOINT = $Extract(d.fundControlPoint,1,30)
		// --- numbers ---
		If d.originalAssetValue '= "" Set e.ORIGINALASSETVALUE = +$Translate(d.originalAssetValue,",","")
		If d.serviceContractCost '= "" Set e.SERVICECONTRACTCOST = +$Translate(d.serviceContractCost,",","")
		// --- dates YYYY-MM-DD -> FileMan ---
		If d.acquisitionDate '= "" Set e.ACQUISITIONDATE = ..ToFMDate(d.acquisitionDate)
		If d.warrantyExpDate '= "" Set e.WARRANTYEXPDATE = ..ToFMDate(d.warrantyExpDate)
		If d.physicalInventoryDate '= "" Set e.PHYSICALINVENTORYDATE = ..ToFMDate(d.physicalInventoryDate)
		// --- set-of-codes (DD VALUELIST/DISPLAYLIST) ---
		If d.typeOfEntry '= "" Set e.TYPEOFENTRY = ..Enum("typeOfEntry",d.typeOfEntry)
		If d.acquisitionMethod '= "" Set e.ACQUISITIONMETHOD = ..Enum("acquisitionMethod",d.acquisitionMethod)
		If d.useStatus '= "" Set e.USESTATUS = ..Enum("useStatus",d.useStatus)
		If d.conditionCode '= "" Set e.CONDITIONCODE = ..Enum("conditionCode",d.conditionCode)
		If d.investmentCategory '= "" Set e.INVESTMENTCATEGORY = ..Enum("investmentCategory",d.investmentCategory)
		If d.equityAccount '= "" Set e.EQUITYACCOUNT = ..Enum("equityAccount",d.equityAccount)
		If d.lockoutRequired '= "" Set e.LOCKOUTREQUIRED = ..Enum("lockoutRequired",d.lockoutRequired)
		If d.jcaho '= "" Set e.JCAHO = ..Enum("jcaho",d.jcaho)
		If d.controlledItem '= "" Set e.CONTROLLEDITEM = ..Enum("controlledItem",d.controlledItem)
		If d.serviceContract '= "" Set e.SERVICECONTRACT = ..Enum("serviceContract",d.serviceContract)
		// --- pointer fields: resolve to IEN then set ---
		Set p = ..Ptr("VISTA.MANUFACTURERLISTFILE6912","VISTA.MANUFACTURER_LIST_FILE6912","MFGS_FULL_LENGTH_NAME",d.manufacturer)  If p'="" Set e.MANUFACTURER = p
		Set p = ..Ptr("VISTA.EQUIPMENTCATEGORY6911","VISTA.EQUIPMENT_CATEGORY6911","NAME",d.equipmentCategory)  If p'="" Set e.EQUIPMENTCATEGORY = p
		Set p = ..Ptr("VISTA.CATEGORYSTOCKNUMBER6917","VISTA.CATEGORY_STOCK_NUMBER6917","NAME",d.categoryStockNumber)  If p'="" Set e.CATEGORYSTOCKNUMBER = p
		Set p = ..Ptr("VISTA.VENDOR440","VISTA.VENDOR440","NAME",d.vendorPointer)  If p'="" Set e.VENDORPOINTER = p
		Set p = ..Ptr("VISTA.SERVICESECTION49","VISTA.SERVICESECTION49","NAME",d.servicePointer)  If p'="" Set e.SERVICEPOINTER = p
		Set p = ..Ptr("VISTA.ENGSPACE6928","VISTA.ENG_SPACE6928","ROOM_NUMBER",d.location)  If p'="" Set e.LOCATION = p
		Set p = ..Ptr("VISTA.EQUIPMENTINV6914","","",d.parentSystem)  If p'="" Set e.PARENTSYSTEM = p
		Set p = ..Ptr("VISTA.EQUIPMENTINV6914","","",d.replacingEntryNumber)  If p'="" Set e.REPLACINGENTRYNUMBER = p
		Set p = ..Ptr("VISTA.BUDGETOBJECTCODE4202","VISTA.BUDGET_OBJECT_CODE420_2","NAME",d.subaccount)  If p'="" Set e.SUBACCOUNT = p
		// fund / budgetObjectCode / standardGeneralLedger point to 6914 SUB-files
		// (NX_FUND6914_6 / _4 / _3). The 6914 field stores the sub-file IEN, which the
		// client now sends. Filed below via a direct internal set after %Save.
		// --- FileMan filing env (needed by BeforeInsertFiling trigger) ---
		If '$Data(DUZ) Set DUZ = .5
		If '$Data(DT) { Set ds = $ZDate($Piece($Horolog,",",1),8), DT = ($Extract(ds,1,4)-1700)_$Extract(ds,5,8) }
		If '$Data(U) Set U = "^"
		Set sc = e.%Save()
		If $$$ISOK(sc) {
			// sub-file pointers: set field internal value = sub-file IEN (4-slash bypass)
			Set DR = ""
			If +d.fund > 0 Set DR = DR _ $Select(DR="":"",1:";") _ "62////" _ (+d.fund)
			If +d.budgetObjectCode > 0 Set DR = DR _ $Select(DR="":"",1:";") _ "61////" _ (+d.budgetObjectCode)
			If +d.standardGeneralLedger > 0 Set DR = DR _ $Select(DR="":"",1:";") _ "38////" _ (+d.standardGeneralLedger)
			If DR '= "" Set DIE = "^ENG(6914,", DA = e.IEN Do ^DIE
			Write {"status":"OK","equipmentIEN":(e.IEN),"lifecycleStatus":"created"}.%ToJSON()
		} Else {
			Set %response.Status = "400 Bad Request"
			Write {"status":"ERROR","error":($System.Status.GetErrorText(sc))}.%ToJSON()
		}
	} Catch ex {
		Set %response.Status = "400 Bad Request"
		Write {"status":"ERROR","error":(ex.DisplayString())}.%ToJSON()
	}
	Quit $$$OK
}

ClassMethod DeleteEquipment6914(ien As %Integer) As %Status
{
	Set %response.ContentType = "application/json"
	Set sc = ##class(VISTA.EQUIPMENTINV6914).%DeleteId(+ien)
	Write {"status":($Select($$$ISOK(sc):"OK",1:"ERROR")),"ien":(+ien)}.%ToJSON()
	Quit $$$OK
}

/// DD-correct set-of-codes conversion (display -> internal). Mirrors the live
/// VALUELIST/DISPLAYLIST of VISTA.EQUIPMENTINV6914. Pass-through if the caller
/// already sent an internal code; error string prefix "?" if unmappable.
ClassMethod Enum(field As %String, val As %String) As %String
{
	Set val = $ZStrip(val,"<>W")
	Set U = $ZConvert(val,"U")
	If field = "typeOfEntry" Quit $Case(U,"NON-EXPENDABLE EQPT":"NX","BUILDING SERVICE EQPT":"BSE","EXPENDABLE EQPT":"EXP","NX":"NX","BSE":"BSE","EXP":"EXP",:"NX")
	If field = "acquisitionMethod" Quit $Case(U,"CONSTRUCTED":"C","GIFT/BEQUEST/DONATION":"G","LEASED":"L","CAPITAL LEASE":"M","OTHER":"O","PURCHASED":"P","TRANSFERRED":"R","TRADED":"T","EXCESS":"X","ON LOAN TO VAMC":"1",:val)
	If field = "useStatus" Quit $Case(U,"IN USE":"1","OUT OF SERVICE":"2","LOANED OUT":"3","TURNED IN":"4","LOST OR STOLEN":"5",:val)
	If field = "conditionCode" Quit $Case(U,"LIKE NEW":"1","GOOD":"2","POOR":"3",:val)
	If field = "investmentCategory" Quit $Case(U,"CAPITALIZED/ACCOUNTABLE":"1","NOT CAPITALIZED/ACCOUNTABLE":"A","EXPENSED/OPTIONALLY ACCOUNTABLE":"0",:val)
	If field = "equityAccount" Quit $Case(U,"MEDICAL":"3299","NON-MEDICAL":"3210","DONATED":"3402",:val)
	If field = "lockoutRequired" Quit $Case(U,"YES":"1","NO":"0","1":"1","0":"0",:"0")
	If field = "jcaho" Quit $Case(U,"YES":"Y","NO":"N",:val)
	If field = "controlledItem" Quit $Case(U,"YES":"1","NO":"0","1":"1","0":"0",:"0")
	If field = "serviceContract" Quit $Case(U,"YES":"Y","NO":"N",:val)
	Quit val
}

/// Resolve a pointer value to a swizzled object reference (or "" if unresolved).
/// If numeric and that IEN exists in the target class, open it. Otherwise look
/// the IEN up by the given .01/display SQL column, then open it.
ClassMethod Ptr(class As %String, table As %String, col As %String, val As %String) As %RegisteredObject
{
	Quit:(val = "") ""
	Set ien = ""
	If (+val > 0) && ($ClassMethod(class,"%ExistsId",+val)) {
		Set ien = +val
	} ElseIf (col '= "") && (table '= "") {
		Set rs = ##class(%SQL.Statement).%ExecDirect(,"SELECT TOP 1 IEN FROM "_table_" WHERE "_col_" = ?", val)
		If (rs.%SQLCODE = 0), rs.%Next() Set ien = rs.IEN
	} ElseIf (+val > 0) {
		Set ien = +val
	}
	Quit:(+ien '> 0) ""
	Quit $ClassMethod(class,"%OpenId",+ien)
}

ClassMethod ToFMDate(iso As %String) As %String
{
	// YYYY-MM-DD -> FileMan YYYMMDD
	If iso = "" Quit ""
	Set y = $Piece(iso,"-",1), m = $Piece(iso,"-",2), dd = $Piece(iso,"-",3)
	If (y = "") || (m = "") || (dd = "") Quit ""
	Quit (y-1700)_m_dd
}

}
