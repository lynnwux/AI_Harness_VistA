/// ^TMP sampling experiment (experiments/tmp-sampler). Throwaway: deleted from VADEMO after the experiment.
/// Read-only on VistA data: reports the shape of ^TMP(pid) / ^UTILITY(pid) (subscript names, $Data, node counts —
/// never values) and %SYS.ProcessQuery state. The sampler's log lives in ^IRIS.Temp.HarnessSampler (IRISTEMP).
Class Harness.Experiment.TmpSampler Extends %RegisteredObject
{

Parameter MAXNODES = 5000;

/// Shape of one job's ^TMP and ^UTILITY: level-1 subscripts, each with $Data, node count and up to 25 level-2 names.
ClassMethod Shape(pid As %Integer) As %DynamicObject
{
	Set o = {}
	For g = "^TMP", "^UTILITY" {
		Set root = $name(@g@(+pid)), lv = {}, s1 = ""
		For {
			Set s1 = $order(@root@(s1))
			Quit:(s1 = "")
			Set ref = $name(@root@(s1)), n = 0, q = ref, more = 0
			For {
				Set q = $query(@q)
				Quit:(q = "")
				Quit:($name(@q, $qlength(ref)) '= ref)
				Set n = n + 1
				If n >= ..#MAXNODES { Set more = 1 Quit }
			}
			Set l2 = [], s2 = "", k = 0
			For {
				Set s2 = $order(@ref@(s2))
				Quit:(s2 = "")
				Set k = k + 1
				If k > 25 { Do l2.%Push("…") Quit }
				Do l2.%Push(s2)
			}
			Do lv.%Set(s1, {"d":($data(@ref)), "nodes":(n), "nodesCapped":(more), "sub2":(l2)})
		}
		Do o.%Set(g, lv)
	}
	Quit o
}

ClassMethod Proc(pid As %Integer) As %DynamicObject
{
	Set p = ##class(%SYS.ProcessQuery).%OpenId(+pid)
	If '$isobject(p) Quit {"alive":0}
	Quit {"alive":1, "namespace":(p.NameSpace), "device":(p.CurrentDevice), "routine":(p.Routine), "state":(p.State), "lastGlobalRef":(p.LastGlobalReference)}
}

ClassMethod Look(pid As %Integer) As %String(MAXLEN="") [ SqlProc ]
{
	Quit {"pid":(+pid), "at":($zdatetime($ztimestamp, 3, 1, 3)_"Z"), "process":(..Proc(pid)), "shape":(..Shape(pid))}.%ToJSON()
}

/// Starts a background sampler of an interactive VISTA-DIEGO terminal process; logs a line only when something changes.
ClassMethod Start(pid As %Integer, intervalMs As %Integer = 250, maxMinutes As %Integer = 20) As %String(MAXLEN="") [ SqlProc ]
{
	Set p = ..Proc(pid)
	If 'p.alive Quit {"ok":0, "why":"no such process"}.%ToJSON()
	If (p.namespace '= "VISTA-DIEGO") || ($extract(p.device, 1, 5) '= "|TRM|") Quit {"ok":0, "why":"not an interactive VISTA-DIEGO terminal", "process":(p)}.%ToJSON()
	If $data(^IRIS.Temp.HarnessSampler(+pid, "run")) Quit {"ok":0, "why":"already sampling"}.%ToJSON()
	Kill ^IRIS.Temp.HarnessSampler(+pid)
	Set ^IRIS.Temp.HarnessSampler(+pid, "run") = 1
	Job ##class(Harness.Experiment.TmpSampler).Loop(+pid, +intervalMs, +maxMinutes)::10
	Quit {"ok":($test), "samplerJob":($zchild), "startedAtUTC":($zdatetime($ztimestamp, 3, 1, 3)_"Z")}.%ToJSON()
}

ClassMethod Loop(pid As %Integer, intervalMs As %Integer, maxMinutes As %Integer)
{
	Set end = $zh + (maxMinutes * 60), last = "", lastP = "", n = 0, samples = 0
	While $get(^IRIS.Temp.HarnessSampler(pid, "run")) && ($zh < end) {
		Set samples = samples + 1
		Set p = ..Proc(pid), s = ..Shape(pid).%ToJSON(), pj = p.%ToJSON()
		If (s '= last) || ($piece(pj, ",""lastGlobalRef""") '= $piece(lastP, ",""lastGlobalRef""")) {
			Set n = n + 1, ^IRIS.Temp.HarnessSampler(pid, "log", n) = {"t":($zdatetime($ztimestamp, 3, 1, 3)_"Z"), "sample":(samples), "process":(p), "shapeChanged":(s '= last), "shape":($select(s '= last:{}.%FromJSON(s), 1:""))}.%ToJSON()
			Set last = s, lastP = pj
		}
		Quit:'p.alive
		Hang intervalMs / 1000
	}
	Set ^IRIS.Temp.HarnessSampler(pid, "done") = {"samples":(samples), "logged":(n), "endedAtUTC":($zdatetime($ztimestamp, 3, 1, 3)_"Z")}.%ToJSON()
	Kill ^IRIS.Temp.HarnessSampler(pid, "run")
	Quit
}

ClassMethod Stop(pid As %Integer) As %String(MAXLEN="") [ SqlProc ]
{
	Kill ^IRIS.Temp.HarnessSampler(+pid, "run")
	Hang 1
	Quit {"stopped":1, "done":($get(^IRIS.Temp.HarnessSampler(+pid, "done")))}.%ToJSON()
}

/// Returns log lines from..from+count-1 as a JSON array of JSON strings.
ClassMethod Fetch(pid As %Integer, from As %Integer = 1, count As %Integer = 200) As %String(MAXLEN="") [ SqlProc ]
{
	Set a = [], i = from - 1
	For {
		Set i = $order(^IRIS.Temp.HarnessSampler(+pid, "log", i))
		Quit:(i = "")
		Quit:(i >= (from + count))
		Do a.%Push(^IRIS.Temp.HarnessSampler(+pid, "log", i))
	}
	Quit {"lines":(a), "running":($data(^IRIS.Temp.HarnessSampler(+pid, "run")) > 0), "done":($get(^IRIS.Temp.HarnessSampler(+pid, "done")))}.%ToJSON()
}

/// Subscript names (no values) at level 3 under ^TMP(pid,s1,s2), each with $Data and its own child names (level 4).
ClassMethod Names(pid As %Integer, s1 As %String, s2 As %String) As %String(MAXLEN="") [ SqlProc ]
{
	Set ref = $name(^TMP(+pid, s1, s2)), a = [], s = "", k = 0
	For {
		Set s = $order(@ref@(s))
		Quit:(s = "")
		Set k = k + 1
		If k > 200 { Do a.%Push("…") Quit }
		Set c = [], t = "", m = 0
		For {
			Set t = $order(@ref@(s, t))
			Quit:(t = "")
			Set m = m + 1
			If m > 20 { Do c.%Push("…") Quit }
			Do c.%Push(t)
		}
		Do a.%Push([(s), ($data(@ref@(s))), (c)])
	}
	Quit {"ref":(ref), "subs":(a)}.%ToJSON()
}

ClassMethod Clear(pid As %Integer) As %String(MAXLEN="") [ SqlProc ]
{
	Kill ^IRIS.Temp.HarnessSampler(+pid)
	Quit {"cleared":1}.%ToJSON()
}

}
