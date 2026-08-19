# 14 — FDE Skill 版本／Diff／Eval／Rollback 旅程

**Phase:** 4
**Blocked by:** None — can start immediately
**Status:** ready-for-agent

## What to build

建立 FDE Skill governance surface，顯示 confirmation、versions、stable/canary、eval、risk 與 rollback。

## To-Do List

- [ ] 整合現有 SkillVersion／Eval APIs
- [ ] 建立版本 diff 與 test evidence views
- [ ] 顯示 promote gate 缺口
- [ ] 完成 rollback confirmation 與結果

## Acceptance criteria

- [ ] FDE 能理解為何可／不可發布
- [ ] 未確認 Skill 不可促進
- [ ] highRisk 與 failed eval 清晰顯示
- [ ] rollback 不刪歷史

## Exact likely files

- aios-web admin skill governance components/tests

## Existing patterns to reuse

- skills／evals routes、skillpromote gate、SkillDraftCard

## Must not modify

- skill confirmation/promotion backend
- MEMBER control

## Verification

- web typecheck
- existing t02 promote gate
- Browser FDE failed→passed→rollback states

## Positive / negative tests

- 正向：version/eval render
- 負向：unconfirmed/highRisk promote disabled and backend refused
