# Aurion AIOS Graph Engineering v2 — Technical Spec

## 1. Goal

Deliver the three missing Graph Engineering layers without weakening AIOS governance:

1. `GraphSpec v2`: a strict, typed, versioned graph contract.
2. `AIOS Graph -> native Langflow`: a deterministic compiler for the supported, semantics-preserving subset.
3. `Graph Workbench`: an FDE-only visual authoring, validation, diff, artifact, and trace surface in AIOS Studio.

Langflow remains a replaceable runtime. AIOS remains the source of truth for Agent, Skill, policy, approval, version, artifact, deployment, and audit data.

## 2. User journeys

- As an FDE, I can arrange nodes and edges visually and see validation failures before anything is stored or deployed.
- As an FDE, I can model explicit start/end, conditional, parallel/join, bounded loop, subgraph, and failure edges.
- As an FDE, I can compare the current graph with a previous artifact before saving a new immutable artifact.
- As an FDE, I can see whether each graph node can be compiled to native Langflow without semantic loss.
- As an FDE, I can compile and live-test a supported graph in Langflow Sandbox.
- As an auditor, I can inspect redacted graph traces associated with an artifact.
- As a MEMBER, I cannot create, compile, validate, or store governed graph artifacts.

## 3. GraphSpec v2 contract

Schema id: `aios.flow-graph/2`.

Required graph fields:

- `schemaVersion`
- `id`, `name`, `revision`
- `stateSchema` (JSON-Schema-like object, declarative only)
- `entryNodeId`
- `exitNodeIds`
- `nodes[]`
- `edges[]`

Required node fields:

- `id`, `kind`, `label`
- `position { x, y }`
- optional `config`, `inputSchema`, `outputSchema`

Node kinds:

- Data/AIOS: `input`, `output`, `tool.read`, `tool.gated`, `gateway.classify`, `gateway.summarize`, `gateway.verify`, `approval.checkpoint`
- Control: `control.start`, `control.end`, `control.condition`, `control.parallel`, `control.join`, `control.loop`, `control.failure`
- Composition: `subgraph`

Edge kinds:

- `default`, `condition`, `parallel`, `failure`, `loop`
- conditional edges require a declarative condition
- loop edges require `maxTraversals` in the range 1..50

## 4. Validation — fail closed

Validation must reject:

- malformed or unknown fields
- duplicate node or edge ids
- missing entry/exit nodes
- edges pointing to missing nodes
- unreachable/orphan nodes
- nodes that cannot reach an exit/failure terminal
- unbounded cycles or cycles without an explicit `loop` edge
- invalid condition fan-out
- parallel nodes without at least two branches or joins without at least two inputs
- `tool.gated` when every path to it is not protected by an AIOS approval checkpoint
- unsafe credential/provider/endpoint material inside nodes or state schema
- invalid subgraph references (missing immutable artifact id/digest)

Validation errors are structured with `code`, `path`, `message`, and optional `nodeId`/`edgeId`.

## 5. Graph diff

Return deterministic structural changes:

- node add/remove/change/move
- edge add/remove/change
- entry/exit/state schema changes
- risk summary: `LOW`, `MEDIUM`, `HIGH`
- changes involving gated tools, approval, failure, loop, or subgraph are never `LOW`

## 6. Native Langflow compiler

The compiler consumes a validated GraphSpec v2 and an exact Langflow component catalogue. It produces native Langflow `data.nodes`, `data.edges`, and `viewport`.

Rules:

- component definitions come from the pinned Langflow runtime catalogue (`/api/v1/all`) and are cloned into the native Flow JSON
- generated ids and layout are deterministic
- edge handles are produced from actual component output/input definitions
- compiler records a per-node mapping and catalogue fingerprint
- only semantics-preserving mappings are allowed
- unsupported node semantics produce `UNSUPPORTED_NODE_KIND`; no Pass-node substitution that would pretend execution succeeded
- secrets, provider keys, or arbitrary Python are never generated

Initial supported native subset:

- `control.start` / `input` -> `ChatInput`
- `control.end` / `output` -> `ChatOutput`
- message pass-through control nodes -> vetted `Pass`
- condition nodes -> vetted `ConditionalRouter` only when their declarative condition fits its supported contract
- subgraph -> vetted `SubFlow` only with immutable, already-governed runtime binding

AIOS approval, tool, MCP, model gateway, and write nodes remain fail-closed until an AIOS-controlled capability bridge exists. The Workbench must display this before deployment.

## 7. Graph Workbench

Route: `/studio/graph` (FDE-only).

Minimum UI:

- node palette grouped by input/output, reasoning, tool, governance, and control
- pannable/zoomable graph canvas with draggable nodes and connectable edges
- node inspector for label, kind-specific configuration, schemas, and position
- validation panel linked to nodes/edges
- Native/Langflow compatibility panel
- version diff panel
- save immutable AIOS artifact action
- artifact list and redacted trace list
- clear notice that saving is not Production deployment; deployment still uses Eval + FDE + Canary/Stable gates

## 8. API

All endpoints require `TRAINER` or `OWNER`:

- `POST /api/graph/validate`
- `POST /api/graph/diff`
- `POST /api/graph/langflow/compile`
- `POST /api/graph/artifacts`
- `GET /api/graph/artifacts`
- `GET /api/graph/artifacts/:id/traces`
- `GET /api/graph/palette`

Responses use the existing `ok()` / `sendError()` envelope. All persisted input is deep-redacted. Artifact storage is immutable/content-addressed. Unknown or invalid input performs zero writes.

## 9. Acceptance and verification

- GraphSpec unit tests cover all node/edge/control semantics and negative safety paths.
- Langflow compiler unit tests prove deterministic native JSON and fail-closed unsupported mappings.
- Live Sandbox test creates, runs, and deletes a supported echo graph against pinned Langflow `1.11.2`.
- API tests prove FDE success and MEMBER/unauthenticated rejection.
- Studio tests cover palette, compatibility, diff presentation, and validation mapping.
- Browser E2E proves FDE can open the Workbench, edit/connect a graph, validate it, compile it, and save an artifact.
- Server and Studio typecheck/build pass.
- Existing cross-model, approval, budget, redaction, and runtime boundary tests remain green.
