# Aurion Agentic OS 重構 Spec（融合版）

> 定位：以上海 WAIC L0–L9 為技術骨架，第一性治理層統攝全棧；我們原本更硬的護城河（跨模型驗證閘、在地優先、引擎層限制、紅線 redactor、understand→confirm 閘）保留並強化為差異化。標記法：🔴我們自研IP／🟢借用開源／🔵採購或外部授權訂閱。

---

## 1. 總架構圖（文字版）

```
╔══════════════════════════════════════════════════════════════════════╗
║  第一性治理總則（統攝全棧，非某一層）                                    ║
║  身分卡 · 能做/不能做（硬約束）· 紅線法遵 · 跨模型驗證閘 · 階層派工      ║
║  「安全與成本是硬約束，不能靠模型自覺」                                  ║
╚══════════════════════════════════════════════════════════════════════╝
                                  ▼ 貫穿注入
┌──────────────────────────────────────────────────────────────────────┐
│ L0 治理與信任  身分卡+PDP/PEP+防竄改稽核鏈：agent 的政策中樞    🔴+🟢   │
│ L1 互動        AWP/1 事件流（驗證回合天生外流）+ 畫布/看板/語音 🔴+🟢   │
│ L2 編排        跨模型驗證閘（crown jewel）+ 耐久執行 + 一等 HITL 🔴+🟢  │
│ L3 技能        understand→confirm 閘 + content-addressed + eval 🔴+🟢  │
│ L4 記憶        wiki+Qdrant+紅線+在地旗標（別換 MemOS）+關係記憶 🔴+🟢   │
│ L5 工具協議    aios-mcp（我們當 server 供給）+ 消費側 gateway   🔴+🟢   │
│ L6 沙盒        每 agent 一間小房間：白名單/配額（近 macOS，遠 microVM）🔴+🟢│
│ L7 模型網關    本地 CLI 路由（免供應鏈風險）+ 成本帳本 fail-closed 🔴   │
│ L8 感知資料    文件解析 OCR/VLM → canonical IR（目前近乎空白）  🟢       │
│ L9 交付商模    健康燈號 + Outcome Judge（＝驗證閘）+ 計費/多租戶 🔴+🟢   │
└──────────────────────────────────────────────────────────────────────┘
                                  ▼ 對外唯一連線
        使用者授權的 Google / Microsoft / LINE + 本地 claude/codex/grok CLI 🔵
```

一句話定位：
- **L0**：把六個布林升級成「agent 的政策引擎 + 防竄改稽核」，是我們第一性治理的主戰場。🔴+🟢
- **L1**：AWP/1 已是事件協議且天生把每個驗證回合流到前端；缺畫布/看板/語音。🔴+🟢
- **L2**：全系統核心，驗證閘是我們最硬的 IP；補 durable 執行與一等 HITL。🔴+🟢
- **L3**：understand→confirm 已實現「只產候選、人審才 promote」再加跨模型維度；補版本化與 eval。🔴+🟢
- **L4**：wiki+Qdrant+永遠生效的 redactor+在地旗標＝護城河，即時查驗背書「別換 MemOS」。🔴+🟢
- **L5**：我們當 MCP server 對外供給起了好頭；若要消費外部 MCP 必先建 gateway。🔴+🟢
- **L6**：目前全有全無＝整台電腦權限，是最弱環節，收斂成每 agent 小房間。🔴+🟢
- **L7**：無網關本身避開供應鏈風險是對的，但成本全盲已釀真實財務事故，帳本必補。🔴
- **L8**：讀不了 PDF/掃描件/複雜表格，是真實能力缺口。🟢
- **L9**：只有計數儀表板，補紅黃綠燈；Outcome Judge 可直接複用驗證閘。🔴+🟢

---

## 2. 自研 vs 借用 vs 採購 總表

