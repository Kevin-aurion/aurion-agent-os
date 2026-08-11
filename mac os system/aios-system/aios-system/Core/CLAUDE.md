# Core — macOS App 核心層

App 的非 UI 基礎設施：設定、憑證、網路、狀態、裝置代理執行器。

## 檔案
- `AIOSConfig.swift` — 可設定 server base URL（UserDefaults，預設 `http://127.0.0.1:8700`）、http→ws / https→wss、固定本機路徑常數。
- `Keychain.swift` — 使用者 JWT（`com.lazyoffice.aios-system`）與裝置憑證（`com.lazyoffice.aios-system.device`）**分離**。
- `APIClient.swift` — 使用者 REST（Bearer JWT）。
- `AwpClient.swift` — 使用者 hub WebSocket `/ws`（JWT query；既有契約）。
- `AppState.swift` — 全域狀態；開機時若已註冊則啟動 `DeviceAgentService`。
- `Models.swift` — 後端 DTO + AWP frame；Swift 6 `nonisolated`。
- `ComputerControlExecutor.swift` — **已退役** public AWP 電腦操控（fail-closed，不回報 dispatched success）。
- `Device/` — 多裝置執行平台 Slice 6 實作：
  - 註冊 / DeviceChannel / capabilities / durable tasks / screenshot / LINE MCP / Computer Use bridge

## 注意
- 模型欄位需與後端 `prisma/schema.prisma` + `routes/device.ts` 回傳形狀一致。
- 裝置 WS envelope：`v/id/kind/topic/reqId/seq/ts/payload`。
- 裝置 token：**永不**進 URL、query、UserDefaults、日誌、subprotocol。
- 任務 payload 本機再跑 `DeviceTaskPayloadValidator`（對齊 `devicetaskpayload.ts`）。
- 能力布林值不得造假；`clientDeclaredRedacted` 僅在實際執行 redaction 規則後才可為 true。
- Region crop（全螢幕擷取再裁切）只是 scoping，**不是** redaction：`clientDeclaredRedacted=false`，meta 標 `region-crop-only` / `not-redacted`；後端 fail-closed 可拒收未真正 redact 的 opaque screenshot。
