# AIOS Client + Langflow Runtime Platform — Ticket Index

執行順序採 blocker frontier；每票由 Grok CLI 實作、Fable 審查、Codex 實跑驗收。

- [01 — Cherry Companion Client 安全與 UX Spike](./issues/01-cherry-companion-spike.md) — Phase 1; blocked by: None — can start immediately
- [02 — 隔離的 Langflow FDE Sandbox](./issues/02-langflow-sandbox-docker.md) — Phase 2; blocked by: None — can start immediately
- [03 — Native／Langflow Runtime Adapter 合約](./issues/03-runtime-adapter-contract.md) — Phase 2; blocked by: 02 — 隔離的 Langflow FDE Sandbox
- [04 — SkillVersion 的機器可讀 Skill IR](./issues/04-skillversion-ir-fields.md) — Phase 3; blocked by: None — can start immediately
- [05 — 不可變 Flow Artifact 與 Digest](./issues/05-flowartifact-model-and-digest.md) — Phase 3; blocked by: 04 — SkillVersion 的機器可讀 Skill IR
- [06 — FDE Runtime Deployment Gate 與 Rollback](./issues/06-runtime-deployment-gate.md) — Phase 3; blocked by: 05 — 不可變 Flow Artifact 與 Digest
- [07 — Skill IR Compiler 與唯讀郵件分類模板](./issues/07-compiler-email-triage.md) — Phase 3; blocked by: 04, 05 — Skill IR 與 FlowArtifact
- [08 — AIOS 排程驅動的報表模板](./issues/08-template-scheduled-report.md) — Phase 3; blocked by: 07 — Compiler Core
- [09 — 需 FDE 核准的單一動作模板](./issues/09-template-approval-gated-action.md) — Phase 3; blocked by: 07 — Compiler Core
- [10 — Workbench V2：交代工作完整旅程](./issues/10-workbench-assign-work.md) — Phase 4; blocked by: None — can start immediately
- [11 — Workbench V2：教它新工作完整旅程](./issues/11-workbench-teach-new-task.md) — Phase 4; blocked by: None — can start immediately
- [12 — Workbench V2：排程工作與 Skill Palette](./issues/12-workbench-scheduled-work.md) — Phase 4; blocked by: None — can start immediately
- [13 — FDE 統一 Proposal／Approval 審核旅程](./issues/13-fde-proposal-approval-journey.md) — Phase 4; blocked by: None — can start immediately
- [14 — FDE Skill 版本／Diff／Eval／Rollback 旅程](./issues/14-fde-skill-governance.md) — Phase 4; blocked by: None — can start immediately
- [15 — FDE Flow Artifact／Deployment 管理旅程](./issues/15-fde-flow-deployment-governance.md) — Phase 4; blocked by: 06 — Runtime Deployment Gate
- [16 — 高風險 AIOS Model Gateway](./issues/16-model-gateway.md) — Phase 5; blocked by: 03 — Runtime Adapter Contract
- [17 — 高風險 Langflow Production 隔離](./issues/17-langflow-production-isolation.md) — Phase 5; blocked by: 02 — Langflow Sandbox
- [18 — 唯讀郵件 Production Pilot、HITL 與 Idempotency](./issues/18-production-rollout-idempotency.md) — Phase 5; blocked by: 06, 16, 17 — Deployment、Model Gateway、Production isolation
- [19 — Runtime Observability、SLO 與 Audit](./issues/19-observability-slo.md) — Phase 5; blocked by: 18 — Production Pilot
- [20 — Phase 5 十大真實負向驗收閘](./issues/20-poc-negative-suite.md) — Phase 5; blocked by: 18, 19 — Pilot 與 Observability
- [21 — Phase 6 企業強化基礎與復原演練](./issues/21-phase6-hardening.md) — Phase 6; blocked by: 20 — Phase 5 十大驗收閘
- [22 — FDE MCP／A2A Registry API 前綴修復](./issues/22-fde-registry-api-prefix.md) — Phase 6; blocked by: 13 — FDE 統一審核與管理旅程
- [23 — Langflow Production Flow API 認證](./issues/23-langflow-api-auth.md) — Phase 6; blocked by: 17 — Langflow Production isolation
- [24 — Runtime Binding 正確路由到 Langflow Flow ID](./issues/24-runtime-binding-execution.md) — Phase 6; blocked by: 23 — Langflow API auth
- [25 — Langflow 環境隔離與 2xx 執行結果 Fail-Closed](./issues/25-langflow-runtime-boundary.md) — Phase 6; blocked by: 23, 24
