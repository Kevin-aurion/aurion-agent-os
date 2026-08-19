# 06 — 記憶 embedding 在不確定時不送雲端

**What to build:** 當系統無法確認某位員工是否允許雲端 embedding（例如查詢失敗）時，選擇「不送出」；雲端 embedding 仍是刻意啟用的設計（OpenRouter Gemini），但必須是明示選擇而非失敗後的預設。文件明載此例外。

**Blocked by:** None — can start immediately

**Status:** ready-for-agent

- [ ] 限制查詢失敗時回「不允許」（fail-closed），不再預設允許
- [ ] 員工明確關閉雲端 embedding 時，行為不變（只寫本地 wiki）
- [ ] 文件明載「雲端 embedding＝刻意例外（OpenRouter Gemini）」與其邊界
- [ ] 記憶沉澱失敗仍不得使 run 失敗（fail-safe 特性保留）
