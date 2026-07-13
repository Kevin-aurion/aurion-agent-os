# skills — 技能理解流程

技能訓練的「閱讀並理解、再由使用者確認」環節。

## 檔案
- `understand.ts` — 讀技能草稿，產出**理解卡**（讀取資料 / 寫入資料 / 風險），狀態轉為 `AWAITING_USER_CONFIRM`，待使用者「確認並掛載」後才 `CONFIRMED`。

## 流程（配合 `routes/skills.ts`）
1. 提交技能描述 → 建 skill 列（`PENDING_UNDERSTANDING`）。
2. **背景**跑草稿 + 理解（非同步，避免同步約 50s 逾時）。
3. 產出理解卡 → 前端顯示，等待確認。
4. 使用者確認 → `CONFIRMED`，顯示於「已掛載的技能」。

## 技能格式
SKILL.md（YAML frontmatter：name/description/kind/宣告能力 + 內文），執行時經 `--append-system-prompt` 注入。執行模式：CLI / 桌面 App / 直接（record-replay 類只能走桌面 App）。

## 實測
案例 4「會議紀要整理」技能走完整訓練→理解→確認→對話使用。
