> ⚠️ **時效聲明（2026-07-26）**：本文件是 **2026-07 上半** 的系統快照，寫於本輪大量新增功能**之前**。
> **最新權威現況請看根目錄 [`/AGENTS.md`](../AGENTS.md)**（給 Codex／協同 AI 的交接文件）。
> 本檔仍具價值：它記錄了當時的逐檔掃描與 code review 結論。文末 §Δ 補上本輪差異索引。

# AIOS 系統總覽（給 AI 開發者的長期參考文件）

> 本文件是為「未來在此 repo 上開發的 AI」寫的安全上手指南。內容基於 2026-07 對原始碼的逐檔實讀掃描 + 三輪 code review（engine / routes+lib / memory+workflow+temporal），所有檔案路徑與函式名皆對應實際程式碼。**改動任何核心路徑前，先讀完 §3（執行流）與 §6（雷點）。**

---

## 1. 系統定位與三支柱

**一句話**：AIOS 是本地優先（local-first）的多代理「AI 員工」作業系統——每個 Agent 是一位員工，掛載技能（Skill）、配置工作流（Workflow），由三個本機 CLI 引擎執行，並以跨模型驗證閘把關輸出品質。

**三支柱（不可弱化的核心設計）**：

1. **三引擎**：`CLAUDE_CODE`（主力執行者）、`CODEX`（程式類 / 交叉驗證）、`GROK`（檢索與驗證最快、技能草擬）。皆為 `child_process.spawn` 呼叫主機 CLI（`claude` / `codex` / `grok`），路徑由 `config.engines.*` 集中管理，可用 `CLAUDE_CLI_PATH` / `CODEX_CLI_PATH` / `GROK_CLI_PATH` 覆寫。
2. **跨模型驗證閘**：**執行引擎 ≠ 驗證引擎，永遠**。防止同模型自我背書。判決 oracle（`isApproved()`）是 fail-closed 正則，寧可誤判失敗不誤放。詳見 §3.2。
3. **引擎層限制（Restrictions）**：`webSearch / computerUse / sendEmail / cloudWrite / shell / cloudEmbedding / sandbox`，雙層強制（提示層 + CLI 旗標層），存在 `Agent.restrictions`（Json）。「存取控制是程式碼，不是提示」。

**在地優先（不離地）**：DB / Redis / Qdrant / Docling 四個 docker 服務全部只綁 `127.0.0.1`；後端與前端**必須跑在主機**（引擎要 spawn 主機 CLI、開 Codex.app，容器內做不到）。對外連線白名單：使用者授權的 Google / Microsoft / LINE + 本機三 CLI。**已知例外（待決策）**：記憶模組 embedding 預設走 OpenRouter（見 §7 風險 #3）。

---

## 2. 目錄與模組地圖

### 2.1 頂層目錄（`/Users/kevin/Documents/aurion/`）

| 目錄 | 屬性 | 說明 |
|---|---|---|
| `web os system/aios-server/` | ✅ 主線後端 | Fastify + Prisma + BullMQ，跑在主機 `127.0.0.1:8700` |
| `web os system/aios-web/` | ✅ 主線前端 | Next.js 14 App Router，`127.0.0.1:3100`，`/api/*` rewrite 到 8700 |
| `web os system/docker-compose.yml` | ✅ 基建 | 四個 loopback-only 儲存服務 |
| `mac os system/` | ✅ 主線 | SwiftUI macOS App `aios-system`，原生前端 + 主機執行器（電腦操控橋接） |
| `MyAgent/` | 執行產物 | 員工磁碟工作區 `MyAgent/<department>/<slug>/`，由 `materializeAgent()` 從 DB 具現化，**可重建** |
| `aios-data/` | 執行產物 | runs / skills / cache / qdrant_storage |
| `agentic-os/` | 文件 | L0-L9 Agentic OS 重構方向文件（本文件所在） |
| `lazyoffice-system-main/` | ❌ 唯讀參考 | **絕對不要在此開發** |

### 2.2 後端模組（`aios-server/src/`）

| 模組 | 職責 | 關鍵檔 / 函式 |
|---|---|---|
| `index.ts` | 進入點：註冊路由（容忍 `ERR_MODULE_NOT_FOUND`）→ `hub.attach()` → scheduler → memory collection → `listen(127.0.0.1:8700)`；全域 `setErrorHandler` → `sendError` | `main()` |
| `config.ts` | 集中設定：引擎路徑、OAuth scopes、`memory.*`、`paths.{agents,skills,cache,runs}` | `config`, `paths`, `integrationsReady` |
| `engine/` | **系統核心**：manifest 編譯、execute↔verify 迴圈、限制強制、成本閘、六種步驟型別 | `runner.ts`(1369行,對外只曝露`runAgent`)、`claude.ts`、`codex.ts`(含`isApproved`)、`grok.ts`、`restrictions.ts`、`cost.ts`、`tools.ts`、`materialize.ts`、`draft.ts`(輕量「問引擎要純文字」共用層)、`types.ts` |
| `routes/` | REST `/api/*`；`requireAuth`/`requireTrainer` 守衛；統一信封 `ok()/sendError()` | 14 檔，見 §4.3 |
| `workflow/` | Layer-2：Workflow → Run 映射（不管步驟怎麼跑） | `runner.ts::runWorkflow()`、`triggers.ts`(關鍵字)、`compose.ts`(AI 草擬工作流) |
| `scheduler/` | BullMQ（Redis）三佇列：`runs`(並發2)/`notify`(並發5)/`sync`；`Schedule` 表 ↔ repeatable job 同步 | `index.ts::startScheduler()/syncSchedule()/catchUpMissedSchedules()` |
| `ws/` | AWP/1 WebSocket hub：pub/sub + req/res + 心跳(25s ping/60s timeout) + `RING_CAP=1000` 環形緩衝 resume | `hub.ts::publish()/onReq()/attach()` |
| `memory/` | L1 wiki（磁碟真相）+ L3 Qdrant（可重建索引）；紅線 redactor 恆生效 | `memoryService.ts`、`qdrant.ts`、`embedding.ts`、`redactor.ts`、`summary.ts` |
| `temporal/` | Opt-in 耐久工作流（`Workflow.durable=true`）：HITL 等 signal + `runAgent` 當 activity | `client.ts`、`workflows.ts`、`activities.ts`、`worker.ts`（需另跑 `npm run temporal:worker`） |
| `agents/compose.ts` | 自然語言 → 完整員工：stub agent → 背景藍圖 + fan-out 技能/工作流草稿（**治理閘門不跳過**：技能停在待確認、工作流 `enabled:false`） | `composeAgentFromRequirement()` |
| `skills/` | 技能建置與「閱讀理解」 | `build.ts::buildSkillFromRequirement()`、`understand.ts::understandSkill()` |
| `integrations/` | Google/Microsoft OAuth + Drive/Gmail、token AES-256-GCM 加密存放 | `google.ts`、`microsoft.ts`、`cloud.ts`、`tokenstore.ts` |
| `channels/` | LINE webhook（HMAC 驗簽）收發、群組推播 | `line.ts`、`routes.ts` |
| `lib/` | 共用：`db.ts`(Prisma單例)、`auth.ts`(argon2+jose)、`crypto.ts`、`guard.ts`、`http.ts`、`audit.ts`(雜湊鏈稽核)、`approval.ts`(HITL)、`filecontext.ts`(雲端檔→文字)、`identitycard.ts`、`skillversion.ts`(內容定址版本+rollback)、`skilltraining.ts`(口述訓練)、`docparse.ts` | — |

