# Grok implementation assignment — Graph Workbench frontend

Work only inside:

`/Users/kaikaiwu/Desktop/LazyOffice/AI OS Langflow/web os system/aios-studio`

Read the repository `AGENTS.md`, applicable `CLAUDE.md`, the Graph spec/tickets in sibling `aios-server/.scratch/graph-engineering/`, and the existing Studio pages/components/styles before editing. Preserve all current WIP. Do not touch the old `aios-web` frontend. Do not commit or push.

Implement T05 plus frontend integration for T04/T06 using strict TDD: write failing pure/presentation tests first, run them, then implement. Use the existing Studio design language and bring the UX to the same quality level as the current Agent/Tool/Knowledge/Runtime pages.

## Required product

Route: `/studio/graph`, FDE-only, with navigation entry **Graph 工程** under Governance/Execution.

Use a real visual node canvas. Prefer `@xyflow/react` and install/pin it normally if compatible with this React/Next project. It must support:

- pan, zoom, fit view
- draggable nodes
- connectable handles and removable edges
- selectable nodes and edges
- minimap/background/controls where appropriate
- responsive fallback so inspector/palette remain usable on narrower screens

## Workbench layout

1. Top header/toolbar:
   - graph name + revision
   - environment selector (`SANDBOX`, `STAGING`, `PRODUCTION`)
   - Validate
   - Langflow compatibility preview
   - Save immutable source version
   - Compile selected source to Langflow native artifact
   - clear governance copy: Save != Deploy; Production still requires Runtime validation, Eval, FDE, Canary/Stable
2. Left palette grouped by Input/Output, Reasoning, Tool, Governance, Control, Composition. Fetch `/api/graph/palette`; show Native/AIOS-only badges.
3. Center graph canvas with polished custom node cards, kind/status/native badge, input/output handles, selected/error states.
4. Right inspector:
   - selected node: label, kind-specific declarative config, tool capability id, subgraph artifact/digest, position, input/output schema JSON
   - selected edge: edge kind, label, condition true/false/operator/match text, loop maxTraversals
   - safe JSON editing with visible parse error; do not silently discard invalid edits
5. Bottom or tabbed governance drawer:
   - Validation issues linked to node/edge; clicking focuses/selects it
   - Langflow per-node mapping and unsupported reasons
   - Version diff vs current baseline with risk badge
   - immutable source/native artifact history and load source detail
   - redacted trace history for selected artifact

## API integration

Use these FDE-only endpoints:

- `GET /api/graph/palette`
- `POST /api/graph/validate` body `{ graph }`
- `POST /api/graph/diff` body `{ before, after }`
- `POST /api/graph/langflow/compile` body `{ graph, environment }` — never send a catalogue
- `POST /api/graph/artifacts` body `{ graph, metadata }`
- `GET /api/graph/artifacts?kind=all`
- `GET /api/graph/artifacts/:id`
- `POST /api/graph/artifacts/:id/compile/langflow` body `{ environment }`
- `GET /api/graph/artifacts/:id/traces`

Update the API error type so structured `error.detail` is available to the UI, without breaking existing callers.

## Graph serialization

Create a tested pure frontend graph model/adapter:

- strict `aios.flow-graph/2` objects
- deterministic default echo graph (`control.start -> control.end`) that compiles live
- React Flow nodes/edges <-> GraphSpec conversion without data loss
- entry/exit inference only from explicit node kinds; never silently choose an arbitrary node
- node and edge add/update/remove helpers
- structured issue -> node/edge highlighting and focus
- preserve revision and stateSchema
- position-only diff remains LOW

Provide quick templates:

- Langflow Echo (supported, runnable)
- Conditional Route (supported native contract)
- Approval-gated Tool (valid AIOS graph but clearly Langflow-unsupported)
- Parallel/Join (valid AIOS graph but clearly Langflow-unsupported)

## Security and governance

- FDE guard in UI; backend remains authority.
- Never display or accept credentials/provider API keys.
- No free-form executable code editor.
- Approval config is fixed to AIOS authority fields; user only edits reason/risk.
- Unsupported Native mapping is explicit and blocks compile; do not draw a green success state.
- Source and compiled artifacts must be visually distinct.
- Do not add a direct Production activate button here; link to `/studio/runtime` after a compiled artifact exists.

## Tests and verification

Add tests first for:

- default graph conversion round-trip
- explicit entry/exit behavior
- node/edge/config edits
- issue grouping and target selection
- artifact kind/deployability presentation
- `ApiError.detail`
- navigation entry and FDE gate presentation helpers

Run:

- `npm test`
- `npm run typecheck`
- `npm run build`

At the end report changed files and exact results. Do not commit/push.
