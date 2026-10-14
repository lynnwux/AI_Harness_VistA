/// Sandbox CRUD prototype for file 6914 (Engineering Equipment Inventory).
/// Read + create against ^ENG(6914) via FileMan, so IEN allocation and the
/// B/F/FC cross-references are maintained correctly. Side effects (work order,
/// PM, FA-to-Austin, bulletin) are intentionally NOT invoked — record create only.
/// VADEMO sandbox only; not for production.
Class Harness.EquipmentAPI Extends %RegisteredObject
{

/// Next IEN = the file's counter + 1 (matches ENR^ENEQ1).
ClassMethod NextIEN() As %Integer [ SqlProc ]
{
	Quit $Piece($Get(^ENG(6914,0)),"^",3)+1
}

/// Create a 6914 record from a JSON payload. Files .01 (ENTRY NUMBER = IEN) via
/// DINUM, then scalar/enum/number fields by external value (DR "fld///value").
/// Returns {status, equipmentIEN, lifecycleStatus} as JSON.
ClassMethod CreateJSON(payload As %String) As %String [ ProcedureBlock = 0, SqlProc ]
{
	New obj,ien,DIC,DIE,DR,DA,DINUM,DLAYGO,X,Y,U,DT,map,k,val,err
	Set U="^",DT=$ZDate($Horolog,8)
	Set $ZTrap="CErr"
	Set obj=##class(%DynamicObject).%FromJSON(payload)
	Lock +^ENG(6914,0):5 Else  Quit "{""status"":""ERROR"",""error"":""lock timeout on ^ENG(6914,0)""}"
	Set ien=$Piece($Get(^ENG(6914,0)),U,3)+1
	Set DIC="^ENG(6914,",DIC(0)="L",DLAYGO=6914,DINUM=ien,X=ien
	Do FILE^DICN
	Lock -^ENG(6914,0)
	If Y<0 Quit "{""status"":""ERROR"",""error"":""FILE^DICN failed allocating IEN""}"
	Set ien=+Y
	// jsonKey -> FileMan field number (scalars/enums/numbers only; pointers & dates skipped)
	Set map("serial")=5,map("mfgrEquipmentName")=3,map("model")=4,map("typeOfEntry")=7
	Set map("acquisitionMethod")=20.1,map("useStatus")=20,map("lockoutRequired")=9
	Set map("conditionCode")=53,map("stationNumber")=60,map("vaPmNumber")=25
	Set map("serviceContract")=19.5,map("serviceContractCost")=19.6,map("localIdentifier")=26
	Set map("jcaho")=27,map("controlledItem")=33,map("investmentCategory")=34
	Set map("fundControlPoint")=35,map("equityAccount")=64,map("originalAssetValue")=31.5
	Set DR="",k=""
	For  Set k=$Order(map(k)) Quit:k=""  Do
	. Set val=obj.%Get(k)
	. Quit:(val="")!($Get(val)="null")
	. Set val=$Translate(val,";^","  ")
	. Set DR=DR_$Select(DR="":"",1:";")_map(k)_"///"_val
	If DR'="" Set DIE="^ENG(6914,",DA=ien Do ^DIE
	Quit "{""status"":""OK"",""equipmentIEN"":"_ien_",""lifecycleStatus"":""created""}"
CErr Set $ZTrap=""
	Lock -^ENG(6914,0)
	Quit "{""status"":""ERROR"",""error"":"""_$Replace($ZError,"""","'")_"""}"
}

/// Fetch a stored record (verify persistence). Uses GET1^DIQ for external values.
ClassMethod GetJSON(ien As %Integer) As %String [ ProcedureBlock = 0, SqlProc ]
{
	New U,o,f
	Set U="^"
	If '$Data(^ENG(6914,+ien,0)) Quit "{}"
	Set o="{""ien"":"_(+ien)
	Set o=o_",""entryNumber"":"""_$$GET1^DIQ(6914,+ien_",",.01)_""""
	Set o=o_",""serial"":"""_$$GET1^DIQ(6914,+ien_",",5)_""""
	Set o=o_",""model"":"""_$$GET1^DIQ(6914,+ien_",",4)_""""
	Set o=o_",""mfgrEquipmentName"":"""_$Replace($$GET1^DIQ(6914,+ien_",",3),"""","'")_""""
	Set o=o_",""typeOfEntry"":"""_$$GET1^DIQ(6914,+ien_",",7)_""""
	Set o=o_",""useStatus"":"""_$$GET1^DIQ(6914,+ien_",",20)_""""
	Quit o_"}"
}

}
