# Design — Workbench Decide Agent (interactive)

## Goal

Add a live chat agent to the **Decide** stage that (a) explains option semantics and the graph→spec mapping on demand, and (b) **applies design decisions** (dispositions / open-question resolutions) via tool calls, retaining chat history. This makes the workbench interactive (served), not a static `file://` page.

## Architecture

```
Browser (served Decide UI + chat drawer)
   │  POST /api/agent/chat { messages }
   ▼
Node/Express server (agent/)
   ├─ loads capability graph (capability-graph/new-inventory-entry.json)
   ├─ decisions store (agent/decisions.json, file-persisted)
   ├─ Bedrock Converse loop (agent/lib/bedrock.js) — bearer token, us-east-1,
   │     model us.anthropic.claude-haiku-4-5-20251001-v1:0 (env BEDROCK_MODEL_ID)
   └─ tools (agent/lib/tools.js), grounded in the graph:
        explainMapping(nodeId) · explainOption(nodeId, option)
        setDisposition(nodeId, option) · resolveOpenQuestion(id, mode, policy)
        getState()
   ▼
returns { reply, decisions, actions[] } → UI merges decisions, re-renders left + spec
```

- **History:** kept client-side (message array) and resent each turn; the server is otherwise stateless except the decisions store.
- **Grounding:** the system prompt carries the capability graph + current decisions + the disposition→IRIS-construct rules; explain-tools return facts computed from the graph so answers cite node ids / evidence and don't hallucinate.
- **Actuation:** apply-tools mutate the decisions store; the loop returns the updated decisions so the UI reflects agent changes immediately.

## Serving & the two modes

The Decide page works in two modes:
- **`file://` (existing):** localStorage decisions, no chat (agent disabled).
- **served (`http://localhost:PORT`):** decisions sync via `/api/decisions`; chat drawer enabled. Detected by `location.protocol`.

Run: `cd agent && npm install && npm start`, open `http://localhost:8899/capability-graph/decide.html`.

## Security

- Bedrock bearer token read at runtime from `AWS_BEARER_TOKEN_BEDROCK` (env) — never hardcoded, never sent to the browser.
- Server binds localhost only. Tools are a fixed allowlist operating only on the decisions store (no arbitrary code / file access).

## Testing

- Bedrock reachability + token verified (endpoint TLS-reachable, token present).
- Smoke test: a scripted `/api/agent/chat` call ("explain Event for Bulletin", then "make PM an event") → assert reply text + that `SIDE.PMSchedule` disposition flips to `Event` in the returned decisions.
- Tool handlers unit-testable without Bedrock (pure functions over graph + decisions).

## Out of scope (later)

- Move the agent to IRIS AI Hub (`%AI.Agent`) — the `askAgent()`/Converse seam stays; only the provider swaps.
- Multi-session/user, auth, retrieval over multiple workflow graphs.
