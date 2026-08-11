# 21 — Phase 6 企業強化基礎與復原演練

**Phase:** 6
**Blocked by:** 20 — Phase 5 十大驗收閘
**Status:** ready-for-agent

## What to build

落實可驗證但不誇大的企業強化基礎：Runtime service identity、環境 binding、rate limit、circuit breaker、dead-letter、Knowledge access contract、備份復原與 SLO；完整多租戶另立後續專案。

## To-Do List

- [ ] 為 Model／Capability Gateway 加可輪替 service identity 與 environment binding
- [ ] 加入 per-deployment rate limit、timeout、circuit breaker 與 dead-letter／manual replay queue
- [ ] 定義 Knowledge capability 的 ACL/retention/data-classification contract，禁止 Runtime 直連 Qdrant
- [ ] 完成 Postgres＋Artifact metadata backup/restore drill 與 Langflow stateless rebuild runbook
- [ ] 建立 SLO dashboard/alerts 與 disaster scenario tests
- [ ] 更新 AGENTS 已知限制，明示 Tenant/per-tenant isolation 未完成

## Acceptance criteria

- [ ] 錯環境／過期 service identity fail-closed
- [ ] 故障 Runtime 進 circuit open，job 進 dead-letter 且不重複 side effect
- [ ] Knowledge access 經 Capability Gateway 並有最小 scope
- [ ] 可從備份重建 AIOS control-plane state 與兩 Langflow runtime
- [ ] SLO/DR report 有實跑時間與結果
- [ ] 文件不宣稱多租戶完成

## Exact likely files

- gateway hardening modules/config
- dead-letter model/routes if required
- knowledge capability contract
- docs/langflow-backup-dr-runbook.md
- tests/t21-*
- AGENTS.md limitation note

## Existing patterns to reuse

- MCP broker timeout/reconnect、BullMQ/Temporal、audit/cost/health、connected account encryption

## Must not modify

- 假 tenantId scaffolding 當作 isolation
- 直接 Runtime→Qdrant／provider
- 跨企業計費宣稱

## Verification

- server/web/MCP tsc
- service identity/rate/circuit/DLQ tests
- backup restore and stateless rebuild drill
- SLO/DR report review

## Positive / negative tests

- 正向：manual replay exactly once、restore drill
- 負向：expired/wrong-env identity、rate burst、gateway outage、secret/ACL violation
