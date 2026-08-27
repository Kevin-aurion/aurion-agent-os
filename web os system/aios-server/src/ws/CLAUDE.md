# ws — WebSocket Hub（AWP/1）

即時通訊中樞。網頁與 macOS App 都靠它拿到執行進度與對話回覆。

## 檔案
- `hub.ts` — pub/sub（公開事件用 `publish(topic, payload)`；私人事件用 `publishToUser(userId, topic, payload)`；主題訂閱含 `*` 萬用）＋ 請求處理（`onReq(kind, handler)`，如 `chat.send`）＋ 連線管理。

## AWP/1 envelope
`v / id / kind / topic / reqId / seq / ts / payload`

## 常見主題
- `run.started` / `run.step` / `run.log` / `run.finished`
- `chat.message`（payload 帶 `conversationId`）
- `schedule.fired` / `workflow.triggered`
- `skill.review_ready`

## 注意（實測修過的 Bug）
前端訂閱對話事件要用 `chat.*` 並以 `payload.conversationId` 過濾——後端發佈的主題是 `chat.message`，不是 `chat.<id>`；訂閱 `chat.<id>` 會永遠不匹配、訊息不刷新。

## 私密事件紅線

`chat.message` 必須用 `publishToUser()` 發送。Hub 會在即時送達及 ring-buffer 斷線重播兩處檢查連線的 `userId`；前端的 `conversationId` 過濾只負責畫面選擇，不是存取控制。新增任何含使用者私有資料的主題時也必須走定向發佈。
