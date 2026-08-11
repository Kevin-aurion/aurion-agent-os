# 03 — Native／Langflow Runtime Adapter 合約

**Phase:** 2
**Blocked by:** 02 — 隔離的 Langflow FDE Sandbox
**Status:** ready-for-agent

## What to build

以同一受治理介面包住 Native Runner 與 Langflow，將 health、validate、deploy、execute stream、get、cancel、resume 統一成 AIOS domain event。

## To-Do List

- [ ] 定義 RuntimeAdapter 與 normalized request/event types
- [ ] 實作 NativeAdapter，僅呼叫既有 runAgent
- [ ] 實作 LangflowAdapter，封裝所有 wire format
- [ ] 加入精確 loopback URL、timeout、cancel 與錯誤正規化

## Acceptance criteria

- [ ] 兩 Adapter 通過同一 contract test
- [ ] Langflow event 不洩漏到 Adapter 外部
- [ ] Sandbox 停機可控失敗，不永久掛住
- [ ] 非 loopback 與同前綴惡意 hostname fail-closed

## Exact likely files

- src/runtime/adapter.ts
- src/runtime/native.ts
- src/runtime/langflow.ts
- tests/t03-*

## Existing patterns to reuse

- runAgent、codexmcp wire translation、mcpregistry precise loopback

## Must not modify

- engine/runner.ts 與 Engine enum
- Prisma schema／migration

## Verification

- server tsc
- t03 adapter contract
- t03 URL／timeout negative

## Positive / negative tests

- 正向：Native／Langflow health 與 terminal event
- 負向：10.0.0.0、127.0.0.1.evil.com、mid-run outage
