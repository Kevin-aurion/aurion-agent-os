# Read-only architecture inventory for AIOS Client + Runtime Platform

You are the read-only research stage of a larger Claude Code dynamic workflow. Use the current repository as the source of truth. Do not edit, create, delete, stage, commit, or restore any file.

## Product decision

- Rebuild the AIOS end-user Client with clean-room, independently authored interaction patterns inspired only by publicly observable Cherry Studio V2 concepts. Never copy Cherry source code, assets, text, component structure, or styling tokens.
- AIOS remains the only control plane and source of truth for Agent, Skill, Tool, MCP, Approval, Policy, Cost, Audit, Schedule, Memory and Run governance.
- Preserve the Native Runner. Langflow is an optional Runtime Adapter and an FDE-only Authoring/Sandbox Lab, never a Model Engine and never the source of truth.
- Production model calls and Tool/MCP calls must pass through AIOS model/capability gateways. Langflow must not hold production provider credentials.
- Implement the six phases described in `.scratch/AIOS_Cherry_V2_Langflow_融合評估_2026-08-08.md`.

## Mandatory red lines

Read `AGENTS.md`, `CONTEXT.md`, all relevant nested `CLAUDE.md` files, and `docs/adr/0013-clean-room-client-and-langflow-runtime.md`. Preserve all five red lines: cross-model verification, code-level restriction/budget fail-closed, permanent redaction, no automatic Skill confirmation, and FDE-only effective changes. Do not touch `lazyoffice-system-main/`.

## Inspect

1. Current dirty worktree and likely conflict files.
2. Current `/work`, Agent Builder, conversations, runs, approvals, tool/MCP registry, schedules, artifacts, devices and admin UI.
3. Engine/runner boundaries and where a Runtime Adapter and Model Gateway can be inserted without weakening `compileManifest()`.
4. Prisma models and migrations; identify minimal additive models/fields for RuntimeKind, FlowArtifact, RuntimeDeployment, Langflow workspace/environment, idempotency and immutable execution metadata.
5. Existing Remote MCP builder profile and whether it can support a companion-client spike without new production powers.
6. Existing tests and the best TDD locations for positive and negative tests.
7. Docker and deployment shape for two isolated Langflow environments.

## Output

Return a concise but complete Markdown report with:

- verified current capability map;
- exact file/symbol inventory;
- WIP conflict inventory;
- proposed dependency order across phases 1–6;
- database and migration plan;
- test matrix, especially fail-closed negative tests;
- blockers and assumptions;
- recommended ticket boundaries small enough for Grok CLI implementation and independent Fable review.

Do not propose a wholesale rewrite. Do not claim a capability exists without code evidence.
