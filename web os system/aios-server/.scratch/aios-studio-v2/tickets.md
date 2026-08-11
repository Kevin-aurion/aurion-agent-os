# Studio V2 vertical tickets

## STUDIO-01 — Design system foundation

- Define colour, typography, spacing, radius, focus and motion tokens.
- Build AppShell, SideNav, TopBar, Card, Badge, EmptyState, Skeleton,
  Disclosure and SettingRow primitives.
- Cover keyboard focus, reduced motion and narrow screens.

## STUDIO-02 — Authentication and API boundary

- Reuse same-origin `/api/*` proxy and rotating AIOS token contract.
- Add protected route shell and role-aware FDE messaging.
- Add loading, network error and expired-session handling.

## STUDIO-03 — Agent workspace

- List existing non-system Agents.
- Provide overview, model, Tool/MCP, knowledge, skills and deployment tabs.
- Persist supported Agent fields through existing guarded endpoints.
- Enforce execute/verify separation before submit.

## STUDIO-04 — Registry workspaces

- Add Tool/MCP registry with trust and health states.
- Add model family explanation and cross-model guard.
- Add knowledge boundary view.
- Add skill registry with review status.

## STUDIO-05 — Runtime workspace

- List deployments and environment badges.
- Distinguish Sandbox from Production and show blocking reason.
- Keep activation behind existing FDE/evaluation gates.

## LF-01 — Knowledge collector shadow clone

- Snapshot the original builder session.
- Create an independently named shadow draft without mutating the source.
- Reduce the pilot capability to read-only knowledge validation.
- Record source session ID and clone relationship in metadata.

## LF-02 — Native Langflow Sandbox flow

- Create a private no-side-effect Chat Input → Chat Output validation flow.
- Use a valid native Langflow graph, not AIOS canonical IR pretending to be one.
- Execute through Langflow Flow API and assert output and trace shape.
- Keep provider credentials, filesystem, shell and network tools absent.

## OPS-01 — Independent deployment

- Build Studio V2 independently on port 3300.
- Install a separate host service with health and restart behaviour.
- Add `aios-studio.lazyoffice.app` to the existing Cloudflare tunnel.
- Verify public login, API proxy and guarded pages in a browser.