| 層 | 🔴 我們自研的 IP（保留/強化） | 🟢 借用的開源（含授權） | 🔵 採購／外部授權 |
|---|---|---|---|
| **治理總則** | 身分卡 schema、跨模型驗證閘、紅線 redactor、階層派工 | A2A AgentCard extensions（Apache-2.0）當身分卡骨架 | — |
| **L0** | AuditLog hash chain（prevHash/hash 自研最小版）、引擎層限制攔截點 | Casbin（Apache-2.0）in-process PEP；A2A AgentCard | — |
| **L1** | AWP/1（ws/hub.ts，含驗證回合事件） | AG-UI 語義映射（MIT）、React Flow（MIT）DAG、LibreChat（MIT）Artifact 沙盒渲染模式 | — |
| **L2** | 跨模型驗證閘、fail-closed isApproved oracle、routeDefects、WorkOrder/HandoffEnvelope schema、HITL approval service+resume token | Temporal（MIT，自架，pin ≥1.31.2）做 durable/crash recovery/長等待 | — |
| **L3** | understand→confirm 閘、TOOL_MODULE 靜態 lint、沉澱迴路（trace→candidate） | Promptfoo（MIT）+ DeepEval（Apache-2.0）eval 閘；AWM（Apache-2.0）/Voyager（MIT）沉澱抽象；SHA-256 content store | — |
| **L4** | wiki 真相層、redactor、cloudEmbedding 旗標、summary.ts 決定性摘要、CompanyMemoryDoc 分層 | Qdrant、Graphiti（Apache-2.0，鎖 ≥0.28.2，換掉預設 OpenAI endpoint）關係記憶；BM25（自訂 Jieba/CKIP 分詞）+ RRF + bge-reranker-v2-m3 | 中文 rerank/embedding 若走雲：OpenRouter 額度 🔵 |
| **L5** | aios-mcp（REST→MCP server，127.0.0.1+timing-safe secret+短效 JWT）、cloudWrite 寫在工具碼 | 消費外部 MCP 時：IBM ContextForge（Apache-2.0，v1.0.5）control plane、Docker MCP Gateway（MIT）開發沙盒；Casbin per-tool 授權 | — |
| **L6** | 每 agent sandbox profile、路徑白名單/資源配額、DO 步驟改最小權限 | 近期：macOS sandbox-exec；中遠期（Linux 節點）：Firecracker（Apache-2.0）/gVisor（Apache-2.0）；借 E2B（Apache-2.0）envd/snapshot 協定設計 | 中遠期 Linux 執行節點雲主機 🔵 |
| **L7** | CostLog 帳本（NUMERIC）、四維帳本、原子預算 reservation fail-closed 硬上限、成本殺手 Agent | 借 WAIC 帳本 pricing_catalog/reservation 設計（不引入其程式碼，**不上 LiteLLM proxy**） | 三引擎 CLI 訂閱（Claude Code/Codex/Grok）+ embedding 額度 🔵 |
| **L8** | parser router、canonical IR 落地與 provenance 對接 memory | PaddleOCR-VL（Apache-2.0，預設）→ MinerU（**2026-04 起自訂 license，須法務詳讀**）複雜表格；DoclingDocument（MIT）IR schema | — |
| **L9** | 十大健康燈號+原因分析、Outcome Judge（＝驗證閘複用）、驗收狀態機、「角色即產品」建模 | OpenMeter（Apache-2.0）計量；Lago（**AGPL-3.0，須法務評估 copyleft**）發票；OpenFeature（Apache-2.0）+ Flagsmith（BSD-3）旗標；Helm（Apache-2.0）交付 | 盒子+雲部署雲資源 🔵 |

**授權地雷清單（法務先過）**：Lago AGPL-3.0、MinerU 自訂 license、Graphiti 預設 OpenAI endpoint（須改本地）、Temporal/LangGraph 須 pin 修復版、ContextForge admission gate 須設為「必須」而非選配。

---

## 3. 第一性治理層 Spec

治理層不是某一層，而是三個機制沿三層（L0 政策／L2 編排閘門／L3 技能審批）貫穿注入。

### 3.1 身分卡 Schema（AgentIdentityCard）

以 A2A AgentCard 的 extensions 欄位當骨架，canonical 存於 `MyAgent/<dept>/<slug>/IDENTITY.card.json`，以 SHA-256 內容定址版本化。

```jsonc
{
  "id": "agt_...", "slug": "ap-scanner", "displayName": "應付帳款掃描員", "avatar": "...",
  "owner": { "userId": "...", "email": "kevin@aurion-group.com" },   // 擁有者
  "purpose": "每日掃描應付帳款、標記異常、產出對帳待辦",              // 目的（崗位一句話）
  "department": "finance/ap",                                        // 部門（階層路徑）
  "parentAgentId": "agt_finance_brain",                             // 階層派工上級
  "dataDomains": ["gdrive:folder/AP2026", "mem:ns/ap-scanner"],     // 可觸及資料域
  "engines": { "execute": "CLAUDE_CODE", "verify": "CODEX" },       // 三引擎綁定（execute≠verify）
  "restrictions": {                                                 // 六旗標 → 升級為 PDP 政策
    "webSearch": false, "computerUse": false, "sendEmail": false,
    "cloudWrite": false, "shell": false, "cloudEmbedding": false,   // shell 預設改 false
    "allowlist": { "paths": ["./", "gdrive:folder/AP2026"], "tools": ["upload_to_cloud"] }
  },
  "riskTier": "medium",                                             // 風險分級
  "costPolicy": { "dailyBudgetUSD": "5.00", "monthlyBudgetUSD": "80.00", "hardStop": true }, // 成本
  "sandboxProfile": "sbx_ap_scanner",                              // 綁 L6 sandbox
  "memoryNamespace": "ap-scanner",                                 // 綁 L4 namespace
  "version": 7, "contentHash": "sha256:...", "createdBy": "...", "createdAt": "..."
}
```

