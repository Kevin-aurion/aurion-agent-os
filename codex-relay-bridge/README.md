# Codex Relay Bridge

從 **Claude / Claude Code**(或任何 MCP client、任何專案)**程式化派工給本機的 Codex**,並把結果、事件、審批取回來。這是一個獨立、可重用的 **stdio MCP server**——其他專案只要接上它,就能讓自己的 agent 呼叫 Codex 做事(含 Codex 的 Computer Use 技能),不必內嵌整套實作。

> 架構:`你的 Agent / Claude Code` →(MCP stdio)→ **Codex Relay Bridge** →(JSON-RPC over stdio)→ `codex app-server`(Codex CLI)。Bridge 負責 thread 對應、turn 佇列/鎖、事件正規化、以及 **fail-closed 的審批**。

---

## 這個工具能做什麼

- 讓程式(而非人手動)**開一個 Codex 任務、續跑、讀輸出、回覆審批**。
- 併發安全:每個 thread 一把寫入鎖 + `turn/steer` 的 `expectedTurnId`,多個 agent 同時呼叫不會互踩。
- **審批一律 fail-closed**:未知/逾時/當機一律當拒絕,高風險動作永不自動放行。
- 已實測可驅動 Codex 的 **Computer Use 技能**(例如派 Codex 用它訓練好的 skill 去操作瀏覽器/桌面)。

## 需求

- macOS,已安裝並登入的 **Codex 桌面版 / CLI**(本工具呼叫 `/Applications/ChatGPT.app/Contents/Resources/codex` 的 `app-server`;可用環境變數 `CODEX_BIN` 覆寫)。
- **Node ≥ 22**。
- 若任務要用 Computer Use:需在系統設定授權「螢幕錄製 / 輔助使用」給 **Codex Computer Use.app**(一次即可,之後 CLI/桌面共用)。

## 安裝

```bash
git clone git@github.com:Kevin-lazyoffice/codex-bridge.git
cd codex-bridge
npm install
npm run build          # 產生協定型別 + 編譯到 dist/
npm test               # 7 條整合測試(對 fake app-server,不需真 Codex)
```

## 註冊為 MCP(給 Claude Code / 你的 agent 用)

```bash
claude mcp add codex-relay -- ~/.local/node/bin/node /Users/kevin/Documents/codex-bridge/dist/main.js
# 之後任何 Claude Code session / MCP client 都能呼叫下方 5 個工具
```

也可用 `-s user` 註冊到使用者層級,所有專案共用。

## 五個 MCP 工具

| 工具 | 用途 | 主要輸入 | 輸出 |
|---|---|---|---|
| `codex_start_task` | 建立 Codex thread 並啟動一個 turn | `project`(絕對路徑,須在白名單)、`message`、`idempotency_key` | `task_id`、`thread_id`、`status` |
| `codex_continue_task` | 續接同一 thread(idle→新 turn;active→steer) | `thread_id`、`message` | `turn_id`、`mode`、`accepted` |
| `codex_get_status` | 讀進度、摘要、待審批清單 | `task_id` 或 `thread_id` | `status`、`summary`、`pending_approvals` |
| `codex_read_output` | 游標式取增量/最終事件 | `task_id`、`cursor?` | `events`、`next_cursor`、`has_more` |
| `codex_respond_approval` | 回覆允許/拒絕(高風險不自動允許) | `request_id`、`decision`(`allow`/`deny`) | `resolved` |

### 典型流程

```
codex_start_task { project, message, idempotency_key }   → 拿 task_id / thread_id
  ↓ 輪詢
codex_read_output { task_id, cursor }                    → 事件流(agent_message、turn_completed…)
codex_get_status  { task_id }                            → 有 pending_approvals 時
codex_respond_approval { request_id, decision }          → 放行/拒絕
codex_continue_task { thread_id, message }               → 在同一 thread 追加指令
```

派 Computer-Use 任務也一樣——在 `message` 裡叫 Codex 使用它的 skill 即可,例如
`"Use the $my-skill skill to …"`。Bridge 會把 Codex 執行過程的事件與審批轉回給你。

## 設定

| 環境變數 | 說明 | 預設 |
|---|---|---|
| `CODEX_BIN` | Codex 執行檔路徑 | `/Applications/ChatGPT.app/Contents/Resources/codex` |
| `CODEX_BRIDGE_ALLOWLIST` | 允許作為 `project` 的路徑,冒號分隔 | 未設 = 開放本機任意絕對路徑(`/`) |

> ✅ **跨專案重用**:預設**開放本機任意路徑**(operator 授權「這臺電腦皆可調用」),所以任何專案裝上就能直接派工。要收緊,設 `CODEX_BRIDGE_ALLOWLIST`(冒號分隔的允許路徑)即可,例如 `CODEX_BRIDGE_ALLOWLIST=/Users/me/proj-a:/Users/me/proj-b`。

## 安全模型

- 只走 **stdio**,不開任何網路 listener。
- `project` 路徑經 `realpath` 正規化後比對白名單,擋路徑穿越 / symlink 逃逸。
- 所有 log 走 **stderr / 檔案**,stdout 純粹保留給 MCP JSON-RPC 通道。
- 審批 **fail-closed**;刪檔/對外訊息/帳號權限/密碼 OTP 等**永不自動允許**。

## 目前限制(Phase 1)

- 記憶體內的 registry/事件(尚無 SQLite 持久化)。
- Codex app-server 若結束不自動重啟。
- `project` 白名單寫死(見上)。
- `item/permissions`、`item/tool/requestUserInput`、`elicitation` 這幾類審批 Phase 1 僅支援拒絕。
- Computer Use 是否沿用桌面權限、桌面 UI 是否即時同步等,見 `spike-report.md` 的 PoC 問題。

## 開發

```bash
npm run gen:types      # 從安裝的 Codex 重新產生協定型別(釘版本)
npx tsc --noEmit       # 型別檢查
npm test               # 整合測試(fake app-server)
LIVE=1 npm test        # 對真 Codex 的 live smoke(需登入)
```

型別以 `src/generated/`(build 時由 `codex app-server generate-ts` 產生)為**協定唯一真相**。

---

*本工具由 AIOS 專案抽離為獨立可重用元件。詳細設計與 PoC 驗收見 `spike-report.md` 與 `docs/architecture.md`。*
