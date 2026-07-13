# AIOS — 本地優先多代理工作站 (Local-First Agent OS)

多個 AI「員工」(Agents)，每個可掛載技能 (Skills) 與多個自動化工作流 (Workflows)，
連動 Microsoft 365 / Google 存取雲端硬碟與郵件，透過 LINE 通知，全部在**本機**運行，
資料與憑證**不離地**。

- **後端 `aios-server/`** — Node 22 / Fastify，跑在**主機**（需呼叫主機上的 `claude`/`codex` CLI，故不進 Docker）。API + WebSocket(AWP/1) + 代理引擎 + 排程。
- **網頁 `aios-web/`** — Next.js 14，瀏覽器介面。
- **macOS `../mac os system/aios-system`** — SwiftUI 原生 App，同時是**主機執行器**（電腦操控 / 開 Codex）。
- **Docker** — 只跑 Postgres 與 Redis（皆綁定 `127.0.0.1`）。

架構全文見 [`ARCHITECTURE.md`](./ARCHITECTURE.md)。

## 前置需求
- Docker Desktop（已安裝）
- Node 22（已裝於 `~/.local/node/bin`，已加入 `~/.zshrc` 的 PATH）
- 主機已登入的 `claude` 與 `codex` CLI

## 首次啟動

```bash
cd "/Users/kevin/Documents/aurion/web os system"

# 1) 啟動本地資料庫 / Redis（Docker）
docker compose up -d

# 2) 後端：套用資料表 + 啟動
cd aios-server
npm run prisma:migrate     # 首次建表（之後可省略）
npm run doctor             # 檢查環境（DB/Redis/CLI/整合金鑰）
npm run dev                # http://127.0.0.1:8700  (ws: /ws)

# 3) 另開一個終端機，啟動網頁
cd "/Users/kevin/Documents/aurion/web os system/aios-web"
npm run dev                # http://localhost:3100
```

打開 http://localhost:3100 ，第一個註冊的帳號即為系統擁有者 (OWNER)。

> macOS App：用 Xcode 開 `../mac os system/aios-system/aios-system.xcodeproj` 直接 Run。

## 設定 API 金鑰（`.env`）
所有金鑰放在 `web os system/.env`（已含自動產生的加密/JWT 密鑰）。需自行填寫：
- **Microsoft 365**：`MS_CLIENT_ID` / `MS_TENANT_ID` /（可選）`MS_CLIENT_SECRET`
- **Google**：`GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`
- **LINE**：`LINE_CHANNEL_ACCESS_TOKEN` / `LINE_CHANNEL_SECRET`

各 OAuth 的重新導向 URI 使用 loopback（`http://localhost:8700/api/integrations/.../callback`），
無需公開網址。填好後在網頁「設定」頁按連動即可。連動後的權杖以 AES-256-GCM 加密存於本地 Postgres。

## 不離地保證
- 所有服務綁定 `127.0.0.1`，不對外監聽。
- 唯一的外連是你**主動授權**的 Microsoft Graph / Google API / LINE 推播，以及本機已登入的 `claude`/`codex`。
- 憑證只存在本地 DB 的加密欄位；加密金鑰只在 `.env`。
