# mac os system — AIOS macOS 原生 App

SwiftUI 專案 `aios-system`（Xcode 26）。它是 AIOS 的**原生前端**，同時扮演**主機執行器**：需要「電腦操控（Computer Use）」或開啟桌面 Codex 的技能，必須經由這個 App 在本機執行。

## 結構
```
mac os system/
  aios-system/
    aios-system.xcodeproj/         Xcode 專案（file-system-synchronized group）
    aios-system/
      aios_systemApp.swift          App 進入點
      ContentView.swift             根視圖
      Core/                         設定、Keychain、API/WS 客戶端、狀態、執行器
      Views/                        各畫面（登入、員工、工作流、執行、設定、選單列）
      Assets.xcassets/              圖像資源
```

## 既有功能
- 以 `APIClient` + `AwpClient`（`URLSessionWebSocketTask`）連本機後端 `127.0.0.1:8700`。
- 憑證存 Keychain；登入、員工/工作流/執行紀錄檢視、設定連動帳號。
- `ComputerControlExecutor` 執行 COMPUTER_CONTROL 步驟（App 開啟時才可用）。
- 選單列（MenuBar）常駐。

## 狀態
- Swift 6 併發：Core 型別加了 `nonisolated`；`xcodebuild` 綠燈。
- 電腦操控為主機端能力；Codex CLI 無 Computer Use，故 record-replay 類技能只能走此 App。

## 建置
用 Xcode 開 `aios-system.xcodeproj`，或 `xcodebuild`。後端須先在 `127.0.0.1:8700` 運行。
