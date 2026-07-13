# mac os system — AIOS macOS 原生 App

SwiftUI 專案 `aios-system`（Xcode 26）。它是 AIOS 的**原生前端**，同時扮演**主機執行器**：需要「電腦操控（Computer Use）」或開啟桌面 Codex 的技能，必須經由這個 App 在本機執行。

## 開發流程（重要）
同全專案規範：採 **Grok 開發 → Opus 4.8 審查** 迴圈。macOS 的需求一樣交由 Grok CLI 在本資料夾實作 Swift 程式（`--cwd "…/mac os system"`），你（Opus）審查、指正、要求重做直到無誤才回報 Kevin。

Swift 端特別注意：
- **審查的實跑證據以 `xcodebuild`（能編過、無錯誤/警告）為準**，不只看 Grok 自述。
- 檢查 Swift 6 併發標註（Core 型別的 `nonisolated`）、與後端回傳形狀（`prisma/schema.prisma` + `routes/*`）是否一致、WS envelope 欄位（`v/id/kind/topic/reqId/seq/ts/payload`）是否正確。
- Xcode 專案為 file-system-synchronized group，新增檔案不需手動改 project 設定。

完整規範見根目錄 [`../CLAUDE.md`](../CLAUDE.md) 的「開發流程」章節。

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
