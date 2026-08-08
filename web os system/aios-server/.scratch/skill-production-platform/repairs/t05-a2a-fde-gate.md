Repair Ticket 05 in the existing implementation. Read AGENTS.md and the relevant module CLAUDE.md first.

Problem found by independent Opus review: src/routes/a2a.ts exposes peer card fetch, internal Agent Card projection, task submit/status/cancel under requireAuth although the implementation spec defines the A2A gateway as FDE-approved, opt-in external delegation.

Required repair:
- All /a2a peer discovery/card and remote task lifecycle endpoints must be guarded by requireTrainer (OWNER/TRAINER). Registration/mutation endpoints already use it; make the boundary consistent and fail-closed.
- Keep the internal Agent Card whitelist/redaction projection unchanged; do not expose rolePrompt, restrictions, memory, credentials or Skill bodies.
- Add a real Fastify route-level authorization negative test proving MEMBER receives 403 for Agent Card, peer card, submit, status and cancel without reaching network dispatch. Do not merely comment that requireTrainer exists.
- Preserve A2A default-disabled behavior and existing FDE successful behavior.
- Preserve all existing exports and WIP. Do not commit, push or modify lazyoffice-system-main.

After editing, run npx tsc --noEmit and the focused Ticket 05 tests against the real local DB. Report changed files and exact test results.
