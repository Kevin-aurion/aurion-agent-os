# Claude MCP 對話式訓練與反思規格

## 目標

將 Agent Builder 的訓練、試教與除錯體驗移到 Claude Remote MCP 對話。AIOS 後臺只保留建置紀錄、不可變版本、FDE 審核與正式放行。

## 使用者旅程

1. End User 在 Claude 對話建立或續訓 AI 員工。
2. Claude 透過 Remote MCP 保存每一輪完整對話與 Shadow Agent/Skill 草稿。
3. 使用者要求試教時，Claude 透過 MCP 將一則真實工作輸入交給最新 Shadow Agent；結果直接回到同一段 Claude 對話。
4. 使用者可指出缺漏、修正規則或補充格式。每次 Claude 回合結束，Stop Hook 都要保存完整成對內容並排入一個 `reflection` iteration。
5. 反思只更新 Shadow Harness：Skill instructions、輸出要求、例外、規則、測試與記憶；不得修改 live Agent/Skill，不得取得工具權限，不得啟用。
6. 使用者確認完成後才送 FDE。正式版本只有 FDE 能放行。

## 硬性規則

- Preview 一律禁止 Web、Shell、Computer Use、外部寫入與不可逆工具。
- 所有輸入、回覆、反思與 Diff 落地前都要 deep-redact。
- 每個完成的 Claude turn 最多建立一個 reflection iteration；Stop 重試必須冪等。
- 反思不得把 Agent 自己未經使用者確認的敘述提升成 confirmed fact；無明確回饋時只能形成 hypothesis 或測試想法。
- Skill 永不自動 CONFIRMED；正式生效仍只允許 OWNER/TRAINER。
- 舊的後臺試跑 API 暫時保留相容性，但 `/agent-builds` 不再提供 End User 測試按鈕。

## 驗收

- Prompt Hook 已先保存 user turn 時，Stop 保存 assistant turn 後仍建立 reflection iteration。
- 重複 Stop 不建立重複 reflection。
- Reflection iteration 的下一版 Shadow Skill 含從完整對話萃取出的可執行規則。
- `chat_with_agent_build` 只執行最新 READY shadow draft，並回傳可在 Claude 顯示的 reply。
- Preview 無 READY draft、跨帳號、待審狀態或要求外部副作用時 fail-closed。
- 後臺沒有上傳測試資料或「調用 Agent 隔離試跑」控制。