### 2.3 前端與 macOS App

- **aios-web**：7 個一級頁（總覽/員工/組織/技能/工作流/設定/稽核 + 登入）；員工詳情 8 分頁（`?tab=` 深連結）：概況/技能/雲端檔案/工作流/執行紀錄/訓練/記憶/對話。`lib/api.ts` 型別化 fetch（401 自動 refresh 重試一次）；`lib/awp.ts::useAwp()` 直連 `ws://<host>:8700/ws?token=`（**Next rewrite 不代理 WS upgrade**）。慣例：WS 事件到達 → `queryClient.invalidateQueries()`，不手改本地狀態。
- **macOS App（`aios-system`）**：原生前端（8 分頁）+ **主機執行器**——`ComputerControlExecutor.swift` 監聽 `computer.control_requested`，NSAlert 徵詢後用 `NSWorkspace` 開 Codex.app（bundle id `com.openai.codex`）並回報 `dispatched`/`skipped`。實際自動化是 Codex 做的，Swift 只是橋接。Token 存 Keychain；`Models.swift` 需與 Prisma schema / routes 回傳形狀同步。

---

## 3. 核心執行流（engine/runner.ts）

### 3.1 `runAgent(opts)` 流程（`runner.ts:1081`）

```
1. 找 Agent row
2. HITL 前置閘：requiresApproval(riskTier, alreadyApproved)
   → riskTier==='high' 且未核准：建 Run{AWAITING_REVIEW} + createApproval()
     + publish('approval.requested')，直接 return，不碰任何引擎
3. materializeAgent(id) → MyAgent/<dept>/<slug>/
   （agent.md frontmatter、CLAUDE.md=rolePrompt、skills/<slug>/SKILL.md 僅 CONFIRMED、
     ensureAgentWiki() L1 骨架；writeIfChanged() sha256 冪等）
4. 建 Run{RUNNING}，組聊天歷史逐字稿
5. compileManifest(agentId, workflowId, agentDir, chatPrompt)
6. depth===0 時：gatherAgentFileContext() 同步雲端檔到 agentDir/data/cloud-files.md
7. while 迴圈逐步 runStep()（含 CONDITION 跳轉、on_fail 返工）
8. 收尾：更新 Run.status、publish('run.finished')；
   記憶沉澱 best-effort（summarizeRun→ingestRunSummary；有 conversationId 再 chat 摘要）
   —— 沉澱失敗永不使 run 失敗
```

### 3.2 跨模型驗證閘 —— **為何不可弱化**

**引擎指派**（`compileManifest`，`runner.ts:320-325`）：

```ts
const autoVerify: Engine = engineExecute === 'CLAUDE_CODE' ? 'CODEX' : 'CLAUDE_CODE';
const engineVerify: Engine =
  agent.engineVerify && agent.engineVerify !== engineExecute ? agent.engineVerify : autoVerify;
```

驗證引擎優先取員工自訂，但**保證不等於執行引擎**；未指定或衝突時自動取「對面」CLI。

**判決 oracle**（`codex.ts::isApproved`，三個 verify 分支共用同一標準）：

```ts
const APPROVED_RE = /##\s*Verdict\s*\r?\n\s*APPROVED\s*[.!。]?\s*(?:\r?\n|$)/i;
const REJECTED_RE = /^\s*(?:ISSUES\s+FOUND|REMAINING\s+ISSUES)\b/im;
// 先查 REJECTED（命中一律 false）→ 再查嚴格 APPROVED 格式 → 最後才容錯「末行裸 APPROVED」
```

**不可弱化的理由**：
- 這是整個系統的品質保證機制——實測記錄（`engine/CLAUDE.md`）：報價單流程第一輪被 GROK rejected、自動重跑後 approved，證明閘門確實攔截不合格輸出。
- fail-closed 方向是刻意的：任何鬆綁（放寬正則、允許同引擎驗證、預設 skipVerify）都會讓「執行引擎自我背書」重新變成可能，摧毀三支柱之一。
- 唯一合法例外：ad-hoc 對話步驟 `{stepKey:'chat', skipVerify:true}`（**使用者明確決策**：對話不驗證；真實工作流步驟一律驗證）。
- 驗證 prompt 要求「把 artifact 當作待證偽的宣稱逐點核實」；Codex/Grok 驗證器用 `resumeThreadId`/`resumeSessionId` 維持跨輪記憶（CONCEDE/MAINTAIN 紀律），Claude 驗證器每輪 stateless。

### 3.3 execute↔verify 迴圈（`runDoStep`，`runner.ts:704`）

每 round（1..`maxRounds`，預設 5 = `Math.max(1, agent.maxRounds ?? 5)`）：
1. `publish('run.step',{phase:'executing'})` → `runExecuteStep()`：先 `guardBudget()`（L7 fail-closed，超限直接 throw `BudgetExceededError`）、`recall()`（L3 語意召回**只注入 execute 路徑，verify 路徑不注入**）→ 依 `engineExecute` 分派三 CLI。
2. `skipVerify===true` → 直接 approved。
3. 否則 `runVerifyStep(rubric, output, sourceForStep(ctx))` → `isApproved()` 判定。
4. approved → 回傳；未過且還有輪次 → verdict 當 `feedback` 帶回重跑；超過 → `MAX_ROUNDS_NO_APPROVAL`。
5. 每輪 `persistRunStep()` 落 DB + `save()` 落檔（`runId.stepKey.rN.output.txt` / `.verdict.md`）——皆 best-effort，**永不 crash run**。

