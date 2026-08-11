# Backend review 1 — required fixes before acceptance

Continue the same Graph Engineering v2 implementation. Preserve all WIP. Do not commit or push.

The first implementation passes its own tests, but the reviewer found these integration/safety defects. Write failing tests first for each, then fix them.

## P0 — Source Graph is incorrectly deployable as a Langflow native artifact

`POST /api/graph/artifacts` currently stores the AIOS GraphSpec v2 with `runtimeKind: LANGFLOW`. Existing RuntimeDeployment sends `artifactJson` directly to Langflow `/api/v1/flows/`, so that source GraphSpec is not a native Langflow flow and would recreate the previous production failure.

Required design:

1. Persist the governed GraphSpec as an immutable **source artifact** with an unambiguous source template (for example `graph-engineering-v2-source`) and a runtime kind that cannot be mistaken for a native Langflow payload. Keep AIOS as source of truth.
2. Add an FDE-only endpoint such as `POST /api/graph/artifacts/:id/compile/langflow` that:
   - loads and digest-verifies the exact source artifact;
   - requires the source template/schema;
   - validates GraphSpec v2;
   - fetches the exact target environment catalogue or accepts a frozen catalogue only in an explicit test/offline path;
   - compiles with fail-closed semantic support;
   - stores a **separate content-addressed LANGFLOW native artifact** whose `artifactJson` is exactly the deployable native `flow.data` (`nodes`, `edges`, `viewport`);
   - records only redacted provenance metadata: sourceArtifactId, sourceDigest, catalogueFingerprint, nodeMapping, target environment, flow name/description;
   - returns both source and compiled artifact ids/digests.
3. Existing runtime validation/deployment of the compiled artifact must work without special casing or posting GraphSpec as native JSON.
4. List responses must distinguish source vs compiled-native artifacts.
5. Invalid/unsupported compile produces zero new FlowArtifact rows.

Add API + real DB tests proving source and compiled artifacts are separate, the native artifact has native `genericNode` JSON, and only the compiled artifact is suitable for Langflow deployment.

## P1 — Catalogue fingerprint is not exact

The current fingerprint only hashes category/type/display_name. Component code/template/output changes with the same names would keep the same fingerprint.

Hash the full canonical, redacted component definitions in deterministic category/type order. Add a test where only a template/output/code leaf changes and fingerprint must change.

## P1 — Graph topology validation gaps

Add fail-closed rules/tests:

- `entryNodeId` kind must be `input` or `control.start`.
- each `exitNodeId` kind must be `output`, `control.end`, or `control.failure`.
- exit nodes cannot have outgoing non-loop execution edges.
- a `loop` edge must originate from `control.loop`; non-loop nodes cannot declare loop edges.
- condition fan-out must have exactly one explicit `condition.branch=true` and one `condition.branch=false` for the native deterministic contract; duplicates or missing branches reject.
- condition edges may originate only from `control.condition`.
- parallel edges may originate only from `control.parallel`.
- failure edges must terminate at `control.failure` or another explicit failure handler contract; do not silently accept arbitrary failure routing.

## P2 — Avoid false-positive Gmail content rejection

`gmail.com` in the generic provider-marker regex rejects legitimate labels/descriptions. Provider endpoints and credential fields must still reject, but ordinary business text mentioning Gmail must not. Add a regression test.

## Verification

Rerun all graph suites, existing compiler/adapter/runtime boundary suites, typecheck, and build. Report exact results and any remaining honest unsupported mapping. Do not touch frontend yet.
