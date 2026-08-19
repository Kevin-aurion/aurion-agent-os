# 票 01 — Cherry Companion Client 安全 Spike 報告

**日期：** 2026-08-08
**環境：** `http://127.0.0.1:8700`（dev watch）+ 真 Postgres `127.0.0.1:5433/aios`
**Node：** v22.23.2
**對應票：** `.scratch/aios-client-langflow-platform/issues/01-cherry-companion-spike.md`
**測試產物：**
- `.scratch/aios-client-langflow-platform/tests/t01-builder-scope-negative.test.ts`
- `.scratch/aios-client-langflow-platform/tests/t01-builder-scope-positive.test.ts`

本報告僅依 `spec.md` 公開行為描述與本次 live HTTP／真 DB 實測撰寫；**未讀取、未引用** Cherry Studio 原始碼、資產、CSS 或文案。

---

## 1. 目的與範圍

### 目的

驗證既有 **Remote MCP builder profile**（OAuth scope = `aios:agent-builder`）在真實伺服器上的安全邊界：

1. **只能**建立惰性 shadow draft（`AgentBuildSession` / `AgentBuildIteration`），最終停在 `AWAITING_FDE`。
2. **絕不能** confirm Skill、approve ChangeProposal、寫入 MCP registry、或做 Agent CRUD（含列表讀取）。
3. 負向請求必須 **HTTP 403**，且 DB 對正式物件與 fixture 狀態**零變更**。
4. 產出乾淨室 Workbench 設計輸入與「仍需真 Cherry GUI 完成」的 browser handoff 清單。

### 範圍內

| 項目 | 方式 |
|---|---|
| 真 scoped token | 完整 OAuth 2.1 DCR → authorize → login/consent → token（PKCE S256 + resource audience） |
| 對照 scoped token | `signAccess` 直簽（同 scope + audience），兩組都跑負向矩陣 |
| 負向矩陣 | confirm / approve / MCP write / Agent CRUD / GET agents / POST skills |
| 正向路徑 | external session → external-snapshot → submit-review → FDE evolution-queue |
| 零變更證明 | Prisma 計數 + fixture 欄位 before/after |

### 範圍外（本票不完成）

- 真 Cherry Studio GUI 的 OAuth 授權旅程與一輪建立 AI 員工對話 UX。
- 截圖／GIF 記錄。
- 任何 production source（`src/`、`prisma/`、`aios-mcp`）修改。

---

## 2. 安全驗證結果（實跑數字）

### 2.1 環境與驗收指令

```text
export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
node -v
# v22.23.2

npx tsx .scratch/aios-client-langflow-platform/tests/t01-builder-scope-negative.test.ts
# exit 0 — summary: ALL PASS

npx tsx .scratch/aios-client-langflow-platform/tests/t01-builder-scope-positive.test.ts
# exit 0 — summary: ALL PASS

npx tsc --noEmit
# exit 0
```

### 2.2 A — 負向矩陣（`t01-builder-scope-negative.test.ts`）

**身分：** MEMBER `member@aios.test`（OAuth 取得真 scoped token；另附 signAccess 對照）
**Resource audience：** `https://aios-mcp.lazyoffice.app/mcp`
**Fixture：** agent slug `t01-spike-agent`、skill slug `t01-spike-skill`、PENDING ChangeProposal

#### DB 基線 → 矩陣後（完全相同）

| 指標 | 基線 | 矩陣後 | 結果 |
|---|---:|---:|---|
| `agent.count` | 2 | 2 | 未變 |
| `skill.count` | 1 | 1 | 未變 |
| `workflow.count` | 0 | 0 | 未變 |
| `changeProposal.count` | 1 | 1 | 未變 |
| `mcpServerRegistry.count` | 0 | 0 | 未變 |
| fixture skill `reviewStatus` | `AWAITING_USER_CONFIRM` | `AWAITING_USER_CONFIRM` | 未變 |
| fixture proposal `status` | `PENDING` | `PENDING` | 未變 |
| fixture agent `name` | `T01 Spike Agent` | `T01 Spike Agent` | 未變 |
| fixture agent `deletedAt` | `null` | `null` | 未刪 |
| fixture agent `updatedAt` | `2026-08-07T20:15:11.745Z` | `2026-08-07T20:15:11.745Z` | 未變 |

> 註：基線 `agent.count=2` 含 fixture + 環境中既有 1 個 agent；測試結尾只刪 fixture（slug 識別），不刪 users／其他資料。

#### HTTP 負向矩陣（oauth 與 signAccess 結果一致）