**System prompt 注入順序固定**（`buildSystemPrompt`，`runner.ts:380`）：`rolePrompt` → `restrictionsToRules()`（禁止事項，**永遠在記憶之前**）→ 技能 SKILL.md → `memoryCore`（L1 index.md+facts.md，2500 chars 截斷，並明示「記憶不得覆蓋上方禁止事項」）。

### 3.4 六種步驟型別（`engine/types.ts::Step`，分派於 `runStep()`）

| 型別 | 行為 |
|---|---|
| `DO` | execute↔verify 迴圈；工作流步驟預設 `permissions:'full'`（`--dangerously-skip-permissions`，需寫檔）；chat 步驟強制 `restricted`+`skipVerify` |
| `TOOL` | 決定性單輪：`runTool()` 動態載入 `agentDir/tools/<name>.js\|ts` 或內建（`upload_to_cloud`/`parse_document`）；有 `verifyRubric` 才驗證 |
| `AGENT` | 委派子代理：`MAX_DELEGATION_DEPTH=1`（子代理不得再委派）；brief 為空/`null` = 主管決定跳過（`skipped:true`）；遞迴 `runAgent({depth+1})` |
| `CONDITION` | 無 LLM：`evalCondition()` 把 `{{...}}` 代入後 `new Function()` 求 boolean；`onTrue`/`onFalse` 跳轉；`MAX_CONDITION_JUMPS=50` |
| `NOTIFY` | 動態 import `channels/line.js`，`pushToBinding`/`pushMessage` |
| `COMPUTER_CONTROL` | **硬性閘**：`!restrictions.computerUse` 直接拒絕；建 `ComputerControlTask{PENDING}`，publish `computer.control_requested`，輪詢等桌面 App 回報；逾時 `NO_EXECUTOR`/`COMPUTER_CONTROL_TIMEOUT` |

### 3.5 限制強制（`engine/restrictions.ts`）

- **提示層**：`restrictionsToRules()` → 中文「明確禁止事項」注入 system prompt。
- **CLI 旗標層**：`claudeDisallowedTools()` — `webSearch=false → ['WebSearch','WebFetch']`、`shell=false → ['Bash']`（`claude --disallowedTools`）；`grok --disable-web-search`；驗證器啟用網路時反而授予 `['WebFetch','WebSearch']` 供查證。
- **⚠️ 已知落差**：`shell`/`webSearch` 的 CLI 層強制**只覆蓋 CLAUDE_CODE（及 grok 的 webSearch）**，CODEX/GROK 執行路徑目前只有提示層（見 §7 engine finding 5）。
- **L6 沙盒（opt-in）**：`restrictions.sandbox.enabled` 時 `ensureSandboxProfile()` 產生 SBPL（`(deny default)` + 白名單），`sandbox-exec -f <profile>` 包住 CLI spawn；未開啟時零行為變動。

### 3.6 缺陷返工（on_fail，`runner.ts:1268`）

步驟失敗且有 `step.onFail`、`cycles < maxCycles`：`routeDefects()` → `callManagerDecision()` 由主管引擎決定送回哪些候選步驟重跑，之後帶 `reworkFeedback` 重驗失敗步驟本身；解析失敗保守全候選重跑；**`BudgetExceededError` 一律重新 throw，不吞**。⚠️ `callManagerDecision` 目前漏 GROK 分支（見 §7）。

### 3.7 觸發路徑總覽

```
conversations.ts::sendMessage ──命中關鍵字──→ workflow/runner.ts::runWorkflow
                              └─否則─→ engine::runAgent({message, history})（ad-hoc chat）
workflows.ts::kickOffRun（/run /test /hooks/:id webhook）──→ runWorkflow（預產 runId 後 unawaited）
scheduler::runWorkflowRunJob（cron 到點）──→ runWorkflow(workflowId, input, triggeredBy)  ← 位置參數！
runWorkflow ──durable=true──→ temporal/client::startDurableWorkflowRun → durableWorkflowRun
             │                （高風險等 approveSignal）→ runAgentActivity → runAgent(...,'temporal-durable')
             └─一般──→ engine::runAgent
```

觸發型別實際有 **5 種**：`manual` / `schedule` / `keyword` / `webhook` / `event`（根 CLAUDE.md 說「三種」是精簡描述，以程式碼為準）。

**真相來源階層**：Prisma/Postgres 是唯一真相；`MyAgent/` 磁碟工作區與 Qdrant 皆為**可從 DB 重建的衍生物**（materialize sha256 冪等；`reindexAgent()` 可整包重建）。

---

## 4. 資料模型、功能清單、REST 端點

### 4.1 Prisma schema（`aios-server/prisma/schema.prisma`，488 行）

**Enums（重點）**：`UserRole`(OWNER/TRAINER/MEMBER)、`Provider`(MICROSOFT/GOOGLE)、`Engine`(CLAUDE_CODE/CODEX/GROK)、`AgentStatus`(ACTIVE/PAUSED/ARCHIVED)、`SkillKind`(PROMPT_MANUAL/TOOL_MODULE/COMPUTER_CONTROL)、`SkillReview`(PENDING_UNDERSTANDING/AWAITING_USER_CONFIRM/CONFIRMED/REJECTED)、`ExecutionEnv`(CLI/DESKTOP_APP/DIRECT)、`StepType`(DO/TOOL/AGENT/CONDITION/NOTIFY/COMPUTER_CONTROL)、`RunStatus`(RUNNING/SUCCEEDED/FAILED/AWAITING_REVIEW/CANCELLED)、`ApprovalStatus`(PENDING/APPROVED/REJECTED)、`MessageRole`(USER/AGENT/SYSTEM)、`Channel`(LINE/TELEGRAM/SLACK/DISCORD，僅 LINE 已實作)、`BindingKind`(USER/GROUP/ROOM)、`AccountStatus`、`CloudRefKind`、`SkillOrigin`。

**Models（22 個，關鍵欄位）**：

