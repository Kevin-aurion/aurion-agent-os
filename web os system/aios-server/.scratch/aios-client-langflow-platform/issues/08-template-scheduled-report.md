# 08 — AIOS 排程驅動的報表模板

**Phase:** 3
**Blocked by:** 07 — Compiler Core
**Status:** ready-for-agent

## What to build

新增 scheduled-report-v1；Schedule 仍由 AIOS 擁有，Artifact 只描述單次報表工作。

## To-Do List

- [ ] 定義 report input/output/rubric slots
- [ ] 拒絕 Langflow-native cron／scheduler node
- [ ] 編譯 AIOS Schedule metadata reference
- [ ] 測試 timezone 與 duplicate trigger contract

## Acceptance criteria

- [ ] Flow 中沒有第二個 scheduler
- [ ] 無 Schedule／無允許 read capability 時拒絕
- [ ] 既有 BullMQ／Temporal 仍是唯一觸發者

## Exact likely files

- src/compiler/templates/scheduled-report-v1.ts
- compiler registry
- tests/t08-*

## Existing patterns to reuse

- Schedule／Workflow durable flag、compiler registry

## Must not modify

- scheduler/index.ts 行為
- Langflow cron node

## Verification

- server tsc
- scheduled template compile tests
- structural no-scheduler negative

## Positive / negative tests

- 正向：daily report IR
- 負向：runtime cron、write-only data source、invalid timezone
