# Agent Workbench Phase 1 — regression tests

Run from `aios-server/`:

```bash
npx tsx .scratch/agent-workbench/tests/conversation-privacy.test.ts
npx tsx .scratch/agent-workbench/tests/confirm-skill-proposal.test.ts
npx tsx .scratch/agent-workbench/tests/draft-auth-scope.test.ts
npx tsx .scratch/agent-workbench/tests/ws-private-replay.test.ts
```

| Test | Covers |
|---|---|
| `conversation-privacy` | Owner-only list/read/send; foreign user 404 |
| `confirm-skill-proposal` | `confirm_skill` path, no client content trust, CODEX gate, contentMd preserved |
| `draft-auth-scope` | requireAuth draft capture, pre-LLM skillId agent scope, recording ownership/path boundary, confirm stays trainer-only |
| `ws-private-replay` | Private `chat.message` live/replay user isolation; public-event compatibility |

Uses real DB; cleans up temp rows.