| 區塊 | Model | 關鍵欄位 |
|---|---|---|
| 認證 | `User` | `role`(預設 OWNER)、`passwordHash`(argon2)、軟刪除 `deletedAt` |
| | `Session` | `tokenHash`(唯一)、`expiresAt`、`revokedAt` |
| 雲端 | `ConnectedAccount` | `accessTokenEnc`/`refreshTokenEnc`(AES-256-GCM)、`scopes[]`、`status` |
| | `CloudFileRef` | `externalId`+`path`+`kind`、`webUrl` |
| 員工 | `Agent` | `rolePrompt`、`engineExecute`/`engineVerify`(null=自動取相反引擎)、`restrictions`(Json)、`costPolicy`(Json: daily/monthly+hardStop)、`identityCard`(Json)、`riskTier`(low/medium/high)、`maxRounds`(預設5)、`department`(預設「未分類」)、軟刪除 |
| | `AgentSkill` / `AgentFileTarget` | 多對多關聯（後者含 `purpose`） |
| 技能 | `Skill` | `contentMd`、`kind`、`executionEnv`(COMPUTER_CONTROL 強制 DESKTOP_APP)、`understanding`(Json)、`reviewStatus` 狀態機、`stableVersionId`/`canaryVersionId`、軟刪除 |
| | `SkillVersion` | `contentHash`(sha256 內容定址)、`channel`(canary/stable/archived)；rollback=切 `stableVersionId` 指標 |
| 工作流 | `Workflow` | `trigger`(Json: 5 型)、`durable`(布林 opt-in Temporal；**REST body schema 尚未開放此欄位**)、`inputSchema`、軟刪除 |
| | `WorkflowStep` | `type`、`config`(Json)、`verifyRubric`、`onFail`(Json)；`(workflowId,position)`/`(workflowId,stepKey)` 唯一 |
| 執行 | `Run` | `workflowId` 可 null(ad-hoc chat)、`input`/`output`、`runDir`、`triggeredBy`(`user:*`/`test:*`/`webhook:*`/`chat:*`) |
| | `RunStep` | `round`、`verdict`+`approved`、`error` |
| | `ComputerControlTask` | `dispatchedTo`、`result` |
| HITL | `ApprovalRequest` | `runId` 唯一、`payload`(重派所需資訊)、`resumeToken`(⚠️ 目前無消費者)、`status` |
| 對話 | `Conversation` / `Message` | Message 可關聯 `runId` |
| 排程/管道 | `Schedule` | `timezone`(預設 Asia/Taipei)、`lastFiredAt`/`nextFireAt` |
| | `ChannelBinding` | `(channel,externalId)` 唯一 |
| 治理 | `CostLog` | 字元長度估算（CLI 不回真實 token）、`stepKey`(細分到步)、`costUsd`(Decimal 12,6) |
| | `AuditLog` | `prevHash`+`hash` sha256 串接雜湊鏈（附加式、tamper-evident；寫入用 `pg_advisory_xact_lock` 防分叉） |
| | `Lesson` | 執行訊號萃取的教訓（學習迴圈用） |
| | `MemoryDoc` | 索引中繼資料（**不存內文**，L1 markdown 才是真相）、`sourceType`、`sha256`、`chunkCount` |

### 4.2 功能清單（摘要）

員工全生命週期（含 `/compose` AI 生成）｜跨模型驗證閘｜限制引擎層強制｜技能建置（手動/上傳 .md/.zip/AI build/口述訓練，**一律人工確認才可掛載**）｜技能內容定址版本+rollback（lib 層備妥，無 REST）｜工作流 CRUD + 5 種觸發｜Temporal 耐久執行（opt-in）｜Run/RunStep 稽核｜對話（20 則歷史記憶、關鍵字轉工作流）｜HITL 高風險核准｜雜湊鏈稽核（`verifyAuditChain`）｜L7 成本控管（預算+hardStop+per-step 細分）｜身分卡治理｜記憶系統（wiki 瀏覽/語意搜尋/重建索引）｜Docling 文件解析｜L9 十燈號健康儀表板（**無資料回 unknown，絕不偽造綠燈**）｜OWNER/TRAINER/MEMBER 三級權限｜本機認證（首位註冊者=OWNER）｜Google/Microsoft/LINE 整合。

### 4.3 REST 端點總表（`src/routes/`；讀=`requireAuth`，寫=`requireTrainer`，另註明者除外）

| 檔案 | 端點 | 備註 |
|---|---|---|
| `agents.ts` | `GET/POST /api/agents`、`POST /api/agents/compose`(非同步)、`GET/PATCH/DELETE /api/agents/:id`、`POST/DELETE /api/agents/:id/skills[/:skillId]`(僅 CONFIRMED 可掛)、`PUT /api/agents/:id/file-targets`(transaction 全量替換) | 軟刪除；slug 含 ulid 尾碼 |
| `skills.ts` | `GET /api/skills[/:id]`、`PATCH /api/skills/:id`、`POST /api/skills`、`POST /api/skills/upload`(multipart .md/.zip，⚠️ Zip Slip 風險見 §7)、`POST /api/skills/:id/confirm|reject`、`POST /api/skills/build`(非同步) | COMPUTER_CONTROL 強制 DESKTop_APP；confirm/reject 缺 hub.publish |
| `workflows.ts` | `GET/POST /api/agents/:agentId/workflows`、`POST .../workflows/compose`、`GET/PATCH/DELETE /api/workflows/:id`、`PUT /api/workflows/:id/steps`(全量替換)、`POST /api/workflows/:id/run|test`、`POST /api/hooks/:id`(**免登入** webhook，`x-aios-secret` timing-safe 比對) | 建立/更新同步 `syncSchedule`，排程變更免重啟 |
| `runs.ts` | `GET /api/runs[?agentId&limit]`、`GET /api/runs/:id`、`POST /api/runs/:id/cancel` | cancel 僅對 RUNNING 生效 |
| `conversations.ts` | `GET/POST /api/agents/:agentId/conversations`、`GET/POST /api/conversations/:id/messages`；WS `chat.send` 共用 `sendMessage` | 背景執行，錯誤轉 SYSTEM 訊息不拋出 |
| `dashboard.ts` | `GET /api/dashboard/health|summary|recent-runs`、`GET /api/audit`、`GET /api/org`、`GET /api/users`+`PATCH /api/users/:id/role`(**僅 OWNER**) | `computeHealthMetrics` 純函式共用於測試 |
| `cost.ts` | `GET /api/agents/:id/cost`、`PUT /api/agents/:id/cost-policy` | 含 `getSpendByStep` |
| `approvals.ts` | `GET /api/approvals`、`POST /api/approvals/:id/approve|reject` | approve 依 payload 重派 `runAgent` |
| `identity.ts` | `GET/PUT /api/agents/:id/identity-card` | `parseIdentityCard`+完整度檢查 |
| `docparse.ts` | `GET /api/docparse/health`、`POST /api/docparse/file` | ⚠️ tmpDir 未清（§7） |
| `training.ts` | `GET /api/agents/:id/flows`(決定性清單)、`POST /api/agents/:id/train/message` | **絕不自動確認技能**（執行期斷言防護） |
| `auth.ts` | `GET /api/auth/status|me`、`POST /api/auth/register|login|refresh|logout` | 首位註冊者=OWNER |
| `health.ts` | `GET /api/health`、`GET /api/preflight` | 免登入；preflight 實跑 CLI `--version` |
| `memory.ts` | `GET /api/agents/:agentId/memory/files|file?path=`、`POST .../memory/search|reindex` | 路徑遍歷防護；未列於 routes/CLAUDE.md（文件落後） |
| `channels/routes.ts` | LINE webhook | 於 index.ts 另行註冊 |

