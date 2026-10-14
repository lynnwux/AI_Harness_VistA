"use strict";
/* Real naive build: scaffold Angular → npm install → ng build → publish to prototype/build/.
   Driven from spec (the capability graph + decisions). Streams progress to build-status.json.
   Invoked (detached) by POST /api/build. Takes minutes (fresh scaffold + install + compile). */
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const ROOT = path.join(__dirname, "..");                    // repo root
const WORK_ROOT = path.join(__dirname, "_build");           // holds per-build workspaces
const RUN_ID = new Date().toISOString().replace(/[:.]/g, "-");
const WORK = path.join(WORK_ROOT, "run-" + RUN_ID);         // fresh, unique per build → guaranteed clean start
const APP = path.join(WORK, "eqbuild");
const OUT = path.join(ROOT, "prototype", "build");          // published site
const STATUS = path.join(__dirname, "build-status.json");
const GRAPH = path.join(ROOT, "capability-graph", "new-inventory-entry.json");
const DECISIONS = process.argv[2] || path.join(__dirname, "decisions.json");

// Ordered phases with a rough typical duration (sec) and a % band; the bar
// interpolates within each phase by elapsed time so it moves during long steps.
const PHASES = [
  { key: "read",     label: "Reading spec",                          from: 0,  to: 3,   sec: 2 },
  { key: "work",     label: "Preparing workspace",                   from: 3,  to: 5,   sec: 2 },
  { key: "scaffold", label: "Scaffolding Angular + installing deps", from: 5,  to: 60,  sec: 150 },
  { key: "generate", label: "Generating app from spec",              from: 60, to: 64,  sec: 3 },
  { key: "build",    label: "Compiling (ng build)",                  from: 64, to: 96,  sec: 100 },
  { key: "publish",  label: "Publishing to /prototype/build/",       from: 96, to: 100, sec: 4 },
];
const TOTAL_SEC = PHASES.reduce((s, p) => s + p.sec, 0);
const t0 = Date.now();
let phaseIdx = -1, phaseStart = Date.now(), ticker = null;
let status = { state: "starting", step: "", pct: 0, elapsedSec: 0, etaSec: TOTAL_SEC, startedAt: new Date().toISOString(), log: [], url: null, error: null };
function save() { try { fs.writeFileSync(STATUS, JSON.stringify(status, null, 2)); } catch (e) {} }
function log(line) { status.log.push(line); if (status.log.length > 400) status.log = status.log.slice(-400); save(); }
function tick() {
  status.elapsedSec = Math.round((Date.now() - t0) / 1000);
  if (phaseIdx >= 0 && phaseIdx < PHASES.length) {
    const p = PHASES[phaseIdx], frac = Math.min(1, (Date.now() - phaseStart) / 1000 / p.sec);
    status.pct = Math.min(p.to - 0.5, p.from + frac * (p.to - p.from));
  }
  status.etaSec = Math.max(0, Math.round(TOTAL_SEC - status.elapsedSec));
  save();
}
function setStep(step) {
  const i = PHASES.findIndex(p => step.indexOf(p.label.split(" ")[0]) === 0 || step === p.label);
  if (i >= 0) { phaseIdx = i; phaseStart = Date.now(); status.pct = PHASES[i].from; }
  status.step = step; status.state = "building"; log("▶ " + step);
}
function run(cmd, args, cwd) {
  return new Promise((resolve, reject) => {
    log("$ " + cmd + " " + args.join(" ") + (cwd ? "   (in " + path.relative(ROOT, cwd) + ")" : ""));
    const p = spawn(cmd, args, { cwd: cwd || WORK, shell: true, env: process.env });
    p.stdout.on("data", d => String(d).split(/\r?\n/).forEach(l => l.trim() && log(l.trim().slice(0, 200))));
    p.stderr.on("data", d => String(d).split(/\r?\n/).forEach(l => l.trim() && log(l.trim().slice(0, 200))));
    p.on("close", code => code === 0 ? resolve() : reject(new Error(cmd + " exited " + code)));
    p.on("error", reject);
  });
}

