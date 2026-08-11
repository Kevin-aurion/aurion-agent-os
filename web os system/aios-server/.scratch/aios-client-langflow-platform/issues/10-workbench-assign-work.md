# 10 — Workbench V2：交代工作完整旅程

**Phase:** 4
**Blocked by:** None — can start immediately
**Status:** ready-for-agent

## What to build

以乾淨室設計完成 Agent／Thread 導覽、中央對話、單一 composer 的交代工作模式與右側 Run／Artifact／Tool timeline。

## To-Do List

- [ ] 先建立 UI contract／角色 visibility tests
- [ ] 整理三欄 responsive shell 與 keyboard/focus behavior
- [ ] 將現有 Conversation／Run／AWP events 投影成 task session
- [ ] 右側顯示 Artifact、來源、RunStep、Tool call、Approval

## Acceptance criteria

- [ ] MEMBER 可選 Agent、建立／續接 Thread、送出工作並看完整即時進度
- [ ] Langflow／Native event 使用相同 UI shape
- [ ] 不暴露 MCP／manifest／Flow JSON
- [ ] mobile 可收合且鍵盤可操作

## Exact likely files

- aios-web work page/workbench components/lib projection/tests

## Existing patterns to reuse

- 現有 /work、ChatRunTimeline、AWP、auth role shell

## Must not modify

- aios-server routes
- Cherry source／package／asset
- 可擴權的 full-auto control

## Verification

- web typecheck
- component／contract selftests
- Browser golden path：choose agent→thread→assign→timeline→artifact

## Positive / negative tests

- 正向：Native run session projection
- 負向：MEMBER 無 FDE controls、未知 event 安全降級
