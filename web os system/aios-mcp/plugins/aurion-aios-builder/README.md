# Aurion AIOS Agent Builder Universal Plugin

這個套件同時支援 ChatGPT／Codex Universal Plugin 與 Claude Plugin。它只安裝客戶端設定：

1. `build-aios-agent` Skill，讓模型用動態 Grill-me 方式協助建立 AI 員工。
2. `use-aios-agent` Skill，讓模型查找並呼叫已通過 FDE 的 AI 員工，也能提出排程申請。
3. HTTPS Remote MCP Connector：`https://aurion-aios-mcp.lazyoffice.app/mcp`。
4. 在支援的 Claude Code／Cowork 環境中，以 `UserPromptSubmit` 與 `Stop` Hook 保存建置對話。

客戶電腦不會安裝 AIOS server、資料庫、Cloudflare Tunnel 或本機 MCP 服務。第一次使用 MCP 時，ChatGPT、Codex 或 Claude 會開啟 AIOS OAuth 登入與授權頁；使用者用自己的 AIOS 帳號登入。建置結果會出現在：

https://aurion-aios.lazyoffice.app/agent-builds

所有外部建置內容都先是 shadow draft。這個 Plugin 沒有 FDE 核准、確認 Skill 或啟用 Agent 的能力。

已啟用的 Agent 可由登入帳號透過 `list_available_agents`、`get_agent_capabilities`、`invoke_agent` 與 `get_agent_run` 使用。每次執行仍受 AIOS 的限制、成本、跨模型驗證與高風險核准閘約束。排程功能只會建立待審提案，FDE 核准前不會真正啟用。

## Claude 建議安裝方式

從受控 GitHub Marketplace 安裝：

`Kevin-aurion/aurion-aios-plugin-marketplace`

Cowork 使用者在 `Customize → Plugins → Add marketplace` 加入 Repository，再安裝 `aurion-aios-builder`。Claude Code 可執行：

```text
/plugin marketplace add Kevin-aurion/aurion-aios-plugin-marketplace
/plugin install aurion-aios-builder@aurion-aios
```

後續在 Marketplace 點 `Update`，或執行 `/plugin marketplace update aurion-aios`，不必重新上傳 ZIP。Marketplace 採私有發佈；安裝者需先取得 Repository 或 Claude 組織授權，而且仍需另外以 AIOS OAuth 登入。

## 使用

安裝後直接說：

> 我想建立一位每天整理產業新聞、附來源並產生主管摘要的 AI 員工。

模型會自然追問，AIOS 則在背景保存對話並迭代 Agent、Skill、記憶、流程與測試草稿。

開始前，Plugin 會先讀取目前登入帳號自己的 AI 員工清單。如果是續訓但無法唯一判定對象，會先請使用者選擇（也可選「都不是」再建立新人）；若是新人，會先詢問希望的員工名稱。其他帳號的員工不會出現在清單中。

上傳檔案時可指定為一般訓練參考，或可重用的 Skill 範本。範本仍要經過 FDE 建置授權與測試，才會放入 Skill 的 `assets/templates/`。

## ChatGPT / Codex

- 本資料夾的 `.codex-plugin/plugin.json` 是 Universal Plugin manifest。
- `.mcp.json` 只指向公開 Remote MCP，不會啟動客戶端服務。
- ChatGPT 網頁沒有 Claude Code 的 Stop Hook；Skill 會在每個有意義的回合顯示答覆前，呼叫 `upsert_agent_build_snapshot` 一次，同步該回合與完整草稿。
- 若以 ChatGPT Developer mode 建立個人 Plugin，請註冊 `https://aurion-aios-mcp.lazyoffice.app/mcp`，完成 AIOS OAuth 登入後啟用 `build-aios-agent` Skill。

## Claude Chat 的限制

Claude Chat 的自訂 Skill ZIP 不等於 Connector。若使用的 Claude 介面不支援 Plugin，請另在 Claude 的 Connectors 設定加入上面的 Remote MCP URL，再安裝獨立的 `build-aios-agent.skill.zip`。此情況沒有 Claude Code 同等的 Stop Hook，Skill 會在每輪回覆前主動呼叫 MCP 同步。
