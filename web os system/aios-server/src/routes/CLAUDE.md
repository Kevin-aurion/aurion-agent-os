# routes — REST 端點

Fastify 路由，全部掛在 `/api/*`。多數以 `requireAuth` preHandler 保護；回應走 `lib/http.ts` 的 `ok()/sendError()`。

## 檔案
- `agents.ts` — 員工 CRUD。含 `engineExecute`/`engineVerify`（含 GROK）、`department`、`restrictions`；`_count.workflows` 以 `{deletedAt:null}` 過濾。
- `workflows.ts` — 工作流 CRUD 與觸發設定（`schedule`/`keyword`/`manual`）；`syncSchedule` 通知即時排程；`kickOffRun` 預先產生 `runId`。
- `skills.ts` — 技能。**`/api/skills/build` 為非同步**：先建 skill 列（PENDING_UNDERSTANDING），背景跑草稿+理解（避免同步逾時）。支援 GROK 建置。
- `conversations.ts` — 對話：持久化使用者訊息 → 背景跑員工 → 回覆持久化並經 WS `chat.message` 廣播。送訊息時帶最近 20 則 `history`（對話記憶）。含 `chat.send` WS 處理器。
- `runs.ts` — 執行紀錄查詢。
- `dashboard.ts` — 總覽統計。
- `auth.ts` — 登入 / token。
- `health.ts` — 健康檢查。

## 注意
- DELETE 請求**不要**帶 `content-type: application/json` 又空 body（Fastify 會 500）。
- 全頁導向的 OAuth `/start` 無法帶 header，改接受 `?token=` query。
