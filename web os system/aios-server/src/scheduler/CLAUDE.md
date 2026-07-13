# scheduler — 定期工作流排程

BullMQ（Redis 後端）驅動的排程。管三個佇列（runs / notify / sync），把 `Schedule` 資料表與 BullMQ repeatable job 同步，時間到就觸發工作流 / 通知。

## 檔案
- `index.ts` — `startScheduler()`（開機載入所有 enabled schedule、註冊 job scheduler、補跑逾期）、`syncSchedule()`、`removeSchedule()`、`getQueues()`。

## 設計原則
- **永不 throw 出 `startScheduler()`**：Redis 連不上就記警告並讓伺服器繼續開。
- cron 用 `cron-parser`（CommonJS，取 default 再解構 `parseExpression`）。
- 觸發時廣播 `schedule.fired` / `workflow.triggered`，並更新 `lastFiredAt`/`nextFireAt`。
- runs worker 呼叫 `runWorkflow(workflowId, input ?? {}, triggeredBy)` — **位置參數**（曾因物件參數 crash，已修）。

## 實測
案例 1「每日帳款掃描」設 `0 9 * * *`（Asia/Taipei），已註冊；測試以手動執行驗證。
