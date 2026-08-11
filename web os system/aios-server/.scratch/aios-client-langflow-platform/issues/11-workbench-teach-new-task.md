# 11 — Workbench V2：教它新工作完整旅程

**Phase:** 4
**Blocked by:** None — can start immediately
**Status:** ready-for-agent

## What to build

在同一 composer 完成打字、語音、上傳、錄製教學，結果明確停在 draft／proposal／awaiting FDE。

## To-Do List

- [ ] 整合既有 AgentBuilderPanel、VoiceInput、Recording 與 SkillDraftCard
- [ ] 設計交代／教學模式的清楚切換與 optimistic transcript
- [ ] 顯示資料讀寫、風險、缺口與下一個 FDE 動作
- [ ] 保留錄製 Agent 綁定與隱私提醒

## Acceptance criteria

- [ ] 四入口可生成惰性 Skill／Agent build 草稿
- [ ] MEMBER 只能送 proposal
- [ ] 錯誤保留訊息並可重試
- [ ] 技術詞對 End User 隱藏

## Exact likely files

- aios-web workbench teaching journey components/tests

## Existing patterns to reuse

- AgentBuilderPanel、VoiceInput、SkillDraftCard、recording ownership

## Must not modify

- training／recording backend governance
- 自動 confirm／attach Skill
- Cherry code

## Verification

- web typecheck
- existing workbench selftests
- Browser：text／voice fixture／recording start-stop／MEMBER proposal

## Positive / negative tests

- 正向：draft visible then FDE queue
- 負向：MEMBER confirm impossible、recording switched-agent mismatch refused