要點：`engines.execute ≠ engines.verify` 在載入時強制（延續 `compileManifest`）；`restrictions` 從「建立時設定一次」升級成 Casbin 可查詢的政策集合，供 L2 每次 tool-call 前置授權（in-process PEP，避免集中式 PDP 延遲——WAIC anti-pattern 已點名）。

### 3.2 紅線稽核（永遠生效的兩道紅線）

1. **落地前遮罩**：`redactor.redactSecrets` 在任何 wiki／向量／稽核 detail 落地前遮罩密鑰/PII，**不受任何旗標影響**（既有優勢，保留為硬約束）。
2. **防竄改稽核鏈**：`AuditLog` 新增 `prevHash`、`hash = sha256(prevHash ‖ canonical(entry))`，串成 append-only hash chain；每日錨定一次 root hash（先落本地檔，之後可外部錨定）。DB 管理員竄改任一環會斷鏈可驗。
3. **法遵紅線動作 → 強制暫停**：`sendEmail`/`cloudWrite`/`computerUse`/不可逆動作命中紅線時，run 進入 `AWAITING_REVIEW`，等人審 resume（見 3.3、L2）。

### 3.3 跨模型驗證閘如何貫穿 L0/L2/L3

同一個「執行者≠審查者、fail-closed」哲學，複用於三個閘門：

| 貫穿點 | 機制 | 現有程式碼基礎 |
|---|---|---|
| **L0 政策閘** | 身分卡強制 execute≠verify；驗證路徑**永不注入** memory recall / 工具寫入權（避免審查者被污染） | `compileManifest` autoVerify 取對面；`recall()` 只在執行路徑 |
| **L2 編排閘** | 每步 execute→verify 迴圈上限 maxRounds；`isApproved` fail-closed 決定性 oracle（REJECTED_RE 先於 APPROVED_RE）；驗證器跨回合續命（codex/grok resume，CONCEDE/MAINTAIN 紀律）；不過關 → routeDefects/經理決策 或 AWAITING_REVIEW | `engine/runner.ts`、`codex.ts` isApproved |
| **L3 技能閘** | understand.ts 用對面引擎審查 skill，輸出 strict JSON（capabilities/data_read/data_written/external_calls/irreversible_actions/risks）+ TOOL_MODULE 靜態 lint → AWAITING_USER_CONFIRM → 人審 CONFIRMED 才可掛載 | `skills/understand.ts`、`agents.ts` reviewStatus 檢查 |
| **L9 驗收** | RaaS Outcome Judge **就是**這個驗證閘的複用：獨立於執行 agent 的驗收器，天然防「球員兼裁判」 | 直接複用 verify gate |

**鐵律**：驗證閘絕不可弱化。它同時是 L2 核心 IP、L3 技能稽核維度、L9 Outcome Judge 地基——這是我們相對 WAIC 單模型 LLM-as-judge 的結構性領先。

---

## 4. 「每個 Agent = 獨立資料夾 + 獨立沙盒 + 獨立控制」落地設計

### 4.1 資料夾結構（canonical）

```
MyAgent/
  <department>/                         # 階層：finance/ · sales/ · ...
    <agent-slug>/
      IDENTITY.card.json                # 身分卡（SHA-256 內容定址、版本化）
      CLAUDE.md                         # materialize 注入：角色 + 限制文字 + skill 索引
      skills/                           # 掛載且 CONFIRMED 的 skill 具現化（SKILL.md + assets/sha256）
      tools/<name>.ts                   # per-agent 工具模組（path-traversal 防護，既有）
      memory/
        wiki/                           # L4 真相層：index/facts/log/decisions.md
        namespace                       # → memoryNamespace（Qdrant agentId 硬過濾）
      sandbox/
        profile.sbpl                    # L6：macOS sandbox-exec profile（近期）
        allowlist.json                  # 路徑白名單 + 資源配額（CPU/記憶體/磁碟/時限）
      runs/<runId>/                     # forensic RunStep 落盤（既有）
      cost/ledger.json                  # L7：per-agent CostLog 快照 + 預算狀態
```

