# AIOS Agent Builder MCP／Skill 安裝與使用說明

這套整合讓使用者留在 ChatGPT、Codex、Claude 或 Cursor 對話，AIOS 負責保存建置歷史、版本、檔案、Skill、記憶、流程、測試與 FDE 治理。

## 0. ChatGPT／Codex Universal Plugin

`releases/aurion-aios-builder-plugin.zip` 同時包含 `.codex-plugin/plugin.json`、共用 Skill 與公開 `.mcp.json`。在支援 Universal Plugin 的 ChatGPT／Codex 介面直接安裝即可；第一次使用時，以 AIOS OAuth 登入，不需要輸入或部署伺服器網址以外的主機設定。

若使用 ChatGPT 網頁的個人 Developer mode：

1. 進入 Settings → Security and login，開啟 Developer mode。
2. 在 ChatGPT Plugins 新增 Remote MCP：`https://aurion-aios-mcp.lazyoffice.app/mcp`。
3. 瀏覽器開啟 AIOS 授權頁後，用自己的 AIOS 帳號登入。
4. 啟用 `build-aios-agent` Skill，然後直接描述要建立的 AI 員工。

ChatGPT 網頁沒有 Claude Code 的 Stop Hook，因此 Skill 會在每一個會改變員工草稿的回合，在顯示回答前呼叫 `upsert_agent_build_snapshot`，一次同步使用者原話、完整回答與完整 shadow draft。網路中斷時以相同事件 ID 重試，不會重複建立版本。

## 1. 客戶端一鍵安裝（建議）

客戶取得 `releases/aurion-aios-one-click-install.zip` 後解壓縮：

- macOS：雙擊 `Install Aurion AIOS.command`。
- Windows：用 PowerShell 執行 `Install-Aurion-AIOS.ps1`。

安裝器只把 Claude Plugin 放進使用者的 Claude 設定，內容包含 Skill、Remote MCP Connector 與支援環境中的對話 Hook。它不會安裝或啟動 AIOS server、PostgreSQL、Redis、Qdrant、Cloudflare Tunnel、Node 常駐程式或本機 MCP 服務。

Plugin 固定連線至：

```text
https://aurion-aios-mcp.lazyoffice.app/mcp
```

第一次使用時，客戶端會開瀏覽器顯示 AIOS OAuth 頁。使用者必須用自己的 AIOS 帳號登入並授權；安裝包內沒有共用帳號、密碼或靜態 Token。對話完成後，建置記錄會出現在 `https://aurion-aios.lazyoffice.app/agent-builds`。

若使用純 Claude Chat、沒有 Claude Code CLI，請在 Claude 的 Connectors 設定新增上述 Remote MCP URL，再上傳 `build-aios-agent.skill.zip`。Claude Chat 的 Skill ZIP 目前無法替使用者自動新增 Connector，也沒有 Claude Code 同等的 Stop Hook，因此該 Skill 會在每次回覆前主動同步。

## 2. 中央 AIOS 主機安裝（只在 Kevin 這臺設備）

先確定 PostgreSQL 與 aios-server 已啟動，再執行：

```bash
export PATH="$HOME/.local/node/bin:$PATH"
cd "/Users/kevin/Documents/aurion/web os system/aios-mcp"
npm install
npm run build
npm run provision:local-user
npm run install:local-clients
```

這會：

1. 建立或輪替 `claude-builder@local.aios` 的專用 `MEMBER` 帳號。
2. 把隨機密碼只寫入 gitignore 的 `.env`，權限為 `0600`，不輸出到終端；並設定 `AIOS_MCP_PROFILE=builder`，只暴露 22 個建置／Hook／Runtime 工具（15 builder + 7 runtime）。
3. 在既有 Claude Desktop、Claude Code 與 Cursor JSON 設定中加入 `mcpServers.aios`，寫入前各保留一份 `.aios-backup`。
4. 把 Skill 安裝到 `~/.claude/skills/build-aios-agent` 與 `~/.claude/skills/use-aios-agent`（Claude／Claude Code 本機使用）。
5. 中央主機的本機 stdio 開發安裝與客戶端 GitHub Plugin 是不同路徑；客戶端 Plugin 使用內建的 `SessionStart`、`UserPromptSubmit`、`PostToolUse`、`Stop` command hooks，不會修改全域 hooks 或保存 OAuth credential。

