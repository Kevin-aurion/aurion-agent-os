# Graph Engineering v2 — Vertical Tickets

## T01 — GraphSpec v2 contract and validation

- Add strict GraphSpec v2 Zod schema and TypeScript types.
- Add structured validator with topology, control-flow, bounded-loop, reachability, and approval-path checks.
- Add deterministic v1-to-v2 compatibility upgrader for existing AIOS FlowArtifact graphs.
- Tests first: happy path plus all fail-closed cases from the spec.

## T02 — Structural diff and risk classification

- Add deterministic graph canonicalization and diff.
- Detect node/edge/state/entry/exit changes.
- Classify governance risk without an LLM.
- Tests first for move-only, semantic config, approval/tool, loop, and removal cases.

## T03 — Native Langflow catalogue and compiler

- Fetch/decompress the pinned Langflow component catalogue through the private adapter.
- Compile the supported semantics-preserving subset to native Langflow nodes/edges.
- Return per-node compatibility and exact unsupported reasons.
- Never translate an unsupported AIOS node into a no-op.
- Unit tests first with frozen minimal catalogue fixtures.

## T04 — Governed Graph API and immutable artifact persistence

- Add FDE-only Graph API routes.
- Validate and deep-redact before storing.
- Reuse content-addressed FlowArtifact persistence.
- Add artifact list and redacted trace lookup.
- API negative tests for auth, role, malformed graph, secret markers, and unsupported Langflow compile.

## T05 — Graph Workbench foundation

- Add `/studio/graph` navigation and route.
- Add graph canvas, palette, inspector, validation, compatibility, and diff panels.
- Ensure keyboard/mouse accessible controls and responsive fallback.
- Keep save separate from Production deployment.
- Presentation tests first.

## T06 — Live Langflow Sandbox verification

- Compile a supported echo graph using the runtime catalogue.
- Create native Langflow Flow, execute it, validate the returned output contract, and delete the temporary Flow.
- Record pass/fail/block counts without weakening checks.

## T07 — Full regression, review, and release

- Server tests, typecheck, build.
- Studio tests, typecheck, build.
- Browser E2E against running local/public-safe services.
- Review all current worktree changes, scan for secrets and generated junk.
- Commit the user-confirmed complete worktree and push the current feature branch.
