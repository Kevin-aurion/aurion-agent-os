# 12 — Workbench V2：排程工作與 Skill Palette

**Phase:** 4
**Blocked by:** None — can start immediately
**Status:** ready-for-agent

## What to build

在 End User 語言顯示 Agent 可做的事、授權狀態與排程，不提供越權變更入口。

## To-Do List

- [ ] 建立 read-only Skill palette
- [ ] 建立 Schedule list、next run、last result 與 paused reason
- [ ] 將 technical capability name 映射業務語言
- [ ] 確認 UI action 與 backend guard 對照

## Acceptance criteria

- [ ] MEMBER 看得懂技能與排程
- [ ] 不存在可繞過 restrictions／riskTier 的 autonomy control
- [ ] FDE-only mutation 不會在 MEMBER DOM 出現

## Exact likely files

- aios-web workbench skills/schedule components/tests

## Existing patterns to reuse

- Agent details、Workflow／Schedule API、role guards

## Must not modify

- scheduler backend
- 工具授權 mutation
- full-auto toggle

## Verification

- web typecheck
- role visibility selftest
- Browser MEMBER/FDE comparison

## Positive / negative tests

- 正向：skills／schedules readable
- 負向：MEMBER DOM 無 enable／permission／production controls
