# AI 知識採集 Langflow Sandbox 實用化規格

## 使用者結果

FDE 在 AIOS Studio 的 Runtime 頁輸入自然語言問題後，系統會查詢既有 `AI知識庫/state/knowledge-search-index.json`，以 Langflow Sandbox 執行受限制的輸出閉環，並回傳可點擊的影片時間碼、Wiki 來源與逐階段執行紀錄。

## 安全與治理邊界

- 僅 `OWNER`／`TRAINER` 可操作。
- 只讀取固定知識索引；查詢不觸發採集、網路搜尋、Shell、Webhook、檔案寫入或外部工具。
- 查詢文字以固定參數交給既有查詢程式，不經 shell interpolation。
- 所有回傳與持久紀錄先經 secrets redaction。
- Langflow 必須健康且真的回傳本次 run marker；否則整次查詢 fail-closed。
- Sandbox 可用不等於 Production 啟用；正式部署仍走 Artifact、Eval、FDE、Canary／Stable 閘門。

## API

- `GET /api/runtime/knowledge-pilot`：索引、Langflow、最近執行狀態。
- `POST /api/runtime/knowledge-pilot/query`：執行一次唯讀查詢。
- `GET /api/runtime/knowledge-pilot/runs`：最近 20 筆 redacted Sandbox 執行紀錄。

## 驗收

1. 空白、過長輸入被拒絕。
2. `PDF 轉文字工具有哪些？` 回傳至少一筆結果與時間碼 URL。
3. 不存在的主題回傳「證據不足」，不補造答案。
4. Langflow 回傳沒有本次 run id 時判定失敗。
5. 成功執行留下本地 run record 與 hash-chain audit 摘要。
6. Studio 可輸入、執行、看到階段、回答、引用與最近紀錄。
