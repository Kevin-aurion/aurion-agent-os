# 18 — 唯讀郵件 Production Pilot、HITL 與 Idempotency

**Phase:** 5
**Blocked by:** 06, 16, 17 — Deployment、Model Gateway、Production isolation
**Status:** ready-for-agent

## What to build

把 AIOS Schedule、active Deployment、Langflow Runtime、Model／Capability Gateway、ApprovalRequest 串成 read-only email triage canary。

## To-Do List

- [ ] 將 Schedule 指向 active RuntimeDeployment，無 deployment 維持 Native path
- [ ] 用 message_id 建立 idempotent Run
- [ ] 串 approval.required→createApproval→isRunApproved→resume
- [ ] 完成 CANARY→STABLE、rollback、kill switch、Native fallback
- [ ] 僅使用 read-only Gmail capability

## Acceptance criteria

- [ ] duplicate message 只有一個 Run
- [ ] refund 在真 ApprovalRequest 前無 write
- [ ] Langflow-side approve 無效
- [ ] kill switch 回 Native 或 AWAITING_REVIEW
- [ ] rollback 不刪資料
- [ ] 既有 Native schedule 零回歸

## Exact likely files

- src/lib/runtimeexecution.ts/productionpilot.ts
- minimal scheduler integration
- runtime routes
- tests/t18-*

## Existing patterns to reuse

- DeviceTask idempotency、approval.ts、Skill canary/stable、scheduler dispatch

## Must not modify

- approval.ts
- 無 deployment 的 Native scheduling 行為
- direct Gmail credential

## Verification

- server tsc
- real DB idempotency/HITL/kill-switch/rollback suite
- existing scheduler/runner regressions

## Positive / negative tests

- 正向：complaint/quotation triage
- 負向：refund、duplicate id、fake approval、dead runtime、budget exhausted
