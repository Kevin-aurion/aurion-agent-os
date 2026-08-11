Continue the Agent Builder implementation. The prior oversized turn was interrupted
before it edited files. Implement BACKEND ONLY now.

Read `/Users/kevin/Documents/lazyoffice/web os system/aios-server/.scratch/agent-builder/spec.md`
and `/Users/kevin/Documents/lazyoffice/AGENTS.md`, then make these concrete changes in
`web os system/aios-server`:

1. Add durable Prisma `AgentBuildSession` plus a multiline status enum and relation
   from User. Fields: id, userId, status, brief Json, transcript Json, plan Json?,
   awaitingField?, strategy?, targetAgentId?, builtAgentId?, skillIds String[], testData
   Json?, testResult Json?, authorizedBy?, authorizedAt?, createdAt, updatedAt. Create a
   new migration (never edit old migration), run prisma generate.
2. Add `src/lib/deepredact.ts`: recursively redact all strings with redactSecrets,
   handle arrays/plain objects/primitives, bound recursion and reject/replace cycles.
3. Add `src/lib/agentbuilder.ts`: deterministic offline-capable one-question-at-a-time
   interview for objective, inputs, outputs, process, exceptions, permissions, testData.
   Infer obvious Gmail/Drive/CSV/PDF/upload/report/email-draft/approval facts from the
   first message; never invent unresolved decisions. Every question includes exactly
   one question plus a recommended answer. Persist only deep-redacted values.
   When complete, query actual nondeleted agents, CONFIRMED skills, connected accounts,
   enabled+healthy MCP registry, and enabled+approved A2A peers to produce a safe
   plain-language plan with recommended existing Agent reuse and explicit gaps.
4. Add `src/routes/agentbuilder.ts` and register it in `src/index.ts` with endpoints in
   the spec. Ownership: session owner or FDE read; foreign MEMBER gets 404. MESSAGE and
   test-data are owner/FDE. AUTHORIZE uses requireAuth then: MEMBER => AWAITING_FDE with
   zero Agent/Skill mutation; OWNER/TRAINER => explicit reuse/create build. Reuse may
   only link a newly created inert draft; it must not rewrite existing Agent. Create
   makes a least-privilege PAUSED Agent. Builder Skill is redacted and
   AWAITING_USER_CONFIRM, linked but not effective. Never auto-enable MCP/A2A/account.
5. TEST requires redacted manual fixture, is async, and calls the existing runAgent on
   built/reused Agent. Add injectable runner helper for tests. Any exception, rejected
   outcome, timeout, malformed result => FAILED. Store compact redacted evidence and
   retain production connector gaps. FINALIZE is FDE-only, requires latest PASSED,
   confirms only session-owned builder skill(s), activates only the session-created
   agent, and audits every mutation. Fail closed on missing/mismatched rows.
6. Add true-DB focused tsx tests under `.scratch/agent-builder/tests/` covering initial
   CEO finance prompt question behavior, plan reuse+gaps, foreign access, MEMBER zero
   mutation, FDE paused/inert build, no-data test rejection, injected engine failure
   cannot pass, finalize guards, and deep redaction.
7. Update relevant server lib/routes CLAUDE.md minimally.

Use ok/sendError/guards, ESM `.js`, ulid, slug/safepath helpers, audit. Do not touch
frontend, AGENTS.md, lazyoffice, unrelated WIP. Do not commit/push. Run migrate dev,
prisma generate, server tsc and the new tests. Implement now and report exact evidence.
