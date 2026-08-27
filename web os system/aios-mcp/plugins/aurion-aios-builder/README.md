# Aurion AIOS Agent Builder Universal Plugin

這個套件同時支援 ChatGPT／Codex Universal Plugin 與 Claude Plugin。它只安裝客戶端設定：

1. `build-aios-agent` Skill，讓模型用動態 Grill-me 方式協助建立 AI 員工。
2. `use-aios-agent` Skill，讓模型免 FDE 立即試聊 READY 測試員工，或查找並呼叫已正式啟用的 AI 員工，也能提出排程與封存申請。
3. HTTPS Remote MCP Connector：`https://aurion-aios-mcp.lazyoffice.app/mcp`。
4. 在 Claude Code／Cowork 中，以相容的 `SessionStart`、`UserPromptSubmit`、`PreToolUse`、`PermissionRequest`、`PostToolUse` 與 `Stop` command Hooks 建立完整同步閉環。

客戶電腦不會安裝 AIOS server、資料庫、Cloudflare Tunnel 或本機 MCP 服務。第一次使用 MCP 時，ChatGPT、Codex 或 Claude 會開啟 AIOS OAuth 登入與授權頁；使用者用自己的 AIOS 帳號登入。建置結果會出現在：

https://aurion-aios.lazyoffice.app/agent-builds

所有外部建置內容都先是 shadow draft。READY Shadow Agent 可以立刻進行無工具、無外部副作用的測試對話；這個 Plugin 沒有 FDE 核准、確認 Skill、正式啟用或直接封存 Agent 的能力。

READY 測試 Agent 可透過 `list_testable_agents`、`chat_with_test_agent` 直接試聊，不需 FDE，但不能使用工具、網路、Shell、Computer Use、排程或外部寫入。已啟用的 Agent 可由登入帳號透過 `list_available_agents`、`get_agent_capabilities`、`invoke_agent` 與 `get_agent_run` 使用；正式執行仍受 AIOS 的限制、成本、跨模型驗證與高風險核准閘約束。排程與封存只會建立待審提案，FDE 核准前不會生效。封存核准後會保留 Agent 稽核資料，但停用 Agent、工作流與排程，並拒絕後續調用。

Hook 不會讀取、保存或轉送 OAuth Token，也不直接呼叫遠端 API。它只保存不含對話內容的同步狀態，並要求 Claude 透過已授權的 Aurion MCP 完成三段呼叫：建置第一輪的 `start_agent_build`、每輪的 `prepare_agent_build_prompt`、結束前的 `guard_agent_build_stop`。`PreToolUse` 與 `PermissionRequest` 只自動允許目前 Claude session 的三個 lifecycle 工具，以及 Build ID 完全吻合的 `sync_agent_build_turn`、`sync_agent_build_artifact`、`upsert_agent_build_snapshot`；上傳檔案、送審、測試、啟用與發布不會自動獲准。`PostToolUse` 只在實際 Plugin 或 Claude Desktop Connector 別名成功後確認 lifecycle 完成。若尚未確認，`Stop` 最多要求重試兩次後 fail-safe 放行，避免無限迴圈。

## 使用

安裝後直接說：

> 我想建立一位每天整理產業新聞、附來源並產生主管摘要的 AI 員工。

或：

> 請用我的 AIOS 員工幫我完成這件事。

模型會自然追問，AIOS 則在背景保存對話並迭代 Agent、Skill、記憶、流程與測試草稿；使用既有員工時則只呼叫帳號隔離的 Runtime 工具。

## ChatGPT / Codex

- 本資料夾的 `.codex-plugin/plugin.json` 是 Universal Plugin manifest。
- `.mcp.json` 只指向公開 Remote MCP，不會啟動客戶端服務。
- ChatGPT 網頁沒有 Claude Code 的完整生命週期 command Hooks；Skill 會在每個有意義的回合顯示答覆前，呼叫 `upsert_agent_build_snapshot` 一次，同步該回合與完整草稿。
- 若以 ChatGPT Developer mode 建立個人 Plugin，請註冊 `https://aurion-aios-mcp.lazyoffice.app/mcp`，完成 AIOS OAuth 登入後啟用 `build-aios-agent` 或 `use-aios-agent` Skill。

## Claude Chat 的限制

Claude Chat 的自訂 Skill ZIP 不等於 Connector。若使用的 Claude 介面不支援 Plugin，請另在 Claude 的 Connectors 設定加入上面的 Remote MCP URL，再安裝獨立的 `build-aios-agent.skill.zip` 或 `use-aios-agent.skill.zip`。此情況沒有 Claude Code 同等的生命週期 Hooks，Skill 會在每輪回覆前主動呼叫 MCP 同步。
