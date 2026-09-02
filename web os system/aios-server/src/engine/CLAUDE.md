# engine — 代理執行引擎（系統核心）

把「員工 Agent + 工作流步驟（或臨時對話步驟）」編譯成 manifest，逐步執行，每步經跨模型驗證閘後才前進，並全程廣播 WS 事件。

## 檔案
- `runner.ts` — **核心**。`runAgent()`／`compileManifest()`／各步驟型別（DO / TOOL / AGENT / CONDITION / NOTIFY / COMPUTER_CONTROL）；execute↔verify 迴圈與 `maxRounds`；對話步驟 `skipVerify`；DO 步驟預設 `permissions:'full'`（允許寫檔）；限制注入；同步雲端檔案為 `data/cloud-files.md`；對話歷史（`history`）渲染成逐字稿。
- `index.ts` — 對外入口（re-export `runAgent`）。
- `claude.ts` — `claude -p` 適配（`--append-system-prompt`、`--disallowedTools`、`--allowedTools`、`--dangerously-skip-permissions`）；含串流版。非串流 CLI 以獨立 process group 啟動，timeout／AbortSignal 必須終止整個子行程群，避免 verifier 或 hooks 在外層逾時後繼續執行。
- `codex.ts` — `codex exec` 適配。
- `grok.ts` — `grok -p --output-format json --always-approve --cwd`（`disableWebSearch`、`resumeSessionId`）。
- `tools.ts` — 內建工具（如 `upload_to_cloud`）＋ `ToolContext`（agentId/agentDir/cloudWrite）；`mcp:<serverId>:<tool>` 一律經 Broker 的 allowlist／restriction／approval／budget 閘。
- `restrictions.ts` — `AgentRestrictions`、`DEFAULT_RESTRICTIONS`、`parseRestrictions()`、`restrictionsToRules()`。
- `materialize.ts` — 依 DB 具現化員工工作區（`agent.md` + `skills/`）到 `MyAgent/`。
- `types.ts` — 步驟與 manifest 型別。

## 關鍵規則
- **執行引擎 ≠ 驗證引擎**：驗證取員工指定的 `engineVerify`，否則自動取執行引擎的「對面」。
- **限制於引擎層強制**：`webSearch=false` → 停用 WebSearch/WebFetch；`computerUse=false` → COMPUTER_CONTROL 硬性拒絕。
- **Builder 正式釋出閘**：`runAgent()` 在 HITL、filesystem materialize、成本與 CLI 之前呼叫 `assertBuilderAgentReleased()`。曾為 `builtAgentId` 的 Agent 沒有 `agent_builder.finalized` 稽核證據就拒絕（不建 Run）。`builderTestSessionId` 隔離測試略過此閘，後續 `compileManifest` 仍驗證 session／actor／draft。
- 驗證器在啟用網路搜尋時，被授予 `allowedTools:['WebFetch','WebSearch']` 以驗證來源。
- 每步 execute→verify 最多 `maxRounds` 回合，超過即停並回報。

## 實測要點（案例 2）
報價單流程曾第一回合被 GROK 驗證 rejected、自動重跑後 approved — 驗證閘確實會攔截不合格輸出。
