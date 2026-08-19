# Grok implementation assignment — Graph Engineering v2 backend

Work only inside:

`/Users/kaikaiwu/Desktop/Aurion/AI OS Langflow/web os system/aios-server`

Read completely before editing:

- repository `AGENTS.md`
- root and module `CLAUDE.md` files that govern aios-server, src, lib, routes, prisma
- `.scratch/graph-engineering/spec.md`
- `.scratch/graph-engineering/tickets.md`

The worktree contains extensive user WIP. Preserve it. Do not reset, delete, reformat, or rewrite unrelated files. Use minimal surgical edits. Do not modify existing migrations.

Implement tickets T01-T04 and backend portions of T06 using strict TDD: create and run failing tests before implementation, then make them pass. Tests must be placed under `.scratch/graph-engineering/tests/` and be executable with `npx tsx` or Node's test runner consistent with this repository.

Required deliverables:

1. Strict `aios.flow-graph/2` schema/types in a cohesive new backend module (for example `src/graph/`). Include typed state schema, explicit entry/exits, nodes, positions, configs, and the full node/edge kinds in the spec.
2. Fail-closed topology and governance validator with structured issues. It must cover duplicate ids, missing endpoints, reachability, ability to reach terminal, bounded loops, condition/parallel/join rules, immutable subgraph refs, secret/provider/credential material, and `tool.gated` protected on every incoming path by AIOS approval.
3. Deterministic compatibility upgrade for existing `aios.flow-graph/1` artifacts. It must not mutate the input.
4. Deterministic structural diff + governance risk classifier.
5. Native Langflow compiler for a semantics-preserving supported subset using an exact component catalogue. The compiler must never replace unsupported behavior with a no-op. It must return structured unsupported reasons. Generate native `genericNode` nodes, valid Langflow handles, viewport, deterministic layout, node mapping, and catalogue fingerprint. Do not embed credentials, provider keys, or new arbitrary Python.
6. Extend the existing private Langflow adapter only as needed to fetch `/api/v1/all` safely with response-size/time limits. Native compilation must be separately unit-testable using a minimal frozen catalogue fixture. Preserve environment credential isolation and existing response fail-closed behavior.
7. FDE-only REST routes from the spec, using `requireTrainer`, `ok()`/`sendError()`, deep redaction, immutable/content-addressed `FlowArtifact`, structured 400s, zero writes on invalid input, artifact list, and redacted trace lookup. Register the route statically in `src/index.ts`.
8. Add a live Sandbox test which compiles a supported echo graph using Langflow 1.11.2 catalogue, creates it through the real Flow API, executes it, verifies the actual returned output, and deletes only the temporary test flow by exact id. If the service is absent, report BLOCKED; do not weaken assertions.

Important architecture constraints:

- AIOS remains source of truth; Langflow is only a runtime.
- Do not add LangGraph as a dependency.
- Runtime is not an Engine enum.
- Keep execute != verify invariant untouched.
- Gate, policy, approval, and budget failures are fail-closed.
- Trace/list adjunct failures may be fail-safe, but never invent success.
- Secrets must be redacted before persistence or error reflection.
- MEMBER and scoped OAuth must receive 403 on every graph authoring endpoint.
- Approval authority remains AIOS. Do not map `approval.checkpoint` to Langflow Human Input.
- Existing graph compiler/template behavior must not regress.
- ESM relative imports include `.js`.
- Avoid Prisma schema changes unless absolutely necessary; `FlowArtifact` already supports unbound graph artifacts.

Run and report:

- new graph test suite
- relevant existing compiler/runtime boundary suites
- `npm run typecheck`
- `npm run build`

At the end, give a concise summary of files changed, pass/fail/block counts, and any honest unsupported mappings. Do not commit or push.
