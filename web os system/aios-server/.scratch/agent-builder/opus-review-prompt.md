You are the independent verification reviewer for the new AIOS Agent Builder. Do not
edit any file. Review the current dirty worktree against:

- `/Users/kevin/Documents/lazyoffice/web os system/aios-server/.scratch/agent-builder/spec.md`
- `/Users/kevin/Documents/lazyoffice/AGENTS.md`

Scope only these new/current changes:

- Prisma `AgentBuildSession` and migration `20260727124113_agent_build_session`
- server `src/memory/deepredact.ts`, `src/lib/agentbuilder.ts`,
  `src/routes/agentbuilder.ts`, route registration/docs and focused tests
- web `src/components/workbench/AgentBuilderPanel.tsx`, workbench/types.ts and
  integration in app/work/page.tsx

Read the real files and run these checks yourself:

1. `npx prisma generate && npx tsc --noEmit` in aios-server.
2. `npx tsx .scratch/agent-builder/tests/agent-builder.test.ts` in aios-server.
3. `npx tsc --noEmit` in aios-web.
4. Inspect the migration and `npx prisma migrate status`.
5. Security/governance audit: foreign session isolation; MEMBER authorization causes
   zero Agent/Skill/Workflow/MCP mutation; FDE authorization explicit; existing Agent
   not rewritten on reuse; new Agent paused/least privilege; Skill cannot auto-confirm;
   finalization requires real PASSED and FDE; run failure/timeout/verifier rejection
   fail closed; all nested persisted content deep-redacted; MCP/A2A/account credentials
   not leaked; execute != verify and cost/restriction gates untouched.
6. UX audit: can start with no selected Agent, one question at a time, recommended
   answer, plan/reuse/gaps, explicit auth, required fixture, real test status,
   production blockers separated, final FDE confirmation, no technical jargon leak.
7. Look for malformed status transitions, race conditions, orphaned rows/files,
   authorization gaps, false-positive tests, Prisma/JSON errors, timeouts that leak,
   and frontend/backend DTO mismatches.

Return concise Traditional Chinese with:
- PASS or FAIL
- findings ordered P0/P1/P2, exact file + line and fix
- command evidence
- any test coverage gaps

Do not modify files, do not commit/push, and do not inspect/alter unrelated WIP.
