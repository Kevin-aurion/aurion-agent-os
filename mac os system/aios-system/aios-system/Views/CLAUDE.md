# Views — macOS App 畫面層

SwiftUI 視圖，對應後端各功能。

## 檔案
- `LoginView.swift` — 登入（帳密 → bearer token 存 Keychain）。
- `MainView.swift` — 主框架 / 導覽。
- `AgentsView.swift` — 員工列表與詳情。
- `RunsView.swift` — 執行紀錄與即時時間軸（訂閱 `run.*` WS 事件）。
- `SettingsView.swift` — 連動 Google／Microsoft／LINE 帳號、環境設定。
- `MenuBarView.swift` — 選單列常駐入口。

## 注意
- 即時更新透過 `Core/AwpClient` 訂閱主題（`run.*`、`chat.*` 等）。
- UI 狀態集中在 `Core/AppState`。
