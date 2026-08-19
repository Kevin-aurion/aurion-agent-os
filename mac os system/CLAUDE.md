# mac os system — AIOS macOS 原生 App

SwiftUI 專案 `aios-system`（Xcode 26）。它是 AIOS 的**原生前端**，同時扮演**主機執行裝置（Device Agent）**：需要「電腦操控（Computer Use）」、截圖檢查點、LINE Desktop MCP 或本機 Codex 的技能，必須經由這個 App 在本機執行。

## 開發流程（重要）
同全專案規範：採 **Grok 開發 → Opus 4.8 審查** 迴圈。macOS 的需求一樣交由 Grok CLI 在本資料夾實作 Swift 程式（`--cwd "…/mac os system"`），你（Opus）審查、指正、要求重做直到無誤才回報 Kevin。

Swift 端特別注意：
- **審查的實跑證據以 `xcodebuild`（能編過、無錯誤/警告）為準**，不只看 Grok 自述。
- 檢查 Swift 6 併發標註（Core 型別的 `nonisolated`）、與後端回傳形狀（`prisma/schema.prisma` + `routes/*`）是否一致、WS envelope 欄位（`v/id/kind/topic/reqId/seq/ts/payload`）是否正確。
- Xcode 專案為 file-system-synchronized group，新增檔案不需手動改 project 設定。
- **App Sandbox 關閉**（主機裝置代理需 spawn 固定本機 CLI/MCP、視窗截圖）；Hardened Runtime 仍開。

完整規範見根目錄 [`../CLAUDE.md`](../CLAUDE.md) 的「開發流程」章節。

## 結構
```
mac os system/
  CLAUDE.md
  docs/
    windows-device-agent-contract.md   # Windows 契約/設計 only（無 Windows runtime）
  aios-system/
    aios-system.xcodeproj/         Xcode 專案（file-system-synchronized group）
    aios-system/
      aios_systemApp.swift
      ContentView.swift
      Core/
        AIOSConfig.swift           # 可設定 server base URL（http/https → ws/wss）
        Keychain.swift             # 使用者 JWT vs 裝置憑證（不同 service）
        APIClient.swift            # 使用者 REST
        AwpClient.swift            # 使用者 hub `/ws`
        AppState.swift
        Models.swift
        ComputerControlExecutor.swift  # 已退役（public AWP 路徑 fail-closed）
        Device/
          DeviceIdentityStore.swift
          DeviceAPIClient.swift        # 裝置 Bearer REST
          DeviceChannel.swift          # `/device/ws` + aios-device
          DeviceCapabilitiesProbe.swift
          DeviceTaskPayloadValidator.swift  # 純函式 allowlist
          DeviceTaskExecutor.swift     # 耐久任務：ACK/lease/progress/result
          DeviceScreenshotCapture.swift
          DeviceMcpStdioClient.swift
          LineDesktopMcpRuntime.swift  # 固定 1.1.2 + sha256
          ComputerUseBridge.swift
          DeviceAgentService.swift
          DeviceAgentSelfTest.swift
          DeviceLocalConsent.swift
          DeviceModels.swift
      Views/
      Assets.xcassets/
```

## 既有功能
- 以 `APIClient` + `AwpClient` 連後端（預設 `127.0.0.1:8700`，可在設定改 URL）。
- 使用者 JWT 存 Keychain service `com.aurion.aios-system`。
- **裝置代理**：一次性註冊碼 → `POST /api/device/enroll` → 裝置 id/token 存 **獨立** Keychain service `com.aurion.aios-system.device`。
- **DeviceChannel**：`URLRequest` + `Authorization: Bearer` + 固定 `Sec-WebSocket-Protocol: aios-device`；**token 絕不進 URL/query/subprotocol**。收到 `device.hello` 才算 online；撤銷/401 停止重連直到重新註冊。
- 能力探測：macOS/app 版號、Codex App、codex CLI、Computer Use bridge、Screen Recording、Accessibility、LINE Desktop、固定 MCP READY 狀態。**不偽造能力**。
- 耐久任務：`GET /api/device/tasks` 為真相；WS 只 wake；ACK + lease 續約 + progress + REST result；本機再驗證 payload allowlist。
- 截圖：ScreenCaptureKit 限縮目標視窗，排除本 App 與明顯密碼/安全視窗；無法安全限縮則 fail-closed。
- LINE Desktop MCP：僅固定 manifest `line-desktop-mcp@1.1.2` + 已知 sha256 + 5-tool allowlist；Application Support 安裝；stdio JSON-RPC。
- Computer Use：固定 bridge/CLI 路徑；無法證明完成則 `FAILED`（**從不**把「開了 Codex」當成功）。
- 選單列常駐（使用者 AWP + 裝置狀態）。

## 狀態 / 已知邊界
- Swift 6 併發：Core 型別加了 `nonisolated`。
- 真 GUI 自動化仍受 **ADR 0005** 限制（Codex Computer Use `tools/call` 可能 timeout / 需 App 授權脈絡）——代理必須誠實回報 FAILED，不可 mock success。
- 真 LINE 讀寫需本機已登入 LINE Desktop + Accessibility；不會自動裝 Node/Homebrew/cliclick。
- **沒有 Windows runtime**；跨平台契約見 `docs/windows-device-agent-contract.md`。

## 建置 / 測試 / 打包
```bash
cd "mac os system/aios-system"
xcodebuild -scheme aios-system -configuration Debug -destination 'platform=macOS' clean build

# Headless pure self-tests (no UI; exits with 0/1)
../scripts/run-device-self-tests.sh
# or after build:
#   …/aios-system.app/Contents/MacOS/aios-system --self-test

# Release .pkg under dist/ (unsigned unless --sign given)
../scripts/package-macos.sh
```
- Deployment target: **macOS 14.0** (SCScreenshotManager / Observation).
- LINE MCP trust: pinned main tarball SHA-256 is the digest boundary; `npm install --ignore-scripts` still resolves transitive deps (not covered by that digest).
- 後端須可連（預設 `127.0.0.1:8700`，或設定中的 server URL）— self-tests 不需後端。
