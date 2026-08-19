# ADR 0005 — 錄製／Computer Use 技能強制 CODEX 主引擎，經 Codex App 的 MCP 驅動

**狀態**：已接受（2026-07）。**握手與 `tools/list` 已實機驗證；live `tools/call` 尚未端對端通過（見文末「已知限制（Slice 6 更新）」）。**

## 實機驗證的事實（2026-07-25）
Codex App 隨附的 MCP 伺服器**確實存在且可用**（先前誤以為只有 `codex mcp-server` 的 `codex`/`codex-reply`，該判斷已作廢）：

- **Computer Use MCP**：`~/.codex/computer-use/Codex Computer Use.app/.../MacOS/SkyComputerUseClient mcp`
  握手回 `serverInfo.name="Computer Use"`，**10 個工具**：`list_apps`、`get_app_state`、`click`、`perform_secondary_action`、`set_value`、`select_text`、`scroll`、`drag`、`press_key`、`type_text`（走 macOS accessibility，可用元素索引或像素座標）。
- **Record & Replay**：外掛 `record-and-replay@openai-bundled` v1.0.1000502（已安裝啟用，**授權 Proprietary/OpenAI**）。
  MCP 名 **`event-stream`**，啟動 `./bin/computer-use-client-launcher event-stream mcp`（cwd=外掛目錄、env `CODEX_HOME`）。
  工具：`event_stream_start` / `event_stream_status` / `event_stream_stop`。
- 另有 `browser@openai-bundled`、`chrome@openai-bundled` 外掛（Browser Use）。
- 註冊位置：`~/.codex/config.toml` 的 `[mcp_servers.*]` 與 `[plugins.*]`。

## 錄製→技能：**委派給 Record & Replay 自己做**（定案，2026-07-25 修正）

**我們不自己寫 events.jsonl → SKILL.md 的翻譯器**，也不把它變成 JSON 或腳本。

實機驗證：`event-stream` MCP（serverInfo 名 `Record & Replay`）只有三個**無參數**工具——`event_stream_start` / `event_stream_status` / `event_stream_stop`——它們只負責起停與回傳產物路徑。**「把錄製變成 Skill」不是 MCP 工具，而是 Codex agent 的行為**，由其 `record-and-replay` skill ＋ `~/.codex/skills/.system/skill-creator` 完成，產出落在 `~/.codex/skills/<name>/SKILL.md`。

因此流程為：
1. 網頁按「開始錄製」→ 後端經 MCP 呼叫 `event_stream_start`；前端顯示「錄製中」（可用 `event_stream_status` 查詢）。
2. 使用者實際操作。
3. 網頁按「結束錄製」→ 後端 `event_stream_stop` → **驅動 CODEX 引擎**（`codex exec`，該員工主引擎已強制為 CODEX）下指令「把剛才的錄製變成一個可重用 skill」→ **Codex 自己**用 record-and-replay + skill-creator 產生 skill。
4. 後端**匯入**產出的 `SKILL.md` 成為我們的 `Skill`（`origin=RECORDED`）→ 走既有 `understand` 閘 → `AWAITING_USER_CONFIRM` → FDE 確認 → 掛載給該員工／進共用技能庫。
5. 匯入時仍套用紅線 redactor（防止密碼／OTP／金鑰被帶進技能）。

## 錄製產物（供理解，我們不解析它）
**事件流，非影片**：
- `events.jsonl`：主證據。滑鼠點擊、輸入文字、每事件的 AX 樹或 AX 差異（`~`變更／`+`新增／`-`移除），含 app/window 歸屬。
- `session.json`：路徑、時間、`endReason`（如 `recording_controls_cancelled`）。
- 限制：單次最長 **30 分鐘**、**同時僅一個**錄製。

## 決策
1. **`SkillOrigin` 新增 `RECORDED`**；需電腦操控者維持 `SkillKind.COMPUTER_CONTROL`（既有程式碼已強制 `executionEnv=DESKTOP_APP`）。
2. **掛載時強制**：掛載 `RECORDED` 或 `COMPUTER_CONTROL` 技能時，若 `agent.engineExecute ≠ CODEX` 則**拒絕**並說明原因（fail-closed）。
3. **執行路徑**：由 CODEX 引擎經上述 MCP 驅動；現有「發 `computer.control_requested` 給 macOS App 開 Codex.app」降為 fallback／可視化橋接。
4. **驗證閘不受影響**：execute=CODEX 時 `compileManifest` 自動取對面（CLAUDE_CODE）為驗證引擎，`executor ≠ verifier` 成立。
5. **錄製→Skill 的治理**：轉譯出的草稿一律走既有 `understand → AWAITING_USER_CONFIRM → FDE 確認`；**紅線 redactor 必須套用在 events.jsonl 的擷取內容上**（官方 SKILL.md 亦明訓不得把密碼/OTP/金鑰寫進技能）。
6. **避免純座標重播**：優先產生穩定的 app/window/control 目標描述與驗證步驟。

## 後果 / 風險
- 依賴 **Proprietary** 外掛與 Codex App 版本；App 更新可能改變工具介面 → 橋接層需版本偵測與明確失敗訊息。
- Computer Use 走 accessibility，需系統「輔助使用」權限；失敗要能清楚回報而非靜默。

## 已知限制（Slice 6 更新，2026-07-27）

**誠實現況**：MCP 握手與 `tools/list`（Computer Use 約 10 工具、Record & Replay 3 工具）已實機驗證可用；但**真正的 `tools/call` 在現況下會 timeout**（`codex exec` 亦約 10 分鐘無回應）。研判需 **Codex/ChatGPT App UI 端確認**或特定授權脈絡才會放行。

- **本 ADR 不宣稱 live Computer Use 端對端成功**；產品文件與測試不得誇大「電腦操控已 live 可用」。桌面授權阻擋時應精確如實回報上述 timeout 條件。
- 可獨立驗收的部分：`RECORDED` 匯入路徑與治理閘（`origin=RECORDED` → `AWAITING_USER_CONFIRM` → FDE 確認、`redactSecrets`、掛載時強制 `engineExecute=CODEX`）。
- 待上游授權／UI 脈絡打通後，再補 live `tools/call` 端對端證據，並更新本節。
