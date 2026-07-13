# Core — macOS App 核心層

App 的非 UI 基礎設施：設定、憑證、網路、狀態、主機執行器。

## 檔案
- `AIOSConfig.swift` — 後端位址與常數（`127.0.0.1:8700`、`/ws`）。
- `Keychain.swift` — 憑證安全存取（token 存 Keychain，不落地明文）。
- `APIClient.swift` — REST 客戶端（帶 bearer token）。
- `AwpClient.swift` — WebSocket（AWP/1）客戶端，`URLSessionWebSocketTask`，含心跳/重連。
- `AppState.swift` — 全域可觀察狀態（登入、員工列表、執行事件）。
- `Models.swift` — 與後端對應的資料模型（Agent/Workflow/Run…）；Swift 6 併發標了 `nonisolated`。
- `ComputerControlExecutor.swift` — 執行 COMPUTER_CONTROL 步驟（主機端電腦操控）。

## 注意
- 模型欄位需與後端 `prisma/schema.prisma` + `routes/*` 回傳形狀一致。
- WS envelope 欄位：`v/id/kind/topic/reqId/seq/ts/payload`。