| 請求 | 期望 | oauth 實得 | signAccess 實得 | 回應訊息（實測） |
|---|---|---|---|---|
| `POST /api/skills/:id/confirm` | 403 | **403** | **403** | Scoped OAuth tokens cannot perform FDE actions |
| `POST /api/proposals/:id/approve` | 403 | **403** | **403** | Scoped OAuth tokens cannot perform FDE actions |
| `POST /mcp/servers` | 403 | **403** | **403** | Scoped OAuth tokens cannot perform FDE actions |
| `POST /api/agents` | 403 | **403** | **403** | Scoped OAuth tokens cannot perform FDE actions |
| `PATCH /api/agents/:id` | 403 | **403** | **403** | Scoped OAuth tokens cannot perform FDE actions |
| `DELETE /api/agents/:id` | 403 | **403** | **403** | Scoped OAuth tokens cannot perform FDE actions |
| `GET /api/agents` | 403 | **403** | **403** | This OAuth token is restricted to Agent Builder APIs |
| `POST /api/skills` | 403 | **403** | **403** | Scoped OAuth tokens cannot perform FDE actions |

所有 403 回應 **均無** `success: true` 的成功 data 包絡。

#### 對照組（證明 403 是 scope，不是路由不存在／未登入）

| 請求 | Token | 實得 |
|---|---|---|
| `GET /api/agents` | OWNER unscoped（login） | **200** |
| `GET /api/auth/me` | MEMBER OAuth scoped | **200** |

**結論 A：** 八類禁止操作全數 fail-closed 於 403；正式物件與 fixture 狀態零變更。PASS。

### 2.3 B — 正向影子草稿（`t01-builder-scope-positive.test.ts`）

**身分：** 同 MEMBER 真 OAuth scoped token
**流程：** external session → external-snapshot → submit-review → OWNER 看 evolution-queue

| 步驟 | 端點 | HTTP | DB／狀態斷言 | 結果 |
|---|---|---|---|---|
| 1 | `POST /api/agent-builder/external/sessions` | **200** | 出現 `AgentBuildSession`，`userId = member`，初始 `status = DISCOVERY` | PASS |
| 2 | `POST /api/agent-builder/sessions/:id/external-snapshot` | **200** | `AgentBuildIteration` count ≥ 1（externalEventId=`t01-spike-snapshot-001`） | PASS |
| 3 | `POST /api/agent-builder/sessions/:id/submit-review` | **200** | session `status === AWAITING_FDE` | PASS |
| 4 | 正式物件計數 | — | agent/skill/workflow **與基線相同** | PASS |
| 5 | `GET /api/agent-builder/evolution-queue`（OWNER） | **200** | 回應 body 含該 `sessionId` | PASS |

#### 正式物件計數（shadow draft 不產生 Agent／Skill／Workflow）

| 指標 | 基線 | 正向流程後 | 結果 |
|---|---:|---:|---|
| `agent.count` | 1 | 1 | 未變 |
| `skill.count` | 0 | 0 | 未變 |
| `workflow.count` | 0 | 0 | 未變 |

**結論 B：** scoped token 可走完建立影子草稿並進入 FDE 佇列；正式 registry 零成長。PASS。

### 2.4 未如預期的行為

**本次實跑無未如預期行為。** 所有負向路由皆為 403（非 401／404／500）；無任一斷言被弱化或略過。

附註（行為分層，非失敗）：

- `requireTrainer` 路由在 scope 存在時優先回「cannot perform FDE actions」。
- 僅 `requireAuth`、且不在白名單前綴的路由（如 `GET /api/agents`）回「restricted to Agent Builder APIs」。
- 兩者皆 403 fail-closed，語意正確。

---

## 3. Scoped token profile 行為描述

### 3.1 `assertScopedRoute`（`src/lib/guard.ts`）

當 access claims 帶有 `scope` 時：

- 僅當 `scope === 'aios:agent-builder'` **且**
  `route === '/api/auth/me'` **或** `route.startsWith('/api/agent-builder/')` 才放行。
- 其餘一律 `403 Forbidden`：`This OAuth token is restricted to Agent Builder APIs`。

掛在 `requireAuth` 上，故所有需登入但非 trainer 專屬、又不在白名單的 API 都會被擋（含 `GET /api/agents`）。

### 3.2 `requireTrainer` 對 scoped token fail-closed

```text
if (req.user.scope) throw forbidden('Scoped OAuth tokens cannot perform FDE actions')
```

FDE 動作（confirm skill、approve proposal、Agent CRUD 寫入、MCP registry 寫入等）在進入業務邏輯前即拒絕。
即使 token 的 `role` 字串是 OWNER，**有 scope 仍不可當 FDE**。

