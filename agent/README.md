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

- `server.js` — serves the workbench + APIs: `GET /api/state`, `GET/PUT /api/decisions`, `POST /api/agent/chat`, `POST /api/decisions/reset`.
- `lib/bedrock.js` — Bedrock **Converse** tool-use loop (bearer-token auth).
- `lib/tools.js` — grounded tools: `getState`, `explainOption`, `explainMapping`, `setDisposition`, `resolveOpenQuestion` (pure functions over graph + decisions; unit-testable without Bedrock).
- Decisions persist to `agent/decisions.json`; chat history is kept client-side and resent each turn.

## Notes

- The Bedrock token and the VADEMO host and credentials are read from the environment at runtime, never hardcoded or sent to the browser.
- Later: swap the Bedrock provider for **IRIS AI Hub** (`%AI.Agent`) behind the same `runAgent()` seam — the tools/UI don't change.
