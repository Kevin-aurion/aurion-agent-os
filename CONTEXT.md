# CONTEXT — AIOS 領域模型與用語

> 由 `/grill-with-docs`（grilling + domain-modeling）逐題確認產生。決策見 `docs/adr/`。

## 角色（Ubiquitous Language）

| 用語 | 定義 | 程式對應 |
|---|---|---|
| **FDE（訓練師）** | 建置、訓練、管控 Agent 的人。唯一能讓變更真正生效的角色。 | `UserRole.TRAINER`（`OWNER` 亦具此權限）；`requireTrainer` |
| **操作者** | 日常使用 Agent 的員工。可提出修正／限制建議，但**不能直接生效**。 | `UserRole.MEMBER` |
| **員工 Agent** | 一位 AI 員工：身分卡＋掛載的 Skill＋Workflow＋記憶＋沙盒。 | `Agent` |
| **Skill** | 全域可複用的能力資產（SKILL.md）。掛載到員工才生效。 | `Skill` ＋ `AgentSkill` |
| **技能工廠** | 產出 Skill 的單一介面，三個入口：①打字/語音描述 ②上傳現成 Skill ③錄製操作。 | 待建（前端）＋ `lib/skilltraining.ts` |
| **變更提案** | 對 Agent 之 Skill／限制／身分卡的擬議變更，須 FDE 核准才生效。來源：操作者提出、或系統偵測到越矩行為。 | 待建（`Lesson` 目前為死 schema，候選承載者） |
| **越矩行為** | Agent 做出超出其身分卡／限制授權範圍的行為，應產生變更提案並通知 FDE。 | 待建 |

## 治理鐵律（既有，不可弱化）

- **跨模型驗證閘**：執行引擎 ≠ 驗證引擎，載入時強制；判決 fail-closed。
- **技能確認閘**：新／改的 Skill 一律停在 `AWAITING_USER_CONFIRM`，**FDE 人工確認**才 `CONFIRMED` 並可掛載。永不自動確認。
- **紅線 redactor**：任何記憶落地前遮罩密鑰／個資，不受任何旗標影響。
- **安全與成本是硬約束**：限制與預算在程式碼層攔截（fail-closed），不靠模型自覺。
- **變更生效唯一路徑**：只有 FDE（TRAINER/OWNER）能讓 Skill／限制／身分卡的變更生效；操作者只能提案。
