Use the installed `mattpocock-skills:to-spec` method now. Synthesize the already completed repository inventory, the user's six-phase implementation request, `.scratch/AIOS_Cherry_V2_Langflow_融合評估_2026-08-08.md`, `CONTEXT.md`, and ADR 0013 into the final specification.

The user explicitly authorized proceeding through implementation without another interview, so treat the testing seams and scope below as approved and do not pause for confirmation:

- Primary runtime seam: one governed `RuntimeAdapter` contract above Native and Langflow runtimes.
- Primary capability seam: existing AIOS MCP Capability Gateway.
- Primary model seam: an AIOS Model Gateway that preserves execute-model != verify-model and fail-closed budget/policy checks.
- Primary client seam: browser-visible `/work` user journeys and `/admin` FDE journeys, backed by existing REST/AWP contracts.
- Production deployment seam: immutable `FlowArtifact` + FDE-gated `RuntimeDeployment`.

Write an extensive product/technical spec covering Phases 1–6, including clean-room constraints, user stories, implementation decisions, state transitions, Langflow Authoring/Sandbox and Production isolation, three safe compiler templates, Agentic Session Runtime, tool registration and approval UX, scheduling, artifacts, knowledge/memory surfaces, Model Gateway, Runtime Adapter, idempotency, rollout/rollback, observability, SLO/DR and tests. Preserve all AIOS red lines.

Important: output only the complete Markdown body for `web os system/aios-server/.scratch/aios-client-langflow-platform/spec.md`. Do not edit files in this session.