### 4.4 WS 主題（AWP/1，單一端點 `/ws?token=`）

Envelope：`{v:1, id, kind: req|res|event|ping|pong|err, topic?, reqId?, seq?, ts, payload?}`。

`run.started` / `run.step`(phase: executing/verifying/approved/rejected/awaiting_review) / `run.log` / `run.finished` / `workflow.triggered` / `schedule.fired` / `chat.message`（**前端須用 `payload.conversationId` 過濾 `chat.*`，不是訂閱 `chat.<id>`**）/ `agent.status` / `approval.requested` / `skill.review_ready` / `computer.control_requested`。

斷線重連帶 `lastSeq` → `replay()`；超出 RING_CAP=1000 回 `RESUME_GAP`，前端改走 REST 補狀態。

---

## 5. 技術棧與基建

### 5.1 技術棧

- **Node >= 22，ESM**（`"type":"module"`）；開發 `tsx watch src/index.ts`，生產 `tsup`，型別檢查 `tsc --noEmit`。
- **fastify ^5.1**（+cors、+multipart）、**@prisma/client ^5.22** + PostgreSQL 16、**bullmq ^5.28** + ioredis、**@qdrant/js-client-rest ^1.18**、**@temporalio/* ^1.20**。
- 安全/工具：argon2、jose、zod、ulid、ws、cron-parser、xlsx、yaml。
- 雲端 SDK：`@googleapis/{drive,gmail}`、`google-auth-library`、`@azure/msal-node`。
- 前端：Next.js 14 App Router / React 18 / Tailwind 3 / @tanstack/react-query。
- macOS：SwiftUI（Xcode 26，Swift 6 `nonisolated`）。

### 5.2 Docker 服務（`web os system/docker-compose.yml`，全部只綁 127.0.0.1）

| 服務 | Image | Port | 用途 |
|---|---|---|---|
| `db` | postgres:16-alpine | `127.0.0.1:5433→5432` | 主資料庫（唯一真相） |
| `redis` | redis:7-alpine（appendonly, 256mb） | `127.0.0.1:6380→6379` | BullMQ 排程佇列 |
| `qdrant` | qdrant/qdrant | `6333/6334` | L3 語意索引（可重建）；資料在 `aios-data/qdrant_storage` |
| `docparse` | ghcr.io/docling-project/docling-serve-cpu | `127.0.0.1:5001` | L8 感知層：PDF/掃描件/表格 → Markdown/IR（`POST /v1/convert/file`，`to_formats=md`） |

**後端與前端跑在主機**（引擎需 spawn 主機 `claude`/`codex`/`grok` CLI、開 Codex.app）。

### 5.3 記憶模組（L1/L3）

- L1：`MyAgent/<dept>/<slug>/memory/wiki/` 磁碟 markdown = 真相來源。
- L3：Qdrant 向量索引，確定性 point-id（sha256 派生）天然冪等。
- **Embedding**：預設 provider=`openrouter`、model=`google/gemini-embedding-001`、dimension=3072；`EMBEDDING_PROVIDER=google` 時拿 `GEMINI_API_KEY` 直連備援。`MEMORY_ENABLED=false` 時所有記憶 I/O 為 no-op。
- **紅線**：`redactSecrets()` 在任何雲端 embed 前**無條件套用**，不受 `cloudEmbedding` 旗標影響；`cloudEmbedding=false` 時完全跳過 embed。

### 5.4 Temporal（opt-in）

- 位址 `localhost:7233`、taskQueue `aios-durable`（client/worker 硬寫兩份，未走 config.ts——已知債）。
- `Workflow.durable=true` → `startDurableWorkflowRun()` → `durableWorkflowRun`（高風險 `await condition(approveSignal)`）→ `runAgentActivity` → `runAgent(..., approvedApprovalId:'temporal-durable')`。
- **必須另跑 `npm run temporal:worker` 才會推進**（worker 直指 `.ts` 原始碼給 Temporal webpack bundler）。
- Temporal workflow 程式碼須確定性：no Date.now / random / direct IO，只能用 activities 與 Temporal API。
- ⚠️ 此路徑目前有嚴重缺陷（§7 風險 #1、#2），修好前**不要讓高風險 agent 掛 durable 工作流**。

### 5.5 開發時要跑的東西

```bash
cd "web os system" && docker compose up -d          # db/redis/qdrant/docparse
cd aios-server && npm run dev                        # tsx watch，8700
cd ../aios-web && npm run dev                        # 3100
# 需要 durable 工作流時：cd aios-server && npm run temporal:worker（另需本機 Temporal server）
```

---

## 6. 開發慣例與雷點（違反即出 bug 或破壞治理）

### 6.1 硬性慣例

1. **ESM import 一律帶 `.js` 副檔名**（原始碼是 `.ts`，import 路徑寫 `.js`）——整個 repo 慣例，含動態 import。
2. **CJS 套件的 ESM 匯入陷阱**：`cron-parser` 需取 default 再解構 `parseExpression`（具名匯出偵測不到）。
3. **Prisma 慣例**：查詢一律過濾 `deletedAt: null`（軟刪除）；`lib/db.ts` 單例；DB 是唯一真相，`MyAgent/` 與 Qdrant 是衍生物。
4. **`runWorkflow(workflowId, input, triggeredBy)` 是位置參數**——scheduler 曾因傳物件參數導致 Prisma crash（`scheduler/CLAUDE.md`/`workflow/CLAUDE.md` 皆註記），改簽章前先搜所有呼叫點。
5. **前端過濾 `chat.*` 事件用 `payload.conversationId`**，不是訂閱 `chat.<id>`（實測 bug 紀錄）。
6. **不要在 `next dev` 執行中跑 `next build`**（汙染 `.next` → 白畫面）。
7. 後端 `npm run start` 不熱重載；開發用 `npm run dev`。Node 在 `~/.local/node/bin`。
8. **`lazyoffice-system-main/` 唯讀**，絕不在內開發。
9. API Key 放各專案 `.env`，不進版控；OAuth token 一律 AES-256-GCM 加密落 DB。
10. 開發分工：**Grok 寫、Opus 審**（根 CLAUDE.md「Grok 開發、Opus 審查迴圈」），審查要附實跑證據（tsc/build/test）。

### 6.2 不可破壞的治理紅線

1. **驗證閘不可弱化**：不得放寬 `isApproved()` 正則、不得允許 `engineVerify === engineExecute`、不得對工作流步驟預設 `skipVerify`。chat 是唯一例外且是使用者明確決策。
2. **紅線 redactor 恆生效**：`redactSecrets()` 在任何雲端 embedding 前無條件套用——任何重構不得讓它變成可繞過。
3. **技能絕不自動確認**：所有生成路徑（build/upload/口述訓練/agents compose fan-out）一律停在 `PENDING_UNDERSTANDING`/`AWAITING_USER_CONFIRM`；`lib/skilltraining.ts:258` 有執行期斷言 `if (reviewStatus==='CONFIRMED') throw`——保留此類斷言。
4. **HITL 前置閘在任何引擎呼叫之前**：高風險 agent 未核准就 `AWAITING_REVIEW`，engine 一行都不跑。
5. **compose fan-out 不跳治理**：AI 生成的工作流 `enabled:false`、技能停在待確認。
6. **COMPUTER_CONTROL 硬性閘**：`!restrictions.computerUse` 直接拒絕；COMPUTER_CONTROL 技能伺服器端強制 `executionEnv=DESKTOP_APP`。
7. **儀表板誠實原則**：無資料來源的健康指標回 `unknown`+reason，**絕不偽造綠燈**。
8. **稽核鏈**：`AuditLog` 附加式雜湊鏈，寫入走 `pg_advisory_xact_lock`；`audit()` 失敗吞掉不擋主流程（fail-safe），但鏈本身續接嚴格（fail-closed）——兩種語意勿混。

### 6.3 fail-closed vs fail-safe 的分工（照抄既有模式）

| 方向 | 適用 | 範例 |
|---|---|---|
| **fail-closed**（有疑慮就擋） | 品質/安全/金錢閘門 | `isApproved()`、`guardBudget()` throw、`BudgetExceededError` 永不被吞（`routeDefects` 特別 re-throw）、webhook 缺 header 401、`evalCondition` catch→false、`VALID_STATUSES` 契約檢查 |
| **fail-safe**（失敗不擋主流程） | 附屬功能 | `save()`/`persistRunStep()` best-effort、記憶沉澱永不使 run 失敗、`startScheduler()` 永不 throw（Redis 掛了伺服器照開）、`audit()` 吞錯、embedding 失敗不擋 run/chat、NOTIFY 動態 import `.catch(()=>null)` |

新增功能時先問：這是閘門（fail-closed）還是附屬（fail-safe）？方向選錯就是 bug。⚠️ 已知反例：`agentAllowsCloudEmbedding` DB 失敗時 `return true`（fail-open，待修，§7）。

### 6.4 Opt-in 機制（預設關閉，開啟才生效）

- **L6 沙盒**：`restrictions.sandbox.enabled` → SBPL + `sandbox-exec`；未開啟零行為變動。
- **Temporal durable**：`Workflow.durable=true` + 必須跑 `temporal:worker`；REST 尚未開放此欄位（刻意或待補，改動前跟 Kevin 確認）。
- **SkillVersion**：schema/lib 備妥（`lib/skillversion.ts`），無 REST 端點；主路徑仍是 `Skill.contentMd`/`version`。

### 6.5 安全模式（新程式碼必須照抄）

- **Path-traversal 防護典範**：`memory/memoryService.ts::readWikiFile`（433-444）——`path.resolve` 後 `startsWith(root + path.sep)`（注意 `+ path.sep`，防同前綴不同目錄旁路）；`routes/docparse.ts` 的 `path.basename(filename)`；`engine/tools.ts` 的 `/\.\./.test(rel) || path.isAbsolute(rel)` 檢查。**任何接受使用者可控路徑/檔名/zip entry 的新程式碼都要套用**（已知兩處漏掉：`sanitizeDepartment`、skills.ts zip 解壓，見 §7）。
- **CLI spawn 一律陣列參數**，不拼字串（無 shell injection 面）。
- **webhook 密鑰**：進來即雜湊（明文不落地）、`timingSafeEqualStr` 常數時間比對。
- **非同步長任務模式**：先驗證 → 預產 id → 背景執行（unawaited + `.catch` 兜底）→ WS 通知；HTTP 立即回應。
- **純邏輯與 glue 分離**：`identitycard.ts`/`approval.ts::requiresApproval`/`audit.ts::computeAuditHash`/`dashboard.ts::computeHealthMetrics` 皆是「純函式可單測、Fastify/Prisma 膠水另放」的範例。

---

## 7. Code Review 摘要（2026-07，Standards + Fowler smells）

### 7.1 最高優先修（安全/正確性）

| # | 位置 | 問題 | 修法 |
|---|---|---|---|
| 1 | `routes/skills.ts` zip 上傳 | **Zip Slip**：`readZip()` entry name 未清洗，`writeSkillFile()` 直接 `path.join`——惡意 zip 可寫主機任意可寫路徑（後端跑在主機非容器） | 比照 `readWikiFile` 模式：resolve + `startsWith(skillRoot+sep)`，或拒絕含 `..`/絕對路徑 entry |
| 2 | `engine/materialize.ts::sanitizeDepartment` | **路徑穿越**：黑名單沒擋 `.`，`department=".."` 可讓 `materializeAgent()` 寫檔跳出 `MyAgent/` | 剔除純點號 segment，或算出 agentDir 後 `path.relative(paths.agents, agentDir)` 斷言不以 `..` 開頭 |
| 3 | `temporal/` durable+高風險 | **死結+閘門繞過雙重缺陷**：無任何 route 呼叫 `approveDurableRun()` 送 signal → 高風險 durable 工作流永久卡死；同時 `activities.ts` 硬寫 `approvedApprovalId:'temporal-durable'`（`requiresApproval` 只檢查 truthy，不驗真實 ApprovalRequest）→ 核准閘形同虛設。兩者互相掩蓋，修任一會暴露另一 | 短期：建立/啟用工作流時擋掉「durable+高風險」組合；長期：接上真正 Approval UI |
| 4 | `workflow/runner.ts:70` | durable 分支 `(await getDurableRunResult(rid)) as RunOutcome` **不安全轉型**——實際回傳無 `results`/`output`，關鍵字觸發的 durable 工作流在聊天會靜默回「(no output)」 | 讓 activity/workflow 序列化完整 RunOutcome 回來，不在呼叫端偽造型別 |
| 5 | `memory/` 雲端 embedding | 預設 OpenRouter + `cloudEmbedding` 預設 `true` + `agentAllowsCloudEmbedding` DB 失敗 fail-open `return true`——三者疊加與「不離地」白名單衝突 | 需 Kevin 決策：改 opt-in 或文件明載例外；`catch` 至少改 `return false` |

### 7.2 引擎層 findings（`engine/`）

- **`callManagerDecision` 漏 GROK 分支**（runner.ts:660-700）：GROK 員工觸發多候選缺陷路由時靜默改用 runClaude，成本也記錯帳。根因是 execute/verify/decide 三處 if-cascade 各自維護（Repeated Switches）→ 建議收斂成 `ENGINE_ADAPTERS: Record<Engine, {...}>` 單一 dispatch 表。
- **`buildAgentMd` 的 engineVerify 與 `compileManifest` 漂移**（materialize.ts:46）：忽略 `agent.engineVerify` 手動覆寫，agent.md frontmatter 會顯示錯誤驗證引擎 → 抽共用 `resolveEngineVerify(engineExecute, explicit)`。
- **`shell`/`webSearch` 限制 CODEX/GROK 路徑無 CLI 層強制**（restrictions.ts）：與根 CLAUDE.md「於引擎層強制」不符——補齊實作或更正文件。
- **`draft.ts` 的 `looseParseJson`/`stripFences` 與 runner.ts 同名不同演算法**（draft.ts 是天真 first-`{`-to-last-`}`，runner.ts 是配對平衡掃描；understand.ts 還有第三份）→ 抽 `engine/json.ts` 統一用嚴謹版。
- **`ctx.attempts` 只寫不讀**（死狀態）；**`evalCondition` 用 `new Function`**（目前信任邊界成立=trainer-only config，但 workflow/compose.ts 讓 LLM 產 step 後邊界會鬆動，建議換受限布林運算式解析器）；`runClaude`/`runClaudeStream` 大段重複。

### 7.3 routes/lib findings

- **`slugify`/`uniqueSlug`/`parseFrontmatter`/`writeSkillFile` 三份複製**（`routes/skills.ts` / `skills/build.ts` / `lib/skilltraining.ts`），且 frontmatter 解析兩種實作結果不一致（YAML.parse vs 手寫逐行）；**`slugify` 對純中文技能名全退化成 `'skill'`/`'skill-2'`**（產品技能名幾乎全中文）→ 抽共用模組 + 中文名改 ulid/雜湊 slug。
- `skills.ts` confirm/reject **缺 `hub.publish`**（前端只能輪詢得知結果）；`build.ts::resolveBuildExecutionEnv` 是閹割版（拿掉 kind 參數，失去 COMPUTER_CONTROL→DESKTOP_APP 強制能力）→ 直接呼叫真版 `resolveExecutionEnv`。
- **`skillversion.ts::promoteToStable` 與 `rollbackStable` 函式體完全相同**——若語意本同，去重；若本該不同（audit 語義），是未發現的功能缺陷，需跟需求方確認。`contentHash` 重造 `crypto.ts::sha256`。
- **`dashboard.ts::computeHealthMetrics` N+1**（每個有 costPolicy 的員工序列化打一次 `getSpend`，此端點會被前端輪詢）→ 批次查詢或 `Promise.all`。
- **`routes/docparse.ts` tmpDir 洩漏**（只 unlink 檔案不刪目錄）→ `rm(tmpDir,{recursive:true,force:true})`。
- `lib/approval.ts` 的 `resumeToken` 產生後**全 repo 無消費者**（死資料，疑為未來免登入核准連結預留）；`guard.ts::requireTrainer` 不必要的動態 import errors；`identitycard.ts` 欄位驗證重複可抽 helper；`memory.ts` 路由唯一沒手動包 try/catch（有全域 errorHandler 兜底，功能無恙但風格不一致）。

### 7.4 workflow/temporal/memory findings

- **`workflow/compose.ts` ⇄ `routes/workflows.ts` 循環 import**（compose 從 routes 拿 `TriggerSchema`/`normalizeTrigger`/`syncSchedule`，方向反了）；目前能跑是因為雙方只在函式體內引用（脆弱巧合）→ 把觸發正規化邏輯下移到 `workflow/trigger.ts`，恢復 `routes → workflow → engine` 單向依賴。
- **`syncSchedule` 同名不同簽章**：`routes/workflows.ts`(workflowId,trigger,enabled) vs `scheduler/index.ts`(scheduleId)，前者還呼叫後者 → scheduler 版建議改名 `syncScheduleJob`。
- `compose.ts` 手抄 `STEP_TYPES` 陣列（Prisma 已有 `StepType` enum；新步驟型別會被 `normalizeFlatStep` 靜默丟棄）→ `import type { StepType } from '@prisma/client'`；`draft.ts::DraftEngine` 同理用 Prisma `Engine`。
- `temporal/`：`startDurableRun`/`approveDurableRun`/`describeDurableRun`/`executeStepActivity`/`finishActivity`（`durableAgentRun` PoC 鏈）全 repo 無呼叫方=死碼；`TEMPORAL_ADDRESS`/`TASK_QUEUE` 硬寫兩份未走 config.ts。
- `skills/understand.ts::loadEngineFns` 優先從 `engine/index.js` 拿 `runClaude`/`runCodex` 的分支是**死碼**（index.ts 沒匯出）→ 正式匯出或刪掉假嘗試。
- `memory/redactor.ts` 的 13-19 位數正則會誤傷發票號/流水號（帳款掃描是旗艦案例）→ 加命中日誌觀察誤傷，長期用 Luhn 校驗。
- `memoryService.ts::recall`/`recallHits` 幾乎逐行重複 → 抽 `searchByQuery()`。
- `scheduler/index.ts` 的 `ERR_MODULE_NOT_FOUND` 防呆已過期（模組穩定存在）→ 可改靜態 import 讓 tsc 檢查位置參數簽章。

### 7.5 正面模式（新程式碼應延續）

fail-closed 判決 oracle 三層收斂｜`BudgetExceededError` 永不被吞｜best-effort 落檔/落 DB 註解明示「must never fail the run」｜`writeIfChanged` 冪等 vs `ensureAgentWiki` create-only 兩種語意有意識區分｜`MAX_DELEGATION_DEPTH=1` / `MAX_CONDITION_JUMPS=50` 有界遞迴｜HITL 閘在引擎前｜`readWikiFile` 的 `+path.sep` 前綴檢查｜稽核鏈 advisory lock 防分叉｜「不偽造綠燈」｜`staticCheckToolModule` 對抗 LLM 自我背書（正則掃 child_process/network 對照 LLM 自報）｜redactor 無條件雙層防護｜`VALID_STATUSES` 契約檢查 fail loudly｜純函式與 glue 分離｜非同步長任務「先驗證+預產id+背景跑+WS 通知」。

### 7.6 已知「schema 超前 API」落差（改動前先確認意圖）

- `Workflow.durable`：schema 有、runner 已分流，REST body schema 未開放。
- `SkillVersion`/`stableVersionId`/`canaryVersionId`：lib 邏輯完整，無 REST 端點。
- `Channel` enum 有 TELEGRAM/SLACK/DISCORD，僅 LINE 實作。
- 觸發型別文件說 3 種、程式碼 5 種（+event/webhook）。
- `routes/CLAUDE.md` 未列 `memory.ts`；`lib/identitycard.ts`、`lib/skillversion.ts`、`lib/skilltraining.ts`、`CostLog.stepKey` 尚無模組 CLAUDE.md 段落。

---

## 附：關鍵檔案絕對路徑速查

```
後端根：      /Users/kevin/Documents/aurion/web os system/aios-server/
  進入點：    src/index.ts
  設定：      src/config.ts
  引擎核心：  src/engine/runner.ts（runAgent/compileManifest/runDoStep）
  判決 oracle：src/engine/codex.ts（isApproved）
  限制：      src/engine/restrictions.ts
  成本閘：    src/engine/cost.ts
  具現化：    src/engine/materialize.ts
  Schema：    prisma/schema.prisma
  WS hub：    src/ws/hub.ts
  排程：      src/scheduler/index.ts
  記憶：      src/memory/memoryService.ts、redactor.ts、embedding.ts
  耐久：      src/temporal/{client,worker,workflows,activities}.ts
基建：        /Users/kevin/Documents/aurion/web os system/docker-compose.yml
前端根：      /Users/kevin/Documents/aurion/web os system/aios-web/
macOS App：   /Users/kevin/Documents/aurion/mac os system/
```


---

# Δ 本輪（2026-07-21 ~ 07-26）新增差異索引

> 完整說明見 [`/AGENTS.md`](../AGENTS.md)；決策見 [`/docs/adr/`](../docs/adr/)；用語見 [`/CONTEXT.md`](../CONTEXT.md)。

## 新增資料表 / 欄位
`ChangeProposal`（+`ProposalSource`/`ProposalStatus`/`ProposalTarget` enums）、`ApprovalRequest`（+`ApprovalStatus`）、`CostLog`（含 `stepKey`）、`SkillVersion`、
`Agent.costPolicy` / `Agent.riskTier` / `Agent.identityCard`、`AuditLog.prevHash`+`hash`、`Workflow.durable`、`SkillOrigin.RECORDED`。

## 新增 lib
`safepath.ts`（路徑守門）、`slug.ts`（CJK slug）、`changeproposal.ts`、`approval.ts`、`skillversion.ts`、`identitycard.ts`、`skilltraining.ts`、`codexmcp.ts`（MCP 客戶端）、`recording.ts`、`docparse.ts`、`engine/cost.ts`。

## 新增 route
`proposals.ts`、`training.ts`、`recording.ts`、`voice.ts`、`cost.ts`、`identity.ts`、`docparse.ts`、`approvals.ts`。

## 新增基建
docker `aios-docparse`（Docling，loopback:5001）、本地 `temporal server start-dev` + `src/temporal/*`（opt-in 耐久執行）。

## 本文件原 §7 提到的 5 個最高優先風險 — 現況
| 原風險 | 現況 |
|---|---|
| Zip Slip（skills.ts zip 上傳） | ✅ **已修**（entry 檢查 + `assertInsideRoot`），commit `9ac890b` |
| `sanitizeDepartment` 路徑穿越 | ✅ **已修**（剔除純點號 + `assertInsideRoot`），commit `b227f87` |
| durable+高風險 死結 + 假核准繞過 | ✅ **已修**（`isRunApproved` 查真提案；durable+high 於派工處 400 拒絕），commit `f4aa014` |
| durable 分支 `as RunOutcome` 不安全轉型 | ✅ **已修**（activity 回完整 RunOutcome），commit `f4aa014` |
| embedding fail-open | ✅ **已修**（`catch → return false`）＋雲端例外明載，commit `f4aa014` `bb69b81` |

其他本文件點名的問題：`callManagerDecision` 漏 GROK 分支 ✅ 已補（引擎派工收斂為 `ENGINE_ADAPTERS`）；slugify 中文退化 ✅ 已修（共用 `lib/slug.ts`）。

## 尚未解決（見 `/AGENTS.md` §10）
Computer Use 實際 `tools/call` timeout（需 Codex App 脈絡）、錄製→技能未端對端實測、`approveProposal` 的 RESTRICTION merge 需加白名單、`Lesson` 死 schema 待清、sandbox 無資源配額。
