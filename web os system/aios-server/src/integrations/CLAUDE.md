# integrations — 雲端整合（Google / Microsoft / LINE）

OAuth 連動與雲端硬碟存取。Token 以 AES-256-GCM 加密存本機 DB（不落地明文）。

## 檔案
- `google.ts` — Google OAuth + Drive/Gmail。scopes 含 `drive.file`。**已連動、實測讀寫 OK**。
- `microsoft.ts` — Microsoft 365 / Graph（MSAL）。scopes 含 `Files.ReadWrite.All`。**待租戶管理員 admin consent**。
- `cloud.ts` — 雲端抽象：`uploadLocalFile()`（任意檔 → 雲端）、`createSampleFile()`、`buildRevenueWorkbook()`、`buildFinanceAnalysisWorkbook()`、`webUrl` 處理。
- `tokenstore.ts` — 加密 token 存取。
- `routes.ts` — OAuth `/start`（接受 `?token=` query，因全頁導向無法帶 header）、`/callback`、sample-file 端點；`configured` 含 line。

## 狀態
- Google + LINE：可用（員工讀 Drive 上 AR/AP Excel、產出上傳、LINE 通知）。
- Microsoft：程式就緒，卡在 admin consent（管理員授權後即可）。
- admin consent URL 見對話紀錄 / 設定頁。
