# 17 — 高風險 Langflow Production 隔離

**Phase:** 5
**Blocked by:** 02 — Langflow Sandbox
**Status:** ready-for-agent

## What to build

建立與 Sandbox 完全分離、無 UI 寫入、唯讀 rootfs、無 provider credential、只載入已核准 Artifact 的 Production Runtime。

## To-Do List

- [ ] 新增 production compose、network、secrets reference 與 runbook
- [ ] drop capabilities、read_only、tmpfs、resource limits
- [ ] 只開 AIOS trigger／Model／Capability Gateway 必要路徑
- [ ] 禁止 Custom Component upload 與直接 provider egress
- [ ] 加入 artifact digest loader/validation

## Acceptance criteria

- [ ] Production 與 Sandbox 無共享 volume／credential／port
- [ ] 容器不持有 Claude/Codex/Grok/Gmail/Graph keys
- [ ] 未 active 或 digest mismatch Artifact 不載入
- [ ] 重建容器不影響 AIOS durable data

## Exact likely files

- docker-compose.langflow-production.yml
- production runtime config/entrypoint docs
- tests/t17-*

## Existing patterns to reuse

- sandbox compose、FlowArtifact verify、local-first loopback boundary

## Must not modify

- sandbox compose
- default compose
- production provider credentials
- arbitrary component UI

## Verification

- docker compose config/security inspection
- health and artifact-load tests
- stop/rebuild/data-isolation drill

## Positive / negative tests

- 正向：active valid artifact loads
- 負向：inactive/drifted artifact、writable root、direct egress、shared volume