// ---- derive the app config from the spec (graph + decisions) ----
function enumOpts(s){ return String(s||"").split(";").map(x=>x.trim()).filter(Boolean).map(p=>{const i=p.indexOf("=");return i>0?[p.slice(0,i).trim(),p.slice(i+1).trim()]:[p,p];}); }
function fieldCfg(d){
  const b={k:d.id.replace(/^FLD\./,""),label:d.name,fno:d.field};
  if(d.field===".01") return {...b,type:"readonly"};
  if(d.enumValues) return {...b,type:"select",options:enumOpts(d.enumValues)};
  if(d.pointsTo){ const small=(typeof d.lookupCount==="number"&&d.lookupCount<=60); return {...b,type:small?"lookupSelect":"lookupType",table:d.lookupTable||"",sample:d.sample||null}; }
  if(/date/i.test(d.name)||/Date/.test(d.type||"")) return {...b,type:"date"};
  if(/Numeric/.test(d.type||"")||/value|cost/i.test(d.name)) return {...b,type:"number"};
  const m=/\((\d+)\s*-\s*(\d+)\)/.exec(d.type||""); return {...b,type:"text",maxlen:m?+m[2]:null};
}
function buildConfig(){
  const g=JSON.parse(fs.readFileSync(GRAPH,"utf8"));
  let dec={},scope={},integration={};
  try{ const s=JSON.parse(fs.readFileSync(DECISIONS,"utf8")); dec=s.dec||{};scope=s.scope||{};integration=s.integration||{}; }catch(e){}
  const c=g.capabilities[0];
  const omit=new Set((c.data||[]).filter(d=>d.kind==="field"&&dec[d.id]==="Omit").map(d=>d.id));
  const byId=id=>(c.data||[]).find(d=>d.id===id);
  const pages=(c.formScreens||[]).filter(s=>s.fields&&s.fields.length).map(s=>({title:s.title,fields:s.fields.map(byId).filter(d=>d&&!omit.has(d.id)).map(fieldCfg)}));
  const OQ={"OQ.WorkOrderPolicy":"Create an incoming inspection work order?","OQ.PMEnrollmentPolicy":"Enroll the item in the PM program?","OQ.FAConfirmation":"Send the FA document to Austin once eligible?"};
  const oq=(c.openQuestions||[]).filter(q=>dec[q.id]==="Required input"&&OQ[q.id]).map(q=>({k:q.id,label:OQ[q.id]}));
  const sideEffects=(c.sideEffects||[]).filter(s=>dec[s.id]!=="Drop").map(s=>({name:s.name,disp:dec[s.id]||"",deferred:(scope[s.id]||"Build now")==="Defer"}));
  return {capability:c.name||"Register Equipment",command:"RegisterEquipment",pages,oq,sideEffects};
}

