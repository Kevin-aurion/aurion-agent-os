# 20 — Phase 5 十大真實負向驗收閘

**Phase:** 5
**Blocked by:** 18, 19 — Pilot 與 Observability
**Status:** ready-for-agent

## What to build

用真 DB、真 Gateways、真 Runtime 組裝十大 PoC 案例與五條紅線完整回歸，不修改 production code。

## To-Do List

- [ ] 為 complaint、quotation、refund、prompt injection、duplicate、outage、digest drift、same-family、budget、MEMBER publish 各寫獨立腳本
- [ ] 每例記錄 command/output/DB before-after
- [ ] 跑 agent-builder、skill-production、workbench、runner regressions
- [ ] 產生 Phase 5 exit report

## Acceptance criteria

- [ ] 十例全綠且有真實證據
- [ ] 所有拒絕在 side effect 前發生
- [ ] 既有五條紅線零回歸
- [ ] 失敗必回到 owning ticket 修復後從頭重測

## Exact likely files

- tests/t20-poc-01..10.ts
- reports/20-phase5-exit-report.md

## Existing patterns to reuse

- skill-production t06 regression、真 DB scratch tests

## Must not modify

- 任何 production source
- 用 mock 冒充 live production

## Verification

- 逐一 npx tsx 十案
- 完整 server/web/MCP typecheck
- 所有既有治理 regression

## Positive / negative tests

- 正向：complaint/quotation/outage isolation
- 負向：refund、injection、duplicate、tamper、same model、budget、MEMBER publish
