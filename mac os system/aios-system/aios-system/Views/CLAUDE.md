# Views — macOS App 畫面層

SwiftUI 視圖，對應後端各功能。

## 檔案
- `LoginView.swift` — 登入（帳密 → bearer token 存 Keychain）。
- `MainView.swift` — 主框架 / 導覽。
- `AgentsView.swift` — 員工列表與詳情。
- `RunsView.swift` — 執行紀錄與即時時間軸（訂閱 `run.*` WS 事件）。
- `SettingsView.swift` — 伺服器 URL、**裝置註冊/能力/任務日誌**、整合狀態、self-tests。
- `MenuBarView.swift` — 選單列（使用者 AWP + 裝置連線狀態）。

## 注意
- 即時更新透過 `Core/AwpClient`（使用者 hub）與 `Core/Device/DeviceChannel`（裝置通道）。
- UI 狀態集中在 `Core/AppState`；裝置代理為 `DeviceAgentService.shared`。
- 裝置 token 永不顯示在 UI/日誌。
