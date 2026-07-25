# AGENTS.md — Aurion AIOS 交接文件（給 Codex / 任何協同 AI）

> **這份是給「接手開發的 AI」看的權威現況文件**（Codex 讀 `AGENTS.md`，Claude 讀 `CLAUDE.md`；兩者內容以本檔為最新）。
> 最後更新：2026-07-26。對應分支 `feat/agentic-os-p0-p1`（19 commits，已 push、PR 已開）。
> 用語與領域模型見 [`CONTEXT.md`](CONTEXT.md)；架構決策見 [`docs/adr/`](docs/adr/)。

---

## 0. 你接手前必讀的 5 條紅線（違反即是 bug）

1. **跨模型驗證閘不可弱化**：執行引擎 ≠ 驗證引擎，於 `compileManifest()` 載入時強制（`autoVerify` 取對面）；判決 oracle `isApproved()` 是 **fail-closed**（`REJECTED_RE` 先於 `APPROVED_RE`）。任何改動都要證明零回歸。
2. **安全與成本是硬約束，不靠模型自覺**：限制與預算在**程式碼層攔截**（throw／拒絕），不是只在 prompt 寫「請不要」。判不準時一律**拒絕**（fail-closed）。
3. **紅線 redactor 永遠生效**：任何記憶／技能／稽核內容落地前一律經 `redactSecrets()` 遮罩密鑰與個資，不受任何旗標影響。
4. **技能永不自動確認**：新／改的 Skill 一律停在 `AWAITING_USER_CONFIRM`，只有 **FDE**（`TRAINER`/`OWNER`）人工確認才 `CONFIRMED` 並可掛載。
5. **變更生效唯一路徑是 FDE**：操作者（`MEMBER`）只能**提案**（`ChangeProposal`），不能讓任何變更生效。

**fail-closed vs fail-safe 的分工**（新增功能前先問自己是哪一種）：
- **閘門類**（限制、預算、核准、路徑守門）→ **fail-closed**：出錯就拒絕。
- **附屬類**（記憶沉澱、成本記錄、越矩提案、文件解析）→ **fail-safe**：出錯只 log，**絕不可**讓 run 失敗。

---

## 1. 這個系統是什麼

**AIOS = 本地優先（local-first）的多代理「AI 員工」作業系統**。每個 Agent 是一位員工：有身分卡、掛載技能（Skill）、配置工作流（Workflow）、有長期記憶、有獨立沙盒與成本上限，由三個**本機 CLI 引擎**執行，並由跨模型驗證閘把關輸出。

**三支柱**
| 支柱 | 內容 |
|---|---|
| 三引擎 | `CLAUDE_CODE`（主力執行）、`CODEX`（程式類／交叉驗證／電腦操控）、`GROK`（檢索與草擬最快） |
| 跨模型驗證閘 | 執行 ≠ 驗證，載入時強制；fail-closed 判決；驗證器可跨回合續命 |
| 引擎層限制 | `webSearch / computerUse / sendEmail / cloudWrite / shell / cloudEmbedding / sandbox` 於程式碼層攔截 |

**在地優先邊界**：DB／Redis／Qdrant／Docling 四個 docker 服務全部只綁 `127.0.0.1`；後端與前端**必須跑在主機**（引擎要 spawn 主機 CLI）。
**兩個刻意的雲端例外**（已在文件明載，不得擴大）：① 記憶 embedding 走 OpenRouter；② 語音轉錄走 OpenAI Whisper。

---

## 2. 專案佈局

| 路徑 | 屬性 | 說明 |
|---|---|---|
| `web os system/aios-server/` | ✅ 主線後端 | Fastify 5 + Prisma + BullMQ，跑主機 `127.0.0.1:8700` |
| `web os system/aios-web/` | ✅ 主線前端 | Next.js 14 App Router，`127.0.0.1:3100`，`/api/*` rewrite 到 8700 |
| `web os system/docker-compose.yml` | ✅ 基建 | postgres:5433 / redis:6380 / qdrant:6333 / **docparse:5001** 皆 loopback |
| `mac os system/` | ✅ 主線 | SwiftUI App：原生前端 + 主機執行器（電腦操控橋接） |
| `web os system/aios-mcp/` | ✅ | 把我們的 REST 暴露成 **MCP server** 供 Claude/Codex 呼叫（我們當供給方）|
| `MyAgent/` · `aios-data/` | 執行產物 | 員工工作區、runs/skills/qdrant 儲存（可重建）|
| `agentic-os/` | 文件 | L0–L9 重構方向、系統總覽、規格 |
| `lazyoffice-system-main/` | ❌ 唯讀參考 | **絕對不要在此開發** |

