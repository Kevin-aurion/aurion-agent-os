You are the implementation engineer for Lazyoffice AIOS. Implement the complete Agent
Builder vertical slice described in:

- /Users/kevin/Documents/lazyoffice/web os system/aios-server/.scratch/agent-builder/spec.md

Before editing, fully read:

- /Users/kevin/Documents/lazyoffice/AGENTS.md
- relevant module CLAUDE.md files under aios-server and aios-web
- current Prisma schema, migrations, routes/agents.ts, agents/compose.ts,
  lib/skilltraining.ts, lib/changeproposal.ts, lib/eval.ts, engine/runner.ts,
  routes/conversations.ts, routes/mcp.ts, lib/mcpregistry.ts, lib/a2a.ts
- current /work page and workbench components/types/API/auth helpers

Chrome acceptance already proved the current teach endpoint returns `bad response`
and is the wrong abstraction. Add a separate durable Agent Builder domain and the
end-user UI entry. Preserve all current WIP and extend surgically.

Hard constraints:

1. Never weaken execute-engine != verify-engine or isApproved fail-closed behavior.
2. Restrictions, budget, auth, approval and paths are code-enforced/fail-closed.
3. Recursively redact every transcript/brief/plan/test/evidence string before DB
   persistence. Add a reusable deep-redaction helper if needed.
4. New/changed Skills never auto-confirm. Builder authorization may create only an
   AWAITING_USER_CONFIRM draft; finalize may confirm only for OWNER/TRAINER after a
   real PASSED builder test and must audit it.
5. MEMBER never applies changes. MEMBER authorize only transitions the owned session
   to AWAITING_FDE; no Agent/Skill/Workflow/MCP mutation.
6. ESM relative imports include .js. API uses ok/sendError and guards. External
   paths use safepath. Do not resolve/store credentials.
7. Do not touch lazyoffice-system-main. Do not git commit/push/reset/restore. Do not
   overwrite unrelated dirty WIP.
8. Prisma enums multiline, comments ///, new migration only. Run prisma migrate dev
   with a descriptive name if DB is reachable, then prisma generate.

Implementation quality:

- Keep discovery fast and dependable. It must not synchronously wait minutes for a
  CLI. Use a deterministic one-question-at-a-time state machine with useful keyword
  inference from the initial prompt and a recommended answer per question. It may be
  designed for an optional future LLM extractor, but the core route must work when
  all model CLIs are offline.
- Capability planning must query the real DB catalogs: existing agents, confirmed
  skills, connected accounts, enabled/healthy MCP registry, enabled approved A2A.
- Explain integrations in business language. The end-user UI must not expose engines,
  manifests, raw JSON, MCP protocol configuration, or A2A internals.
- Build uses PAUSED Agent plus inert linked draft. Reuse does not rewrite an existing
  Agent. Least privilege defaults block email send/cloud write/shell/computer use.
- Test must be a real asynchronous runAgent execution against required manual fixture
  data. Persist a redacted compact result. Any error/rejection/timeout is FAILED.
  Production connector gaps remain visible even after a manual fixture passes.
- Finalize is FDE-only and fail-closed on latest PASSED. It confirms only builder-owned
  draft skill(s), activates a newly created Agent, and audits every mutation.
- Session ownership is fail-closed (404 for foreign users to avoid existence leaks;
  FDE may inspect).
- Add focused true-DB temporary tsx tests under
  .scratch/agent-builder/tests/, including all negative cases from the spec. Make
  deterministic unit helpers injectable so engine-failure tests never call paid CLIs.
- Update relevant module CLAUDE.md files, but do not rewrite AGENTS.md.

Required verification before finishing:

- npx prisma generate
- npx tsc --noEmit in aios-server
- npx tsc --noEmit in aios-web
- run the new focused tests with npx tsx
- run existing agent-workbench and skill-production security/regression tests that
  touch auth, redaction, confirmation, restrictions and cross-model verification
- report exact files changed, migration name, commands and outcomes.

Implement now; do not only write a plan.