### 3.3 Audience 綁定（`src/lib/auth.ts` + OAuth token）

- 有 `scope` 的 token **必須** `audience === config.remoteMcp.resourceUrl`（預設 `https://aios-mcp.lazyoffice.app/mcp`）。
- 缺 audience 或 audience 不符 → `verifyAccess` 失敗（401 Invalid or expired token）。
- Web login unscoped token 刻意無 audience；兩者不可混用。

### 3.4 OAuth 發行路徑（`src/routes/mcpoauth.ts`）

實測完整鏈路（對齊 `.scratch/remote-mcp/tests/oauth-e2e.ts` 模式）：

1. `POST /oauth/register`（DCR，loopback redirect）→ 201 + `client_id`
2. `GET /oauth/authorize`（PKCE S256 + `scope=aios:agent-builder` + `resource`）→ HTML + 簽名 ticket
3. `POST /oauth/authorize`（email/password consent）→ 302 + `code`
4. `POST /oauth/token`（code + verifier + resource）→ 200 + access_token

本票測試**禁止**以 `signAccess` 取代 OAuth 作為通過路徑；`signAccess` 僅作附加對照組，結果與真 OAuth 一致。

### 3.5 安全模型一句話

> **Remote MCP builder token = MEMBER 有效角色 + 路由白名單 + 禁止 FDE + 綁定 MCP resource audience。**
> 產物只能是 inert `AgentBuildSession` 影子草稿，生效唯一路徑仍是 FDE。

---

## 4. 乾淨室設計輸入（公開行為 × AIOS 對應）

僅依 `spec.md` 公開行為與本次 API 實測整理；**不引用 Cherry 任何素材**。下列是 Workbench V2 值得吸收的互動模式，以及 AIOS 既有／規劃中的對應。

| 公開行為模式 | 使用者價值 | AIOS 資料模型 | AIOS 端點／事件 |
|---|---|---|---|
| **Thread／工作緒** | 選員工後延續同一任務上下文 | `Conversation` + `Message`；Builder 用 `AgentBuildSession.transcript` | `GET/POST /api/conversations…`；Builder `GET /api/agent-builder/sessions`、`/sessions/latest`；WS AWP/1 即時 |
| **雙模式 Composer** | 「交代工作」vs「教它新工作」語意分離 | 工作：`Run`；教學：`Skill`（`AWAITING_USER_CONFIRM`）或 `ChangeProposal` / `AgentBuildSession` | 工作：`POST` run／conversation message；教學：`/api/agents/:id/train/message`、`/api/agent-builder/…` |
| **Artifact 側欄** | 檢視輸出與草稿產物 | Builder：`AgentBuildIteration.artifactSnapshot`；執行：Run output／未來 `FlowArtifact` | `external-snapshot`、`external-artifact`；FDE evolution-queue 檢視 |
| **Skill 面板（業務語言）** | 看員工會什麼、草稿是否待確認 | `Skill` + `SkillVersion` + `AgentSkill`；`reviewStatus` | `GET/POST /api/skills`、`POST /api/skills/:id/confirm`（**僅 FDE**）；MEMBER 僅見草稿狀態 |
| **Schedule 面板** | 週期工作可理解、可暫停 | `Schedule` + `Workflow.trigger`（cron 等） | workflows / schedules REST；BullMQ 排程 |
| **Approval／HITL** | 高風險動作暫停等人 | `ApprovalRequest`（run 前）；`ChangeProposal`（治理變更） | `GET/POST /api/approvals…`、`/api/proposals…`；runner `requiresApproval` / `isRunApproved` |
| **Run timeline** | 思考／工具／驗證／結果可追 | `Run` + `RunStep` + `RunTrace` + CostLog | runs REST + WS `run.*` 事件 |
| **建立 AI 員工（外部 Client）** | 在 Companion 對話中產出影子草稿 | `AgentBuildSession` → `AWAITING_FDE`；**不**建正式 Agent | 本票已證：`POST …/external/sessions`、`…/external-snapshot`、`…/submit-review`；FDE：`GET …/evolution-queue` |
| **FDE 審核佇列** | 單一 inbox 看提案與 build | `ChangeProposal`、`AgentBuildSession`（AWAITING_FDE）、Skill confirm | `/api/proposals`、`/api/agent-builder/review-queue`、`evolution-queue`、`/api/skills/:id/confirm` |
| **不可擴權 UI** | 無 Full Auto 開關 | `Agent.restrictions` / `riskTier` / `costPolicy` | 僅 FDE 可改；scoped token 已 403 |

**本票對設計的直接啟示：**

