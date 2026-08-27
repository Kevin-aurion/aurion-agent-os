# channels — 通訊管道（LINE）

外部訊息管道的收發。目前實作 LINE（概念/程式借自 aurion 參考框架並擴充群組推播）。

## 檔案
- `line.ts` — LINE webhook 驗簽（對 raw body 做 HMAC-SHA256 + `timingSafeEqual`）、fast-ack-then-async-push（reply token 先即時回「處理中」，慢任務跑完再 `POST /v2/bot/message/push`）、4900 字裁切、`pushToBinding()`/`pushMessage()`；擴充**群組推播**（`groupId`）。
- `routes.ts` — LINE webhook 路由。
- `types.ts` — `ChannelAdapter { configured(), handleHttp?, start? }` 管道插件契約。

## 狀態
- LINE 以 ngrok 暫時網域測試 OK（員工可草擬並推播帳款通知到 LINE 群組）。
