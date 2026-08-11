# 16 — 高風險 AIOS Model Gateway

**Phase:** 5
**Blocked by:** 03 — Runtime Adapter Contract
**Status:** ready-for-agent

## What to build

建立 loopback service-to-service Model Gateway，讓 Langflow execute／verify 都走 AIOS 原有 Engine Adapter、預算、限制、成本與跨模型驗證。

## To-Do List

- [ ] 先寫 auth spoof／same-family／budget／restriction 負向測試
- [ ] 抽出或安全重用既有 engine dispatch，不複製判決 regex
- [ ] 建立 execute、verify、health internal endpoints
- [ ] 由 run/deployment 回查權威資料，不信任 caller fields
- [ ] 記錄 per-step cost 與 model family

## Acceptance criteria

- [ ] dispatch 前先 guardBudget
- [ ] verify engine server-side 必與 execute 不同
- [ ] service identity／loopback 皆 fail-closed
- [ ] 限制、成本、redaction 與 outcome 可追溯
- [ ] Native compileManifest 零回歸

## Exact likely files

- src/lib/modelgateway.ts
- src/routes/modelgateway.ts
- minimal exported engine dispatch seam if unavoidable
- tests/t16-*

## Existing patterns to reuse

- ENGINE_ADAPTERS single table、guardBudget、recordCost、isApproved、internal service auth

## Must not modify

- 新增第二份 approval oracle
- LANGFLOW Engine enum
- caller-controlled restrictions/model family
- 公開 end-user route

## Verification

- server tsc
- cross-model/budget/auth negative tests
- existing runner invariant suite

## Positive / negative tests

- 正向：execute then opposite verify
- 負向：same family、budget exhausted、forged agent/run/deployment、non-loopback、invalid service token
