/// XINDEX experiment probe (experiments/xindex). Throwaway: deleted from VADEMO after the experiment.
/// Runs Toolkit's ^XINDEX through its documented API (SETUP^XINDX7, lines loaded with $TEXT, BEG^XINDEX) in a background job, following
/// called routines whose names start with a prefix, and returns XINDEX's per-routine index as JSON. Writes only the
/// job's own ^UTILITY($J) scratch and the result in ^IRIS.Temp.HarnessXIndex (IRISTEMP), both killed after use.
Class Harness.Experiment.XIndex Extends %RegisteredObject
{

ClassMethod Run(roots As %String = "ENEQ1", prefix As %String = "EN", max As %Integer = 60) As %String(MAXLEN="") [ SqlProc ]
{
	Set key = $job
	Kill ^IRIS.Temp.HarnessXIndex(key)
	Job ##class(Harness.Experiment.XIndex).Worker(key, roots, prefix, +max)::10
	If '$test Quit {"error":"job did not start"}.%ToJSON()
	Set child = $zchild
	For i = 1:1:900 { Quit:'$data(^$JOB(child))  Hang 0.2 }
	If '$data(^IRIS.Temp.HarnessXIndex(key)) Quit {"error":"no output", "jobStillRunning":($data(^$JOB(child))>0)}.%ToJSON()
	Set out = "" For n = 1:1:^IRIS.Temp.HarnessXIndex(key) { Set out = out_^IRIS.Temp.HarnessXIndex(key, n) }
	Kill ^IRIS.Temp.HarnessXIndex(key)
	Quit out
}

ClassMethod Out(key, text) [ ProcedureBlock = 0 ]
{
	New i,n Kill ^IRIS.Temp.HarnessXIndex(key)
	Set n = 0 For i = 1:30000:$length(text) { Set n = n + 1, ^IRIS.Temp.HarnessXIndex(key, n) = $extract(text, i, i + 29999) }
	Set ^IRIS.Temp.HarnessXIndex(key) = n
	Quit
}

ClassMethod Worker(zzF, zzRoots As %String, zzPre As %String, zzMax As %Integer) [ ProcedureBlock = 0 ]
{
	Try {
	Set U = "^", DT = $$DT^XLFDT()
	Set IO = $principal, IO(0) = $principal, IOF = "#", IOM = 80, IOSL = 999999, IOST = "P-OTHER", IOST(0) = 0
	Kill ^UTILITY($job)
	Do PARAM^XINDX6
	Set INDDA = 0
	Do SETUP^XINDX7
	For zzI = 1:1:$length(zzRoots, ",") { Set zzR = $piece(zzRoots, ",", zzI) Set:zzR'="" ^UTILITY($job, zzR) = "" }
	Kill zzDone, zzMiss
	Set zzN = 0, zzStart = $zh
	For zzPass = 1:1:30 {
		Set zzNew = 0, zzR = "$"
		For {
			Set zzR = $order(^UTILITY($job, zzR))
			Quit:(zzR = "")
			Continue:$data(zzDone(zzR))
			Set zzDone(zzR) = 1, zzN = zzN + 1
			If zzN > zzMax { Set zzCapped = 1 Quit }
			For zzX = 1:1 { Set zzT = $text(@("+"_zzX_"^"_zzR)) Quit:(zzT = "")  Set ^UTILITY($job, 1, zzR, 0, zzX, 0) = zzT }
			If zzX = 1 { Set zzMiss(zzR) = "" Continue }
			Set ^UTILITY($job, 1, zzR, 0, 0) = zzX - 1
			Set RTN = zzR, INDLC = 0
			Do BEG^XINDEX
			Set zzL = ""
			For {
				Set zzL = $order(^UTILITY($job, 1, zzR, "X", zzL))
				Quit:(zzL = "")
				Set zzP = $piece($piece(zzL, " ", 1), "(")
				Continue:((zzP = "") || (zzP [ "@") || (zzP [ "&"))
				If $extract(zzP, 1, $length(zzPre)) = zzPre, '$data(^UTILITY($job, zzP)) Set ^UTILITY($job, zzP) = "", zzNew = 1
			}
		}
		Quit:('zzNew || $get(zzCapped))
	}
	Set zzO = {"roots":(zzRoots), "prefix":(zzPre), "max":(zzMax), "capped":($get(zzCapped, 0)), "seconds":($zh - zzStart), "routines":{}, "missing":[]}
	Set zzR = "" For { Set zzR = $order(zzMiss(zzR)) Quit:(zzR = "")  Do zzO.missing.%Push(zzR) }
	Set zzR = ""
	For {
		Set zzR = $order(zzDone(zzR))
		Quit:(zzR = "")
		Continue:$data(zzMiss(zzR))
		Continue:'$data(^UTILITY($job, 1, zzR, 0))
		Set zzE = {"size":($get(^UTILITY($job, 1, zzR, 0))), "rsum":($get(^UTILITY($job, 1, zzR, "RSUM"))), "line1":($get(^UTILITY($job, 1, zzR, 0, 1, 0))), "line2":($get(^UTILITY($job, 1, zzR, 0, 2, 0)))}
		For zzLoc = "T", "X", "G", "N", "MK", "O", "I" {
			Set zzK = {}, zzS = ""
			For {
				Set zzS = $order(^UTILITY($job, 1, zzR, zzLoc, zzS))
				Quit:(zzS = "")
				Set zzV = $get(^UTILITY($job, 1, zzR, zzLoc, zzS))
				For zzJ = 0:1 { Quit:'$data(^UTILITY($job, 1, zzR, zzLoc, zzS, zzJ))  Set zzV = zzV_$get(^UTILITY($job, 1, zzR, zzLoc, zzS, zzJ)) }
				Do zzK.%Set(zzS, zzV)
			}
			Do zzE.%Set(zzLoc, zzK)
		}
		Set zzErr = [], zzS = 0
		For { Set zzS = $order(^UTILITY($job, 1, zzR, "E", zzS)) Quit:(zzS = "")  Do zzErr.%Push($get(^UTILITY($job, 1, zzR, "E", zzS))) }
		Set zzE.E = zzErr
		Do zzO.routines.%Set(zzR, zzE)
	}
	Kill ^UTILITY($job)
	Do ..Out(zzF, zzO.%ToJSON())
	} Catch zzEx {
	Kill ^UTILITY($job)
	Do ..Out(zzF, {"error":(zzEx.DisplayString()), "routine":($get(RTN)), "done":($get(zzN))}.%ToJSON())
	}
	Quit
}

}
