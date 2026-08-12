# AIOS Agent Builder MCP／Skill 安裝與使用說明

這套整合讓使用者留在 Claude Desktop、Claude Code 或 Cursor 對話；AIOS 在背景保存對話並建立 Agent、Skill、記憶、流程與測試草稿，正式生效仍受 FDE 治理。

## 本機 AIOS 管理者安裝

先確定 PostgreSQL 與 `aios-server` 已啟動，再執行：

```bash
export PATH="$HOME/.local/node/bin:$PATH"
cd "/Users/kevin/Documents/aurion/web os system/aios-mcp"
npm install
npm run build
npm run provision:local-user
npm run install:local-clients
```

安裝器會保留既有設定的 `.aios-backup`，並完成：

1. 設定 Claude Desktop、Claude Code 與 Cursor 的 `aios` MCP。
2. 安裝 `build-aios-agent` Skill 到 `~/.claude/skills/`。
3. 在 Claude Code 安裝 `UserPromptSubmit` Hook：明確提出建立／訓練 Agent、AI 員工或 Skill 時，自動開案、保存使用者原話並排入背景建置。
4. 在 Claude Code 安裝 `Stop` Hook：自動保存最後回答，並在前一個 Hook 漏接時補抓使用者原話。
5. 只允許 11 個 AIOS Builder MCP 工具；既有 allow／ask／deny 與其他 Hook 不會被移除。

完成後請重新啟動 Claude Desktop、Claude Code 與 Cursor。AIOS 後端必須保持可連線。

## Claude Desktop 安裝 Skill

在 Claude Desktop 的 Skills／自訂技能頁面上傳 `releases/build-aios-agent.skill.zip`。Claude Desktop 與 Cursor 目前沒有 Claude Code 同等的公開對話生命週期 Hook，因此 Skill 會在建置對話中明確呼叫 MCP；Claude Code 則由 Hook 自動保存一般回合。

## 使用方式

直接對 Claude 說：

> 我想建立一位每天整理競品 AI 新聞、附來源並交給主管的 AI 員工。

Claude 會用動態 Grill-me 方式一次詢問一個最有價值的問題。AIOS 的背景工作不會卡住 Claude 對話；每次新需求、修正或反悔都會形成新的可追溯版本。

建置結果請在以下獨立入口查看：

- `https://aios-new.lazyoffice.app/agent-builds`
- 使用原本 AIOS 帳號密碼登入。
- 一般使用者只能看到自己的建置；OWNER／TRAINER 可看全部。
- 草稿可送交 FDE、建立待測版本，並在頁面提供測試資料後調用 Agent 隔離試跑。

## 安全與治理

- 背景產物都是不生效的 shadow draft；不會因 Claude 對話而自動取得權限或正式啟用。
- 新／修改的 Skill 一律維持 `AWAITING_USER_CONFIRM`，只有 FDE 可確認。
- 寄信、雲端寫入、Computer Use、Shell、付款、刪除等外部或不可逆動作仍需真實核准。
- 對話、檔案與草稿在落地前都會遮罩秘密與個資。
- Stop Hook 不再為了等待完整 Artifact 阻止 Claude 結束；後端直接從已保存的對話非同步建立下一版。
- 完整 `sync_agent_build_artifact` 仍可用來傳遞 Claude 已完成的 SKILL.md、Agent Markdown、工作流或測試集，但不是每輪保存的必要條件。

## 撤銷與更新

- 重新執行 `npm run install:local-clients` 可更新 MCP、Skill 與兩個 Hook。
- 重新執行 `npm run provision:local-user` 會輪替 MCP 專用密碼並撤銷舊 refresh sessions。
- `AIOS_MCP_LOGOUT=1 node dist/index.js` 可撤銷本機 MCP session。