**每個模組都有自己的 `CLAUDE.md`**（`aios-server/`、`src/`、`src/engine/`、`src/routes/`、`prisma/` 等）——那些是**模組級細節的權威來源**，請一併讀。

---

## 3. 核心執行流（`src/engine/runner.ts`，系統心臟）

```
runAgent(opts)
 1. 找 Agent
 2. HITL 前置閘：requiresApproval(riskTier, alreadyApproved)
    → riskTier==='high' 且未真核准 ⇒ 建 Run{AWAITING_REVIEW} + ApprovalRequest，直接 return（不碰引擎、不燒錢）
    ※ 「真核准」＝ isRunApproved() 查 DB 有 status='APPROVED' 的 ApprovalRequest（**不是**傳個字串就算）
 3. materializeAgent → MyAgent/<dept>/<slug>/（agent.md、CLAUDE.md、skills/、memory/wiki、sandbox profile）
 4. 建 Run{RUNNING}
 5. compileManifest（**此處強制 execute≠verify**）
 6. 同步雲端檔 → data/cloud-files.md（PDF/docx/圖片經 Docling 解析）
 7. 逐步 runStep()：DO / TOOL / AGENT / CONDITION / NOTIFY / COMPUTER_CONTROL
      每步：guardBudget（fail-closed）→ execute → verify（對面引擎）→ recordCost
      不過關 → 重跑至 maxRounds → routeDefects／經理決策
 8. 收尾：Run 狀態、WS run.finished、記憶沉澱（best-effort，失敗不影響 run）
```

**引擎派工已收斂為單一對照表** `ENGINE_ADAPTERS: Record<Engine, EngineAdapter>`（`execute`/`verify`/`decide` 三條路徑共用）。新增引擎只改這張表。

---

## 4. 完整資料模型（24 models / 19 enums）

**核心**：`User`(OWNER/TRAINER/MEMBER) · `Session` · `Agent` · `Skill` · `Workflow` · `WorkflowStep` · `Run` · `RunStep` · `Conversation` · `Message` · `Schedule`
**治理**：`ApprovalRequest`（HITL）· **`ChangeProposal`**（提案佇列）· `AuditLog`（**hash chain**）· `CostLog`（**含 stepKey**）
**技能**：`SkillVersion`（內容定址 + stable/canary）· `AgentSkill`（掛載）
**其他**：`ConnectedAccount` · `CloudFileRef` · `AgentFileTarget` · `ComputerControlTask` · `MemoryDoc` · `ChannelBinding` · `Lesson`（**死 schema，未使用，待刪**）

**`Agent` 的治理欄位**：`restrictions(Json)`、`costPolicy(Json)`、`riskTier`、`identityCard(Json)`、`engineExecute`/`engineVerify`
**慣例**：enum 必須**多行**書寫；欄位註解用 `///`；改 schema 後 `npx prisma migrate dev --name <desc>` + `generate`；**不可手改既有 migration**；金額用 `Decimal`（禁 Float）。

---

## 5. REST 端點（17 個 route 檔）

| 檔 | 端點 | 權限 |
|---|---|---|
| `agents.ts` | 員工 CRUD、掛/卸技能（**掛 RECORDED/COMPUTER_CONTROL 技能時強制 engineExecute=CODEX**）| trainer |
| `skills.ts` | 技能 CRUD、`upload`（**zip 已加 Zip Slip 守門**）、`confirm`/`reject`、`build` | trainer |
| `workflows.ts` | 工作流 CRUD、觸發設定（**`durable` 旗標**）| trainer |
| `runs.ts` · `conversations.ts` · `memory.ts` · `dashboard.ts` | 執行、對話、記憶、總覽（**含 `/api/dashboard/health` 十大燈號**）| auth |
| `approvals.ts` | HITL：列出待審 run／approve（帶 resumeToken 續跑）／reject | trainer |
| **`proposals.ts`** | `POST /api/agents/:id/proposals`（**auth**，MEMBER 可提案）／`GET /api/proposals`／`approve`／`reject`（**trainer**）| 混合 |
| **`training.ts`** | `GET /api/agents/:id/flows`（**免 LLM**）／`POST /api/agents/:id/train/message`（口述訓練→草稿） | auth／trainer |
| **`recording.ts`** | 錄製 `start`／`status`／`stop`／`POST /api/agents/:id/recording/to-skill` | trainer |
| **`voice.ts`** | `POST /api/voice/transcribe`（OpenAI whisper-1 → redact） | trainer |
| **`cost.ts`** | 成本查詢（含 `byStep` 明細）／設定預算政策 | trainer |
| **`identity.ts`** | 身分卡 GET／PUT | auth／trainer |
| **`docparse.ts`** | 文件解析服務健康檢查 | auth |
| `auth.ts` · `health.ts` | 登入／refresh、健康 | — |