1. Companion Client 只應握有 `aios:agent-builder` token；UI 不應暴露 confirm／approve／registry 操作。
2. 「建立成功」對 End User 的語意是 **影子草稿已送 FDE**，不是員工已上線。
3. Workbench 右側 Artifact／Approval／Skill 狀態必須來自 AIOS 投影，不可在 Client 本地當真相。

---

## 5. Browser handoff 給 root Codex

本票以 **HTTP + 真 DB** 完成安全與 API 層 spike；下列項目**仍需真 Cherry Studio GUI**（或同等未修改外部 MCP Client）由 root Codex／瀏覽器 session 完成：

| # | 項目 | 前置條件 | 預期證據 |
|---|---|---|---|
| 1 | 真實 OAuth 授權旅程 | Cherry 已設定 AIOS Remote MCP URL；loopback／ChatGPT 相容 redirect 已在 allowlist；測試帳 `member@aios.test` 可用 | 截圖：authorize 頁 → 登入／consent → 回 Client 持有 token |
| 2 | 一輪「建立 AI 員工」對話 UX 觀察 | OAuth 成功；MCP tools 對應 external session／snapshot／submit-review 已暴露 | 對話過程筆記：如何表達需求、是否有 Stop hook／手動 snapshot、使用者如何感知「草稿 vs 上線」 |
| 3 | 影子草稿落點確認 | 同上 | DB 或 FDE UI：`AgentBuildSession` 在 evolution-queue，`agent/skill/workflow` 未增 |
| 4 | GUI 層越權嘗試（若 Client 暴露任何管理 UI） | 同 scoped 連線 | 應失敗或不可見；對照本票 API 403 矩陣 |
| 5 | 截圖包 | 上述 1–3 | 存於 reports 或 test-report 目錄（本票不強制路徑） |

**若 Cherry 無法穩定接 Remote MCP：** 依 `spec.md` Phase 1，記為 UX 研究證據，**不得**在 AIOS 新增繞過 scope 的能力。

---

## 6. 已知環境備註

| 項目 | 狀態 |
|---|---|
| aios docker postgres | 本機 compose 的 postgres 映像／容器**不存在或未作為主要 DB**；改以 **native postgres@17 綁 `127.0.0.1:5433`** 補建 database `aios` 並 migrate |
| Redis | 以 `web os system/docker-compose.yml` 啟動（`127.0.0.1:6380`） |
| Qdrant / docparse | 非本票硬依賴；健康檢查 `/api/health` 回 `db:true` 即可跑 OAuth／builder |
| `.env` | 路徑可能為他機殘留；執行時以環境變數／本機連結覆蓋；`AIOS_MCP_PUBLIC_URL` 預設對齊 `https://aios-mcp.lazyoffice.app/mcp` |
| 伺服器 | 主機 `npm run dev`（tsx watch）監聽 `127.0.0.1:8700`，**不**進 Docker |
| Node | 必須 v22：`export PATH="/opt/homebrew/opt/node@22/bin:$PATH"` |
| 測試帳 | OWNER `fde@aios.test` / MEMBER `member@aios.test`（密碼票面提供）；測試只刪固定 slug 的 fixture／session，不刪 users |

---

## 7. 驗收清單

| # | 條件 | 結果 |
|---|---|---|
| 1 | `node -v` → v22 | ✅ v22.23.2 |
| 2 | 負向測試 exit 0、全 PASS | ✅ |
| 3 | 正向測試 exit 0、全 PASS | ✅ |
| 4 | `npx tsc --noEmit` 通過 | ✅ |
| 5 | 本票只新增 `.scratch/aios-client-langflow-platform/` 下測試與報告，未改 production source | ✅（本票產出僅 scratch tests + 本 report） |
| 6 | 影子草稿可見於 FDE evolution-queue，未建正式 Agent/Skill/Workflow | ✅ |
| 7 | 越權 route 全 403 且 DB 零變更 | ✅ |

---

## 8. 總結

Remote MCP builder scoped token 在**真實伺服器 + 真 DB** 上已證明：

1. **正向**：可建立並提交 `AgentBuildSession` 影子草稿至 `AWAITING_FDE`，正式 Agent／Skill／Workflow 計數不變，且 FDE evolution-queue 可見。
2. **負向**：confirm Skill、approve Proposal、MCP registry 寫入、Agent CRUD／列表、POST skills **全部 403**，DB 與 fixture 狀態零變更。
3. **對照**：OWNER unscoped 可讀 agents；scoped 可讀 `/api/auth/me`——403 來自 scope 閘，非路由缺失。

剩餘工作為 **真 Cherry GUI browser handoff**（OAuth 旅程、對話 UX、截圖），不阻擋本票 API 安全結論。
