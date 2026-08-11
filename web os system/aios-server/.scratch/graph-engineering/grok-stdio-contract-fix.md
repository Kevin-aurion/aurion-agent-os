# Task: align MCP stdio E2E with the current non-blocking Stop reflection contract

Repository: `/Users/kaikaiwu/Desktop/LazyOffice/AI OS Langflow`

The merge is in progress. Do not commit, push, reset, abort, or rewrite unrelated files.

Observed failure after credentials were reprovisioned:

`web os system/aios-mcp/.scratch/tests/stdio-e2e.mjs` still expects the old server response `decision: "block"` on the first `guard_agent_build_stop` call. The current governed Stop design is deliberately non-blocking: Stop synchronizes the final assistant text, queues a Shadow Draft reflection, and never activates production. The separate Claude hook state machine already tests one bounded continuation before allowing the next Stop.

Please make the smallest correct update:

1. Update the stdio E2E assertion/name for the first Stop response to the current contract. Assert useful deterministic fields such as `matched`, `finalMessageSynced`, `artifactFresh`, and absence of `decision`; only assert background/reflection queue fields if deterministic from the fixture.
2. Update the stale route comment in `web os system/aios-server/src/routes/agentbuilder.ts` that says Stop requires a final full snapshot, so it accurately says the final turn is mirrored and a governed Shadow reflection is queued.
3. Do not weaken Stop lifecycle hooks, FDE gates, or production activation rules.
4. Run:
   - `cd web os system/aios-mcp && npm run typecheck && npm run build && node --test .scratch/tests/stdio-e2e.mjs`
   - `cd ../aios-server && npm run typecheck`
5. Stage only the intended changes. Do not commit or push.