### 4.2 四個「獨立」如何用身分卡欄位組合綁定

| 獨立性 | 綁定來源（身分卡欄位） | 落地機制 |
|---|---|---|
| **獨立資料夾** | `department` + `slug` | materialize 只建不覆蓋既有骨架（延續現況） |
| **獨立沙盒（L6）** | `sandboxProfile` + `restrictions.allowlist.paths` | 生成 `sandbox/profile.sbpl`；DO 步驟預設從 `permissions:'full'` **改為最小權限 + 明確白名單**；COMPUTER_CONTROL 派給 macOS App 時同樣套 profile |
| **獨立記憶（L4）** | `memoryNamespace` | Qdrant 對 agentId 硬過濾（既有）；recall 順序：個人 ns → 部門 `CompanyMemoryDoc` → 公司庫，依角色權限過濾 |
| **獨立控制（Computer Use / L0 政策）** | `restrictions.computerUse` + `riskTier` | `runComputerControlStep` 硬拒為預設；唯有政策允許且風險分級通過才放行，且高風險動作走 AWAITING_REVIEW |

**關鍵修正**：今天 `shell=true` 預設 + DO 步驟 `permissions:'full'` = 一條工作流能做 host user 能做的任何事。落地設計把「沙盒＝小房間」寫死：無白名單即拒。

---

## 5. 「語音描述 → 自動生虛擬員工」流程（端到端）

```
① 語音輸入 (L1)                     ② 意圖解析                    ③ 挑 Skill (L3)
   VAD/判停(未來)→STT→自然語言職描 →  抽 崗位/部門/職責/資料域/能力 →  Skill 庫語意匹配 CONFIRMED skills
                                     產 draft 身分卡(擴充 draft.ts)      缺的→build.ts 生候選→understand→人審
                                                                              │
④ 組裝 Agent ─────────────────────────────────────────────────────────────────┘
   身分卡 + engines(execute≠verify) + restrictions(預設最小權限,shell/computerUse=false)
   + costPolicy(日/月硬上限) + riskTier + sandboxProfile + memoryNamespace
                                     │
⑤ 掛沙盒/記憶 ───────────────────────┤
   materialize 資料夾骨架 → 生 sandbox/profile.sbpl + allowlist → 初始化 memory/wiki → 綁 Qdrant ns
                                     │
⑥ 驗證閘 (跨模型) ───────────────────┤
   用對面引擎驗證組裝結果：身分卡完整、限制自洽、掛載 skill 全 CONFIRMED、成本/風險有硬上限
   fail-closed → 不過關重組；過關 → AWAITING_REVIEW 人審 → 啟用
                                     │
⑦ Workflow 配置 (差異化) ────────────┘
   把 job 拆成 workflow steps，交接用結構化 WorkOrder/HandoffEnvelope schema（對應對岸的「結構化交接」）
   觸發：cron / 關鍵字 / 手動（既有三種）
```

差異化說明：對岸 Agent 內多半無顯式 Workflow，靠 Prompt+Skill+文件+記憶串聯；我們保留 Workflow，並用 typed `HandoffEnvelope` 把它對應到他們的「結構化 schema 交接」，兩邊語義可互通。語音（L1 VAD/打斷/判停）列為後期，近期先用自然語言文字輸入走完 ①–⑦。

---

## 6. 與現有 AIOS 的遷移路徑

### 6.1 沿用／改造／新建

- **直接沿用（不動）**：跨模型驗證閘、redactor 紅線、understand→confirm 閘、三引擎分工、memory wiki+Qdrant、AWP/1 事件流、aios-mcp（我們當 server）。
- **改造**：`restrictions.ts` 六布林 → Casbin PDP/PEP；`AuditLog` → hash chain；`runner.ts` in-process → Temporal durable；`Skill.version Int` → SHA-256 content-addressed + stable/canary channel；`dashboard.ts` 計數 → 十大健康燈號；Agent 扁平角色 → 身分卡。
- **新建**：`CostLog` 帳本 + fail-closed 預算；HITL approval service + resume token；per-agent sandbox profile（sandbox-exec）；文件解析 L8（PaddleOCR-VL/Docling IR）；`CompanyMemoryDoc` 公司/部門記憶庫；OpenMeter/Lago 計費與多租戶（遠期）。

