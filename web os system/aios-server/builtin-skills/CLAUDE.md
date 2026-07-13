# builtin-skills — 內建技能

隨系統附帶、可掛載到員工的預置技能（SKILL.md 格式）。

## 內容
- `line-group-notify/` — 產生並推播 LINE 群組通知的技能。
- `onedrive-status-scan/` — 掃描 OneDrive 檔案狀態的技能（配合 Microsoft 整合；待 admin consent 後完整可用）。

## 格式
每個子資料夾一份 SKILL.md：YAML frontmatter（name/description/kind/宣告能力）+ 內文說明；掛載後經 `--append-system-prompt` 注入員工的每一步系統提示。使用者也可自行上傳/訓練新技能（見 `src/skills`）。
