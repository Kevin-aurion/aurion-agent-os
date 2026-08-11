# Verification report — 2026-08-11

> Update: the original pass-through knowledge pilot is now a real read-only knowledge query loop. See `../aios-knowledge-langflow-usable/verification.md` for the current evidence.

## Langflow Sandbox

- Native private flow ID: `4ec97062-f088-45b6-a304-a4fe1d1c9f26`
- Name: `AI 知識採集 — Grounded Langflow Sandbox`
- Graph: Chat Input → Chat Output
- Result: native deploy and run-marker check passed
- Side effects: none
- Production activation: false
- MCP / webhook: disabled

## AIOS shadow copy

- Source session: `01KZKPM049RKZ0CD8N5T6T1CZ5`
- Shadow session: `01KZPCK4X7APKZF61FYZ95Z3KY`
- Shadow status: `AWAITING_FDE`
- Latest iteration: `READY`
- Source before/after digest: identical

## Studio V2

- Unit tests: 4 passed
- TypeScript: passed
- Production build: passed (11 routes)
- Dependency audit: 0 vulnerabilities
- Local service: `app.lazyoffice.aios-studio`, running on `127.0.0.1:3300`
- Public page: `https://aios-studio.lazyoffice.app/login`, HTTP 200
- Public backend health: HTTP 200, database healthy
- Unauthenticated MCP registry: HTTP 401 as expected
- Existing `aios-new.lazyoffice.app`: HTTP 200 after rollout

## Browser E2E

- Login: passed with a temporary TRAINER identity; identity and sessions removed
  after the test.
- Overview: passed.
- Agent, Model, Tool/MCP, Knowledge, Skill and Deployment pages: passed with no
  rendered error state.
- Agent workspace: six tabs present.
- Cross-model negative test: selecting the same execute and verify model disables
  Save and renders an error.
- Browser console: no errors or warnings.
- Layout: viewport width equals body scroll width; no horizontal overflow.
