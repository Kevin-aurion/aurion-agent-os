# scheduler — 定期工作流排程

BullMQ（Redis 後端）驅動的排程。管四個佇列（runs / notify / sync / builder-evolution），把 `Schedule` 資料表與 BullMQ repeatable job 同步，時間到就觸發工作流 / 通知；另有固定治理工作 `system:reflection`。

## 檔案
- `index.ts` — `startScheduler()`（開機載入所有 enabled schedule、註冊 job scheduler、補跑逾期）、`syncSchedule()`、`removeSchedule()`、`getQueues()`。

## 設計原則
- **永不 throw 出 `startScheduler()`**：Redis 連不上就記警告並讓伺服器繼續開。
- cron 用 `cron-parser`（CommonJS，取 default 再解構 `parseExpression`）。
- 觸發時廣播 `schedule.fired` / `workflow.triggered`，並更新 `lastFiredAt`/`nextFireAt`。
- runs worker 呼叫 `runWorkflow(workflowId, input ?? {}, triggeredBy)` — **位置參數**（曾因物件參數 crash，已修）。
- `system:reflection` 固定用 `0 0,9,18 * * *` + `config.tz`，開機會補跑最近一個完整時段；`ReflectionCycle` 的 window unique 負責冪等。
- FDE 的「立即整理」走 `enqueueReflectionNow()`，分析上一個固定時點至當下的部分時段。
- `builder-evolution` 消費每輪 Agent Builder 的 shadow Harness 編譯工作；API 不等待 worker。Redis 不可用時呼叫端可走 in-process fail-safe，開機會重排 DB 中仍為 QUEUED 的迭代。

## 實測
案例 1「每日帳款掃描」設 `0 9 * * *`（Asia/Taipei），已註冊；測試以手動執行驗證。
