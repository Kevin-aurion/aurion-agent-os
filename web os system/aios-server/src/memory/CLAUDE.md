# memory — 員工長期記憶（L1 wiki + L3 Qdrant）

## 邊界

- **雲端 embedding 是刻意例外**（OpenRouter Gemini），非意外。老闆明確要雲端向量；預設仍啟用（`cloudEmbedding` 預設 true）。
- **查不到限制時 fail-closed**：`agentAllowsCloudEmbedding` 在 DB 查詢失敗時回 `false`，不把內容送出雲端。與「資料不離地」承諾一致——只有明示允許才送出。
- **記憶沉澱失敗不得使 run 失敗**：ingest / index 皆 best-effort；失敗只 log，不 throw 到 runner。
- **Redactor 永遠套用**：不因 `cloudEmbedding` 開關而跳過密文清洗。

## 模組

| 檔案 | 職責 |
|---|---|
| `memoryService.ts` | 唯一公開入口（wiki 讀寫、ingest、recall） |
| `embedding.ts` | OpenRouter embedding provider |
| `qdrant.ts` | 向量庫 upsert / search |
| `redactor.ts` | 密文／token 清洗 |
| `summary.ts` | run / chat 摘要文字 |
