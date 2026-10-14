/// One-time setup for the Harness Equipment REST data service (SE Workbench prototype).
/// Creates a CSP web application that dispatches to Harness.Equipment.REST, cloning
/// the auth/CORS settings of the existing LYNN demo app so behavior matches.
Class Harness.Setup Extends %RegisteredObject
{

ClassMethod CreateWebApp() As %String [ ProcedureBlock = 0, SqlProc ]
{
	New $namespace
	Set name = "/Harness/Equipment"
	Set src = "/FileMan/Lynn"
	Set $namespace = "%SYS"
	If ##class(Security.Applications).Exists(name) Quit "exists: "_name
	If '##class(Security.Applications).Exists(src) Quit "ERROR: source app "_src_" not found"
	Do ##class(Security.Applications).Get(src, .p)
	Set p("DispatchClass") = "Harness.Equipment.REST"
	Set p("NameSpace") = "VISTA-DIEGO"
	Set p("CookiePath") = name
	Set p("Description") = "Harness Equipment 6914 REST data service (SE Workbench prototype)"
	Set sc = ##class(Security.Applications).Create(name, .p)
	Quit $Select($$$ISOK(sc):"created: "_name, 1:"ERROR: "_$System.Status.GetErrorText(sc))
}

/// List CSP web applications that have a DispatchClass (REST apps), with their
/// name → dispatch class → namespace. Helps find the real LYNN app name.
ClassMethod ListRest() As %String [ ProcedureBlock = 0, SqlProc ]
{
	New $namespace
	Set $namespace = "%SYS"
	Set out = "", rs = ##class(%SQL.Statement).%ExecDirect(,"SELECT Name, DispatchClass, NameSpace FROM Security.Applications WHERE DispatchClass IS NOT NULL AND DispatchClass <> ''")
	While rs.%Next() {
		Set out = out _ rs.Name _ " => " _ rs.DispatchClass _ " [" _ rs.NameSpace _ "]" _ $Char(10)
	}
	Quit out
}

/// Report the key settings of an app (for verification).
ClassMethod Describe(name As %String) As %String [ ProcedureBlock = 0, SqlProc ]
{
	New $namespace
	Set $namespace = "%SYS"
	If '##class(Security.Applications).Exists(name) Quit "not found"
	Do ##class(Security.Applications).Get(name, .p)
	Quit "dispatch="_$Get(p("DispatchClass"))_" ns="_$Get(p("NameSpace"))_" enabled="_$Get(p("Enabled"))_" authe="_$Get(p("AutheEnabled"))_" resource="_$Get(p("Resource"))
}

}
