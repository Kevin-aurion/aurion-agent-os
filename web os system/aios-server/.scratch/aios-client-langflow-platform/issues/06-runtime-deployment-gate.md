# 06 — FDE Runtime Deployment Gate 與 Rollback

**Phase:** 3
**Blocked by:** 05 — 不可變 Flow Artifact 與 Digest
**Status:** ready-for-agent

## What to build

建立 RuntimeDeployment、環境／channel、Run runtime metadata 與 FDE-only validate／activate／rollback API。

## To-Do List

- [ ] 先寫 MEMBER／eval／same-family／digest 負向測試
- [ ] 新增 additive models、Run nullable fields、unique idempotency constraint
- [ ] 實作 activateDeployment 與 rollback，不刪紀錄
- [ ] 建立 trainer routes 與 AuditLog

## Acceptance criteria

- [ ] 只有 FDE 可 activate
- [ ] VALIDATED、confirmed Skill、passing eval、無 highRisk、不同 model family、digest 與 adapter validation 全通過才生效
- [ ] rollback 只切 active pointer
- [ ] 所有失敗零有效變更

## Exact likely files

- prisma/schema.prisma
- new migration
- src/lib/runtimedeployment.ts
- src/routes/runtime.ts
- tests/t06-*

## Existing patterns to reuse

- promoteWithGate、rollbackStable、requireTrainer、ok/sendError、audit hash chain

## Must not modify

- skillpromote.ts／approval.ts
- runner.ts／Engine enum

## Verification

- prisma validate／generate／migrate
- server tsc
- FDE gate positive／negative suite

## Positive / negative tests

- 正向：CANARY activation、prior-artifact rollback
- 負向：MEMBER、COMPILED only、no eval、highRisk、same family、digest drift
