# aurion — 專案總覽（AIOS 本地代理工作站）

此目錄是 Kevin（Aurion Group / 奧聯集團）的工作根目錄。本輪（2026-07 起）主線專案是 **AIOS — 本地優先多代理「AI 員工」作業系統**。

## 這裡有哪些子專案

| 資料夾 | 屬於 AIOS？ | 說明 |
|---|---|---|
| `web os system/` | ✅ **主線** | 後端 `aios-server`（Fastify + Prisma + BullMQ）＋ 網頁 `aios-web`（Next.js 14）＋ 文件與測試報告 |
| `mac os system/` | ✅ **主線** | SwiftUI 原生 macOS App `aios-system`，同時是主機執行器（電腦操控 / 開 Codex） |
| `MyAgent/` | ✅ 執行產物 | AI 員工的工作區（依部門／員工分子資料夾），由後端引擎具現化 |
| `aios-data/` | ✅ 執行產物 | 執行期資料存放（runs、skills、cache、agents 快照） |
| `lazyoffice-system-main/` | ❌ **參考用，唯讀** | 借用設計概念與部分程式的參考框架。**絕對不要在此路徑內開發** |
| `meeting-voice-assistant/` | ❌ 其他專案 | 獨立的會議語音助理（與 AIOS 無關） |
| `監測系統/` | ❌ 其他專案 | 獨立專案 |

## AIOS 是什麼

把每個 AI 代理當成一位「**員工 Agent**」：使用者為員工設定角色、掛載**技能 Skill**、配置**工作流 Workflow**（一位員工可對應多條工作流）。整套系統**在地優先（不離地）**：資料庫、驗證、前後端、引擎全部跑在本機 loopback，唯一對外連線是使用者授權的 Google／Microsoft／LINE 與本機 `claude`/`codex`/`grok` CLI。

核心設計三支柱：
- **三引擎**：`CLAUDE_CODE`（主力）、`CODEX`（程式類 / 交叉驗證）、`GROK`（檢索與驗證最快）。
- **跨模型驗證閘**：執行引擎 ≠ 驗證引擎，避免同模型自我背書。
- **限制 Restrictions**：網路搜尋／電腦操控／寄信／雲端寫入／Shell，於引擎層強制。

深入架構請看 [`web os system/ARCHITECTURE.md`](web os system/ARCHITECTURE.md)。

## 我想做的 vs 目前完成度

**已完成（可用、已實測）**
- 員工全生命週期：建立 → 角色／限制設定 → 技能訓練/理解/確認 → 工作流配置 → 執行紀錄。
- 三種工作流觸發：定期（cron，BullMQ）、關鍵字、手動。
- 三引擎協作 + 跨模型驗證閘（實測能攔截不合格輸出並重跑）。
- Google Drive／Gmail 讀寫、LINE 通知（ngrok）。
- 對話（含歷史記憶）、限制引擎層強制。
- macOS App：登入、員工/工作流/執行檢視、設定、電腦操控執行器。

**進行中 / 待辦**
- Microsoft 365 / OneDrive 完整流程 — 待租戶管理員完成 admin consent 後補測。
- record-replay 類技能需透過桌面版 App 執行（Codex CLI 無 Computer Use）。

## 我們怎麼測試的
2026-07-13 做了 5 個端對端案例（每日帳款掃描、報價單生成→上傳、AI 新聞日報、技能訓練→對話、限制驗證），全數通過，過程用 Chrome 逐步截圖並錄成 GIF，產出 HTML 報告：[`web os system/docs/test-report/index.html`](web os system/docs/test-report/index.html)。除錯守則：**發現 Bug → 修復 → 從頭重測直到通過**。

## 🔧 開發流程（重要規範）— Grok 開發、Opus 審查迴圈

之後在 Claude Code 開發本專案時，**一律遵循以下分工**：Grok 負責「寫」，Opus 4.8 負責「把關」，執行與審查分離（延續本專案的跨模型驗證閘精神）。

1. **接收需求**：Kevin 在 Claude Code 說明要做什麼。
2. **委派 Grok CLI 開發**：由你（Claude / Opus）把需求整理成清楚、含驗收標準與限制的指示，透過 Grok CLI 叫它在對應的**本地資料夾**實作。
   ```bash
   ~/.grok/bin/grok -p "<清楚的需求：目標、要改的檔案路徑、驗收標準、限制>" \
     --output-format json --always-approve \
     --cwd "<目標資料夾的絕對路徑>" \
     [--rules "<系統規則 / 風格>"] [--resume <sessionId>]
   ```
   - 一個需求對應一個目標資料夾；把檔案路徑、驗收標準、限制都寫進 prompt。
   - 要延續同一輪脈絡，用 `--resume <sessionId>`（Grok 回傳的 session id）。
   - **不要在參考框架 `lazyoffice-system-main/` 內開發**。
3. **Opus 4.8 審查**：Grok 回報後，由你以 Opus 4.8 **親自**檢查它改的內容是否正確——讀 diff / 檔案、對照需求、實跑型別檢查 / 建置 / 測試。
4. **不正確就指正並要求重做**：發現問題就明確指出「哪裡錯、為什麼錯、該怎麼修」，用 `--resume` 丟回 Grok 重新修復。**重複此迴圈，直到你確信沒問題**。
5. **通過才回報 Kevin**：只有在你（Opus）審查通過、確認無誤後，才向 Kevin 回報完成，並附上「做了什麼／Grok 怎麼實作／你怎麼驗證（附實跑證據）」。

原則：
- 審查要有**實跑證據**（tsc / build / 測試通過），不能只看 Grok 的自述。
- 除非 Kevin 另外指示，否則**不要略過審查直接回報**，也不要自己動手寫主要程式（你的角色是把關與指正，寫碼交給 Grok）。

## 重要慣例
- API Key 放各專案的 `.env`（不進版控）。
- Node 在 `~/.local/node/bin`（已在 PATH）。
- **不要在 `next dev` 執行中跑 `next build`**（會汙染 `.next` 快取導致白畫面）。
- 後端若以 `npm run start` 啟動則**不會熱重載**；開發請用 `npm run dev`（tsx watch）。
