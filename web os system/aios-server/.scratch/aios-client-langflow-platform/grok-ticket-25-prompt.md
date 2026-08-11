Implement Ticket 25 in this existing dirty workspace.

Read and follow, in order:
1. root `AGENTS.md`
2. `CLAUDE.md`, `src/CLAUDE.md`, `src/lib/CLAUDE.md`
3. `.scratch/aios-client-langflow-platform/spec-25-langflow-runtime-boundary.md`
4. `.scratch/aios-client-langflow-platform/issues/25-langflow-runtime-boundary.md`

Work test-first. Preserve all unrelated user WIP and make only narrow surgical edits. Do not edit Prisma schema/migrations, real `.env` secret values, compose auth posture, or `lazyoffice-system-main`. Do not commit or push.

Required design points:
- Environment selection must be explicit for LANGFLOW network operations and must never fall back across SANDBOX/STAGING/PRODUCTION.
- Local Langflow artifact validation must not require remote configuration.
- Use a shared pure safe Flow ID parser at deploy and binding boundaries.
- Add a `run.output` normalized event with a strict runtime guard. Normalize only bounded, deep-redacted JSON-safe output.
- Treat 2xx as failure unless the documented Langflow `{session_id, outputs:[{outputs:[...]}]}` shape has at least one effective output and no explicit error-bearing payload.
- Persist normalized output before terminal success.
- Approval-required metadata must be server-generated and resume must revalidate the exact active deployment/environment.
- Never reflect hostile raw values or secrets in errors/tests/tool output.

Run and fix until green:
- Ticket 25 test and ticket-scoped typecheck
- t03 adapter + URL/timeout
- t17 isolation
- all t18 runtime tests
- t23 and t24
- all t20 POCs
- full server `npx tsc --noEmit`
- web `npx tsc --noEmit`

Report exact pass/fail/block counts and list changed files. If a live canonical AIOS IR still cannot execute because it is not a native Langflow graph, report it as BLOCKED; do not weaken result validation and do not claim success.