(async function(){
  ticker = setInterval(tick, 1000);
  try{
    setStep("Reading spec (capability graph + decisions)");
    const cfg = buildConfig();
    log(`spec → ${cfg.pages.length} screens, ${cfg.pages.reduce((n,p)=>n+p.fields.length,0)} fields`);

    setStep("Preparing workspace");
    // Guarantee a clean start for EVERY iteration: this build gets its own fresh workspace,
    // and we best-effort sweep any leftover ones. A dir still locked by a just-killed npm/ng
    // (Windows EBUSY after Stop) is skipped — harmless, because this run never touches it and
    // the next sweep clears it. The build therefore ALWAYS begins in an empty directory.
    try {
      for (const d of fs.readdirSync(WORK_ROOT)) {
        const p = path.join(WORK_ROOT, d);
        if (p === WORK) continue;
        try { fs.rmSync(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); log("· removed old workspace " + d); }
        catch (e) { log("· old workspace " + d + " is in use — skipping (will sweep next build)"); }
      }
    } catch (e) { /* _build doesn't exist yet — nothing to sweep */ }
    fs.mkdirSync(WORK, { recursive: true });

    // Pin CLI to v20 — its Node engine (^22.12.0) is satisfied by this machine's
    // Node 22.13.1; @latest (v21) needs >=22.22.3 which this box doesn't have.
    setStep("Scaffolding Angular project (npx @angular/cli@20 new)");
    await run("npx", ["-y", "@angular/cli@20", "new", "eqbuild", "--routing=false", "--style=css", "--skip-git", "--skip-tests", "--defaults", "--ssr=false"], WORK);

    setStep("Generating app from spec");
    writeAngularApp(cfg);

    setStep("Compiling (ng build) — this is the long part");
    await run("npx", ["ng", "build", "--base-href", "/prototype/build/", "--output-path", "dist"], APP);

    setStep("Publishing to /prototype/build/");
    fs.rmSync(OUT, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
    const browser = path.join(APP, "dist", "browser");
    const src = fs.existsSync(browser) ? browser : path.join(APP, "dist");
    fs.cpSync(src, OUT, { recursive: true });
    // tidy this run's workspace now that its output is published (best-effort — the
    // start-of-build sweep is the real guarantee, so a locked dir here is harmless).
    try { fs.rmSync(WORK, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch (e) {}

    clearInterval(ticker); phaseIdx = -1;
    status.state = "done"; status.pct = 100; status.etaSec = 0; status.url = "/prototype/build/"; status.finishedAt = new Date().toISOString();
    status.step = "Done — built and published"; log("✅ Done — built and published"); save();
  }catch(e){
    clearInterval(ticker); phaseIdx = -1;
    status.state = "error"; status.error = String(e.message || e); status.etaSec = 0; save();
    log("✗ BUILD FAILED: " + status.error);
  }
})();

// ---- generate the Angular source (standalone component wizard) from the config ----
function writeAngularApp(cfg){
  const appDir = path.join(APP, "src", "app");
  // main bootstrap
  fs.writeFileSync(path.join(APP, "src", "main.ts"),
`import { bootstrapApplication } from '@angular/platform-browser';
import { App } from './app/app';
bootstrapApplication(App).catch(e => console.error(e));
`);
  fs.writeFileSync(path.join(APP, "src", "index.html"),
`<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>${cfg.command} — build</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Bitter:wght@600;700&family=Source+Sans+3:wght@400;600;700&display=swap" rel="stylesheet">
</head><body><app-root></app-root></body></html>`);
  fs.writeFileSync(path.join(APP, "src", "styles.css"), VA_CSS);
  // the wizard component — config embedded
  fs.writeFileSync(path.join(appDir, "app.ts"), APP_TS.replace("/*__CONFIG__*/", JSON.stringify(cfg)));
  // remove default component files if present (avoid confusion; main.ts imports ./app/app)
  ["app.component.ts","app.component.html","app.component.css","app.component.spec.ts","app.config.ts","app.routes.ts"].forEach(f=>{ try{ fs.rmSync(path.join(appDir,f),{force:true}); }catch(e){} });
}

const VA_CSS = `
:root{--bg:#f1f1f1;--card:#fff;--ink:#1b1b1b;--dim:#5b616b;--line:#d6d7d9;--navy:#112e51;--accent:#0071bc;--accent2:#2e8540;--err:#e31c3d;--serif:"Bitter",Georgia,serif;--sans:"Source Sans 3","Source Sans Pro",Arial,sans-serif;--rail-w:280px;}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 var(--sans)}
.hd{background:var(--navy);color:#fff;padding:16px 22px;display:flex;align-items:center;gap:12px}
.hd .logo{font-weight:800;border:2px solid #fff;border-radius:4px;padding:2px 8px}
.hd h1{margin:0;font-family:var(--serif);font-size:20px}.hd .sub{opacity:.85;font-size:12px}
.wrap{max-width:1160px;margin:22px auto;padding:0 16px}
.steps{display:flex;gap:6px;margin-bottom:18px;flex-wrap:wrap}
.step{flex:1;min-width:120px;padding:8px;border-radius:8px;background:#e7ecf2;color:var(--dim);font-size:12px;font-weight:600;text-align:center}
.step.active{background:var(--accent);color:#fff}.step.done{background:#dff3e6;color:var(--accent2)}
/* rail layout: rail slides in from the left, form shrinks to fill the rest */
.stage{display:flex;gap:16px;align-items:flex-start}
.rail{width:var(--rail-w);flex-shrink:0;background:var(--card);border:1px solid var(--line);border-top:6px solid var(--accent);border-radius:4px;padding:14px;position:sticky;top:16px}
.rail h3{margin:0 0 8px;font-family:var(--serif);font-size:14px;color:var(--navy);display:flex;justify-content:space-between;align-items:center}
.rail h3 button{font-size:11px;padding:2px 8px;border-radius:4px;border:1px solid var(--line);background:transparent;color:var(--dim);cursor:pointer}
.rail-search{width:100%;padding:7px 9px;font:inherit;font-size:13px;border:2px solid #565c65;margin-bottom:8px}
.rail-search:focus{outline:4px solid #ffbe2e}
.rail-list{max-height:420px;overflow-y:auto;border:1px solid var(--line);border-radius:3px}
.rail-item{padding:7px 10px;font-size:13px;cursor:pointer;border-bottom:1px solid #eee}
.rail-item:hover,.rail-item.hi{background:#e7f0fb;color:var(--navy)}
.rail-empty{padding:10px;font-size:12px;color:var(--dim);text-align:center}
.main{flex:1;min-width:0}
.card{background:#fff;border:1px solid var(--line);border-top:6px solid var(--navy);border-radius:4px;padding:22px 24px}
.card h2{margin:0 0 14px;font-family:var(--serif);color:var(--navy)}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:14px 20px}
.fld{display:flex;flex-direction:column;gap:4px}.fld.full{grid-column:1/-1}
label{font-size:12px;font-weight:700}.fno{color:var(--dim);font-weight:400;font-size:10.5px}
.eg{font-size:10.5px;color:var(--dim)}
input,select{font:inherit;font-size:15px;padding:8px 10px;border:2px solid #565c65;background:#fff;width:100%}
input:focus,select:focus{outline:4px solid #ffbe2e}input[readonly]{background:#f0f0f0;color:var(--dim)}
.rail-trigger{background:#f0f5fb;border-color:var(--accent);cursor:pointer}
.rail-trigger:focus{outline:4px solid #ffbe2e}
.nav{display:flex;justify-content:space-between;margin-top:20px}
button{font:inherit;font-weight:700;padding:11px 22px;border-radius:5px;border:2px solid var(--accent);background:#fff;color:var(--accent);cursor:pointer}
button.primary{background:var(--accent);color:#fff}
.sum{display:grid;grid-template-columns:1fr 1fr;gap:18px}.sg h3{font-size:12px;text-transform:uppercase;color:var(--dim);border-bottom:1px solid var(--line);padding-bottom:4px}
.row{display:flex;justify-content:space-between;font-size:12.5px;padding:2px 0}.row .k{color:var(--dim)}.row .v{font-weight:600}
.oq{background:#e7f6f8;border:1px solid #99deea;border-left:6px solid #00a6d2;border-radius:8px;padding:12px 14px;margin-top:16px}
.oq h3{margin:0 0 6px;font-size:13px;color:var(--navy)}.oq label{display:flex;gap:8px;align-items:center}.oq input{width:auto}
.nb{font-size:9.5px;font-weight:800;text-transform:uppercase;color:#b25000;background:#fff3e0;border:1px solid #f0c98a;border-radius:10px;padding:1px 6px;margin-left:6px}
.bn{margin-top:14px;padding:11px 14px;border-radius:8px;font-weight:600}.bn.ok{background:#dff3e6;color:var(--accent2)}.bn.err{background:#fdeaee;color:var(--err)}.bn.info{background:#eaf1fc;color:var(--accent)}
`;

const APP_TS = `import { Component, HostListener } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
const CFG:any = /*__CONFIG__*/;
@Component({
  selector: 'app-root', standalone: true, imports: [CommonModule, FormsModule],
  template: \`
  <div class="hd"><span class="logo">VA</span><div><h1>{{cfg.command}}</h1><div class="sub">{{cfg.capability}} · POST /equipment · file 6914 (Phase 1)</div></div></div>
  <div class="wrap">
    <div class="steps">
      <div class="step" *ngFor="let t of stepLabels; let i=index" [class.active]="i===step" [class.done]="i<step">{{i+1}}. {{t}}</div>
    </div>
    <div class="stage">
      <!-- LEFT-RAIL LOOKUP PANEL — slides in when a large-pointer field is focused -->
      <div class="rail" *ngIf="railField">
        <h3>{{railField.label}}{{railTotal?' ('+railTotal+')':''}} <button (click)="closeRail()">✕ Close</button></h3>
        <input class="rail-search" type="text" placeholder="Filter…"
               [(ngModel)]="railQ" (ngModelChange)="railSearch()" autocomplete="off">
        <div class="rail-list">
          <div class="rail-item" *ngFor="let o of railOpts; let i=index"
               [class.hi]="i===railHi"
               (click)="railPick(o)"
               (mouseenter)="railHi=i">{{o.display}}</div>
          <div class="rail-empty" *ngIf="railOpts.length===0">
            {{railLoading ? 'Loading…' : (railQ ? 'No matches' : 'Type to search')}}
          </div>
        </div>
      </div>
      <!-- MAIN FORM -->
      <div class="main">
        <div class="card" *ngIf="step < cfg.pages.length">
          <h2>{{cfg.pages[step].title}}</h2>
          <div class="grid">
            <div class="fld" [class.full]="f.type==='lookupType'||f.type==='lookupSelect'" *ngFor="let f of cfg.pages[step].fields">
              <label>{{f.label}} <span class="fno">[fld {{f.fno}}]</span></label>
              <input *ngIf="f.type==='readonly'" [value]="model['entryNumber']||''" readonly>
              <select *ngIf="f.type==='select'" [(ngModel)]="model[f.k]"><option value="">— select —</option><option *ngFor="let o of f.options" [value]="o[0]">{{o[1]}}</option></select>
              <select *ngIf="f.type==='lookupSelect'" [(ngModel)]="model[f.k]"><option value="">{{loaded(f)?'— select —':'loading…'}}</option><option *ngFor="let o of opts(f)" [value]="o.ien">{{o.display}}</option></select>
              <ng-container *ngIf="f.type==='lookupType'">
                <input class="rail-trigger" readonly
                       [value]="railLabel(f)"
                       [placeholder]="'Browse ' + f.label + '…'"
                       (click)="openRail(f)"
                       (keydown.enter)="openRail(f)"
                       title="Click to browse and select">
              </ng-container>
              <input *ngIf="f.type==='date'" type="date" [(ngModel)]="model[f.k]">
              <input *ngIf="f.type==='number'" type="number" [(ngModel)]="model[f.k]">
              <input *ngIf="f.type==='text'" type="text" [(ngModel)]="model[f.k]" [attr.maxlength]="f.maxlen">
              <span class="eg" *ngIf="f.sample">e.g. {{f.sample.value}} — {{f.sample.label}}</span>
            </div>
          </div>
          <div class="nav"><button (click)="back()" [disabled]="step===0">◀ Back</button><button class="primary" (click)="next()">Next ▶</button></div>
        </div>
        <div class="card" *ngIf="step === cfg.pages.length">
          <h2>Confirmation &amp; Submit</h2>
          <div class="sum">
            <div class="sg" *ngFor="let p of cfg.pages"><h3>{{p.title}}</h3>
              <div class="row" *ngFor="let f of p.fields"><span class="k">{{f.label}}</span><span class="v">{{display(f)}}</span></div>
            </div>
          </div>
          <div class="oq"><h3>Ensuing workflows <span class="nb">Phase 2 · not in this build</span></h3>
            <label *ngFor="let q of cfg.oq"><input type="checkbox" [(ngModel)]="model[q.k]"> {{q.label}}</label>
            <div *ngIf="!cfg.oq.length" style="color:var(--dim);font-size:12.5px">No per-item decisions.</div>
            <div *ngFor="let s of cfg.sideEffects" style="font-size:12px;margin-top:4px">{{s.deferred?'⏸ ':''}}{{s.name}} — {{s.disp}} <span class="nb">Phase 2</span></div>
          </div>
          <div class="bn info" *ngIf="saving">Saving…</div>
          <div class="bn ok" *ngIf="ok">✓ Saved. IEN: {{ok.equipmentIEN}} · status {{ok.status}} · lifecycle {{ok.lifecycleStatus}}</div>
          <div class="bn err" *ngIf="err">Submit failed — {{err}}</div>
          <div class="nav"><button (click)="back()">◀ Back</button><button class="primary" (click)="submit()">Submit ▶</button></div>
        </div>
      </div>
    </div>
  </div>\`,
})
export class App {
  cfg:any = CFG; step = 0; model:any = {}; saving=false; ok:any=null; err='';
  // left-rail state
  railField:any = null; railQ = ''; railOpts:any[] = []; railAll:any[] = []; railTotal = 0; railLoading = false; railHi = 0;
  // IEN→display cache so the trigger shows what was picked
  private railCache: Map<string, Map<any,string>> = new Map();

  get stepLabels(){ return this.cfg.pages.map((p:any)=>p.title).concat(['Confirmation & Submit']); }

  constructor(){
    fetch('/equipment/next-ien').then(r=>r.ok?r.json():null).then(d=>{ if(d&&d.ien!=null) this.model['entryNumber']=d.ien; }).catch(()=>{});
    this.cfg.pages.forEach((p:any)=>p.fields.forEach((f:any)=>{ if(f.type==='lookupSelect') this.loadAll(f); }));
  }

  // opts stored in a component Map (not mutated onto the CFG const) so change detection reliably fires
  optsMap: Map<string, any[]> = new Map();
  loadedSet: Set<string> = new Set();
  loadAll(f:any){
    fetch('/lookup/'+encodeURIComponent(f.table)+'?all=1')
      .then(r=>r.ok?r.json():{items:[]})
      .then((res:any)=>{
        const items = Array.isArray(res.items) ? res.items : (Array.isArray(res) ? res : []);
        this.optsMap.set(f.table, items); this.loadedSet.add(f.table);
      })
      .catch(()=>{ this.loadedSet.add(f.table); });
  }
  opts(f:any):any[]{ return this.optsMap.get(f.table)||[]; }
  loaded(f:any):boolean{ return this.loadedSet.has(f.table); }

  openRail(f:any){
    this.railField = f; this.railQ = ''; this.railAll = []; this.railOpts = []; this.railTotal = 0; this.railHi = 0;
    if(!this.railCache.has(f.k)) this.railCache.set(f.k, new Map());
    // load full list on open — user can scroll through all options immediately
    this.railLoading = true;
    fetch('/lookup/'+encodeURIComponent(f.table)+'?all=1')
      .then(r=>r.ok?r.json():{items:[],total:0})
      .then((res:any)=>{
        const items = Array.isArray(res.items) ? res.items : (Array.isArray(res) ? res : []);
        this.railAll = items; this.railOpts = items; this.railTotal = res.total ?? items.length; this.railLoading = false; this.railHi = 0;
      }).catch(()=>{ this.railLoading = false; });
  }
  closeRail(){ this.railField = null; }
  railSearch(){
    // filter client-side from the already-loaded full list (fast, no extra network call)
    const q = this.railQ.toUpperCase();
    this.railOpts = q ? this.railAll.filter((o:any)=>o.display.toUpperCase().includes(q)) : this.railAll;
    this.railHi = 0;
  }
  railPick(o:any){
    if(!this.railField) return;
    const f = this.railField;
    this.model[f.k] = o.ien;
    if(!this.railCache.has(f.k)) this.railCache.set(f.k, new Map());
    this.railCache.get(f.k)!.set(o.ien, o.display);
    this.closeRail();
  }
  railLabel(f:any): string {
    const v = this.model[f.k];
    if(v == null || v === '') return '';
    return this.railCache.get(f.k)?.get(v) || String(v);
  }
  @HostListener('document:keydown.escape') onEsc(){ this.closeRail(); }

  display(f:any){
    let v = this.model[f.k];
    if(f.type==='readonly') v = this.model['entryNumber'];
    if(v==null||v==='') return '—';
    if(f.type==='lookupType'){ const lbl = this.railCache.get(f.k)?.get(v); return lbl ? lbl+' (IEN '+v+')' : String(v); }
    if(f.options){ const h = f.options.find((o:any)=>o[0]==v); if(h) return h[1]; }
    if(f.type==='lookupSelect'){ const h = this.opts(f).find((o:any)=>o.ien==v); if(h) return h.display; }
    return v;
  }
  back(){ if(this.step>0){ this.closeRail(); this.step--; } }
  next(){ this.closeRail(); this.step++; }
  submit(){ this.saving=true; this.ok=null; this.err='';
    const body:any={}; Object.keys(this.model).forEach(k=>body[k]=this.model[k]);
    fetch('/equipment',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})
      .then(async r=>({ok:r.ok,d:await r.json().catch(()=>({}))}))
      .then(x=>{ this.saving=false; if(x.ok && String(x.d.status).toUpperCase()==='OK' && x.d.equipmentIEN!=null) this.ok=x.d; else this.err=x.d.error||x.d.message||'backend error'; })
      .catch(e=>{ this.saving=false; this.err=String(e.message||e); }); }
}
`;
