"use strict";
// API layer spec: legacy discovery + a REST service proposal. Reads ONLY the graph, the Phase 1
// slice of the record (data-field dispositions) and implemented services — never a higher layer's decisions.
const { cap } = require("../rules");

const TARGET = "RegisterEquipment";
const DROPDOWN_MAX = 60;

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

function dataSlice(graph, record) {
  const ids = new Set((cap(graph).data || []).map(d => d.id));
  return Object.fromEntries(Object.keys(record.dec || {}).filter(id => ids.has(id)).sort().map(id => [id, record.dec[id]]));
}
const phase1 = (graph, record) => ({ dec: dataSlice(graph, record) });
const included = (graph, r1) => (cap(graph).data || []).filter(d => d.kind === "field" && r1.dec[d.id] !== "Omit");

function requestContract(graph, record) {
  return included(graph, phase1(graph, record)).map(d => ({ id: d.id, field: String(d.field), name: d.name }));
}

function proposedServices(graph) {
  return (cap(graph).sideEffects || []).filter(s => s.writes)
    .map(s => ({ id: "write:" + s.writes.file, what: `write file ${s.writes.file} — ${s.name}`, source: s.call }));
}

function buildApiSpec(graph, record, implemented) {
  const c = cap(graph), r1 = phase1(graph, record);
  const omit = new Set((c.data || []).filter(d => d.kind === "field" && r1.dec[d.id] === "Omit").map(d => d.id));
  const byId = id => (c.data || []).find(d => d.id === id);
  const pages = (c.formScreens || []).filter(s => s.fields && s.fields.length)
    .map(s => ({ title: s.title, fields: s.fields.map(byId).filter(d => d && !omit.has(d.id)).map(fieldCfg) }));
  const built = (implemented && implemented.api) || [];
  return {
    layer: "api",
    builds: ["REST data service on VADEMO (file 6914)", "Angular data-entry app"],
    owns: { built, proposed: proposedServices(graph).filter(p => !built.some(b => b.id === p.id)) },
    uses: [], needs: [], missing: [], complete: true,
    request: requestContract(graph, record),
    detail: { capability: c.name || "Register Equipment", command: TARGET, pages },
  };
}

function control(d) {
  if (d.enumValues) return "select (dropdown) — options: " + d.enumValues;
  if (d.pointsTo) {
    const n = d.lookupCount, tbl = d.lookupTable ? ` from \`${d.lookupTable}\`` : "";
    const eg = d.sample ? ` · e.g. \`${d.sample.value}\` — ${d.sample.label}` : "";
    if (typeof n === "number") return (n <= DROPDOWN_MAX ? `select (dropdown) — ${n} options${tbl}, fetched via \`GET /lookup\`` : `left-rail lookup panel — ${n} rows${tbl} · \`GET /lookup\``) + eg;
    return "autocomplete / lookup → file " + d.pointsTo + eg;
  }
  if (/date/i.test(d.name) || /Date/.test(d.type || "")) return "date picker";
  if (/Numeric/.test(d.type || "") || /value|cost/i.test(d.name)) return "number";
  return d.type || "text";
}

