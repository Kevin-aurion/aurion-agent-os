# components — 共用 UI 元件

- `AppShell.tsx` — 應用外框與側邊導覽（總覽 / 員工 / 組織 / 技能 / 工作流 / 設定 / 稽核）。
- `ui.tsx` — 基礎元件（卡片、按鈕、徽章、開關等）。

## 注意
- 開關（toggle）採 flex 佈局避免跑版。
- 樣式用 Tailwind + `lib/cn.ts` 合併 className。