回應一律走 `lib/http.ts` 的 `ok()` / `sendError()`；守門用 `lib/guard.ts` 的 `requireAuth` / `requireTrainer`。

---

## 6. 共用 lib（17 個，寫新功能前先看有沒有現成的）

| 檔 | 用途 |
|---|---|
| `safepath.ts` | **路徑守門**：`assertInsideRoot`（`resolve` + `startsWith(root+sep)`，防同前綴旁路）／`safeJoin`／`sanitizeSegment`。**任何接受外部路徑/檔名/zip entry 的新程式碼都要用它** |
| `slug.ts` | **CJK-aware slugify**（保留中日韓字元；空結果回穩定短雜湊，永不空） |
| `changeproposal.ts` | 提案：`createProposal`／`listPendingProposals`／`approveProposal`／`rejectProposal`／**`recordViolation`**（fail-safe + 去重） |
| `approval.ts` | HITL：`requiresApproval`／**`isRunApproved`（查真 ApprovalRequest）**／`createApproval`／`decideApproval` |
| `skillversion.ts` | 內容定址版本：`createSkillVersion`（同 sha256 回既有版本）／`promoteToStable`／`rollbackStable`（切指標不刪版本） |
| `identitycard.ts` | `parseIdentityCard`（正規化）／`checkIdentityCard`（出廠檢查） |
| `skilltraining.ts` | `listAgentFlows`（決定性、免 LLM）／`draftSkillFromMessage`（走 understand 閘） |
| `codexmcp.ts` | 手寫 stdio JSON-RPC **MCP 客戶端**（零依賴）：`connectComputerUse`／`connectEventStream`／`assertToolsPresent` |
| `recording.ts` | 錄製起停 + `buildSkillFromRecording`（**委派 Codex 自產技能**）+ `importSkillFromMarkdown` |
| `docparse.ts` | 本地 Docling：`parseDocumentFile`／`docparseHealthy` |
| `filecontext.ts` | `fileToText`（試算表→表格／PDF·docx·圖片→Docling／其餘 utf8） |
| `audit.ts` | **hash chain 稽核**：`computeAuditHash`／`verifyChain`／`verifyAuditChain`／`backfillAuditChain`（pg advisory lock 序列化） |
| `db.ts` · `auth.ts` · `crypto.ts` · `guard.ts` · `http.ts` | Prisma 單例、argon2+jose、AES-256-GCM、權限、回應信封 |

`src/engine/cost.ts`：`estimateTokens`／`priceUsd`／`decideBudget`（純函式）／`guardBudget`（fail-closed）／`recordCost`／`getSpendByStep`。

---

## 7. 治理模型（本輪的核心產物）

```
操作者(MEMBER) ──提案──┐
系統硬攔截 ──violation──┤──→  ChangeProposal 佇列  ──FDE(TRAINER/OWNER)審核──→ 核准：產生 SkillVersion／更新限制／身分卡（可回滾）
驗證閘語意審查 ─semantic┘                                                    駁回：目標物零變動
```
- **越矩偵測雙軌**：
  - **硬攔截即訊號**（決定性、免 LLM）：`computerUse` 硬拒、`upload_to_cloud`(cloudWrite) throw、`BudgetExceededError` → `recordViolation()`
  - **語意層**：驗證閘 prompt 追加 `## Overstep NONE|LOW|HIGH`（**不影響 APPROVED 判決**）→ `parseOverstep()` → **僅 HIGH** 建提案（噪音控制）
- **⚠️ 偵測不到的（不要假造）**：`shell`/`webSearch` 由 claude `--disallowedTools` 在**子行程內**封鎖；沙盒是 **OS 層 EPERM** —— 我們的 process 看不到嘗試。

---

## 8. 開發與執行

```bash
docker compose up -d                    # postgres/redis/qdrant/docparse（web os system/）
cd aios-server && npm run dev           # 後端 8700（tsx watch，會熱重載）
cd aios-web && npm run dev              # 前端 3100
npm run temporal:worker                 # 只有 Workflow.durable=true 才需要
temporal server start-dev               # 耐久執行用（loopback；未進 compose，重開機要重跑）
```
**雷點**
- Node 在 `~/.local/node/bin`。ESM：**相對 import 必須帶 `.js`**。
- 後端 `npm run start` **不會**熱重載；開發用 `npm run dev`。
- **不要在 `next dev` 執行中跑 `next build`**（汙染 `.next` → 白畫面；解法 `rm -rf .next`）。
- 金鑰在 `web os system/.env`（**已 gitignore、未追蹤**；`aios-server/.env` 是符號連結）。
- 測試典範：**臨時 `.ts` 腳本 + `npx tsx` + 真 DB/真服務 + 用完清理**（不是 vitest）；測試放 `.scratch/<feature>/tests/`。安全項一律加**負向測試**。