const LABEL_RULES = [
  "- **Option labels are a UX decision, not a mirror of VistA storage.** An option's label exists to let the operator *recognise the right entry*; it is chosen for helpfulness, not because it is how the field happens to be stored. The stored value is always the IEN, so the label is free to differ from the stored column. Three consequences:",
  "  1. **Never show a bare code.** Coded reference sets store a terse code (`AMAF`, `3110`, `1750`) that means nothing on its own, while a description column sits alongside it. Render **`CODE — Description`**: FUND → `NX_FUND_CODE — BRIEF_DESCRIPTION` (\"4014 — Canteen Service\"); BUDGET OBJECT CODE → `CAPITALIZED_BUDGET_OBJECT_CODE — BOC_TITLE` (\"3110 — TRANSPORTATION EQUIPMENT, PASSENGER VEHICLES\"); STANDARD GENERAL LEDGER → `ACCOUNT — ACCOUNT_DESCRIPTION` (\"1750 — NONEXPENDABLE EQUIPMENT\").",
  "  2. **Add a descriptor that aids recognition, even if sparsely populated.** LOCATION → `ROOM_NUMBER — FUNCTION_NAME` (\"201 — OFFICE, PHYSICIAN\"); where FUNCTION_NAME is blank the label degrades cleanly to the bare room number. A descriptor that helps on some rows and is omitted on the rest beats no descriptor at all.",
  "  3. **Don't append a column just because it exists.** Verify it actually adds information. ENG_SPACE's `BUILDING_NUMBER` was rejected: room numbers already embed the building (`304-110` = room 304, bldg 110) in 229 of 234 rows, and no room number repeats — so appending it would restate the room and disambiguate nothing.",
  "  When profiling a lookup file, list **all** its columns, then pick the label that a clerk would find most recognisable — don't settle for the storage column by default.",
];
const LEFT_RAIL = [
  "- **Left-rail lookup panel** (large pointer fields, > 60 rows): when the operator focuses a large-pointer field a collapsible panel slides in from the left alongside the form. Behaviour:",
  "  - **Header shows total count**: e.g. \"MANUFACTURER (5,175)\" so the operator knows the full size of the list before filtering.",
  "  - **On open (empty filter): loads ALL options** and shows them in a scrollable list — the operator can scroll through the full list without typing anything. This mirrors the VistA `??` full-list browse.",
  "  - **On typing: live-filters** the full list client-side (no extra network call once loaded); shows matching rows only.",
  "  - Selecting a row fills the field and collapses the panel. Escape also closes the panel.",
  "  - `GET /lookup/<file>?all=1` is used on open to load the full option set; response format is `{ items: [{ ien, display }], total: N }`. Filtered searches (`?q=<term>`) return the same format.",
  "  - Keyboard-navigable (arrow keys to move highlight, Enter to pick).",
];
const LOOK_AND_FEEL = [
  "Adopt the **U.S. Web Design System (USWDS v3) with the VA.gov theme** — this is a federal VA application, so the visual language must match VA.gov (reference: the Million Veteran Program site). Recommended: the `@department-of-veterans-affairs/component-library` (VA design system) or `@uswds/uswds` for tokens + components.",
  "- **Color tokens:** header/footer band navy `#112e51`; accent section band blue `#2a5599` (lighter `#4a6ba5`); primary action (buttons/links) `#0071bc`, hover/active `#205493`; page background `#f1f1f1`; content surfaces white `#ffffff`; ink `#1b1b1b`, muted `#5b616b`, borders `#d6d7d9`; crisis/error red `#e31c3d`.",
  "- **Typography:** serif headings (`Bitter` / `Merriweather`), sans body (`Source Sans Pro`); base 16–17px, line-height 1.5; bold section headings.",
  "- **Layout:** centered container (max-width ~1000px); top utility bar (Contact Us / Sign In) → navy primary nav → content in alternating white / blue section bands; white cards with 1px `#d6d7d9` border + subtle shadow; generous vertical rhythm.",
  "- **App shell:** keep it minimal — just a navy app header showing the app title. Do NOT add a VA masthead/\"official website\" strip, a crisis-line banner, footer link columns, or a contact/phone block; this is an internal data-entry tool, only the VA visual language (color, type, components) is wanted.",
  "- **Form components (USWDS):** labels **bold, above** each control; large inputs (≥44px touch target), 2px border, focus ring `#0071bc`; wizard steps → USWDS **Step indicator** (numbered, current highlighted); primary Next/Submit = solid primary button, Back = outline button; lookup combobox / left-rail → USWDS **combo box**, enum selects → USWDS **dropdown**; confirmation → USWDS **Summary box**; success → green alert, errors → red alert.",
  "- **Accessibility:** Section 508 / WCAG 2.1 AA — semantic landmarks, every control labeled, visible focus, ≥4.5:1 text contrast, fully keyboard-navigable wizard and lookups.",
];

