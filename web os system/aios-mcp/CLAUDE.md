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
- 客戶端用途設定 `AIOS_MCP_PROFILE=builder`，只註冊 22 個 Agent Builder／Hook／Runtime 工具與 Builder resources（15 builder + 7 runtime）；`full` 才註冊完整 provider 能力

## 工具模組（`src/tools/`）

皆在 `registerAllTools` 註冊（**勿移除或重排既有註冊**）：

| 模組 | 能力摘要 |
|---|---|
| `agents` / `skills` / `workflows` / `runs` | 員工、技能、工作流、執行 |
| `conversations` / `memory` / `system` | 對話、記憶、健康／總覽 |
| **`recording`**（slice4） | 錄製起停／狀態／轉技能 → aios-server 錄製 API（如 `/api/recording/*`、`/api/agents/:id/recording/to-skill`）；產物仍停在 **待確認**、依 **user 隔離**；不接受前端任意本機路徑 |
| **`googleworkspace`** | Gmail／Drive 唯讀工具；草稿／寄信／Drive 寫入另走 FDE + 真核准 Run + Agent restriction 的 fail-closed route |
| **`agentbuilder`** | ChatGPT/Claude/Codex/Cursor 建置對話逐輪同步、檔案、完整 shadow draft、`list_testable_agents` + `chat_with_test_agent` 免 FDE 隔離試教、每回合反思、送 FDE 審核與最後驗證；不得 approve／confirm／activate |
| **`agentruntime`** | 列出登入帳號自己的 ACTIVE Agent、讀能力、冪等呼叫與查 Run；排程與封存只建立 ChangeProposal，FDE 核准前不生效；封存核准後停用 Agent／Workflow／Schedule 並拒絕調用 |

Resources 在 `src/resources/`（agents / skills / workflows / memory / system / agentbuilder）；prompt `build-aios-agent` 與 `use-aios-agent` 在 `src/prompts/`。

外部 Builder 逐輪同步用 `externalEventId` 去重；檔案只能傳內容，不接受主機路徑。完整安裝與操作見 `docs/INSTALLATION.zh-TW.md`。

Claude Plugin 使用 `SessionStart`、`UserPromptSubmit`、`PreToolUse`、`PermissionRequest`、`PostToolUse`、`Stop` command hooks 維護不含對話內容的本機同步狀態。明確 Agent 建置第一輪要求 `start_agent_build`，每輪要求 `prepare_agent_build_prompt`，Stop 要求 `guard_agent_build_stop`；`PreToolUse`／`PermissionRequest` 只能自動允許目前 Claude session 的三個 lifecycle 工具，以及 Build ID 完全吻合的三個 inert draft-sync 工具。上傳、送審、測試、啟用與發布不得加入自動白名單。只有嚴格白名單的 Plugin scoped／Claude Desktop Connector 名稱成功 `PostToolUse` 才能關閉 lifecycle 旗標。Hook 不持有 credential、不得讀取 OAuth cache、一般對話必須 no-op；Stop 重試最多兩次後 fail-safe，禁止無限迴圈。現行 Claude Code loader 不接受此 Plugin 原先使用的 `mcp_tool` handler，因此不得重新加入該格式，除非先以實際版本驗證 loader schema。

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
