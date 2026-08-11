# app — Next.js App Router 頁面

## 版面/入口
- `layout.tsx` / `providers.tsx` — 全域版面與 React Query provider。
- `page.tsx` — 根路徑：auth 後導向 **`/work`**（未登入 → `/login`）。
- `work/page.tsx` — **AI 工作台**（三欄：Agent／thread／訊息；**建立 AI 員工**入口 + 交代工作 + 教它新工作）。`?mode=builder` 開 Agent Builder。
- `admin/page.tsx` — **FDE 管理中心總覽**（原 Dashboard）。
- `admin/devices/page.tsx` — **FDE 裝置管理**（註冊碼／token 輪替／撤銷／LINE MCP；`GET /api/device-tasks` 任務表＋篩選；`device.task.*` AWP 重抓；檢查點詳情）。能力晶片含獨立 `codexApp` / `codexCli` / `lineDesktop`（不可由 computerUse 推斷）。
- `globals.css` — 全域樣式。
- `login/` — 登入頁。
- `install/agent-builder/` — 公開 Agent Builder 安裝中心；ChatGPT／Codex 與 Claude 分流說明，提供 Plugin、Skill、一鍵安裝包、MCP 設定、Markdown 文件與校驗碼下載。`prebuild` 會由 `aios-mcp/releases` 同步正式檔案到 `public/downloads/agent-builder/`。

## 功能頁（FDE 管理路由；MEMBER 前端會被導回 `/work`）
- `employees/` — 員工列表與 **`[id]/page.tsx` 詳情**（概況/技能/**裝置**/雲端檔案/工作流/執行紀錄/訓練/記憶/對話）。含限制卡、引擎/驗證選擇（含 GROK）、LiveRunTimeline、RunsTab、ChatTab、TrainingTab、DevicesTab。用 `?tab=` 深連結。
- `workflows/` — 工作流列表與 `[id]` 編輯（返回連到 `/employees/<id>?tab=workflows`）；COMPUTER_CONTROL / device-mcp:line-desktop 需選線上合格裝置。
- `skills/` — 技能。
- `settings/` — 連動 Google/Microsoft/LINE 帳號、環境設定。
- `org/` — 組織圖與權限（OWNER/TRAINER/MEMBER；Kevin 為 OWNER 最高管理）。
- `audit/` — 中文稽核紀錄。
- `proposals/` — FDE 提案審核。
- `agent-builds/` — **獨立 Agent 建置治理入口**；同一組登入、單一側欄。FDE 看全部，MEMBER 只看本人。訓練、Shadow Agent 試教與除錯全部留在 Claude MCP 對話；本頁只顯示版本、每回合反思、送審狀態與 FDE 正式放行，不再提供 End User 測試表單。
- `admin/devices/` — 多裝置執行平台管理。

## 三表面（Agent Workbench + Builder Portal）
| 表面 | 路由 | 誰用 |
|---|---|---|
| 工作台 | `/work` | 全部角色日常使用 |
| 管理中心 | `/admin` + 既有管理路由 | FDE（OWNER/TRAINER）|
| Agent 建置入口 | `/agent-builds` | 全部角色（本人／FDE 全域視圖）|

AppShell 依路徑切 shell；MEMBER 進管理路由會被導回 `/work`（後端 guard 仍是權威）。

## 實測修過的重點
- 開關元件跑版 → flex 佈局修正（`inline-flex h-5 w-9 items-center` + `translate-x-[18px]`）。
- 對話回覆不顯示 → 訂閱 `chat.*` 並以 `payload.conversationId` 過濾、`run.finished` 重抓訊息。
