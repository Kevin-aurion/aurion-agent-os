# 票 02 — Agent thread 工作台

## 範圍

- 新增 `/work` 頁面。
- 顯示 Agent 清單與每個 Agent 的 conversation 清單。
- 支援建立新任務、切換 thread、載入訊息、送訊息。
- 訂閱 `chat.message`，只更新目前 conversation。
- query string 保存 agent/conversation。
- 空狀態提供一般人看得懂的提示。

## 驗收

- 不顯示 engine、Skill/Workflow 編排等技術設定。
- 不建立平行的聊天後端。
- 使用現有 REST 與 WS。
- API 失敗有可見錯誤且 UI 不假成功。
