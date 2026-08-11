# AIOS — 本地優先多代理「AI 員工」作業系統

> Local-first multi-agent "employee" operating system — Lazyoffice Group / 奧聯集團

把每一個 AI 代理當成一位「**員工（Agent）**」：你為員工設定角色、掛載**技能（Skill）**、配置**工作流（Workflow）**，一位員工可對應多條工作流。整套系統**在地優先（不離地）**——資料庫、驗證、前後端、執行引擎全部跑在本機 `127.0.0.1`，唯一的對外連線是你**親自授權**的 Google／Microsoft／LINE，以及本機的 `claude`／`codex`／`grok` CLI。

---

## ✨ 核心特色

- **三引擎協作**　`CLAUDE_CODE`（主力）、`CODEX`（程式類／交叉驗證）、`GROK`（檢索與驗證最快，約 30s vs 60–120s）。
- **跨模型驗證閘**　執行引擎 **≠** 驗證引擎，避免同模型自我背書；不合格的輸出會被攔截並自動重跑。
- **三種工作流觸發**　定期（cron / BullMQ）、關鍵字、手動。
- **技能訓練流程**　提交描述 → AI 起草並理解 → 產出「理解卡」（讀取／寫入／風險）→ 使用者確認後才掛載。
- **員工限制（Restrictions）**　網路搜尋／電腦操控／寄信／雲端寫入／Shell，於**引擎層強制**（提示規則＋CLI 旗標＋硬性阻擋）。
- **雲端讀寫**　讀取 Google Drive 上的 Excel、產出文件（報價單／報告）並上傳回雲端；LINE 群組通知。
- **對話**　多輪對話含歷史記憶。
- **即時串流**　WebSocket（AWP/1）把執行進度即時推到網頁與 macOS App。
- **治理**　組織圖與權限（OWNER／TRAINER／MEMBER）、中文稽核紀錄、AES-256-GCM 加密的雲端 token。

---

## 🧱 架構總覽

```
┌─────────────────────────  Kevin 的 Mac（全部在地）  ─────────────────────────┐
│                                                                            │
│  Docker                              主機程序                               │
│  ┌────────────────┐                  ┌──────────────────────────────────┐  │
│  │ postgres:16    │◄────────────────►│  aios-server (Node 22 / Fastify) │  │
│  │ 127.0.0.1:5433 │                  │  127.0.0.1:8700  REST + WS(/ws)  │  │
│  ├────────────────┤                  │  ├ engine  三引擎 + 驗證閘        │  │
│  │ redis:7        │◄────────────────►│  ├ workflow / scheduler          │  │
│  │ 127.0.0.1:6380 │                  │  └ integrations  Google/MS/LINE  │  │
│  └────────────────┘                  └──────────────────────────────────┘  │
│                                          ▲                ▲                 │
│                          ┌───────────────┘                └─────────┐       │
│                   ┌──────────────┐                          ┌───────────────┐│
│                   │ aios-web     │                          │ aios-system   ││
│                   │ Next.js 3100 │                          │ SwiftUI macOS ││
│                   └──────────────┘                          └───────────────┘│
└────────────────────────────────────────────────────────────────────────────┘
        對外唯一連線：使用者授權的 Microsoft Graph / Google API / LINE Push
```

架構全文見 [`web os system/ARCHITECTURE.md`](web%20os%20system/ARCHITECTURE.md)。

---

## 📁 專案結構

```
lazyoffice-agent-os/
├─ web os system/              後端 + 網頁（跑在主機）
│  ├─ aios-server/             Node 22 · Fastify 5 · Prisma · BullMQ
│  │  └─ src/{engine,routes,workflow,scheduler,integrations,channels,lib,skills,ws}
│  ├─ aios-web/                Next.js 14 · React 18 · Tailwind · React Query
│  ├─ docs/test-report/        五案例端對端實測報告（HTML + GIF）
│  └─ docker-compose.yml       postgres:16 + redis:7（皆綁 127.0.0.1）
├─ mac os system/              SwiftUI 原生 App（同時是主機執行器 / 電腦操控）
│  └─ aios-system/
└─ CLAUDE.md                   各目錄皆附 CLAUDE.md 說明用途、測試方式、完成度
```

