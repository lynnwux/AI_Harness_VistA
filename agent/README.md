# Decide Agent (interactive)

A small served app that adds a **live chat agent** to the Decide stage. The agent explains option semantics and the graph→spec mapping, and **applies design decisions** (dispositions / open-question resolutions) via tool calls — grounded in the capability graph, backed by AWS Bedrock.

## Run

```bash
cd agent
npm install                      # once
cp .env.example .env             # once — fill in the VADEMO host + sandbox login (agent/.env is git-ignored)
# provide the Bedrock bearer token (reused from the Equipment agent), unless it is in agent/.env:
set -a; . ../../Vista-Engineering-IRIS/.env; set +a   # loads AWS_BEARER_TOKEN_BEDROCK + region
npm start                        # = node --env-file-if-exists=.env server.js
```

Open **http://localhost:8899/capability-graph/decide.html** — the **💬 Assistant** button (bottom-right) is enabled only when served. On `file://` the page still works (localStorage, no agent).

Config via env: `PORT` (default 8899), `BEDROCK_MODEL_ID` (default `us.anthropic.claude-haiku-4-5-20251001-v1:0`), `AWS_DEFAULT_REGION` (default us-east-1), `AWS_BEARER_TOKEN_BEDROCK` (required), `VADEMO_URL` / `VADEMO_USER` / `VADEMO_PASSWORD` (required for lookups and saves against VADEMO — keep them in `agent/.env`, never in a committed file).

Smoke test (no UI): `npm run smoke`.

## How it works

- `server.js` — serves the workbench + APIs: `GET /api/state`, `GET /api/decisions` (read-only — decisions are written only by the chat tools), `GET /api/specs` (the three generated layer specs), `POST /api/agent/chat` (returns `recorded`, the exact record changes), `POST /api/build` (regenerates the specs, then builds the API layer from `capability-graph/specs/api.json`).
- `lib/specs/` — generates `capability-graph/specs/{api,orchestrator,ai}.{json,md}` from the graph, `decisions.json` and `implemented.json`.
- `lib/bedrock.js` — Bedrock **Converse** tool-use loop (bearer-token auth).
- `lib/tools.js` — grounded tools: `getState`, `explainOption`, `explainMapping`, `setDisposition`, `resolveOpenQuestion`, `setBuildScope`, `setTarget`, `bindRuleTerms` (pure functions over graph + decisions; unit-testable without Bedrock).
- Decisions persist to `agent/decisions.json`; chat history is kept client-side and resent each turn.

## Notes

- The Bedrock token and the VADEMO host and credentials are read from the environment at runtime, never hardcoded or sent to the browser.
- Later: swap the Bedrock provider for **IRIS AI Hub** (`%AI.Agent`) behind the same `runAgent()` seam — the tools/UI don't change.

## AI layer (piece 3 — the equipment inventory chatbot)

> **After updating this branch, restart the workbench server** (`npm start` in `agent/`). A server started before the AI layer was added has none of the routes below; the Decide page shows a "restart the workbench server" notice when it detects one.

- **Discovery** — `node --env-file=.env discover-inventory.js` (read-only against VADEMO) writes `capability-graph/inventory-fields.json`: the 6914 tables and columns with their DD meaning, codes and pointer→name columns, the general-SQL `allowList`, and `excluded` (each table kept off the allow-list, with its reason). A table with personal data — a social security or tax id, a home address or phone, a birth date, pay, or a person's phone or address — is never allow-listed, by its columns rather than its file name.
- **Spec and decisions** — the AI tab's spec (`lib/specs/ai.js`) is generated from the quick-access question templates (`lib/ai-templates.js`), the record's `aiQuestions` section (written only by the chat tool `setQuickQuestion`) and the inventory file. It is offered once the orchestrator is built and verified.
- **Build** — 🔨 **Build AI** on the AI tab calls `POST /api/build/ai` (409 unless the stage is the AI layer and its spec is complete; never while a production build runs, and vice versa); progress at `GET /api/build/ai/status` (`agent/ai-status.json`). `ai-runner.js` generates the `EquipmentAI.*` classes (`lib/ai-hub.js`), pushes and compiles them into `iris-ai-hub`/`INTEROP`, stores the VADEMO login and the Bedrock token as IRIS credentials, creates the `/equipmentai` web app, builds the Angular chat app (`lib/chat-app.js`) to `prototype/chat/`, verifies the chatbot against direct VADEMO queries, and records `ai` in `implemented.json`.
- **Chat proxy** — the chat app at `/prototype/chat/` calls `POST /ai/chat` and `POST /ai/quick/:id`, which the server forwards to `${IRIS_AI_HUB_URL}/equipmentai/…` with the IRIS login from `.env` (the browser never sees it).
- **Settings** (in `agent/.env`; placeholders in `.env.example`): `AWS_BEARER_TOKEN_BEDROCK` (required for the AI build), `IRIS_AI_HUB_URL` / `IRIS_AI_HUB_USER` / `IRIS_AI_HUB_PASSWORD`, `INTERCLAW_SCRIPTS`; optional `VADEMO_URL_FROM_IRIS` (VADEMO as `iris-ai-hub` sees it; default `VADEMO_URL`) and the read-only pair `VADEMO_READ_USER` + `VADEMO_READ_PASSWORD` (set both or neither; default `VADEMO_USER` / `VADEMO_PASSWORD`).

## Restore last good (fallback)

Every fully successful build saves a known-good copy of its deliverable in `agent/_known-good/` (git-ignored):
the API build saves the published entry form (`prototype/build/`), the production build saves the generated
`EquipmentEntry` classes once its verification passes, and the AI build saves the generated `EquipmentAI` classes
and the chat app (`prototype/chat/`) once its verification passes. A failed build never replaces a copy.

Type **`restore last good`** in the Decide chat to put all three back. The server handles that exact command itself —
the model is not involved, so it works when Bedrock doesn't — and runs `restore-runner.js`, which:

- copies the entry form back to `prototype/build/`;
- uploads and compiles the production classes in INTEROP and restarts `EquipmentEntry.Production`;
- uploads and compiles the AI classes, re-applies the AI settings from `agent/.env`, clears stored conversations,
  and copies the chat app back to `prototype/chat/`.

Logins and hosts always come from `agent/.env`; copies hold no credentials. The decisions record, the specs and
`implemented.json` are not changed. A restore and a build never run at the same time. Progress:
`GET /api/restore/status` (status file `agent/restore-status.json`).

## Demo reset

The small **↺** icon in the Decide page's top bar (tooltip: Demo reset) starts the page over — only after you type `reset` to confirm: every decision in
`agent/decisions.json` goes back to the defaults — a copy is kept as `agent/decisions.backup-<time>.json` — and
`implemented.json` marks the production and the AI layer not built, so the stage starts again at the first decision.
What is deployed keeps running (the entry form, the IRIS production, the AI chatbot), the Phase 1 services stay, and
"restore last good" still works. Refused while a build or restore is running. Route: `POST /api/demo/reset`.
