Work in the repository's current uncommitted merge result. Do not commit/push. Fix the new portable Agent Package feature so it follows the already-approved product rename. Current active code/docs/schema/tests still say Aurion; that is a merge bug.

Required canonical contract for this not-yet-released package feature:
- manifest kind: `aurion.aios.agent-package`
- source product: `Aurion AIOS`
- JSON Schema id: `https://aurion-aios.lazyoffice.app/schemas/agent-package-v1.json`
- schema/readme/title/docs: `Aurion AIOS Portable Agent Package`

Update consistently:
- `web os system/aios-server/src/lib/agentpackage.ts`
- `web os system/aios-server/.scratch/agent-package-export/tests/agent-package-export.test.ts`
- `web os system/aios-web/public/schemas/agent-package-v1.json`
- `docs/agent-package-v1.md`
- any current non-historical source/test added by the remote merge that refers to Aurion branding.

In `.scratch/duplicate-agent-cleanup/external-session-idempotency.ts`, remove the obsolete `kevin@aurion-group.com` account fallback; use the Aurion account/OWNER lookup without old brand text.

Do not alter historical migration provenance identifiers in `.scratch/migrate-ai-landing-proposal.ts` where `aurion:*` is an immutable source/event key. Do not change the actual GitHub remote/org path. Do not weaken tests.

Stage the fixes. Run server Prisma validate/typecheck/build and the Agent package export plus idempotency tests. Run web typecheck/build. Verify `git grep --cached -i Aurion` only returns explicitly historical migration provenance (if any), not active product code/docs/schema/tests. Report exact results. Do not create merge commit.