> 執行期產物（`MyAgent/`、`aios-data/`）、參考框架與無關專案不納入本 repo。

---

## 🚀 快速開始

**前置需求**：Docker Desktop、Node 22、已登入的 `claude`／`codex`（選配 `grok`）CLI。

```bash
cd "web os system"

# 1) 本地資料庫 / Redis
docker compose up -d

# 2) 後端
cd aios-server
cp .env.example .env          # 填入你的 OAuth 金鑰（見 .env.example 註解）
npm install
npm run prisma:migrate        # 首次建表
npm run doctor                # 檢查 DB/Redis/CLI/整合金鑰
npm run dev                   # 後端 127.0.0.1:8700（tsx watch 熱重載）

# 3) 網頁（另開終端）
cd "web os system/aios-web"
npm install
npm run dev                   # 網頁 127.0.0.1:3100，代理 /api → 8700
```

macOS App：用 Xcode 開 `mac os system/aios-system/aios-system.xcodeproj`（後端需先啟動）。

> ⚠️ **不要在 `next dev` 執行中跑 `next build`**（會汙染 `.next` 快取導致白畫面）。
> ⚠️ 後端用 `npm run start` 啟動**不會熱重載**；開發請用 `npm run dev`。

---

## 🧪 測試

2026-07-13 完成 **5 個端對端案例**，橫跨 4 個部門角色，全數通過（每步 Chrome 截圖並錄成 GIF）：

| # | 員工（部門） | 案例 | 觸發 | 重點 |
|---|---|---|---|---|
| 1 | 財務長（財務） | 每日帳款掃描 | 定期 `0 9 * * *` | 雲端讀取 · 跨模型驗證 |
| 2 | 財務長（財務） | 報價單生成→上傳 | 手動 | 文件生成 · Drive 寫入 · **驗證閘 reject→重跑** |
| 3 | 企劃專員（企劃） | AI 新聞日報 | 手動 | GROK 網路檢索 · HTML · 上傳 |
| 4 | 行政秘書（行政） | 技能訓練→對話 | 對話 | 訓練/理解/確認 · 對話記憶 |
| 5 | 市場研究員（研究） | 限制驗證 | 對話 | 關網搜→引擎層正確拒絕 |

完整報告：[`web os system/docs/test-report/index.html`](web%20os%20system/docs/test-report/index.html)
除錯守則：**發現 Bug → 修復 → 從頭重測直到通過**。

---

## 🛠 技術棧

| 層 | 技術 |
|---|---|
| 後端 | Node 22 (ESM) · Fastify 5 · Prisma + PostgreSQL · BullMQ + Redis · Zod · argon2/jose · AES-256-GCM |
| 網頁 | Next.js 14 (App Router) · React 18 · TypeScript · Tailwind 3 · @tanstack/react-query |
| macOS | SwiftUI · Xcode 26 · URLSessionWebSocketTask · Keychain |
| 引擎 | `claude -p` · `codex exec` · `grok -p --output-format json` |
| 即時 | WebSocket 自訂協定 AWP/1 |

---

## 🔒 安全與隱私

- **不離地**：資料與憑證留在本機；唯一對外連線是使用者授權的 Google／Microsoft／LINE。
- 金鑰放各專案 `.env`（**已列入 `.gitignore`，不會進版控**）；範本見 `.env.example`。
- 雲端 token 以 AES-256-GCM 加密存本機資料庫。
- 存取控制是**程式碼**（工具層參數綁定 + DB 角色 + 驗證器），不是提示。

---

<sub>© Lazyoffice Group / 奧聯集團 · 內部專案</sub>
