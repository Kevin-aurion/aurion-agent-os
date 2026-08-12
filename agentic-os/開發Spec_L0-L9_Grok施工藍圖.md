# Aurion Agentic OS — 開發總 Spec / 施工藍圖

| 項目 | 內容 |
|---|---|
| **文件版本** | v1.0（2026-07-21） |
| **狀態** | 🟢 定稿 — 可直接作為 Grok 施工依據與 Opus/Fable 驗收基準 |
| **基準程式碼** | `web os system/aios-server`（Fastify + Prisma + BullMQ） |
| **現況依據** | 所有「現況」均為 2026-07 實讀程式碼所得（程式可能微幅漂移，動手前先確認） |
| **涵蓋範圍** | L0–L9 十層 + 第一性治理層；波次 🔴 P0（止血）→ 🟢 P1（骨架）→ 🔵 P2（完善） |

> **文件用途**：這是接下來委派 **Grok CLI 開發**的唯一依據，也是 **Opus 4.8 / Fable 5 驗收**的對照基準。
> **角色分工（延續 CLAUDE.md）**：Grok 寫 → Opus 4.8 審（實跑 tsc/build/測試證據）→ 不對就 `--resume` 退回重做 → 通過才回報 Kevin。
> **基準程式碼**：`web os system/aios-server`（Fastify + Prisma + BullMQ）。所有「現況」均為 2026-07 實讀程式碼所得；Grok 動手前**務必先 Read 該檔確認現狀**（程式可能微幅漂移）。
> **鐵律**：發現 Bug → 修復 → 從頭重測直到通過。安全與成本是**硬約束**，不能靠模型自覺。**跨模型驗證閘絕不可弱化。**

### 🔴 四條紅線（全文件不可弱化，任何工項不得牴觸）

> 1. **跨模型驗證閘絕不可弱化** — `executor≠verifier` 於載入時強制、`isApproved` fail-closed。
> 2. **安全與成本是硬約束（fail-closed）** — 判不準或出錯一律拒絕，不能靠模型自覺。
> 3. **`shell` 預設關（`false`）** — 限制是程式碼層攔截點，不是 prompt 提示。
> 4. **P0 三項（成本帳本／硬攔截／HITL）是止血最優先** — 先做完，再進 P1/P2。

---

## 如何使用這份文件

