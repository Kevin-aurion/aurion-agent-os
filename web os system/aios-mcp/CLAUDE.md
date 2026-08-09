# aios-mcp — AIOS 的 MCP provider

> 設定細節、註冊範例與完整工具對照表見 [`README.md`](README.md)。本檔只寫模組定位與開發慣例。

## 定位

**aios-mcp** 是 AIOS 的 **MCP provider**：把中央主機上的 **aios-server**（內部仍為 `http://127.0.0.1:8700`）能力以 MCP **tools / resources / prompts** 暴露給 ChatGPT、Claude Desktop、Claude Code、Cursor、Codex。客戶 Agent Builder 走公開 OAuth Remote MCP `https://aurion-aios-mcp.lazyoffice.app/mcp`，不在客戶電腦啟動 AIOS 服務。

它是 aios-server 的 REST client：

- MCP 本身不直接碰 DB／執行產物；所有內容經過後端治理端點
- 大多數工具 **1:1** 對應一條已驗證的 aios-server route（`converse_with_agent` 組兩條：建對話 + 送訊息）

## Provider vs Consumer（勿混淆）

**AIOS 同時是 MCP provider 與 consumer**（方向相反）：

| 角色 | 專案／模組 | 方向 |
|---|---|---|
| **Provider** | **本專案 `aios-mcp`** | 把 aios-server REST **供給**外部 client（Claude / Codex） |
| **Consumer** | aios-server 內 `lib/mcpclient.ts` + `mcpbroker.ts` + `mcpregistry.ts` | 去消費「外部」**loopback** MCP 伺服器 |

詳見 aios-server 的 `docs/adr/0010`（MCP gateway broker）。

## 傳輸

- **預設 stdio**
- **公開 Builder host**：`AIOS_MCP_TRANSPORT=http` + `AIOS_MCP_HTTP_AUTH=oauth` + `AIOS_MCP_PROFILE=builder`；process 仍只綁 `127.0.0.1:8701`，由主機 Cloudflare Tunnel 發布指定路由
- **Legacy private HTTP**：`AIOS_MCP_HTTP_AUTH=secret` + `AIOS_MCP_HTTP_SECRET`
- 客戶 Plugin 只帶 HTTPS URL、Skill 與 Hook，不帶 Node server、帳密或靜態 Token

## 認證

- 公開 Remote MCP：OAuth authorization code + PKCE S256 + DCR；各使用者以自己的 AIOS 帳號授權，15 分鐘 access JWT + 可撤銷旋轉 refresh session
- stdio／private HTTP：`POST /api/auth/login` 取約 **15 分鐘** access JWT
- 每 **10 分鐘** 用單次 refresh token **主動輪替**；持久化於 `AIOS_MCP_STATE_DIR`（預設 `~/.aios-mcp`）
- 遇 **401** 強制刷新後**重試一次**
- 憑證在 `.env`：`AIOS_MCP_EMAIL` / `AIOS_MCP_PASSWORD`（**MEMBER 角色即足夠**）
- 客戶端用途設定 `AIOS_MCP_PROFILE=builder`，只註冊二十一個 Agent Builder／Hook／Runtime 工具與 Builder resources；`full` 才註冊完整 provider 能力

## 工具模組（`src/tools/`）

皆在 `registerAllTools` 註冊（**勿移除或重排既有註冊**）：

| 模組 | 能力摘要 |
|---|---|
| `agents` / `skills` / `workflows` / `runs` | 員工、技能、工作流、執行 |
| `conversations` / `memory` / `system` | 對話、記憶、健康／總覽 |
| **`recording`**（slice4） | 錄製起停／狀態／轉技能 → aios-server 錄製 API（如 `/api/recording/*`、`/api/agents/:id/recording/to-skill`）；產物仍停在 **待確認**、依 **user 隔離**；不接受前端任意本機路徑 |
| **`googleworkspace`** | Gmail／Drive 唯讀工具；草稿／寄信／Drive 寫入另走 FDE + 真核准 Run + Agent restriction 的 fail-closed route |
| **`agentbuilder`** | ChatGPT/Claude/Codex/Cursor 建置對話逐輪同步、檔案、完整 Agent/Skill/Memory/Workflow/Test shadow draft、狀態、送 FDE 審核與初審後測試；不得 approve／confirm／activate |
| **`agentruntime`** | 列出登入帳號自己的 ACTIVE Agent、讀能力、冪等呼叫與查 Run；排程只建立 `SCHEDULE` ChangeProposal，FDE 核准前不生效 |

Resources 在 `src/resources/`（agents / skills / workflows / memory / system / agentbuilder）；prompt `build-aios-agent` 在 `src/prompts/`。

外部 Builder 逐輪同步用 `externalEventId` 去重；檔案只能傳內容，不接受主機路徑。完整安裝與操作見 `docs/INSTALLATION.zh-TW.md`。

Claude Code 同時安裝 `prepare_agent_build_prompt`（`UserPromptSubmit`）與 `guard_agent_build_stop`（`Stop`）兩個 MCP-tool hook：前者保守辨識明確 Agent 建置意圖、自動開案／續接並排入背景版本；後者補記 `last_assistant_message` 與漏接的 user turn。Stop **不得**為了等待完整 Artifact 阻擋；沒有對應 Builder session 的一般對話必須 no-op。

## 指令

```bash
export PATH="$HOME/.local/node/bin:$PATH"   # Node 22
npm run dev         # tsx watch
npm run typecheck   # tsc --noEmit
npm run build       # tsup → dist/index.js
npm run provision:local-user   # 專用 MEMBER + 私密 .env
npm run install:local-clients  # Claude Desktop / Cursor / 本機 Skill
npm run install:remote-host    # 只在中央 AIOS 主機安裝 loopback LaunchAgent
npm run package:client         # 產 Claude Plugin、Skill 與一鍵安裝包
```

開發前請先確保 aios-server 在 `127.0.0.1:8700` 可達，且 `.env` 已填帳密。