---

## 9. 本輪已完成（19 commits，全部有實跑驗證）

| 主題 | 內容 | commit |
|---|---|---|
| P0 止血 | 成本帳本 fail-closed 預算／`shell` 預設關 + 硬攔截／HITL 復活 | `3334d61` |
| P1 | AuditLog hash chain（backfill 302 列）／十大健康燈號／opt-in sandbox-exec 寫入圍籬 | `3334d61` `7daf506` |
| P2 基建 | Temporal 耐久執行（實測殺 worker→重啟仍續跑）／Docling 文件解析容器 | `c0d5670` `7193119` |
| 整合 | Docling 接進檔案讀取管線／`Workflow.durable` 走 Temporal | `cd1cdcc` `8be15d3` |
| 技能治理 | 內容定址版本 + rollback／身分卡 schema | `059c9ca` `ee5d9aa` |
| 成本 | `CostLog.stepKey` 每步/每功能用量 | `476f1c1` |
| 口述訓練 | 後端（對話建 Skill + 問流程） | `7e83d80` |
| **安全修正** | 假核准後門關閉／durable+高風險 fail-closed／embedding fail-closed／**部門路徑穿越**／**Zip Slip**／引擎派工收斂 + 補 GROK decide／CJK slug | `f4aa014` `b227f87` `9ac890b` |
| **技能工廠治理** | `RECORDED` 來源 + CODEX 掛載閘／`ChangeProposal` 兩層授權佇列 | `cd3ca20` |
| **越矩偵測** | 硬攔截→自動提案（去重、fail-safe）／語意越矩審查 | `faa89d3` |
| **Codex 整合** | Computer Use MCP 橋接／錄製→技能（**委派 Codex 自產**） | `b5f7297` |
| **前端** | 聊天式技能工廠（訓練 tab）＋語音轉錄／**FDE 提案審核頁** | `866d8cc` `0c5deee` |

---

## 10. ⚠️ 已知限制與下一步（接手前務必知道）

1. **Computer Use 實際執行未通**：`computer-use` MCP 握手與 `tools/list`（10 工具）正常，但**真的 `tools/call` 會 timeout**（`codex exec` 也卡 10 分鐘無回應）。研判需 **Codex/ChatGPT App UI 端確認**或特定授權脈絡。詳見 `docs/adr/0005`。
   - MCP 位置：`~/.codex/computer-use/Codex Computer Use.app/.../SkyComputerUseClient mcp`
   - 錄製：`~/.codex/.tmp/bundled-marketplaces/openai-bundled/plugins/record-and-replay` → `./bin/computer-use-client-launcher event-stream mcp`（3 個無參數工具）
   - **「把錄製變成 Skill」不是 MCP 工具**，是 Codex 自己的 `record-and-replay` + `~/.codex/skills/.system/skill-creator` 行為 → **我們委派，不自寫翻譯器**。
2. **錄製→技能未端對端實測**（因為 1）；匯入階段已驗證（`origin=RECORDED`、停在待確認、redactor 生效）。
3. **`approveProposal` 對 RESTRICTION 提案是整包 merge** → 非限制欄位（如 `note`）會寫進 `restrictions`。功能無害（`parseRestrictions` 忽略未知鍵）但**建議加白名單**。
4. **`Lesson` 表是死 schema**（零使用）→ 可刪或併入 `ChangeProposal`。
5. **sandbox 只做寫入圍籬**，無 CPU/記憶體配額；claude-in-sandbox 尚未 live 驗證。
6. **語意越矩的 severity 門檻**目前是實作預設，尚未依真實資料調校。
7. 未做：Browser Use 整合、本地 Whisper、多租戶/計費、消費外部 MCP 的 gateway。

---

## 11. 協同開發規範

- **執行與審查分離**（延續跨模型驗證閘精神）：寫碼與驗收不要同一個模型。本輪是 **Grok 寫 → Opus 審**（實跑 `tsc`/`build`/測試才算過）。
- **驗收要有實跑證據**，不接受「我覺得沒問題」。安全項要負向測試（惡意輸入必須失敗）。
- **發現 Bug → 修 → 從頭重測**直到通過。
- 規格與票的產出流程：`/grill-with-docs`（決策）→ `to-spec`（規格）→ `to-tickets`（垂直切片票）→ TDD 開發。產物在 `aios-server/.scratch/<feature>/`。
- **不要動他人未提交的 WIP**；若同檔不可避免，最小外科手術改動，並在提交訊息說明。
