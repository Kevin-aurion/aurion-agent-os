# Views — macOS App 畫面層

選單列裝置代理的 SwiftUI 視圖。管理 UI（員工／技能／工作流／執行／組織／稽核）已收到 aios-web。

## 檔案
- `LoginView.swift` — 登入（帳密 → bearer token 存 Keychain）。
- `MainView.swift` — 精簡主視窗：連線狀態、裝置代理、最近裝置任務、開啟 Web 後台。
- `SettingsView.swift` — 伺服器 URL、**裝置註冊/能力/任務日誌**、整合狀態、self-tests。
- `MenuBarView.swift` — 選單列（使用者 AWP + 裝置連線狀態）。

## 注意
- 即時更新透過 `Core/AwpClient`（使用者 hub）與 `Core/Device/DeviceChannel`（裝置通道）。
- UI 狀態集中在 `Core/AppState`；裝置代理為 `DeviceAgentService.shared`。
- 裝置 token 永不顯示在 UI/日誌。
- Web 後台預設 `http://<server-host>:3100/admin`（aios-web）。
