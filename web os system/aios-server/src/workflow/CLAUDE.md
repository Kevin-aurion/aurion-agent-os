# workflow — 工作流執行與觸發

工作流是「員工 + 一串步驟」的自動化，位於步驟驗證引擎（`engine/`）之上。

## 檔案
- `runner.ts` — `runWorkflow(workflowId, input, triggeredBy, runId?)`：載入工作流步驟，委派 `engine.runAgent` 執行，回傳統一的 `RunOutcome`。
- `triggers.ts` — 關鍵字觸發：`findKeywordWorkflows(message, agentId)`、`fireKeywordWorkflows()`。對話送訊息時若命中關鍵字，由該工作流驅動回覆（形狀與臨時對話一致）。

## 三種觸發
| 型別 | 來源 | 說明 |
|---|---|---|
| `schedule` | `scheduler/` (BullMQ) | cron，如 `0 9 * * *` |
| `keyword` | `triggers.ts` + `conversations.ts` | 訊息含關鍵字即觸發 |
| `manual` | `routes/workflows.ts` | 使用者手動執行 |

## 注意
- `scheduler` 呼叫 `runWorkflow` 必須用**位置參數**（曾因傳物件導致 Prisma crash）。
