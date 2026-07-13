# web os system — AIOS 後端 + 網頁

AIOS 的 Web 半邊：後端 `aios-server`（跑在主機）＋ 網頁 `aios-web`（Next.js）＋ Docker 的 Postgres/Redis。深入設計見 [`ARCHITECTURE.md`](ARCHITECTURE.md)；快速上手見 [`README.md`](README.md)。

## 結構
```
web os system/
  aios-server/          Node 22 / Fastify 5 後端（API + WS + 引擎 + 排程）
  aios-web/             Next.js 14 網頁前端
  docs/                 文件與測試報告（含 5 案例 HTML 報告）
  docker-compose.yml    postgres:16 (5433) + redis:7 (6380)，皆綁 127.0.0.1
  ARCHITECTURE.md       架構全文
  README.md             啟動步驟
  backups/              備份（非程式碼）
```

## 既有功能（本輪已完成、已實測）
- 員工 CRUD、角色/引擎/限制設定、技能訓練與掛載、工作流建置與執行、對話。
- 三引擎（Claude Code / Codex / Grok）＋ 跨模型驗證閘。
- 三種觸發：定期（cron/BullMQ）、關鍵字、手動。
- Google Drive/Gmail、LINE（ngrok）整合。中文稽核紀錄、組織圖與權限（OWNER/TRAINER/MEMBER）。

## 我想做的 vs 完成度
- ✅ 全在地、加密 token、五案例端對端通過。
- ⏳ Microsoft 365 / OneDrive 完整流程待管理員 admin consent。

## 怎麼測試
5 個端對端案例（Chrome 逐步截圖＋GIF），報告在 [`docs/test-report/index.html`](docs/test-report/index.html)。除錯守則：發現 Bug → 修復 → 從頭重測。

## 開發流程（重要）
本專案採 **Grok 開發 → Opus 4.8 審查** 迴圈：需求交由 Grok CLI 在本地實作，你（Opus）審查、指正、要求重做直到無誤才回報 Kevin。完整規範見根目錄 [`../CLAUDE.md`](../CLAUDE.md) 的「開發流程」章節。

## 啟動（重點）
```bash
docker compose up -d                     # Postgres + Redis
cd aios-server && npm run dev             # 後端(8700)，tsx watch 會熱重載
cd aios-web    && npm run dev             # 網頁(3100)，代理 /api → 8700
```
- ⚠️ **不要在 `next dev` 執行中跑 `next build`**（汙染 `.next` 快取 → 白畫面；解法 `rm -rf .next` 再重啟）。
- ⚠️ 後端用 `npm run start` 啟動**不會熱重載**；改動要生效請用 `npm run dev` 或手動重啟。