function renderApi(graph, record, spec) {
  const c = cap(graph), r1 = phase1(graph, record), w = graph.workflow;
  const dataFields = included(graph, r1);
  const xrefs = (c.data || []).filter(d => d.kind === "crossReference" && r1.dec[d.id] !== "Omit");
  const L = [];
  L.push(`# API layer spec — ${TARGET}`);
  L.push(`Source: ${w.name} · legacy ${c.entryPoint ? c.entryPoint.dispatch : ""} (file 6914). Generated from the capability graph and Phase 1 decisions only — legacy discovery plus a REST service proposal.`);
  L.push("");
  L.push("## Builds"); spec.builds.forEach(b => L.push(`- ${b}`)); L.push("");
  L.push("## Owns — built services"); spec.owns.built.forEach(s => L.push(`- \`${s.endpoint}\` — ${s.what} (\`${s.id}\`)`)); L.push("");
  L.push("## Owns — proposed services (from legacy discovery, not built)");
  if (!spec.owns.proposed.length) L.push("- none");
  spec.owns.proposed.forEach(p => L.push(`- ${p.what} — from \`${p.source}\` (\`${p.id}\`)`));
  L.push("");
  L.push("## Uses"); L.push("- none — bottom layer"); L.push("");
  L.push("## Needs from lower layers"); L.push("- none — bottom layer"); L.push("");

  L.push("## Phase 1 · Command & REST contract");
  L.push(`- Command: \`${TARGET}\``);
  L.push("- `POST /equipment` — create; body = the request data contract below; returns the response contract below.");
  L.push("- `GET /equipment/next-ien` — returns `{ status, ien }`; the form pre-fetches this to show the IEN display-only (server re-allocates authoritatively on POST).");
  L.push("- `GET /lookup/{file}?q=<term>` — filtered search; returns `{ items: [{ ien, display }], total: N }` where `total` is the full file size (pre-filter).");
  L.push("- `GET /lookup/{file}?all=1` — full list; returns `{ items: [...all options...], total: N }`. Used on rail open (large pointers) and `<select>` load (small pointers).");
  const ptrs = dataFields.filter(d => d.pointsTo && typeof d.lookupCount === "number");
  const files = pred => [...new Set(ptrs.filter(pred).map(d => d.lookupTable || d.pointsTo))].map(n => "`" + n + "`").join(", ");
  const large = files(d => d.lookupCount > DROPDOWN_MAX), small = files(d => d.lookupCount <= DROPDOWN_MAX);
  if (large || small) L.push(`- Files: ${[large && large + " (large, left-rail)", small && small + " (small, select)"].filter(Boolean).join("; ")}.`);
  L.push("");

  L.push("## Phase 1 · REST request — data contract");
  const inScreens = new Set(); (c.formScreens || []).forEach(s => (s.fields || []).forEach(f => inScreens.add(f)));
  const serverNote = { ".01": "system-allocated IEN (= ENTRY NUMBER)", "5.1": "canonical serial, derived from SERIAL (uppercased, spaces and punctuation stripped, one trailing space, cut to 30) — drives the FC duplicate index", ".5": "filing user (DUZ)", ".6": "filing date/time" };
  const operatorFields = dataFields.filter(d => inScreens.has(d.id) && d.field !== ".01");
  const serverFields = dataFields.filter(d => !(inScreens.has(d.id) && d.field !== ".01"));
  if (operatorFields.length) { L.push("**Operator-entered** — the form POSTs these:"); L.push("```"); operatorFields.forEach(d => L.push(`${d.name || d.field}   [fld ${d.field}]`)); L.push("```"); }
  if (serverFields.length) { L.push("**Server-populated** — set by the write, NOT on the form (do not add inputs for these):"); L.push("```"); serverFields.forEach(d => L.push(`${d.name || d.field}   [fld ${d.field}]${serverNote[d.field] ? "  — " + serverNote[d.field] : "  — server-set"}`)); L.push("```"); }
  if (!operatorFields.length && !serverFields.length) L.push("- (no fields selected)");
  const xrefNames = xrefs.map(x => x.index || x.name).filter(Boolean);
  if (xrefNames.length) L.push(`Query filters (from cross-references): ${xrefNames.map(n => "`" + n + "`").join(", ")}.`);
  L.push("");

  L.push("## Phase 1 · REST response — data contract");
  L.push("```"); L.push("{ status, equipmentIEN, lifecycleStatus }"); L.push("```");
  L.push("- `status` — `\"OK\"` or an error code/message.");
  L.push("- `equipmentIEN` — new IEN allocated in `^ENG(6914)`; drives the confirmation page.");
  L.push("- `lifecycleStatus` — outcome of the write (created / error).");
  L.push("");

  L.push("## Phase 1 · Front end (Angular)");
  L.push("- Angular 21 SPA (matches the existing Vista_Equipment stack); calls `POST /equipment` via `HttpClient` through the dev proxy.");
  L.push(`- **Form-control convention:** set-of-codes fields → native \`<select>\` (dropdown); pointer/lookup fields with **≤ ${DROPDOWN_MAX} rows** → \`<select>\` (populated via \`GET /lookup/<file>?all=1\`); pointer/lookup fields with **> ${DROPDOWN_MAX} rows** → **left-rail lookup panel** (see below). Dates → date picker; numerics → number input. Each field below states its resolved control.`);
  LABEL_RULES.forEach(l => L.push(l));
  LEFT_RAIL.forEach(l => L.push(l));
  const entry = (c.formScreens || []).filter(s => s.fields && s.fields.length);
  const fieldById = id => (c.data || []).find(x => x.id === id);
  if (entry.length) {
    L.push("- Container component `register-equipment` drives a **multi-step wizard**. **Rule: each legacy ScreenMan screen becomes one Angular page** — preserving the operator's screen-by-screen entry flow. A **confirmation page is always appended** as the final step.");
    entry.forEach(s => {
      L.push("");
      L.push(`### Page ${s.screen} — ${s.title}  _(← ScreenMan screen ${s.screen} of ${entry.length})_`);
      s.fields.forEach(fid => {
        const d = fieldById(fid); if (!d || r1.dec[d.id] === "Omit") return;
        L.push(`- **${d.name}** \`[fld ${d.field}]\` — ${d.field === ".01" ? "display-only (system-allocated IEN)" : control(d)}${d.condition ? ` · _${d.condition}_` : ""}`);
      });
    });
    L.push("");
    L.push(`### Page ${entry.length + 1} — Confirmation & Submit`);
    L.push("- Read-only summary of every entered field, grouped under the page headings above — the operator reviews before committing.");
    L.push("- **Submit** → `POST /equipment`; show \"Saving…\", then the new **IEN + lifecycle status**, or an error banner on failure.");
  } else {
    L.push("- Single `register-equipment` form bound to the data-contract fields above (no ScreenMan screen structure detected); append a confirmation step before submit.");
  }
  L.push("");
  L.push("- Form uses template-driven bindings (`FormsModule`), matching the existing Vista_Equipment stack.");
  L.push("- Fetch the next IEN up front (`GET /equipment/next-ien`) so page 1 can show it display-only; the POST allocates authoritatively server-side.");
  L.push("- Validation is DEVELOPER-REVIEWED, not assumed — see \"Input requirements & validation\" below. Server (FileMan) remains the source of truth.");
  L.push("");

  const ff = dataFields.filter(d => d.field !== ".01");
  L.push("## Phase 1 · Input requirements & validation ==developer review==");
  L.push("What the legacy actually enforces — at the DD (field definition) and routine (runtime) level. **Confirm whether the modern app should keep each, tighten it under current regulation/policy, or relax it. None of this is auto-applied.**");
  const req = ff.filter(d => d.required);
  L.push(`- **Required (DD):** ${req.length ? req.map(d => d.name).join(", ") : "none — every operator field is optional at the DD level (ENTRY NUMBER is system-allocated). Making any field mandatory is a modern-policy choice."}`);
  const lenF = ff.map(d => { const m = /\((\d+)\s*-\s*(\d+)\)/.exec(d.type || ""); return m ? `${d.name} ${m[1]}–${m[2]}` : null; }).filter(Boolean);
  if (lenF.length) L.push(`- **Length bounds (DD):** ${lenF.join("; ")}.`);
  const enumF = ff.filter(d => d.enumValues); if (enumF.length) L.push(`- **Set-of-codes — value must be one of the listed options:** ${enumF.map(d => d.name).join(", ")}.`);
  const ptrF = ff.filter(d => d.pointsTo); if (ptrF.length) L.push(`- **Pointer — must resolve to a real entry:** ${ptrF.map(d => d.name + " → " + String(d.pointsTo).split(" ")[0]).join(", ")}.`);
  const dateF = ff.filter(d => /date/i.test(d.name) || /Date/.test(d.type || "")); if (dateF.length) L.push(`- **Dates — FileMan date validity:** ${dateF.map(d => d.name).join(", ")}.`);
  const serialF = ff.find(d => d.id === "FLD.serial"); if (serialF && serialF.legacyInput) L.push(`- **SERIAL (routine \`ASKSER\`):** ${serialF.legacyInput}`);
  L.push("- **Modern validation = your call.** e.g. should SERIAL become *required* and/or *hard-unique* (the legacy is neither)? should any optional field be mandatory under current policy? The legacy behavior above is the baseline to review, not a mandate.");
  L.push("");

  L.push("## Phase 1 · Look & feel (design system)");
  LOOK_AND_FEEL.forEach(l => L.push(l));
  L.push("");
  L.push("## Acceptance criteria — differential vs. legacy");
  L.push("- Creates a record in `^ENG(6914)` with a new IEN (next-IEN = `$P(^ENG(6914,0),\"^\",3)+1`).");
  if (dataFields.some(d => d.id === "FLD.serial")) L.push("- Files SERIAL (field 5) and maintains the `F` + `FC` cross-references; `FC` uses the canonical serial ASKSER builds — uppercased, spaces and punctuation stripped, one trailing space appended, cut to 30 characters — for duplicate detection.");
  L.push("- Given identical sandbox input, target output & state match the legacy option on all of the above.");
  L.push("");
  L.push("## Traceability");
  L.push(`- \`${TARGET}\` ← ${c.id}, ${c.entryPoint ? c.entryPoint.id : ""}, ${c.entryPoint ? c.entryPoint.dispatch : ""}`);
  return L.join("\n") + "\n";
}

module.exports = { TARGET, dataSlice, requestContract, buildApiSpec, renderApi };
