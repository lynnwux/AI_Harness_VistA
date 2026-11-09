/// Runtime-trace experiment probe (experiments/runtime-trace). Throwaway: deleted from VADEMO after the experiment.
/// Traces only an interactive terminal process in VISTA-DIEGO; reads globals only as $Data / subscript names.
Class Harness.Experiment.RuntimeTrace Extends %RegisteredObject
{

Parameter EVENTS = "RtnLoad,GloRef";

/// Global roots whose existence ($Data) or subscript names may be checked.
Parameter ROOTS = "ENG,XTMP,TMP,DIC,XMB,XUSEC,DIE";

ClassMethod Dir() As %String
{
	Quit ##class(%File).NormalizeDirectory("Temp/harness-runtime-trace", $zu(12))
}

ClassMethod File(pid) As %String
{
	Quit ..Dir()_"iristrace_"_(+pid)_".txt"
}

ClassMethod Now() As %String
{
	Quit $zdatetime($ztimestamp, 3, 1, 3)_"Z"
}

ClassMethod L2J(l) As %DynamicArray
{
	Set a = []
	For i = 1:1:$listlength(l) { Do a.%Push($listget(l, i)) }
	Quit a
}

ClassMethod Env() As %String(MAXLEN="") [ SqlProc ]
{
	Set o = {}
	Set o.version = $zversion, o.user = $username, o.controllerJob = $job, o.namespace = $namespace
	Set o.adminManageUse = $SYSTEM.Security.Check("%Admin_Manage", "USE")
	Set o.traceDirDefault = ##class(%SYS.Trace).GetDirectory()
	Set o.maxSizeDefaultMB = ##class(%SYS.Trace).GetMaxSize()
	Set o.eventsDefault = ..L2J(##class(%SYS.Trace).GetEvents())
	Set o.eventNames = ..L2J(##class(%SYS.Trace).EventNames())
	Set o.tracedPids = ..L2J(##class(%SYS.Trace).PIDList())
	Set sc = ##class(%SYS.Trace).ValidateEvents($listfromstring(..#EVENTS))
	Set o.experimentEventsValid = $select(sc:"OK", 1:$system.Status.GetErrorText(sc))
	Set o.mgrDir = $zu(12), o.experimentDir = ..Dir()
	Set o.experimentDirExists = ##class(%File).DirectoryExists(..Dir())
	Quit o.%ToJSON()
}

ClassMethod PrepareDir() As %String(MAXLEN="") [ SqlProc ]
{
	Set d = ..Dir(), ok = ##class(%File).CreateDirectoryChain(d)
	Quit {"dir":(d), "created":(ok), "exists":(##class(%File).DirectoryExists(d))}.%ToJSON()
}

ClassMethod Target(pid) As %DynamicObject
{
	Set p = ##class(%SYS.ProcessQuery).%OpenId(+pid)
	If '$isobject(p) Quit {"pid":(+pid), "ok":0, "why":"no such process"}
	Set t = {"pid":(+pid), "namespace":(p.NameSpace), "user":(p.UserName), "device":(p.CurrentDevice), "routine":(p.Routine), "jobType":(p.JobType), "state":(p.State), "ok":1}
	If +pid = $job {
		Set t.ok = 0, t.why = "refusing to trace the controller itself"
	} ElseIf p.NameSpace '= "VISTA-DIEGO" {
		Set t.ok = 0, t.why = "not in VISTA-DIEGO"
	} ElseIf $extract(p.CurrentDevice, 1, 5) '= "|TRM|" {
		Set t.ok = 0, t.why = "not an interactive terminal process"
	}
	Quit t
}

ClassMethod Check(pid As %Integer) As %String(MAXLEN="") [ SqlProc ]
{
	Quit ..Target(pid).%ToJSON()
}

ClassMethod Start(pid As %Integer, maxMB As %Integer = 50) As %String(MAXLEN="") [ SqlProc ]
{
	Set t = ..Target(pid)
	If 't.ok Quit t.%ToJSON()
	If $listfind(##class(%SYS.Trace).PIDList(), +pid) Set t.ok = 0, t.why = "already traced" Quit t.%ToJSON()
	Set events = $listfromstring(..#EVENTS)
	Set sc = ##class(%SYS.Trace).StartPID(+pid, ..Dir(), events, +maxMB)
	Set t.startedAtUTC = ..Now(), t.status = $select(sc:"OK", 1:$system.Status.GetErrorText(sc))
	Set t.file = ..File(pid), t.events = ..L2J(events), t.maxMB = +maxMB, t.controllerJob = $job
	Quit t.%ToJSON()
}

ClassMethod Stop(pid As %Integer) As %String(MAXLEN="") [ SqlProc ]
{
	Set sc = ##class(%SYS.Trace).StopPID(+pid)
	Set f = ..File(pid)
	Quit {"pid":(+pid), "stoppedAtUTC":(..Now()), "status":($select(sc:"OK", 1:$system.Status.GetErrorText(sc))), "stillTraced":($listfind(##class(%SYS.Trace).PIDList(), +pid)>0), "file":(f), "bytes":(##class(%File).GetFileSize(f))}.%ToJSON()
}

ClassMethod Status(pid As %Integer) As %String(MAXLEN="") [ SqlProc ]
{
	Set f = ..File(pid)
	Quit {"pid":(+pid), "at":(..Now()), "traced":($listfind(##class(%SYS.Trace).PIDList(), +pid)>0), "tracedPids":(..L2J(##class(%SYS.Trace).PIDList())), "file":(f), "exists":(##class(%File).Exists(f)), "bytes":(##class(%File).GetFileSize(f))}.%ToJSON()
}

/// Parsed rows from %SYS.Trace:ReadFile, a page at a time.
ClassMethod Rows(pid As %Integer, from As %Integer = 1, count As %Integer = 2000, flags As %String = "qs") As %String(MAXLEN="") [ SqlProc ]
{
	Set out = [], n = 0, more = 0, end = 0, err = ""
	Set rs = ##class(%ResultSet).%New("%SYS.Trace:ReadFile")
	Set sc = rs.%Execute(..File(pid), flags)
	If 'sc Quit {"error":($system.Status.GetErrorText(sc))}.%ToJSON()
	For {
		Set sc2 = $$$OK, got = rs.%Next(.sc2)
		If 'sc2 { Set err = $system.Status.GetErrorText(sc2) Quit }
		If 'got { Set end = 1 Quit }
		Set n = n + 1
		Continue:(n < from)
		If n >= (from + count) { Set more = 1 Quit }
		Do out.%Push([(rs.Get("Event")), (rs.Get("Text")), (rs.Get("TOffset")), (rs.Get("Level")), (rs.Get("Count")), (rs.Get("LineAndRoutine")), (rs.Get("RoutineLoc")), (rs.Get("SrcLine")), (rs.Get("GlobalRef")), (rs.Get("GlobalLoc"))])
	}
	Do rs.Close()
	Quit {"from":(from), "rows":(out), "more":(more), "end":(end), "stopReason":(err)}.%ToJSON()
}

/// Raw trace-file lines, a page at a time.
ClassMethod Raw(pid As %Integer, from As %Integer = 1, count As %Integer = 20000) As %String(MAXLEN="") [ SqlProc ]
{
	Set s = ##class(%Stream.FileCharacter).%New()
	Set sc = s.LinkToFile(..File(pid))
	If 'sc Quit {"error":($system.Status.GetErrorText(sc))}.%ToJSON()
	Set out = [], n = 0, more = 0
	While 's.AtEnd {
		Set line = s.ReadLine()
		Set n = n + 1
		Continue:(n < from)
		If n >= (from + count) { Set more = 1 Quit }
		Do out.%Push(line)
	}
	Quit {"from":(from), "lines":(out), "more":(more)}.%ToJSON()
}

/// Process-private global names and block counts (never values) via ^GETPPGINFO, run as a background job so its
/// console output goes to the null device instead of this SQL connection.
ClassMethod PPG(pid As %Integer) As %String(MAXLEN="") [ SqlProc ]
{
	Set t = ..Target(pid)
	If 't.ok Quit t.%ToJSON()
	Set f = ..Dir()_"ppg_"_(+pid)_"_"_$translate($ztimestamp, ",.", "__")_".csv"
	New $namespace
	Set $namespace = "%SYS"
	Job ^GETPPGINFO(+pid, "S", f)::10
	Set jobbed = $test, child = $zchild
	For i = 1:1:50 { Quit:'$data(^$JOB(child))  Hang 0.2 }
	Set lines = []
	If ##class(%File).Exists(f) {
		Set s = ##class(%Stream.FileCharacter).%New()
		Do s.LinkToFile(f)
		While 's.AtEnd { Do lines.%Push(s.ReadLine()) }
		Kill s
		Do ##class(%File).Delete(f)
	}
	Quit {"pid":(+pid), "at":(..Now()), "jobbed":(jobbed), "lines":(lines)}.%ToJSON()
}

ClassMethod Allowed(ref As %String) As %Boolean
{
	Set sub = "(-?[0-9.]+|""([^""]|"""")*"")"
	Set pat = "\^("_$translate(..#ROOTS, ",", "|")_")(\("_sub_"(,"_sub_")*\))?"
	Quit $match(ref, pat)
}

/// $Data for each given global reference (a JSON array of strings); values are never returned.
ClassMethod Defined(refs As %String(MAXLEN="")) As %String(MAXLEN="") [ SqlProc ]
{
	Set in = [].%FromJSON(refs), out = {}, it = in.%GetIterator()
	While it.%GetNext(.k, .ref) {
		If '..Allowed(ref) { Do out.%Set(ref, "not allowed") Continue }
		Do out.%Set(ref, $data(@ref))
	}
	Quit out.%ToJSON()
}

/// Up to max immediate subscript names under one global reference (no values), with each child's $Data.
ClassMethod Subs(ref As %String(MAXLEN=""), max As %Integer = 50) As %String(MAXLEN="") [ SqlProc ]
{
	If '..Allowed(ref) Quit {"ref":(ref), "error":"not allowed"}.%ToJSON()
	Set out = [], s = "", n = 0, more = 0
	For {
		Set s = $order(@ref@(s))
		Quit:(s = "")
		Set n = n + 1
		If n > max { Set more = 1 Quit }
		Do out.%Push([(s), ($data(@ref@(s)))])
	}
	Quit {"ref":(ref), "subs":(out), "more":(more)}.%ToJSON()
}

/// Read-only worker for SelfTest: FileMan reads of one record, every half second.
ClassMethod Worker(ien As %Integer, seconds As %Integer) [ ProcedureBlock = 0 ]
{
	New U, DT, x, y, i
	Set U = "^", DT = $$DT^XLFDT()
	Hang 2
	For i = 1:1:(seconds * 2) {
		Set x = $$GET1^DIQ(6914, ien, 5), y = $data(^ENG(6914, "FC"))
		Hang 0.5
	}
	Quit
}

/// Traces a background job started here (not another user's process), then waits for it to halt.
ClassMethod SelfTest(ien As %Integer = 487, seconds As %Integer = 20) As %String(MAXLEN="") [ SqlProc ]
{
	Job ##class(Harness.Experiment.RuntimeTrace).Worker(+ien, +seconds)::10
	If '$test Quit {"error":"job did not start"}.%ToJSON()
	Set child = $zchild
	Set sc = ##class(%SYS.Trace).StartPID(child, ..Dir(), $listfromstring(..#EVENTS), 10)
	Set t0 = ..Now()
	For i = 1:1:((seconds + 10) * 5) { Quit:'$data(^$JOB(child))  Hang 0.2 }
	Set f = ..File(child)
	Quit {"pid":(child), "startedAtUTC":(t0), "endedAtUTC":(..Now()), "status":($select(sc:"OK", 1:$system.Status.GetErrorText(sc))), "file":(f), "bytes":(##class(%File).GetFileSize(f))}.%ToJSON()
}

/// Deletes this experiment's trace and PPG files and the directory, if empty.
ClassMethod Cleanup(pid As %Integer) As %String(MAXLEN="") [ SqlProc ]
{
	Set f = ..File(pid), del = ##class(%File).Delete(f)
	Set dir = ##class(%File).RemoveDirectory(..Dir())
	Quit {"traceFileDeleted":(del), "dirRemoved":(dir)}.%ToJSON()
}

}
