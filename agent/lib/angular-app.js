"use strict";
// Angular source for the Phase 1 data-entry app, generated from the API spec's build config.

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

function angularFiles(cfg){
  return {
    "src/main.ts":
`import { bootstrapApplication } from '@angular/platform-browser';
import { App } from './app/app';
bootstrapApplication(App).catch(e => console.error(e));
`,
    "src/index.html":
`<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>${cfg.command} — build</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Bitter:wght@600;700&family=Source+Sans+3:wght@400;600;700&display=swap" rel="stylesheet">
</head><body><app-root></app-root></body></html>`,
    "src/styles.css": VA_CSS,
    "src/app/app.ts": APP_TS.replace("/*__CONFIG__*/", JSON.stringify(cfg)),
  };
}
const DEFAULT_COMPONENT_FILES = ["app.component.ts","app.component.html","app.component.css","app.component.spec.ts","app.config.ts","app.routes.ts"];

module.exports = { angularFiles, DEFAULT_COMPONENT_FILES };