### 6.2 三波（依致命缺口優先序）

**P0（止血，一個 workflow 可完成的實質範圍）**
1. **成本帳本**（L7，缺口#1）：`runner.ts` 每次引擎呼叫後寫 `CostLog`（NUMERIC）；每 agent 日/月預算 fail-closed 硬阻斷。已釀真實財務事故，最高優先。
2. **硬攔截點**（L0/L6，缺口#2）：`sendEmail`/`shell` 從「只注入提示文字」補上真正攔截點；`DEFAULT_RESTRICTIONS.shell` 預設改 `false`。
3. **HITL 復活**（L2，缺口#3）：讓 `AWAITING_REVIEW` 真的被觸發（紅線/高風險/成本臨界）+ approval service + resume token + 逾時升級。

**P1**
4. AuditLog hash chain（L0，#4）。 5. Temporal durable 執行 + crash resume（L2，#5）。 6. sandbox-exec per-agent 白名單/配額，DO 步驟改最小權限（L6，#6）。 7. 文件解析 PaddleOCR-VL → Docling IR（L8，#7）。 8. 十大健康燈號 + 原因分析（L9，#8）。

**P2**
9. Skill content-addressed 版本 + rollback=切指標 + Promptfoo/DeepEval eval 閘（L3，#9）。 10. 委派深度 >1 + 階層派工（L2，#10）。 11. 身分卡 schema 全面上線（A2A extension）。 12. 沉澱迴路（trace→候選走既有 understand 閘）。 13. 公司/部門記憶庫 + BM25+RRF+rerank + Graphiti 關係記憶（L4）。 14. 消費外部 MCP 前建 ContextForge gateway（L5）。 15. OpenMeter/Lago 計費 + 多租戶 + 語音原語（L9/L1）。

---

## 7. 前端介面資訊架構（供下游做雛形）

全域：`AWP/1 WS EventProvider`（訂閱 run.started/step/log/finished、chat.message、agent.status、workflow.triggered、schedule.fired、skill.review_ready、computer.control_requested；**run.step 帶 executing/verifying/approved/rejected phase 即時流**）。

| 頁面 | 用途 | 主要元件 |
|---|---|---|
| **Agent 列表（資料夾視圖）** | 部門樹 + agent 卡 | `DepartmentTree`、`AgentCard`、`StatusBadge`（燈號）、`CostMeter`（日/月預算條）、`RiskTierChip` |
| **Agent 詳情** | 身分卡+沙盒+記憶+Computer Use+成本+執行 | `IdentityCardPanel`、`SandboxProfileEditor`（白名單/配額）、`MemoryBrowser`（wiki 分頁/搜尋/reindex，已存在）、`ComputerUseConsole`、`RestrictionToggles`、`CostLedgerChart`、`RunTimeline`（含 verify phase 事件流） |
| **Skill 庫** | 列表+理解卡+eval+版本/rollback | `SkillTable`（origin/kind/reviewStatus/version channel）、`UnderstandingCard`（strict JSON）、`EvalReport`（Promptfoo/DeepEval pass/fail）、`VersionChannelSwitch`（stable/canary）、`ConfirmGateDialog` |
| **Workflow 編排** | DAG 畫布 + step 檢視 + 交接 + HITL | `WorkflowCanvas`（React Flow）、`StepInspector`（DO/TOOL/AGENT/CONDITION/NOTIFY/COMPUTER_CONTROL）、`HandoffEnvelopeViewer`（WorkOrder schema）、`ApprovalNode`（HITL）、`TriggerConfig`（cron/關鍵字/手動） |
| **語音建員工** | 語音/文字→意圖→身分卡草稿→驗證→人審 | `NLInput`（+未來 `VoiceCapture`）、`IntentPreview`、`SkillMatchList`、`IdentityCardDraft`、`VerificationGateResult`、`ActivateReviewDialog` |
| **Dashboard / 健康** | 十大燈號 + 原因 + 成本告警 + 稽核鏈 | `HealthLightGrid`、`MetricCard`（紅黃綠）、`RootCausePanel`（原因+解法）、`CostAlertBanner`、`AuditChainViewer`（hash chain 驗證）、`OrgChart`（階層派工） |

十大健康指標（燈號）候選：驗證通過率、平均重跑輪數、成本超標次數、限制違規攔截數、HITL 待審積壓、記憶新鮮度、技能 eval 通過率、稽核鏈完整性、沙盒逃逸嘗試、首輪通過率。紅燈一律附「原因＋解法」。