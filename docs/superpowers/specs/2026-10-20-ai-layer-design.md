# AI layer (piece 3): an equipment inventory chatbot on IRIS AI Hub

Date: 2026-10-20 · Status: draft for review

## Intent

The workbench has built two layers from the legacy *New Inventory Entry* capability: the API layer (the
Angular entry form over the Harness REST service on VistA) and the orchestrator layer (the IRIS production
`EquipmentEntry.Production` in `iris-ai-hub`, verified by a delivered bulletin email). The third layer is a
chatbot that answers questions about the equipment inventory — FileMan file 6914 — on IRIS AI Hub.

It is designed the same way as the other two layers: the developer decides it in the Decide page's chat, its
layer spec renders live on the AI tab, and a 🔨 build on that tab generates, deploys and verifies it.

The model to follow is the AI Hub prototype in `C:\Users\xwu\Develop\Vista-Engineering-IRIS`
(`Equipment.Agent.RoutingAgent`, `Equipment.Agent.Tools`, `equipment-intelligence-agent.md`): a `%AI.Agent`
on Bedrock with a `%AI.ToolSet` of SQL query tools over VADEMO's 6914 tables, with conversation sessions kept
in IRIS. Follow its patterns for the agent, tools and sessions; do not copy its data assumptions (it scopes
every query to synthetic IENs 401–450 and reads a local orchestration table this build does not have). The
legacy routines and the data dictionary are the truth for what fields mean.

## Goals

1. **Quick-access questions** — one-click questions in the chat app, each a fixed SQL **template held in
   the AI spec**, with its parameters decided in the Decide chat (decided by the user). The set:
   - capitalized assets aging out in a given fiscal year
   - high-value assets without a service contract
   - JCAHO items with an inspection pending
   - capital-planning totals (portfolio counts and values)

   The developer may keep, drop or reword these. A question outside the four cannot become a quick-access
   button; it is still answerable as a general question.
2. **General questions** about file 6914, answered by the AI **writing SQL on the fly** (decided by the
   user). Examples the user gave: "How many pieces of equipment do we have?" and "How many bed-related
   equipments do we have and what are they?" — a count, and a fuzzy search over the equipment name and the
   category name with a list of matches showing names, not pointer IENs.
3. **A separate Angular chat app** (decided by the user) — quick-access questions as buttons, a free-text
   box, answers as text plus a results table, and the SQL that produced each answer shown with it.
4. **Follow-ups work** — "what are they?" after "how many?" — the conversation is remembered per session.
5. **Proof it works: the results look real.** The build's verification asks the chatbot each quick-access
   question plus "How many pieces of equipment do we have?" and runs the same queries directly against
   VADEMO; it passes only if the counts and rows match. The build's finish message shows both side by side.

## Non-goals

- No writes: the chatbot never creates, edits or deletes records.
- No MCP surface, no out-of-scope log, no links into the entry form (all in the prototype; not wanted now).
- Not routed through the production: the chatbot reads VistA directly; the production's register flow is
  unchanged.

## Anti-goals (it fails even if it technically works)

- An answer that is invented rather than read from VistA — numbers or rows that do not match the data.
- Any write reaching VistA through the general SQL path.
- A credential, host or token in source, in a spec, in the decisions record, or in a generated class
  (the repo is public).
- Pointer IENs shown where a person expects a name (category, location, service, manufacturer).

## Constraints

- **Where it runs:** AI Hub in container `iris-ai-hub`, namespace `INTEROP`, alongside
  `EquipmentEntry.Production` (which keeps running). Use a distinct package from `EquipmentEntry` so the
  production build and the AI build never overwrite each other's classes.
- **Data — all of file 6914**, not the prototype's synthetic IEN range: VADEMO's SQL projection of file 6914 and its pointer files — `VISTA.EQUIPMENT_INV_6914`,
  `VISTA.EQUIPMENT_CATEGORY6911`, `VISTA.ENG_SPACE6928`, `VISTA.SERVICESECTION49`,
  `VISTA.MANUFACTURER_LIST_FILE6912`, the 6914 sub-files, and the rest listed in `LOOKUP` in
  `agent/server.js` — read through the same Atelier SQL query endpoint the form's lookups use.
- **General SQL guard** (enforced in code before any query runs, not left to the prompt):
  a single `SELECT` statement only; only allow-listed 6914 tables and pointer files; a row cap; no
  statement separators or data-changing keywords. Every answer returns the SQL it ran.
- **Schema guide:** the AI is given a guide to the 6914 tables and columns, generated at build time from the
  graph and the data dictionary plus VADEMO's own column catalog — not hand-written, not from the prototype.
- **Secrets only in `agent/.env`:** the Bedrock token and the VADEMO login the tools use are read from the
  environment by the build and stored inside IRIS (credentials store or equivalent) at deploy time, the way
  the bulletin's mail settings are. Generated classes contain no host or credential.