完成後重新啟動 Claude Desktop 與 Cursor。AIOS 後端必須保持在 `127.0.0.1:8700`；MCP 不會自行啟動後端。

## 3. Claude Plugin／Skill 檔案

完整 Plugin 位於 `releases/aurion-aios-builder-plugin.zip`；跨平台安裝包位於 `releases/aurion-aios-one-click-install.zip`；建置 Skill 位於 `releases/build-aios-agent.skill.zip`；Runtime Skill 位於 `releases/use-aios-agent.skill.zip`。

在 Claude Desktop 的自訂／Skills 頁面上傳對應 zip。壓縮檔根層包含 `build-aios-agent/` 與 `use-aios-agent/` Skill 資料夾。若桌面版帳號尚未顯示自訂 Skill 功能，仍可使用 MCP prompt `build-aios-agent`／`use-aios-agent`；Claude Code 則會直接讀取安裝到 `~/.claude/skills/` 的版本。

## 4. 使用者怎麼開始

使用者可以直接說：

> 我想建立一位每天整理競品 AI 新聞、附來源並寄給主管的 AI 員工，請用 AIOS 幫我訓練。

或選用 MCP prompt `build-aios-agent`。Claude 會：

1. 立即建立一筆 AIOS 建置記錄。
2. 用動態 Grill-me 方式一次問一個最重要、跟情境有關的問題。
3. Claude Code 由 Hook 自動保存每輪對話；ChatGPT／Codex／Claude Chat／Cursor 由 Skill 呼叫 MCP 保存。
4. AIOS 直接依對話在背景建立新版本，不會卡住 Claude 回答，也不覆蓋歷史。
5. 收到檔案時傳遞實際文字或 bytes，不傳主機路徑。
6. READY 測試員工可直接用 `list_testable_agents` + `chat_with_test_agent` 試聊，不需 FDE；此模式沒有工具、網路、電腦控制、排程或外部寫入。
7. 使用者明確確認後才送 FDE 正式審核；FDE 初審後要求驗證資料、實跑，再由 FDE 最終啟用正式版本。

登入 `https://aurion-aios.lazyoffice.app/agent-builds` 可在獨立入口看到外部對話、每次迭代、Agent／Skill、記憶、流程與測試；**所有角色（含 FDE）都只看該登入帳號自己的建置**。FDE 跨帳號審核走管理頁／admin evolution-queue。

公開 Remote MCP 以 OAuth 對應每位 AIOS 使用者；每個人的建置資料仍依登入身分隔離。沒有共用 Builder 密碼。

## 5. 治理與限制

- 建置工具寫入的內容全部是 shadow draft；外部客戶端沒有核准、確認 Skill 或啟用 Agent 的工具。
- Remote MCP OAuth token 只能呼叫 Agent Builder 與帳號隔離的 Agent Runtime API；它不能開一般 WebSocket、整合授權或其他 AIOS API，且一律以 MEMBER 權限執行，不繼承 OWNER／TRAINER 的生效權限。
- 測試模式只能看到登入者自己的 READY Shadow Agent，可免 FDE 安全試聊；Production Runtime 只能看到登入者自己的 ACTIVE Agent，執行沿用限制、預算、跨模型驗證與高風險核准。排程只會建立待審提案，FDE 核准前不生效。
- 使用者或任何外部模型宣稱工具已授權時，AIOS 仍會把它降為 `NEEDS_FDE`，由本機真實狀態驗證。
- 寄信、雲端寫入、電腦操作、Shell、付款、刪除等不可逆動作一定需要人工核准。
- 對話、檔案與 Artifact 在落地前都會再經 secrets／個資遮罩；客戶端仍應先避免傳送不必要的秘密。
- 同步使用穩定事件 ID，可重試而不重複寫入。
- Claude Desktop／Cursor 沒有 Claude Code 同等的公開生命週期 Hook，因此仍由 Skill 呼叫 MCP；Claude Code 以六種 command hook 事件建立閉環，但真正保存仍要看到 MCP 成功的 `PostToolUse`。任何客戶端中斷或 API error 都不得假裝同步成功。

