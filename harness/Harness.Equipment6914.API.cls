/// Harness-generated service for VistA Engineering Equipment Inventory (FileMan file #6914, global ^ENG(6914,*)).
///
/// PROVENANCE: inferred from a roll-and-scroll navigation trace
///   EVE -> Core Applications -> EN (Engineering) -> EQ (Equipment Management) -> New Inventory Entry
/// The "ENTRY NUMBER" allocated by New Inventory Entry is the FileMan IEN in file #6914.
/// Field access is driven by the LIVE data dictionary via GETS^DIQ, so this class does not
/// hard-code global piece offsets and does not depend on any hand-built mapped class.
///
/// This is a Harness.* candidate service produced by the discovery pipeline. All names are
/// prefixed "Harness." so they cannot collide with existing production/demo code.
Class Harness.Equipment6914.API [ Abstract ]
{

/// FileMan file number for Engineering Equipment Inventory.
Parameter FILE = 6914;

/// Next available IEN for file 6914. Read-only; does not allocate.
/// Mirrors the legacy next-IEN logic: $P(^ENG(6914,0),"^",3)+1
ClassMethod NextIEN() As %Integer [ SqlProc ]
{
	Quit $Piece($Get(^ENG(6914,0)), "^", 3) + 1
}

/// Number of records currently on file (last-used IEN counter).
ClassMethod LastIEN() As %Integer [ SqlProc ]
{
	Quit +$Piece($Get(^ENG(6914,0)), "^", 3)
}

/// Read one equipment record by IEN and return it as a %DynamicObject.
/// Every top-level field is returned with its external (display) and internal (stored) value,
/// keyed by FileMan field number. pStatus reports not-found / FileMan errors.
ClassMethod GetRecord(pIEN As %Integer, Output pStatus As %Status) As %DynamicObject [ ProcedureBlock = 0 ]
{
	Set pStatus = $$$OK
	Set obj = {}
	Set pIEN = +pIEN
	If '$Data(^ENG(6914, pIEN, 0)) {
		Set pStatus = $$$ERROR($$$GeneralError, "IEN " _ pIEN _ " not found in file 6914")
		Quit obj
	}
	// FileMan needs a user + date context; default safely if the process has none.
	New DUZ, DT, U, DIERR
	If $Get(DUZ) = "" Set DUZ = .5
	If $Get(U) = "" Set U = "^"
	If $Get(DT) = "" Do NOW^%DTC Set DT = $Piece(%, ".")
	Set iens = pIEN _ ","
	Kill OUT, ERR
	// "*" = all top-level fields; "IE" = return both Internal and External values.
	Do GETS^DIQ(6914, iens, "*", "IE", "OUT", "ERR")
	If $Data(ERR("DIERR")) {
		Set pStatus = $$$ERROR($$$GeneralError, "FileMan GETS^DIQ error for IEN " _ pIEN)
		Quit obj
	}
	Set fld = ""
	For {
		Set fld = $Order(OUT(6914, iens, fld))
		Quit:fld=""
		Set ext = $Get(OUT(6914, iens, fld, "E"))
		Set int = $Get(OUT(6914, iens, fld, "I"))
		Do obj.%Set(fld, {"external": (ext), "internal": (int)})
	}
	Do obj.%Set("ien", pIEN)
	Quit obj
}

/// Convenience: JSON string for one record (for quick terminal inspection).
///   W ##class(Harness.Equipment6914.API).GetRecordJSON(455),!
ClassMethod GetRecordJSON(pIEN As %Integer) As %String [ SqlProc ]
{
	Set obj = ..GetRecord(pIEN, .sc)
	If $$$ISERR(sc) Quit "{""error"":""" _ $System.Status.GetErrorText(sc) _ """}"
	Quit obj.%ToJSON()
}

/// SQL-callable list of up to pMax records as a JSON array string.
ClassMethod ListJSON(pMax As %Integer = 25) As %String [ SqlProc ]
{
	Quit ..List(pMax).%ToJSON()
}

/// List up to pMax records as [{ien, entryNumber, name}], oldest IEN first.
ClassMethod List(pMax As %Integer = 25) As %DynamicArray
{
	Set arr = []
	// Start at 0 so $Order moves past the ^ENG(6914,0) header node.
	Set ien = 0, n = 0
	For {
		Set ien = $Order(^ENG(6914, ien))
		Quit:(ien = "")
		Quit:('$IsValidNum(ien))          // stop when we reach cross-ref subscripts ("B","F",...)
		Set zero = $Get(^ENG(6914, ien, 0))
		Continue:(zero = "")              // skip sparse / deleted IENs
		Do arr.%Push({
			"ien": (+ien),
			"entryNumber": ($Piece(zero, "^", 1)),
			"name": ($Piece(zero, "^", 2)),
			"serial": ($Piece($Get(^ENG(6914, ien, 1)), "^", 3))
		})
		Set n = n + 1
		Quit:(n >= pMax)
	}
	Quit arr
}

/// Look up an IEN by serial number using the legacy "F" cross-reference:
///   ^ENG(6914,"F",SERIAL,IEN)
ClassMethod FindBySerial(pSerial As %String) As %Integer [ SqlProc ]
{
	Set ien = $Order(^ENG(6914, "F", pSerial, ""))
	Quit +$Get(ien)
}

/// Terminal smoke test. Prints next IEN, a record, and a short list.
///   D ##class(Harness.Equipment6914.API).Test(455)
ClassMethod Test(pIEN As %Integer = "")
{
	Write !, "=== Harness.Equipment6914.API smoke test ===", !
	Write "LastIEN on file : ", ..LastIEN(), !
	Write "NextIEN         : ", ..NextIEN(), !
	If pIEN = "" Set pIEN = ..LastIEN()
	Write !, "Record ", pIEN, ":", !
	Write ..GetRecordJSON(pIEN), !
	Write !, "First few records:", !
	Write ..List(5).%ToJSON(), !
}

}
