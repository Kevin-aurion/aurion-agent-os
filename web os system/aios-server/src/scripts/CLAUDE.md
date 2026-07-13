# scripts — 維運腳本

以 tsx 執行的一次性/維運腳本。

## 檔案
- `doctor.ts` — 環境自檢：DB / Redis 連線、`claude`/`codex`/`grok` CLI 是否可用、整合金鑰是否設定。對應 `npm run doctor`。
- `seed.ts` — 種子資料（開發用預設帳號等）。對應 `npm run seed`。

## 開發登入
seed 建立的開發帳號見腳本內容（本機開發用）。
