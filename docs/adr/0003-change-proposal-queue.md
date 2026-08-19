# ADR 0003 — 兩層授權：操作者提案、FDE 核准（單一變更提案佇列）

**狀態**：已接受（2026-07）

## 脈絡
前期由 FDE 建置與訓練 Agent；後期希望操作者（日常使用的員工）也能參與——在使用過程中修正 Agent 的回答、加上限制。但操作者的變更**不可直接生效**。此外，當 Agent 出現越矩行為時，也需要 FDE 確認才更新其技能／設定。

## 決策
1. **角色沿用既有 `UserRole`**：FDE ＝ `TRAINER`（`OWNER` 亦可）；操作者 ＝ `MEMBER`。
2. **單一佇列**：操作者的修正／限制建議，與系統偵測到的越矩行為，**共用同一個「變更提案」佇列**，FDE 在一個收件匣審核。
3. **新建 `ChangeProposal`**（不復用 `Lesson`）。欄位方向：`agentId / runId? / source(operator|violation|semantic) / proposedBy / targetType(skill|restriction|identityCard) / targetId / proposedChange(Json) / severity / status(PENDING|APPROVED|REJECTED) / decidedBy / decidedAt / resultingVersionId`。
4. **核准後的效果**：接上既有 `SkillVersion` + `stable/canary` + rollback——核准即產生新版本並切指標；駁回則不動任何東西。天然可回溯、可回滾。

## 後果
- 操作者能參與但無法越權；「唯一能讓變更生效的是 FDE」成為系統不變量。
- `Lesson` 確認為死 schema（全庫零使用），標記未來刪除或併入 `ChangeProposal`。
- 技能確認閘不變：提案核准仍走 `AWAITING_USER_CONFIRM → CONFIRMED`，永不自動確認。
