# 04 — SkillVersion 的機器可讀 Skill IR

**Phase:** 3
**Blocked by:** None — can start immediately
**Status:** ready-for-agent

## What to build

以 additive migration 為 SkillVersion 增加 schemaVersion 與 specJson，舊技能維持原行為。

## To-Do List

- [ ] 先寫 migration compatibility test
- [ ] 新增 nullable 欄位與 /// 註解
- [ ] 產生新 migration 與 Prisma client
- [ ] 驗證舊 SkillVersion create／promote／rollback

## Acceptance criteria

- [ ] 既有資料新欄位為 null 且行為不變
- [ ] 未修改任何既有 migration
- [ ] Prisma validate、generate、server tsc 與既有 promote gate 通過

## Exact likely files

- prisma/schema.prisma
- new prisma migration
- tests/t04-*

## Existing patterns to reuse

- SkillVersion content-addressed versioning、Prisma conventions

## Must not modify

- 既有 migration
- skillversion.ts／skillpromote.ts 行為

## Verification

- prisma validate／generate／migrate status
- server tsc
- 現有 skill promote regression

## Positive / negative tests

- 正向：legacy row 可讀、new IR row 可 round-trip
- 負向：不合法 JSON contract 被 IR parser 拒絕（實作在後續票）