## 6. Claude Code／Cowork 相容 Hook

Claude Code Plugin 的 Hook 行為如下：

1. `SessionStart`：只初始化不含對話內容的本機同步狀態；一般 Claude 對話不會因此呼叫 AIOS。
2. `UserPromptSubmit`：明確建置／訓練 Agent、AI 員工、Skill 或 Workflow 時，第一輪要求 `start_agent_build`，每輪要求 `prepare_agent_build_prompt`；已進入建置的對話即使只說「繼續」仍會同步。
3. `PreToolUse`／`PermissionRequest`：自動允許目前 Claude session 的 `start_agent_build`、`prepare_agent_build_prompt`、`guard_agent_build_stop`；取得後端回傳的 Build ID 後，另允許 Build ID 完全吻合的 `sync_agent_build_turn`、`sync_agent_build_artifact`、`upsert_agent_build_snapshot`。上傳檔案、送審、測試、啟用、發布、寄信與電腦操作一律不代替使用者核准。
4. `PostToolUse`：只接受嚴格白名單中的 Plugin scoped 名稱或 Claude Desktop Connector 別名，且 `externalConversationId` 必須等於目前 Claude session；成功後才關閉同步旗標。
5. `Stop`：要求 `guard_agent_build_stop` 保存最後回答；若前面的 start／prompt 漏掉也一併補呼叫。成功後第二次 Stop 才放行，最多重試兩次以避免無限迴圈。
6. command hook 不讀取 OAuth Token、不直接連線遠端服務，也不將使用者 prompt、助手回答或 credential 寫入狀態檔。
7. 完整 Artifact 仍由 Skill 透過 `upsert_agent_build_snapshot`／`sync_agent_build_artifact` 傳遞；Hook 與外部 MCP 都不能自行送審、核准、確認 Skill、測試或啟用 Agent。

安裝器只會將 13 個非 Runtime 的 `mcp__aios__...` 建置同步工具加入 Claude Code 的
`permissions.allow`，讓背景同步不會卡在互動式權限視窗。6 個 Runtime 工具不會預先放行，因為呼叫 Agent 可能產生外部副作用。既有的
`permissions.ask`、`permissions.deny` 與其他工具權限都會原樣保留；deny/ask
仍依 Claude Code 的權限優先順序生效。

若模型未執行提示中的工具或 MCP 發生錯誤，Stop 會要求補送；超過兩次仍失敗時會 fail-safe 放行並要求如實告知未同步，禁止假裝成功或無限卡住對話。

## 7. 檔案格式

目前接收 Excel (`xlsx`/`xls`)、CSV/TSV、Markdown/文字、PDF、DOCX、JSON、YAML 與 HTML，單檔上限 10 MB。文字直接送 `textContent`，二進位檔送 `base64Content`。伺服器使用安全暫存路徑與既有本地文件解析管線處理。

## 8. 重新安裝與撤銷

- 客戶端重跑一鍵安裝器會先備份前一版 Aurion marketplace，再重新安裝 Aurion Plugin；不會動其他 Plugin 或 MCP。
- 使用者可在 Claude 的 `/mcp` 或 Connectors 頁撤銷 OAuth；AIOS refresh session 會被撤銷。
- 中央主機的 `npm run provision:local-user` 與 `install:local-clients` 只供本機 stdio 開發，不應在客戶電腦執行。
