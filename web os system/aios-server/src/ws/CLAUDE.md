# ws — WebSocket Hub（AWP/1）

即時通訊中樞。網頁與 macOS App 都靠它拿到執行進度與對話回覆。

## 檔案
- `hub.ts` — pub/sub（`publish(topic, payload)`、主題訂閱含 `*` 萬用）＋ 請求處理（`onReq(kind, handler)`，如 `chat.send`）＋ 連線管理。

## AWP/1 envelope
`v / id / kind / topic / reqId / seq / ts / payload`

## 常見主題
- `run.started` / `run.step` / `run.log` / `run.finished`
- `chat.message`（payload 帶 `conversationId`）
- `schedule.fired` / `workflow.triggered`
- `skill.review_ready`

## 注意（實測修過的 Bug）
前端訂閱對話事件要用 `chat.*` 並以 `payload.conversationId` 過濾——後端發佈的主題是 `chat.message`，不是 `chat.<id>`；訂閱 `chat.<id>` 會永遠不匹配、訊息不刷新。