- **給 Grok（施工者）**：接到工項後，先讀第 2 節對應層的「現況／改建／驗收標準」與第 3 節硬規範，動手前務必先 Read 目標檔案確認現狀，完工必須通過該項全部驗收標準。
- **給 Opus 4.8 / Fable 5（驗收者）**：以第 3 節（尤其 3.2/3.3/3.5）＋各工項驗收標準為對照基準，實跑 tsc/build/測試（含安全負向測試）取證，不合格就 `--resume` 退回重做。
- **給 Kevin**：看 [0. TL;DR](#0-tldr)、[總架構圖](#總架構圖) 與 [4. 開發進程與 To-do list](#4-開發進程與-to-do-list) 的追蹤看板，即可掌握全貌與進度。

---

## 目錄

- [如何使用這份文件](#如何使用這份文件)
- [總架構圖](#總架構圖)
- [0. TL;DR](#0-tldr)
- [1. 整體架構：我們要改哪些東西](#1-整體架構我們要改哪些東西) — 沿用／改造／新建、技術棧決策、Repo 佈局、資料模型
- [2. L0–L9 逐層開發內容](#2-l0l9-逐層開發內容)
  - [L0 治理與信任層](#l0-治理與信任層)｜[L1 互動層](#l1-互動層)｜[L2 編排層](#l2-編排層)｜[L3 技能層](#l3-技能層)｜[L4 記憶層](#l4-記憶層)
  - [L5 工具與協議層](#l5-工具與協議層)｜[L6 執行沙盒層](#l6-執行沙盒層)｜[L7 模型網關層](#l7-模型網關層)｜[L8 感知與資料層](#l8-感知與資料層)｜[L9 交付與商模層](#l9-交付與商模層)
- [3. 開發規格與開發規範](#3-開發規格與開發規範) — 工程規範、安全硬規範、驗收紀律、Grok 委派、DoD
- [4. 開發進程與 To-do list](#4-開發進程與-to-do-list) — P0 詳細三項、P1/P2 清單、追蹤看板
- [附錄 A：資料模型變更（Prisma migrations）總表](#附錄-a資料模型變更prisma-migrations總表)
- [附錄 B：授權地雷禁用清單](#附錄-b授權地雷禁用清單)

---

## 總架構圖

> **本節重點**：一眼看懂全貌 — 第一性治理層統攝 L0–L9 十層；🔴 標記處（L7／L0／L6／L2）就是 P0 止血點。

```text
╔════════════════════════════════════════════════════════════════════════════════════╗
║                     第一性治理層：統攝 L0-L9 全棧（不可弱化）                      ║
║ 跨模型驗證閘 executor != verifier | 安全/成本 fail-closed | 紅線 redactor 永遠生效 ║
╚══════════════════════════════════════════╤═════════════════════════════════════════╝
                                           │  ▼ 治理原則貫穿並約束下列每一層
┌──────────────────────────────────────────┴─────────────────────────────────────────┐
│ L9 交付與商模層  十大健康燈號 + Outcome Judge +（遠期）計費/多租戶           P1/P2 │
├────────────────────────────────────────────────────────────────────────────────────┤
│ L1 互動層        AWP/1 事件流（保留）+ 畫布/看板/語音                        P2    │
├────────────────────────────────────────────────────────────────────────────────────┤
│ L2 編排層        驗證閘（保留）+ HITL 復活 + Temporal 耐久 + typed 交接      P0-P2 │
├────────────────────────────────────────────────────────────────────────────────────┤
│ L3 技能層        技能閘（保留）+ 內容定址版本 + eval + 沉澱                  P2    │
├────────────────────────────────────────────────────────────────────────────────────┤
│ L4 記憶層        wiki+Qdrant（保留）+ 公司/部門記憶庫 + 多路檢索             P2    │
├────────────────────────────────────────────────────────────────────────────────────┤
│ L5 工具與協議層  aios-mcp（保留）+ 外部 MCP gateway                          P2    │
├────────────────────────────────────────────────────────────────────────────────────┤
│ L6 執行沙盒層    DO 最小權限 + per-agent sandbox-exec 小房間                 P0/P1 │
├────────────────────────────────────────────────────────────────────────────────────┤
│ L7 模型網關層    CostLog 成本帳本 + fail-closed 預算（最高優先）             P0    │
├────────────────────────────────────────────────────────────────────────────────────┤
│ L8 感知與資料層  文件解析 PaddleOCR-VL / MinerU / Docling IR                 P1    │
├────────────────────────────────────────────────────────────────────────────────────┤
│ L0 治理與信任層  硬攔截點 + AuditLog hash chain + Casbin 政策                P0/P1 │
└────────────────────────────────────────────────────────────────────────────────────┘
```

> 圖例：🔴 **P0 止血**（最優先）｜🟢 **P1 骨架**｜🔵 **P2 完善**。「P0-P2」表示該層工項橫跨三波。各層細節見[第 2 節](#2-l0l9-逐層開發內容)。

---

## 0. TL;DR

我們**不重寫架構**。現有 AIOS 的地基（跨模型驗證閘、在地優先、引擎層限制、紅線 redactor、understand→confirm 閘）比多數對岸方案更硬，全部**保留強化**。這輪開發是「在既有 `runner.ts / restrictions.ts / schema.prisma / dashboard.ts` 上增量補三個會流血的 P0 硬約束缺口，再分波長肌肉」。

**🔴 P0（止血，先做）**：

- **①** 成本計量＝0 → `CostLog` 帳本＋fail-closed 預算；
- **②** `shell`/`sendEmail` 只有提示、`shell` 預設開 → 補真正攔截點；
- **③** HITL 死狀態 → 讓 `AWAITING_REVIEW` 真的被觸發＋approval/resume。

---

## 1. 整體架構：我們要改哪些東西

> **本節重點**：不重寫架構 — 盤點「✅ 沿用／🔁 改造／🆕 新建」、明列刻意不做的決策，並定出 P0 要動的檔案與資料表。

### 1.1 現況 → 目標（一句話）

把每個 Agent 從「**扁平角色**（一段 rolePrompt + 六個布林旗標）」升級為「**有身分卡、有獨立沙盒、有成本上限、有防竄改稽核、可被跨模型驗證閘與 HITL 治理的數位員工**」，並讓 L0–L9 十層各就其位，第一性治理層統攝全棧。

### 1.2 保留 / 改造 / 新建 總覽

| 類別 | 項目 |
|---|---|
| ✅ **直接沿用（不動）** | 跨模型驗證閘（`compileManifest` execute≠verify、`isApproved` fail-closed、驗證器跨回合續命）、紅線 `redactor.redactSecrets`、`understand→confirm` 技能閘、三引擎分工、memory `wiki+Qdrant`、`AWP/1` 事件流（`ws/hub.ts`）、`aios-mcp`（我們當 MCP server 供給） |
| 🔁 **改造** | `restrictions.ts` 六布林 → 真正攔截點 + Casbin 政策（P0/P1）；`AuditLog` → hash chain（P1）；`runner.ts` in-process → Temporal 耐久（P1）；`Skill.version Int` → SHA-256 內容定址 + channel（P2）；`dashboard.ts` 計數 → 十大健康燈號（P1）；`Agent` 扁平角色 → 身分卡（P2） |
| 🆕 **新建** | `CostLog` 帳本 + fail-closed 預算（P0）；HITL approval service + resume token（P0）；per-agent sandbox profile（P1）；文件解析 L8（PaddleOCR-VL/Docling IR）（P1）；`CompanyMemoryDoc` 公司/部門記憶庫（P2）；OpenMeter/Lago 計費與多租戶（P2，遠期） |

### 1.3 技術棧與相依決策

- **不動的棧**：TypeScript、Fastify、Prisma（PostgreSQL）、BullMQ（Redis）、Qdrant、三引擎本地 CLI（`claude`/`codex`/`grok`）。
- **刻意「不做」的決策（重要，別為了像上海而做）**：
  - ❌ **不換 MemOS**：多背 Neo4j+Qdrant、預設遙測、供應鏈疑慮，且與現有 runner 高度重疊。保留自建 wiki+Qdrant。
  - ❌ **不上 LiteLLM proxy**：2026-03 供應鏈攻擊；我們本地 CLI + 無 key passthrough 反而天然免疫，只需自建成本帳本。
  - ❌ **P0 階段不上 Firecracker/E2B**：需 `/dev/kvm`(Linux)或雲帳號，與 macOS 在地優先衝突；先用 macOS `sandbox-exec` 收斂。
- **新引入的開源（P0 用得到的）**：P0 幾乎全自研，無新外部相依（`CostLog`/攔截/HITL 都在既有程式碼上加）。P1 起才引入 Casbin、Temporal、PaddleOCR-VL、Docling 等（見[第 2 節](#2-l0l9-逐層開發內容)，授權見[附錄 B](#附錄-b授權地雷禁用清單)）。

### 1.4 Repo 佈局與新增模組（`web os system/aios-server/src`）

```
engine/
  runner.ts          ← 改：DO 步驟預設最小權限；引擎呼叫後寫 CostLog；紅線動作→AWAITING_REVIEW
  restrictions.ts    ← 改：sendEmail/shell 補真正攔截；DEFAULT_RESTRICTIONS.shell=false
  cost.ts            ← 新：token/成本估算 + CostLog 寫入 + 預算檢查（fail-closed）
  claude.ts/codex.ts/grok.ts ← 改：回傳 usage（token 數）供 cost.ts 計量
lib/
  approval.ts        ← 新：HITL approval service（建立/查詢/決議/resume token）
  audit.ts           ← 改（P1）：hash chain（prevHash/hash）
routes/
  cost.ts            ← 新：GET 成本查詢 / 預算設定
  approvals.ts       ← 新：HITL 待審佇列 / 核准 / 駁回
  dashboard.ts       ← 改（P1）：十大健康燈號聚合
prisma/schema.prisma ← 改：新增 CostLog / ApprovalRequest；Agent 加 costPolicy/riskTier（見附錄 A）
```

### 1.5 資料模型變更

見 [附錄 A](#附錄-a資料模型變更prisma-migrations總表)。P0 需要的新表：`CostLog`、`ApprovalRequest`；`Agent` 新增 `costPolicy(Json)`、`riskTier(String)`。

---

## 2. L0–L9 逐層開發內容

> 每層格式：**目標 → 現況 → 要改/建的檔案 → 新資料模型 → 借用開源(授權) → 驗收標準 → 波次**。詳細開源選型見 [`技術參考文獻/`](技術參考文獻/README.md)。

**十層快速導覽**（首波 = 該層最早動工的波次；「目標」一句話原文照錄）：

| 層 | 首波 | 目標（一句話） |
|---|---|---|
| [L0 治理與信任層](#l0-治理與信任層) | 🔴 P0 | 六布林 → agent 政策引擎 + 防竄改稽核 |
| [L1 互動層](#l1-互動層) | 🔵 P2 | 保留 AWP/1 事件協議；補畫布/看板狀態面 |
| [L2 編排層](#l2-編排層) | 🔴 P0 | 保留驗證閘；補 durable 執行、一等 HITL、typed 交接 |
| [L3 技能層](#l3-技能層) | 🔵 P2 | 保留 understand→confirm；補 content-addressed 版本、eval 閘、沉澱迴路 |
| [L4 記憶層](#l4-記憶層) | 🔵 P2 | 保留 wiki+Qdrant+紅線+在地旗標；補公司/部門共用庫與多路檢索 |
| [L5 工具與協議層](#l5-工具與協議層) | 🔵 P2 | 保留 aios-mcp（我們當 server）；消費外部 MCP 前建 gateway |
| [L6 執行沙盒層](#l6-執行沙盒層) | 🔴 P0 | 全有全無 → 每 agent 小房間（白名單/配額） |
| [L7 模型網關層](#l7-模型網關層) | 🔴 P0 | 不上 proxy；自建成本帳本 + fail-closed 預算 |
| [L8 感知與資料層](#l8-感知與資料層) | 🟢 P1 | 補文件解析（目前近乎空白） |
| [L9 交付與商模層](#l9-交付與商模層) | 🟢 P1 | 補十大健康燈號；Outcome Judge 複用驗證閘；（遠期）計費/多租戶 |

---

### L0 治理與信任層

> 🔴 **本節重點**：把六布林升級為真正的程式碼層攔截點與政策引擎，稽核上鏈防竄改（攔截 P0；hash chain／Casbin P1）。

| 欄位 | 規格 |
|---|---|
| **目標** | 六布林 → agent 政策引擎 + 防竄改稽核。 |
| **現況** | `restrictions.ts` 6 布林，僅 4 項真正攔截；`AuditLog` 是普通表無 hash chain。 |
| **改/建** | `restrictions.ts`（補 sendEmail/shell 攔截、shell 預設 false）；`lib/audit.ts`（加 `prevHash/hash`）；（P1）引入 Casbin in-process PEP。 |
| **新資料模型** | `AuditLog` 加 `prevHash String?`、`hash String`。 |
| **借用開源（授權）** | Casbin（Apache-2.0）、A2A AgentCard schema（Apache-2.0）。 |
| **驗收標準** | `shell`/`sendEmail` 關閉時，即使 prompt 要求也**在程式碼層被拒**（非只提示）；AuditLog 任一筆被改，鏈驗證失敗可偵測。 |
| **波次** | 🔴 攔截 P0；🟢 hash chain P1；🟢 Casbin P1。 |

---

### L1 互動層

> 🔵 **本節重點**：AWP/1 事件協議不換，前端補畫布／看板狀態面（P2）。

| 欄位 | 規格 |
|---|---|
| **目標** | 保留 AWP/1 事件協議；補畫布/看板狀態面。 |
| **現況** | `ws/hub.ts` AWP/1 已是事件流，驗證回合（executing/verifying/approved/rejected）天生外流；缺 State Plane/Artifact 版本鏈/語音。 |
| **改/建** | AWP/1 不換；（P2）前端加 Artifact 沙盒渲染（借 LibreChat 模式）、React Flow DAG。語音列後期。 |
| **新資料模型** | — |
| **借用開源（授權）** | AG-UI 語義映射（MIT）、React Flow（MIT）、LibreChat 模式（MIT）。 |
| **驗收標準** | AWP/1 既有 topics 不回歸；新畫布視圖能訂閱同一事件流。 |
| **波次** | 🔵 P2（前端雛形已示意，見 `agentic-os/web/`）。 |

---

### L2 編排層

> 🔴 **本節重點**：我們最強的一層，保留 + 補三件 — HITL 復活 P0、durable 執行 P1、typed 交接 P2；**驗證閘行為零回歸是底線**。

| 欄位 | 規格 |
|---|---|
| **目標** | 保留驗證閘；補 durable 執行、一等 HITL、typed 交接。 |
| **現況** | `runner.ts` execute→verify 迴圈 + `compileManifest` 強制 executor≠verifier + `isApproved` fail-closed + `routeDefects`；**HITL 半殘**（`AWAITING_REVIEW` 無人觸發）；**無耐久**（in-process，crash 不能 resume）；交接是文字非 typed schema；`MAX_DELEGATION_DEPTH=1`。 |
| **改/建** | `lib/approval.ts`（新，HITL）；`runner.ts`（紅線/高風險/成本臨界 → set `AWAITING_REVIEW` + 發 approval + 等 resume）；（P1）Temporal 包住 run 生命週期；（P2）typed `WorkOrder/HandoffEnvelope` schema、放寬委派深度。 |
| **新資料模型** | `ApprovalRequest`（見[附錄 A](#附錄-a資料模型變更prisma-migrations總表)）。 |
| **借用開源（授權）** | Temporal（MIT，自架，pin ≥1.31.2）。 |
| **驗收標準** | 命中紅線動作時 run 進入 `AWAITING_REVIEW` 並在待審佇列出現；人工核准後 resume 續跑；駁回則終止。**驗證閘行為零回歸**（executor≠verifier 仍於載入時強制）。 |
| **波次** | 🔴 HITL P0；🟢 durable P1；🔵 typed 交接/深度 P2。 |

---

### L3 技能層

> 🔵 **本節重點**：核心 IP — 保留 understand→confirm 閘，補內容定址版本、eval 閘與沉澱迴路（P2）。

| 欄位 | 規格 |
|---|---|
| **目標** | 保留 understand→confirm；補 content-addressed 版本、eval 閘、沉澱迴路。 |
| **現況** | `Skill.version Int`（非內容定址）；`understand.ts` 跨模型審查 strict JSON + TOOL_MODULE 靜態 lint + 人審 CONFIRMED；無 eval harness；無自動沉澱。 |
| **改/建** | （P2）版本改 SHA-256 內容存 + `stable/canary` 指標；接 Promptfoo/DeepEval eval 閘；沉澱 pipeline（軌跡→候選→走既有 understand 閘）。 |
| **新資料模型** | — |
| **借用開源（授權）** | Promptfoo（MIT）、DeepEval（Apache-2.0）、AWM（Apache-2.0）/Voyager（MIT）沉澱抽象。 |
| **驗收標準** | 技能發佈前跑 eval pass/fail；rollback = 切指標（不刪版本）；沉澱只產候選、人審才 promote。 |
| **波次** | 🔵 P2。 |

---

### L4 記憶層

> 🔵 **本節重點**：即時查驗背書 — 保留我們的 wiki+Qdrant，**別換 MemOS**；補公司/部門共用庫與多路檢索（P2）。

| 欄位 | 規格 |
|---|---|
| **目標** | 保留 wiki+Qdrant+紅線+在地旗標；補公司/部門共用庫與多路檢索。 |
| **現況** | `memoryService.ts` wiki 真相層 + `qdrant.ts`（agentId 硬過濾）+ `redactor.ts`（永遠生效）+ `summary.ts`（決定性摘要）；`cloudEmbedding=false` 只寫本地；單層 per-agent，純向量召回。 |
| **改/建** | （P2）新增 `CompanyMemoryDoc`（組織/部門層）；recall 順序個人→部門→公司依權限過濾；補 BM25（自訂 Jieba/CKIP 分詞）+ RRF + rerank；選配 Graphiti 關係記憶。 |
| **新資料模型** | `CompanyMemoryDoc`。 |
| **借用開源（授權）** | Graphiti（Apache-2.0，鎖 ≥0.28.2、換掉預設 OpenAI endpoint）。 |
| **驗收標準** | A 學到的 SOP，B 依權限查得到；紅線 redactor 零回歸。 |
| **波次** | 🔵 P2。 |

---

### L5 工具與協議層

> 🔵 **本節重點**：我們當 MCP server 的 `aios-mcp` 保留；要消費外部 MCP，必須先建 gateway 與 admission gate（P2）。

| 欄位 | 規格 |
|---|---|
| **目標** | 保留 aios-mcp（我們當 server）；消費外部 MCP 前建 gateway。 |
| **現況** | `tools.ts` 動態載入 per-agent 工具（path-traversal 防護），內建 `upload_to_cloud`（`cloudWrite` 檢查寫在工具碼）；`aios-mcp/` 把 REST 暴露為 MCP server（127.0.0.1 + timing-safe secret + 短效 JWT）。 |
| **改/建** | （P2）若要消費外部 MCP，先上 IBM ContextForge 當 control plane，admission gate（版本+image digest+SBOM+risk 分級）設為**必須**；工具授權加 Casbin。 |
| **新資料模型** | — |
| **借用開源（授權）** | IBM ContextForge（Apache-2.0）、Docker MCP Gateway（MIT）。 |
| **驗收標準** | **永不從 public registry auto-run 外部 MCP server**；aios-mcp http secret 強度足夠。 |
| **波次** | 🔵 P2。 |

---

### L6 執行沙盒層

> 🔴 **本節重點**：目前最弱的一層 — 把「全有全無」收斂成每 agent 的小房間（DO 最小權限 P0；sandbox-exec profile P1）。

| 欄位 | 規格 |
|---|---|
| **目標** | 全有全無 → 每 agent 小房間（白名單/配額）。 |
| **現況** | Claude `--dangerously-skip-permissions`、DO 步驟預設 `permissions:'full'`；Codex 驗證走 read-only（亮點）；run 直接在 host、`cwd=agentDir`；無沙盒隔離/配額。 |
| **改/建** | `runner.ts`（DO 步驟預設從 `full` 改**最小權限 + 明確白名單**）；（P1）per-agent `sandbox/profile.sbpl`（macOS `sandbox-exec`）+ 路徑白名單/資源配額。 |
| **新資料模型** | `Agent` 的 `restrictions.allowlist{paths,tools}`（放進既有 restrictions Json）。 |
| **借用開源（授權）** | macOS `sandbox-exec`（系統內建）；（遠期 Linux 節點）Firecracker/gVisor（Apache-2.0）。 |
| **驗收標準** | 無白名單即拒；一條工作流不能碰白名單外路徑。 |
| **波次** | 🔴 DO 最小權限預設 P0（與 L0 攔截同批）；🟢 sandbox-exec profile P1。 |

---

### L7 模型網關層

> 🔴 **本節重點**：成本盲區＝最高優先 — 不上 proxy，自建 `CostLog` 成本帳本 + fail-closed 預算（P0）。

| 欄位 | 規格 |
|---|---|
| **目標** | 不上 proxy；自建成本帳本 + fail-closed 預算。 |
| **現況** | 三引擎直接 `spawn` CLI，**完全無 token/成本計量**；唯一雲呼叫 memory embedding 也無 budget。 |
| **改/建** | `engine/cost.ts`（新）：從各引擎回傳的 usage 估算成本、寫 `CostLog`；`runner.ts` 每次 execute/verify 引擎呼叫後計量；每 agent 日/月預算**fail-closed 硬阻斷**（超過即拒新呼叫並發告警）。`claude.ts/codex.ts/grok.ts` 回傳 usage。 |
| **新資料模型** | `CostLog`；`Agent.costPolicy(Json){dailyBudgetUSD,monthlyBudgetUSD,hardStop}`。 |
| **借用開源（授權）** | 無（借 WAIC 帳本的 pricing_catalog/reservation **設計**，不引入其程式碼）。 |
| **驗收標準** | 每次引擎呼叫都有一筆 `CostLog`；用量達日/月上限時**下一次呼叫被 fail-closed 拒絕**並在 dashboard 告警；金額用 `NUMERIC` 非 Float。 |
| **波次** | 🔴 **P0，最高優先**。 |

---

### L8 感知與資料層

> 🟢 **本節重點**：感知近乎空白 — 補文件解析管線（PaddleOCR-VL 預設、Docling IR 中間格式，P1）。

| 欄位 | 規格 |
|---|---|
| **目標** | 補文件解析（目前近乎空白）。 |
| **現況** | `lib/filecontext.ts` 把雲端檔同步成純文字；無 OCR/VLM/結構化 IR。 |
| **改/建** | （P1）引入 PaddleOCR-VL 當預設、複雜表格升 MinerU；中間格式用 DoclingDocument IR（保留 bbox/page/provenance）。 |
| **新資料模型** | — |
| **借用開源（授權）** | PaddleOCR-VL（Apache-2.0）、MinerU（**2026-04 起自訂 license，須法務詳讀**）、DoclingDocument（MIT）。 |
| **驗收標準** | 能解析 PDF/掃描件/複雜表格為 canonical IR，接進 memory ingestion。 |
| **波次** | 🟢 P1。 |

---

### L9 交付與商模層

> 🟢 **本節重點**：讓交付看得見 — 十大健康燈號 P1；Outcome Judge 複用驗證閘；計費／多租戶 P2（遠期）。

| 欄位 | 規格 |
|---|---|
| **目標** | 補十大健康燈號；Outcome Judge 複用驗證閘；（遠期）計費/多租戶。 |
| **現況** | `dashboard.ts` 只有計數；無燈號/根因/計費/多租戶。 |
| **改/建** | `dashboard.ts`（新增十大健康指標聚合 + 紅黃綠燈 + 紅燈附原因解法）；（P2）OpenMeter/Lago 計費、多租戶。 |
| **新資料模型** | — |
| **借用開源（授權）** | OpenMeter（Apache-2.0）、Lago（**AGPL-3.0，須法務評估**）、Helm（Apache-2.0）。 |
| **驗收標準** | dashboard 出十大燈號；紅燈一律附「原因＋解法」；Outcome Judge 直接複用 verify gate（executor≠judge）。 |
| **波次** | 🟢 健康燈號 P1；🔵 計費/多租戶 P2。 |

---

## 3. 開發規格與開發規範

> **本節重點**：工程、安全治理、跨模型驗收、Grok 委派與完成定義（DoD）的硬規範 — **3.2 任一條違反即驗收不通過**。

### 3.1 工程規範

- **語言/框架**：TypeScript（strict）、Fastify route handler、Prisma schema+migration、BullMQ job。跟隨既有檔案的命名、註解密度、慣用法。
- **Node**：`~/.local/node/bin`（已在 PATH）。
- **開發啟動**：後端用 `npm run dev`（tsx watch，會熱重載）；**不要用 `npm run start`**（不熱重載）。**不要在 `next dev` 執行中跑 `next build`**（汙染 `.next` 快取）。
- **DB 變更**：改 `schema.prisma` 後跑 `npx prisma migrate dev --name <desc>` 產 migration，並 `prisma generate`；**不可手改既有 migration**。
- **金額/數值**：成本金額一律 `Decimal/NUMERIC`（Prisma `Decimal`），**禁止 Float**。
- **設定**：API key 放各專案 `.env`（不進版控）。新增設定要有預設值且 fail-safe。
- **不碰**：`lazyoffice-system-main/`（唯讀參考，不得在內開發）；不動 `MyAgent/`、`aios-data/` 執行產物結構除非該項明列。

### 3.2 安全與治理硬規範（違反即驗收不通過）

> 🔴 **本小節每一條都是硬約束：違反任一條 = 該工項驗收直接不通過。**

- **Fail-closed**：所有限制/預算/審批，判不準或出錯時一律**拒絕**，不得放行。
- **限制是攔截點、不是提示**：新增或改動的限制必須在**程式碼層真正攔截**（拒絕執行/丟錯），不得只在 prompt 注入文字。`shell` 預設 `false`。
- **無 key passthrough**：維持引擎用使用者本地 CLI 授權，**不得**在系統內轉存/轉傳模型 API key。
- **紅線永遠生效**：`redactor.redactSecrets` 於任何 wiki/向量/稽核 detail 落地前遮罩，**不受任何旗標影響**，不得繞過。
- **驗證閘不可弱化**：`executor≠verifier` 於載入時強制、`isApproved` fail-closed（REJECTED 先於 APPROVED）——**任何改動不得破壞此行為**，PR 必須證明零回歸。
- **授權地雷**：分發路徑禁用 AGPL/BSL 1.1/ELv2/已封存專案（見[附錄 B](#附錄-b授權地雷禁用清單)）；引入任何開源前先確認授權相容且 pin 修復版。

### 3.3 跨模型驗證紀律（Grok 開發 → Opus/Fable 驗收）

- **執行 ≠ 驗證**：Grok 寫的東西，由 **Opus 4.8**（或複雜視覺/敘事由 Fable 5）驗收；不得自我背書。
- **驗收要實跑證據**，至少：
  1. `npx tsc --noEmit` 通過（型別）；
  2. `npm run build`（若該模組適用）通過；
  3. 針對該項驗收標準的**實跑測試**（單元或端對端），附輸出；
  4. 對安全項：**負向測試**（例如關閉 `shell` 後，故意要求 shell，證明被拒）。
- **重測迴圈**：發現 Bug → 指出「哪裡錯、為何錯、怎麼修」→ `--resume` 退回 Grok → **從頭重測**直到通過。

### 3.4 Grok 委派規範

- 一個需求對應一個目標資料夾；把**檔案路徑、驗收標準、限制**都寫進 prompt。
- 指令樣板：

  ```bash
  ~/.grok/bin/grok -p "<需求：目標/要改的檔案路徑/驗收標準/限制>" \
    --output-format json --always-approve \
    --cwd "/Users/kevin/Documents/aurion/web os system/aios-server" \
    [--rules "<風格/規範>"] [--resume <sessionId>]
  ```

- 延續脈絡用 `--resume <sessionId>`。**不在 `lazyoffice-system-main/` 內開發**。

### 3.5 Definition of Done（每個 To-do 項）

> 一項完成的定義：**程式碼改動落地** + **migration（如有）** + **tsc 通過** + **該項驗收標準的實跑證據（含安全項的負向測試）** + **Opus/Fable 驗收簽核** + **不破壞既有行為（尤其驗證閘/紅線/AWP-1 topics 零回歸）**。

---

## 4. 開發進程與 To-do list

> **本節重點**：**P0 三項是止血最優先** — 先做完 P0，再進 P1 骨架與 P2 完善。

### 4.1 波次總覽

| 波 | 主題 | 項目 |
|---|---|---|
| 🔴 **P0 止血** | 硬約束缺口 | 成本帳本(L7)、硬攔截+shell預設關+DO最小權限(L0/L6)、HITL復活(L2) |
| 🟢 **P1 骨架** | 耐久/稽核/沙盒/感知/健康 | AuditLog hash chain、Temporal 耐久、sandbox-exec profile、文件解析、十大健康燈號、Casbin PEP |
| 🔵 **P2 完善** | 版本化/記憶/協議/計費 | Skill 內容定址+eval+沉澱、公司記憶庫+多路檢索、MCP gateway、身分卡全面上線、計費/多租戶、語音 |

### 4.2 P0 詳細 To-do

> 先做這三個；每項含檔案 / 模型 / 驗收 / 測試。

#### ☐ P0-1 成本帳本 + fail-closed 預算（L7）🔴

> 缺口：成本計量＝0 → 建 `CostLog` 帳本＋fail-closed 預算。

- **改/建**：新 `engine/cost.ts`；改 `runner.ts`（execute/verify 引擎呼叫後計量）、`claude.ts/codex.ts/grok.ts`（回傳 usage token 數）、新 `routes/cost.ts`。
- **模型**：新 `CostLog{ id, agentId, runId?, engine, inputTokens, outputTokens, costUsd Decimal, createdAt }`；`Agent.costPolicy Json { dailyBudgetUSD, monthlyBudgetUSD, hardStop }`。
- **邏輯**：呼叫前檢查 agent 當日/當月累計 vs 預算，超過且 `hardStop` → **拒絕呼叫**（fail-closed）並發 `run.log`/告警；呼叫後寫 `CostLog`。
- **驗收**：①每次引擎呼叫有一筆 `CostLog`；②累計達上限 → 下次呼叫被拒（負向測試）；③金額 `Decimal`；④dashboard 能查每 agent 日/月成本。
- **測試**：設 dailyBudget=0.01，跑一次 run，證明第二次被 fail-closed 拒絕並記錄告警。

#### ☐ P0-2 硬攔截點 + shell 預設關 + DO 最小權限（L0/L6）🔴

> 缺口：`shell`/`sendEmail` 只有提示、`shell` 預設開 → 補真正攔截點。

- **改/建**：`restrictions.ts`（`sendEmail`/`shell` 從只注入提示 → **真正攔截點**，比照 `computerUse`/`cloudWrite` 模式；`DEFAULT_RESTRICTIONS.shell=false`）；`runner.ts`（DO 步驟 `permissions` 預設從 `'full'` → 最小權限 + 白名單）；相關 `tools.ts`/引擎 flag。
- **模型**：`restrictions.allowlist { paths:[], tools:[] }`（放進既有 restrictions Json，無需新表）。
- **驗收**：①`shell=false` 時，即使 prompt 要求執行 shell 也**被程式碼層拒絕**；②`sendEmail=false` 同理；③新 agent 預設 `shell=false`；④DO 步驟無白名單 → 拒絕碰白名單外路徑。
- **測試**：關閉 `shell` 後故意下 shell 指令 → 證明被攔截（負向測試）；驗證閘/既有四項限制零回歸。

#### ☐ P0-3 HITL 復活（L2）🔴

> 缺口：HITL 死狀態 → 讓 `AWAITING_REVIEW` 真的被觸發＋approval/resume。

- **改/建**：新 `lib/approval.ts` + `routes/approvals.ts`；改 `runner.ts`（紅線動作/高風險 tier/成本臨界 → set `RunStatus.AWAITING_REVIEW` + 建 `ApprovalRequest` + 暫停）。
- **模型**：新 `ApprovalRequest{ id, runId, agentId, reason, payload Json, status(PENDING/APPROVED/REJECTED), resumeToken, decidedBy?, decidedAt?, createdAt }`。
- **邏輯**：run 命中條件 → `AWAITING_REVIEW` + 待審佇列；人核准 → 用 `resumeToken` 續跑（保留原 context）；駁回 → 終止。逾時可升級（P1 再補逾時）。
- **驗收**：①命中紅線/高風險/成本臨界時 run 進 `AWAITING_REVIEW` 並出現在 `GET /approvals` 佇列；②核准後 run 續跑至完成；③駁回後 run 終止；④`AWP/1` 發 `run.step`（awaiting_review phase）。
- **測試**：造一個會觸發紅線的 run，證明它停在 AWAITING_REVIEW，核准後續跑、駁回則停。

### 4.3 P1 To-do（骨架）🟢

- ☐ **AuditLog hash chain**（L0）
  - 內容：`AuditLog` 加 `prevHash/hash`；`audit()` 串鏈；每日錨定 root（先落本地檔）。
  - 驗收：改任一筆 → 鏈驗證失敗可偵測。
- ☐ **Temporal 耐久執行**（L2）
  - 內容：Temporal（MIT，pin ≥1.31.2）包 run 生命週期；crash 可 resume、跨天等待。
  - 驗收：中途 kill 後能 resume 續跑。**驗證閘語義不變。**
- ☐ **sandbox-exec per-agent profile**（L6）
  - 內容：生成 `sandbox/profile.sbpl` + 白名單/配額。
  - 驗收：碰白名單外路徑被 OS 層拒。
- ☐ **文件解析 L8**
  - 內容：PaddleOCR-VL（預設）+ DoclingDocument IR。
  - 驗收：PDF/掃描件/表格 → canonical IR。
- ☐ **十大健康燈號**（L9）
  - 內容：`dashboard.ts` 聚合（驗證通過率/平均重跑輪數/成本超標次數/限制違規攔截數/HITL待審積壓/記憶新鮮度/技能eval通過率/稽核鏈完整性/沙盒逃逸嘗試/首輪通過率）+ 紅燈附原因解法。
- ☐ **Casbin in-process PEP**（L0）
  - 內容：高頻 tool-call 前置授權（避免集中式 PDP 延遲）。

### 4.4 P2 To-do（完善）🔵

- ☐ **Skill 內容定址版本 + rollback=切指標 + Promptfoo/DeepEval eval 閘 + 沉澱迴路**（L3）。
- ☐ **公司/部門記憶庫 `CompanyMemoryDoc` + BM25(Jieba/CKIP)+RRF+rerank + Graphiti 關係記憶**（L4）。
- ☐ **消費外部 MCP 前建 ContextForge gateway（admission gate 必須）**（L5）。
- ☐ **身分卡 schema 全面上線（A2A AgentCard extensions）+ 委派深度>1 + 階層派工**（L0/L2）。
- ☐ **OpenMeter/Lago 計費 + 多租戶 + 前端畫布/看板 + 語音原語**（L9/L1）。

### 4.5 追蹤看板

```
P0（止血）  ☐ P0-1 成本帳本   ☐ P0-2 硬攔截/shell/DO   ☐ P0-3 HITL
P1（骨架）  ☐ hash chain  ☐ Temporal  ☐ sandbox-exec  ☐ 文件解析  ☐ 健康燈號  ☐ Casbin
P2（完善）  ☐ Skill版本/eval  ☐ 公司記憶庫  ☐ MCP gateway  ☐ 身分卡/階層  ☐ 計費/多租戶/語音
```

---

## 附錄 A：資料模型變更（Prisma migrations）總表

> **本節重點**：全部 schema 變更一頁總覽 — P0 兩張新表＋`Agent` 兩欄位；P1/P2 各自增補。

| 波 | 變更 | 內容 |
|---|---|---|
| 🔴 P0 | 新表 `CostLog` | `id, agentId, runId?, engine, inputTokens Int, outputTokens Int, costUsd Decimal, createdAt` |
| 🔴 P0 | 新表 `ApprovalRequest` | `id, runId, agentId, reason, payload Json, status enum, resumeToken, decidedBy?, decidedAt?, createdAt` |
| 🔴 P0 | `Agent` 加欄位 | `costPolicy Json`（daily/monthly/hardStop）、`riskTier String @default("medium")` |
| 🔴 P0 | `restrictions` Json 內加 | `allowlist { paths:[], tools:[] }`（無需 schema 改動，屬 Json 內容） |
| 🟢 P1 | `AuditLog` 加欄位 | `prevHash String?`、`hash String` |
| 🔵 P2 | 新表 `CompanyMemoryDoc` | 組織/部門層記憶索引（對應既有 `MemoryDoc` 結構 + `orgId/deptId`） |
| 🔵 P2 | `Skill` 改版本 | `version Int` → 內容定址（`contentHash`, `channel stable/canary`） |

> 每個 migration 用 `prisma migrate dev --name <desc>`；**不可改既有 migration**；`RunStatus.AWAITING_REVIEW` 已存在於 enum，P0-3 只是讓它被觸發。

---

## 附錄 B：授權地雷禁用清單

> **本節重點**：分發路徑禁用 / 須法務先過 — 引入任何開源前，先對照此表確認授權相容並 pin 修復版。

| 專案 | 授權 | 處置 |
|---|---|---|
| Lago | AGPL-3.0 | 分發前法務評估 copyleft 邊界 |
| MinerU | 2026-04 起自訂 license | 人工詳讀（我們規模可免費商用，仍須確認） |
| immudb | BSL 1.1（非 OSI） | 僅內部自用；SaaS 化須重評 |
| Arize Phoenix | ELv2 | 禁受管服務轉售；僅內部自架 |
| MinIO | 已封存（AGPLv3） | **不採用**；改 Ceph RGW / 雲 Object Lock |
| Graphiti | Apache-2.0 | 須**換掉預設 OpenAI endpoint**、鎖 ≥0.28.2 |
| LiteLLM / Temporal / LangGraph | MIT/Apache | 若引入須 **pin 修復版**（供應鏈/CVE） |

> 規則：進入「會分發給客戶/盒子」的路徑，只用 Apache-2.0 / MIT / BSD；AGPL/BSL/ELv2 僅限純內部後端且經法務確認。