- **Model:** Bedrock, the same model setting the workbench uses (`BEDROCK_MODEL_ID`).
- **Reaching VADEMO from IRIS (builder's call):** a new setting for VADEMO's address as the `iris-ai-hub`
  container sees it (like `BULLETIN_SMTP_HOST`), defaulting to `VADEMO_URL`. The tools use a separate
  read-only VADEMO login when one is configured, and fall back to `VADEMO_USER`; the SQL guard is the
  protection either way, and a read-only login is a second one.
- **Bedrock token (builder's call):** stored in IRIS at build time. If it expires, the chat endpoint returns
  a plain "Bedrock token expired — update it in agent/.env and press 🔨 again" instead of failing silently.
- **Allow-lists (builder's call):** the general SQL tool's allow-list is fixed: file 6914, its sub-files and
  its pointer files. A quick-access tool may read whatever tables its recorded definition needs (for
  example file 6920), because its query is fixed and tested.
- **Layering:** the AI layer uses lower layers by reference and never changes them. Its need — read-only SQL
  over the 6914 projection — is listed in the AI spec's "Needs from lower layers".
- **Decisions come only from the Decide page's chat.** The dev session never writes `decisions.json`.
- **The developer presses 🔨 themselves**; nothing triggers a build on their behalf.
- The AI layer is offered only once the orchestrator is built and verified (true now).

## What was decided, as decided

- Scope: the four quick-access questions above, plus general questions about 6914.
- General questions: the AI writes SQL on the fly.
- Front end: a separate Angular chat app.
- The Decide page user supplies the quick-access questions, through the chat.
- Quick-access queries are SQL templates in the spec, one per question; the chat decides their parameters.
- Success: the returned results look real — they match VistA.

## How it is decided in the Decide page

The AI tab gets the same treatment the orchestrator tab has: the AI layer spec is generated from the graph,
the decisions record and `implemented.json`, renders live, lists what is missing, and the chat walks the
developer through it. What the developer decides:

- **The quick-access question list** — which of the four to keep, and each one's wording and parameters.
  Each question's SQL template lives in the AI spec generator (written against the discovered fields
  below); the rendered AI spec shows each template with the decided parameters filled in, so the developer
  sees the exact query that will run. The templates are tested against VADEMO by the build's verification;
  the Decide chat does not query VADEMO. Each parameter is a decision the chat asks for, with the legacy meaning shown as evidence: what "high-value" means; the
  default fiscal year and how "aging out" is measured; what "inspection pending" means in VistA terms
  (the prototype read a local workflow table this build does not have); which fields "capital-planning
  totals" sums.
- **No borrowed values (builder's call, keeping the existing chat rule):** the chat never proposes a
  threshold, year or condition the developer has not stated — including the prototype's ($50,000,
  FY2031). It shows the legacy field meanings as evidence and asks. The existing grounding check applies
  unchanged.
- Nothing about the general SQL path needs deciding beyond its guard, which is fixed by this design.

### Evidence for fields the entry form does not cover (builder's call)

The capability graph holds only the entry form's fields. The AI layer also needs fields such as
REPLACEMENT DATE, TOTAL ASSET VALUE, LIFE EXPECTANCY, the PM schedule sub-file and work orders (file 6920).
A discovery pass gathers their data-dictionary meaning and the legacy routines that use them, using the
methods in `harness/VADEMO-ACCESS-PLAYBOOK.md` (including its temporary DDProbe class, deleted when done),
plus VADEMO's SQL column catalog. The result goes in a **separate file** next to the graph (for example
`capability-graph/inventory-fields.json`), not into `new-inventory-entry.json`, so the API spec's input hash
and the lower layers are untouched. The AI spec, its grounding and the schema guide read from it.

The spec is complete when every kept quick-access question has its wording and parameters recorded.
A template parameter that changes what the query means (for example which work-order statuses count as
"pending") is a decision, not a default.

## Build and verify (🔨 on the AI tab)

1. Read the AI spec; refuse if it is incomplete or stale (as the production build does).
2. Generate the agent, its toolset (one tool per quick-access question plus the guarded general tool), the
   schema guide, and a chat REST endpoint; push and compile them into INTEROP with the interclaw scripts.
3. Store the Bedrock token and VADEMO login in IRIS from `agent/.env`.
4. Generate and publish the Angular chat app.
5. Verify (builder's calls marked):
   - Each quick-access button calls its own tool directly — not chosen by the model — and the model only
     words the result. The check compares that tool's rows and counts with the same SQL run directly on
     VADEMO.
   - "How many pieces of equipment do we have?" goes through the model and the general SQL tool. The
     reference is a fixed query: the count of all file 6914 entries. It passes if the count in the tool's
     result matches the reference **and** that number appears in the reply text. One retry is allowed,
     since model output varies.
   - The guard rejects a non-SELECT statement and a table outside the allow-list.
   - Pass only if all of the above hold.
6. Record the AI layer as built and verified in `implemented.json`; the finish message links to the chat app
   and shows each question's chatbot answer next to the direct query result.

## Left to the builder

- Package and class names; the chat endpoint's route and web app; session storage details (follow the
  prototype's `%AI.Agent.Session` export/import pattern).
- Where the chat app is published and how it reaches the IRIS endpoint (a same-origin proxy through the
  workbench server, as the form app's VADEMO calls do, keeps credentials server-side).
- The row cap, the exact guard implementation, and the schema guide's format.
- How the decisions record stores the kept questions, their wording and parameters, and the chat tools
  that edit them.
- The four templates' SQL, written against the discovered fields and checked against VADEMO during
  development.
- The AI layer spec's rendered layout, following the API and orchestrator specs.
- Chat app look and layout, in the workbench's style.
