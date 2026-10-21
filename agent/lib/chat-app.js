"use strict";
// Angular source for the AI chat app, generated from the AI spec's detail.questions.
// The app posts to same-origin /ai/quick/<id> and /ai/chat — no host, login or token anywhere.

// Identical design tokens to angular-app.js (VA design system look).
const VA_CSS = `
:root{--bg:#f1f1f1;--card:#fff;--ink:#1b1b1b;--dim:#5b616b;--line:#d6d7d9;--navy:#112e51;--accent:#0071bc;--accent2:#2e8540;--err:#e31c3d;--serif:"Bitter",Georgia,serif;--sans:"Source Sans 3","Source Sans Pro",Arial,sans-serif;}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 var(--sans)}
.hd{background:var(--navy);color:#fff;padding:16px 22px;display:flex;align-items:center;gap:12px}
.hd .logo{font-weight:800;border:2px solid #fff;border-radius:4px;padding:2px 8px}
.hd h1{margin:0;font-family:var(--serif);font-size:20px}
.wrap{max-width:900px;margin:22px auto;padding:0 16px}
.quick-btns{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:18px}
.q-btn{font:inherit;font-weight:700;padding:9px 16px;border-radius:5px;border:2px solid var(--accent);background:#fff;color:var(--accent);cursor:pointer;font-size:14px}
.q-btn:hover{background:var(--accent);color:#fff}.q-btn:disabled{opacity:.5;cursor:default}
.chat-area{display:flex;gap:8px;margin-bottom:20px}
.chat-input{flex:1;font:inherit;font-size:15px;padding:9px 12px;border:2px solid #565c65;background:#fff;min-width:0}
.chat-input:focus{outline:4px solid #ffbe2e}.chat-input:disabled{background:#f0f0f0}
button{font:inherit;font-weight:700;padding:10px 20px;border-radius:5px;border:2px solid var(--accent);background:#fff;color:var(--accent);cursor:pointer}
button.primary{background:var(--accent);color:#fff}button:disabled{opacity:.5;cursor:default}
.answer-card{background:var(--card);border:1px solid var(--line);border-top:4px solid var(--navy);border-radius:4px;padding:18px 20px;margin-bottom:14px}
.reply-text{margin:0 0 10px;line-height:1.6}
.err-notice{background:#fdeaee;color:var(--err);border:1px solid #f5c6cb;border-radius:4px;padding:9px 12px;margin-bottom:10px;font-size:14px}
.trunc-note{background:#eaf1fc;color:var(--accent);border:1px solid #b8d4f0;border-radius:4px;padding:8px 12px;margin-bottom:10px;font-size:13px}
.result-table{width:100%;border-collapse:collapse;font-size:13px;margin-bottom:10px}
.result-table th{background:var(--navy);color:#fff;padding:6px 10px;text-align:left;font-size:12px}
.result-table td{padding:5px 10px;border-bottom:1px solid var(--line)}
.result-table tr:nth-child(even) td{background:#f7f9fb}
.sql-details{margin-top:8px;font-size:13px}
.sql-details summary{cursor:pointer;color:var(--dim);user-select:none;padding:2px 0}
.sql-details pre{background:#f4f4f4;border:1px solid var(--line);border-radius:3px;padding:10px 12px;overflow-x:auto;font-size:12px;margin:6px 0 0}
`;

