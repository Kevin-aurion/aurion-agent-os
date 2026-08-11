# Graph Workbench release-blocker fixes

You are the implementation model for Lazyoffice AIOS. Work only in `web os system/aios-studio/` and the existing graph-engineering scratch tests. Do not touch backend code or unrelated user WIP. Follow the root AGENTS.md red lines. Implement and test these fixes; do not merely describe them.

## Release blockers

1. **Current graph must be the graph compiled**
   - The current page can reuse `lastSourceId` after the user edits the graph, so `Compile -> Native` may compile an older source artifact.
   - Make the compile action always save/content-address the current `GraphSpecV2`, then compile the exact returned source artifact id. An unchanged graph may naturally reuse the immutable source.
   - Extract this sequencing to a small testable helper (for example `src/lib/graph/actions.ts`) and add a unit test proving that the returned id from saving the *current* graph is the id passed to compile. Do not trust stale UI state.

2. **Invalidate stale verdicts on semantic edits**
   - Adding/removing/updating nodes or edges, editing graph name/revision/state schema, or applying a template must clear validation issues, diff, Langflow mapping, compile status/message and any stale success note as appropriate.
   - Pure canvas position changes may preserve semantic validation/compatibility, but no semantic edit may leave a green `Native OK` badge or old mapping behind.
   - Centralize this rather than scattering inconsistent `setGraph` calls.

3. **Fix current syntax corruption**
   - `src/app/studio/graph/page.tsx` currently contains an extra `}, []);` around `onUpdateNode` (and inspect the nearby validate handler for accidental duplication). Fix it and run all checks.

4. **Inspector must only offer valid GraphSpec values**
   - Approval checkpoint risk is only `medium | high`; remove `low`.
   - Condition operator must be a select backed by the exact supported operator enum from the frontend GraphSpec types, not free text cast with `as never`.
   - Keep approval authority/emits/resume requirements fixed and non-editable.

5. **Typed graph state must be editable**
   - Add a safe declarative `stateSchema` JSON-object editor when no node/edge is selected (or a clear Graph settings section). It must use the same parse-error UX and update the current graph through the semantic edit invalidation path. No executable code editor.

6. **Browser-test affordances**
   - Add stable `data-testid` attributes at least for: workbench root, validate, compatibility preview, save source, compile native, environment selector, canvas, template buttons, issue/compat status, and artifact drawer/list. Keep visible UI non-technical and polished.

## Tests and validation

- Add/adjust unit tests for the current-source compile sequencing and any pure state invalidation helper you introduce.
- Run `npm test`, `npm run typecheck`, and `npm run build` from `web os system/aios-studio`.
- Report exact files changed, exact test totals, and any remaining limitation.
- Do not commit or push.
