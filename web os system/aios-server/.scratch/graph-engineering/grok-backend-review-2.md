# Backend review 2 — deployment guard and trusted catalogue boundary

Continue the same session. Tests first, then fixes. Preserve all WIP. No commit/push.

## P0 — Source artifacts must be authoring-only, not deployable as NATIVE

Changing the source GraphSpec to `runtimeKind=NATIVE` prevents accidental Langflow posting, but the existing runtime validation/activation path may now treat it as a deployable Native artifact even though Native Runtime does not execute GraphSpec v2.

Add a server-side fail-closed guard in the existing runtime validation/deployment path:

- `template=graph-engineering-v2-source` is authoring-only.
- `/api/runtime/artifacts/:id/validate` must reject it with a stable code/message.
- activation/deployment must also independently reject it even if status was somehow changed or a stale row exists.
- only `graph-engineering-v2-langflow` with `runtimeKind=LANGFLOW` and `isLangflowNativeFlowData(artifactJson)` can enter the Langflow deployment path.
- add negative tests proving a source artifact cannot be validated or activated and that the compiled native artifact can pass the existing Langflow validation path.

Do not create a new RuntimeKind or weaken existing adapters.

## P0 — Never accept a client-supplied Langflow component catalogue

Both ephemeral and persisted compile routes currently accept `catalogue` in the HTTP body. A malicious FDE/client could submit component definitions containing arbitrary Python and have them stored as a native artifact. The comment "offline/test only" is not an authorization boundary.

Required:

- Remove `catalogue` from every public HTTP request schema.
- Public routes always fetch the exact catalogue through `resolveRuntimeAdapter(...).fetchComponentCatalogue()` for the selected environment.
- Keep unit/API tests deterministic through server-side dependency injection or a private test-only function, never through an HTTP body field and never through `NODE_ENV` branching.
- Add a negative API test: body containing `catalogue` is rejected by strict schema (400) and creates zero artifacts.
- Ensure schemas are `.strict()` so unknown request keys reject.

## P1 — Add FDE artifact detail for Workbench loading/diff

Add `GET /api/graph/artifacts/:id` before the `/:id/traces` route:

- requireTrainer
- load + digest verify exact artifact
- return redacted metadata and `artifactJson`
- return `artifactKind`, `langflowDeployable`, digest/status/runtime/template/compiler timestamps and bindings
- for source, `artifactJson` is GraphSpec v2 and can be loaded in Workbench
- for compiled, it is native flow.data
- not found 404, digest drift conflict, MEMBER 403

## P1 — Compiled template shape guard

At runtime validation, if template is `graph-engineering-v2-langflow`, require `runtimeKind=LANGFLOW` and exact native `genericNode`/viewport shape before marking VALIDATED. This is additive to the adapter digest check.

## Verification

Add a new review suite and rerun all Graph suites, relevant runtime/deployment tests, typecheck, and build. Report exact results. Do not touch frontend.