// The component TypeScript. Placeholders are replaced by chatAppFiles:
//   /*__QUESTIONS__*/  → JSON array of { id, wording, quickUrl }
//   /*__TITLE__*/      → title string (plain text, HTML-escaped before insertion)
//   /*__ROW_CAP__*/    → numeric row cap (e.g. 200), used in the truncation notice
const APP_TS = `import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';

const QUESTIONS: any[] = /*__QUESTIONS__*/;
const ROW_CAP: number = /*__ROW_CAP__*/;

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, FormsModule],
  template: \`
  <div class="hd"><span class="logo">VA</span><div><h1>/*__TITLE__*/</h1></div></div>
  <div class="wrap">
    <div class="quick-btns">
      <button class="q-btn" *ngFor="let q of questions" (click)="askQuick(q)" [disabled]="busy">{{q.wording}}</button>
    </div>
    <div class="chat-area">
      <input class="chat-input" type="text" [(ngModel)]="chatMsg" (keydown.enter)="askChat()"
             placeholder="Ask a question about the equipment inventory…" [disabled]="busy" autocomplete="off">
      <button class="primary" (click)="askChat()" [disabled]="busy || !chatMsg.trim()">Send</button>
    </div>
    <div *ngFor="let ans of answers" class="answer-card">
      <p class="reply-text" *ngIf="ans.reply">{{ans.reply}}</p>
      <div class="err-notice" *ngIf="ans.error">{{ans.error}}</div>
      <p class="trunc-note" *ngIf="ans.truncated">
        Showing the first {{rowCap}} rows — there are more; refine the question to see the rest.
      </p>
      <table class="result-table" *ngIf="ans.columns && ans.rows && ans.rows.length">
        <thead><tr><th *ngFor="let c of ans.columns">{{c}}</th></tr></thead>
        <tbody><tr *ngFor="let r of ans.rows"><td *ngFor="let v of r">{{v}}</td></tr></tbody>
      </table>
      <details class="sql-details" *ngIf="ans.sql">
        <summary>SQL used</summary>
        <pre>{{ans.sql}}</pre>
      </details>
    </div>
  </div>\`,
})
export class App {
  questions: any[]  = QUESTIONS;
  rowCap:    number = ROW_CAP;
  sessionId: string = crypto.randomUUID();
  chatMsg:   string = '';
  busy:      boolean = false;
  answers:   any[]  = [];

  askQuick(q: any): void {
    this.busy = true;
    fetch(q.quickUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: this.sessionId }),
    })
      .then(r => r.json())
      .then((d: any) => { this.answers.unshift(d); this.busy = false; })
      .catch((e: any) => { this.answers.unshift({ reply: '', error: String(e?.message ?? e) }); this.busy = false; });
  }

  askChat(): void {
    const msg = this.chatMsg.trim();
    if (!msg) return;
    this.chatMsg = '';
    this.busy = true;
    fetch('/ai/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: this.sessionId, message: msg }),
    })
      .then(r => r.json())
      .then((d: any) => { this.answers.unshift(d); this.busy = false; })
      .catch((e: any) => { this.answers.unshift({ reply: '', error: String(e?.message ?? e) }); this.busy = false; });
  }
}
`;

/**
 * Generate the four Angular source files for the equipment-inventory chat app.
 *
 * @param {object}   opts
 * @param {Array}    opts.questions  Array of { id, wording } objects from ai.json detail.questions
 * @param {string}   [opts.title]   Page title (default: "Equipment inventory assistant")
 * @param {number}   [opts.rowCap]  Server row cap (default: 200 — matches global constraint)
 * @returns {{ "src/main.ts", "src/index.html", "src/styles.css", "src/app/app.ts" }}
 */
function chatAppFiles({ questions, title = "Equipment inventory assistant", rowCap = 200 }) {
  // Embed only id, wording and the pre-built quickUrl — no SQL or params that could change
  const questionsJson = JSON.stringify(
    (questions || []).map(q => ({
      id:       q.id,
      wording:  q.wording,
      quickUrl: "/ai/quick/" + q.id,
    }))
  );

  // Escape title for safe embedding in both the HTML title tag and the Angular template
  const safeTitle = String(title)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  return {
    "src/main.ts":
`import { bootstrapApplication } from '@angular/platform-browser';
import { App } from './app/app';
bootstrapApplication(App).catch(e => console.error(e));
`,
    "src/index.html":
`<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>${safeTitle}</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Bitter:wght@600;700&family=Source+Sans+3:wght@400;600;700&display=swap" rel="stylesheet">
</head><body><app-root></app-root></body></html>`,
    "src/styles.css": VA_CSS,
    "src/app/app.ts": APP_TS
      .replace("/*__QUESTIONS__*/", questionsJson)
      .replace("/*__TITLE__*/",    safeTitle)
      .replace("/*__ROW_CAP__*/",  String(rowCap)),
  };
}

module.exports = { chatAppFiles };
