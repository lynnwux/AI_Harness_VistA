# Legacy Capability Graph — schema

The handoff artifact produced by the VistA Service Enablement Workbench for each traced workflow. It is the durable, evidence-bearing model of a legacy capability — not prose, not chat history.

## Node hierarchy

```
WORKFLOW
  └─ INTERACTION
       └─ LEGACY CAPABILITY
            ├─ OPTION / ENTRY POINT
            ├─ ROUTINE
            ├─ DATA
            │    ├─ File / Global
            │    ├─ Field
            │    ├─ Cross-reference
            │    └─ access:  read | write | create
            ├─ BUSINESS RULE
            ├─ SECURITY / POLICY
            ├─ SIDE EFFECT
            └─ DEPENDENCY
```

- **WORKFLOW** — a user journey (e.g. Equipment Management → New Inventory Entry).
- **INTERACTION** — one user step within the workflow (select option, enter field, confirm prompt).
- **LEGACY CAPABILITY** — the reusable unit an interaction exercises (e.g. CreateEquipment). Capabilities are shared across workflows; that sharing is how divergence/convergence is detected.
- Child node types describe *how* the capability is implemented and *what* it touches.

## Mandatory metadata (`meta`) on every node and relationship

| Field | Values / form | Meaning |
|-------|---------------|---------|
| `provenance` | `observed` \| `derived` \| `AI-inferred` \| `verified` | how this fact was established (see below) |
| `confidence` | 0.0–1.0 | calibrated confidence in the fact |
| `evidence` | list of source references | what the claim rests on (file:line, routine^tag, SQL, screenshot, API round-trip) |
| `workflows` | list of workflow ids | workflow(s) in which this node was observed |
| `conditions` | list (may be empty) | gates that must hold for this edge to fire (keys, params, field values) |

### Provenance states

- **observed** — directly seen in captured evidence: routine source, menu output, a navigation screenshot.
- **derived** — computed from a definition, not a claim: FileMan data-dictionary → field number / global node+piece / cross-reference mapping.
- **AI-inferred** — model reasoning or recommendation not directly evidenced (e.g. candidate REST endpoint, suggested interop production). Lowest default confidence; must be promoted by verification before implementation.
- **verified** — empirically confirmed against the live system via an API round-trip (Atelier SQL / `/doc` read / record diff). Highest confidence.

A node may carry more than one provenance chain in `evidence` (e.g. a global write that is both *observed* in source and *verified* against the live record). Record the strongest as `provenance` and keep the others in `evidence`.

### Determinacy (orthogonal to provenance)

Provenance says *how we know*; **determinacy says whether the system actually decides the behavior**. Business rules, side effects and decision edges carry a `determinacy`:

- **coded** — outcome fully determined by code/DD at runtime, no human input (capture the exact condition).
- **data-driven** — determined by a site-configurable value/param (the *value* is data; the *policy behind it* may still be a question).
- **user-decision** — a runtime prompt the user answers; the code runs whichever they pick, but the **selection criteria are not in the code**.
- **coded-eligibility + user-confirmed** — a coded precondition gates *whether the user is asked*, but the final action is still user-confirmed.

Prose from `^DD` field DESCRIPTIONs / help documents *intent* but is not executable → treat as `documented`, never `coded`.

### Open questions (`openQuestions[]` on a capability)

Discovery is complete only when the machine-undecidable decisions are **enumerated, not guessed**. Any `user-decision` or ambiguous branch produces an open-question node:

```
{ id, decisionPoint, promptText, default, codedBehavior, whatIsNotCoded,
  candidateInterpretations[], askSME:true, meta }
```

These are rendered as amber **"needs confirmation"** nodes in the graph and become explicit **required inputs / elicited rules** in the modernization target — never auto-encoded `IF`s. A prompt's default (`YES//`) is a weak intent hint, not a rule.

> Worked example: the "Create an Incoming Inspection Work Order?" decision is `user-decision` (OQ.WorkOrderPolicy) — the mechanism and gate are coded/data-driven, but *when* to create one is site policy. The earlier `RULE.Inspection` (LOCKOUT→WO) was removed as a misclassification: that logic lives in the modern production, not legacy `ENEQ1`.

## Relationships (edges)

Edges are typed and also carry `meta`:

- `WORKFLOW —has→ INTERACTION`
- `INTERACTION —exercises→ CAPABILITY`
- `CAPABILITY —enteredVia→ OPTION`, `—implementedBy→ ROUTINE`, `—touches→ DATA`, `—governedBy→ BUSINESS_RULE`, `—requires→ SECURITY`, `—triggers→ SIDE_EFFECT`, `—dependsOn→ DEPENDENCY`
- `SIDE_EFFECT —candidateCapability→ CAPABILITY` (a side effect that is itself a modernizable capability)

## DD Survey — formal discovery step

Between **Trace Routines** and **Enumerate Data Nodes**, the workbench performs a **Data Dictionary Survey**. VistA is self-describing: the `^DD` global and the IRIS compiled class projection together yield, for every file, a machine-readable field manifest.

### What to collect

| Source | How | Gives you |
|--------|-----|-----------|
| `VISTA.<ClassName>.cls` (Atelier `GET /doc`) | Read class docstrings: `FileMan Field Label:` + `FileMan Field Number:` | Authoritative field numbers + labels |
| `%Dictionary.CompiledProperty` SQL | `WHERE parent = 'VISTA.<ClassName>'` | SqlFieldName, Type, Required, pointer targets |
| `%Dictionary.CompiledProperty` DISPLAYLIST param | Same query | Enum values for SET-OF-CODES fields |
| `^DD(file,field,0)` piece 4 | ObjectScript or DDProbe class | Global storage node + piece offset |

All fields from the survey enter the graph as `"provenance": "derived"` with `"evidence": ["DD: FileMan Field Number X (<class>, <date>)"]`. They are promoted to `"verified"` only after an Atelier round-trip confirms a live value.

### formScreens[] — ScreenMan layout

A capability that drives a ScreenMan form adds `formScreens[]` alongside `data[]`:

```json
{ "screen": 1,
  "title": "Equipment Identity & Acquisition",
  "fields": ["FLD.manufacturer", "FLD.model", "FLD.serial", ...],
  "note": "ScreenMan screen 1 of 3; ENTRY NUMBER display-only." }
```

`formScreens` encodes which fields appear on which screen and in what order — information the compiled class does not carry. It is derived from observed ScreenMan navigation screenshots, `^DD` form/template files (if accessible), or cross-referenced with the modernized Angular component's screen groupings. The spec generator uses it to produce a multi-step form structure.

## Instances

- [`new-inventory-entry.json`](new-inventory-entry.json) — Equipment Management → New Inventory Entry (`EQAD^ENEQ1`, file 6914).

Each instance validates against this schema. Downstream, the graph feeds: REST candidate identification (the FileMan seams), the suggested IRIS interoperability production (rules ← gates, operations ← side effects), and differential verification.
