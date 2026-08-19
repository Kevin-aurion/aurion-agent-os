# AIOS × 上海 WAIC L0–L9 逐層 Review（程式碼實讀版）

> 產出：Opus 4.8 實讀 aios-server 全部 engine/memory/skills/workflow/routes + aios-mcp + schema.prisma，對照 WAIC L0-L9 藍圖。2026-07。

I've now read the full engine, memory, skills, workflow, routes, scheduler, config, the new `aios-mcp` server, plus `ARCHITECTURE.md` and the first-principles `synthesis.md`. Here is the layer-by-layer review, grounded in the actual code.

---

# AIOS × 上海 WAIC L0–L9 逐層 Review（首席架構師版）

> 對照基準：`schema.prisma`（真實資料模型）＋ `engine/`（執行/驗證核心）＋ `memory/`＋ `agents|skills|workflow/`＋ `aios-mcp/`（新）。判斷已排除即時查驗中標記為授權/資安風險者（AGPL 感染、BSL/ELv2 非開源、MinIO 已封存、LiteLLM 供應鏈事件、MCP STDIO RCE、MemOS 遙測+供應鏈）。

---

## L0 治理與信任層

- **我們現況**
  - 身分：`Agent` 是**扁平角色**——`schema.prisma` 只有 `name/slug/description/department(字串 tag)/rolePrompt/avatar/engineExecute/engineVerify/restrictions(Json)`。沒有結構化身分卡（擁有者/目的/資料域/成本/風險），`createdBy` 是唯一近似 owner 的欄位。
  - 政策執行：`engine/restrictions.ts` 六個布林（`webSearch/computerUse/sendEmail/cloudWrite/shell/cloudEmbedding`）。**真正在程式碼層攔截的只有四項**：`webSearch`（`claude.ts` 的 `--disallowedTools`、`grok.ts` 的 `--disable-web-search`）、`computerUse`（`runner.ts` `runComputerControlStep` 硬拒）、`cloudWrite`（`tools.ts` `upload_to_cloud` throw）、`cloudEmbedding`（`memoryService.ts` 跳過 embed）。**`sendEmail`／`shell` 只在 `restrictionsToRules()` 注入提示文字，無攔截點**，且 `shell` 預設 `true`。
  - 政策時機：限制在 agent 建立時設定一次、run 開始注入一次——**沒有 per-tool-call 的 PDP/PEP**。
  - 稽核：`AuditLog` 表 + `lib/audit.ts` 的 `audit()`（action/entity/entityId/detail）。是**普通 Postgres 表，非防竄改鏈**——無 `prev_hash`、無 Merkle、無外部錨定。
  - 人類 RBAC：`UserRole` OWNER/TRAINER/MEMBER + `requireAuth/requireTrainer` guard。這是「人的存取控制」，不是「agent 的政策」。
- **上海最佳實踐**：A2A AgentCard schema 做 Registry、OPA/Cedar PDP＋Casbin in-process PEP、OpenFGA ReBAC、SPIFFE/SPIRE 短效身分、immudb append-only + Merkle 稽核鏈、OTel GenAI 埋點。
- **判斷**：🔁 **改造沿用**。骨架在（restrictions＋AuditLog＋RBAC＋materialize 的 CLAUDE.md 注入），但治理強度不足。這是我們**第一性治理的主戰場**，不能整套外包。
- **開源選型**：稽核鏈先自研最小版——`AuditLog` 加 `prevHash/hash` 欄位串 hash chain（不必馬上上 immudb BSL 授權）；政策引擎若要升級，用 **Casbin（Apache-2.0）in-process** 做 tool-call 前置授權，避免每次跳集中式 PDP 的延遲（WAIC anti-pattern 已點名）；身分格式借 **A2A AgentCard（Apache-2.0）** 的 extensions 欄位當身分卡骨架。
- **第一性接點**：**身分卡 + 引擎層限制**都在這層。`sendEmail/shell` 只有提示、`shell` 預設開，直接違反「安全必須是硬約束、不能靠模型自覺」（synthesis B4，P0）。

---

## L1 互動層

- **我們現況**
  - **AWP/1**（`ws/hub.ts`）：單一 WS endpoint、pub/sub topics（`run.started/run.step/run.log/run.finished/chat.message/agent.status/workflow.triggered/schedule.fired/skill.review_ready/computer.control_requested`）、`lastSeq` ring-buffer 續傳。這**已是一套事件流協議**，功能上等同 AG-UI 的北向事件契約，且**跨模型驗證的每一回合（executing/verifying/approved/rejected phase）都即時串到前端**（`runDoStep` 內 `hub.publish('run.step', …phase…)`）。
  - Chat plane：`Conversation/Message` + `conversations.ts`。
  - **缺**：畫布/任務看板狀態面（無 State Plane、無 Artifact 版本鏈、無 durable Task Board）；**語音原語完全沒有**（無 VAD/打斷/判停）。
- **上海最佳實踐**：AG-UI 事件協議、assistant-ui/CopilotKit、Pipecat/LiveKit 語音、Artifact 版本化、Task Board durable 狀態機。
- **判斷**：事件協議 🔁 **改造沿用**（AWP/1 已在地運作、且天生把驗證回合流出去，比 AG-UI 更貼我們的驗證閘）；畫布/看板/語音 🆕 **採用上海方案**（我們沒有）。
- **開源選型**：不必換 AWP/1；若要對外相容生態，可在 AWP/1 之上映射 **AG-UI（MIT）** 事件語義。前端 Artifact 沙盒渲染借 **LibreChat（MIT）** 模式；DAG 視覺化用 **React Flow（MIT）**。語音先不做（本地優先、非近期痛點）。
- **第一性接點**：跨模型驗證閘的可觀測性已內建於 WS——這是我們相對 AG-UI 的加分項，保留。

---

## L2 編排層（我們最強）

- **我們現況**
  - `engine/runner.ts` 是全系統核心：順序步驟（DO/TOOL/AGENT/CONDITION/NOTIFY/COMPUTER_CONTROL）、每步 execute→verify 迴圈上限 `maxRounds`、**執行引擎 ≠ 驗證引擎於 `compileManifest` 強制**（`autoVerify` 取對面）、**fail-closed 決定性核准 oracle**（`codex.ts` `isApproved`：`REJECTED_RE` 先於 `APPROVED_RE`）、**驗證器跨回合續命**（codex `exec resume`／grok `--resume`，CONCEDE/MAINTAIN 紀律）、`on_fail` 缺陷路由 + 經理決策（`routeDefects`）。
  - **HITL：半殘**。`RunStatus.AWAITING_REVIEW` 在 schema 存在，但**全庫沒有任何程式碼把 run 設成這個狀態**（synthesis F2 已標）；無 approval service、無 resume token、無逾時升級。
  - **耐久性：無 Temporal 意義的 durable**。run 是 in-process 的單一 async 函式；`RunStep` 逐步落庫（forensic），但**中途 crash 無法 resume**，跨天審批等待做不到。
  - **交接：半結構化**。AGENT 步驟把 `brief`＋prior outputs 當文字訊息傳（`runAgentStep`），**不是 typed HandoffEnvelope/WorkOrder schema**——與 WAIC「結構化 schema 而非自然語言」有落差。
  - `MAX_DELEGATION_DEPTH=1` 與階層組織目標衝突（synthesis B3）。
- **上海最佳實踐**：LangGraph（認知圖/checkpoint/interrupt-resume HITL）＋ Temporal（durable runtime/retry/timer/saga/crash recovery）＋ typed handoff＋ HITL 一等公民。
- **判斷**：🔁 **改造沿用**（保留驗證閘這個 crown jewel），補三件事：durable 執行、HITL 一等公民、typed handoff。
- **開源選型**：**Temporal（MIT，自架）** 做 run 生命週期/長等待/crash recovery/saga——把「業務步驟=Activity、認知步驟=我們的 step」界線套上；HITL 用 approval service + resume token（可自研，不必整套 LangGraph）；交接契約自研 `WorkOrder/HandoffEnvelope` versioned schema。即時查驗補充：**pin LangGraph/Temporal 修復版**（若引入 LangGraph 需 ≥1.0.10 檔 RCE 鏈；Temporal ≥1.31.2 檔 CVE-2026-5724）。
- **第一性接點**：**跨模型驗證閘 = 我們的 L2 核心 IP**，比 WAIC 的單模型 LLM-as-judge 更硬（executor≠verifier 於載入時強制、fail-closed oracle）。**務必保留**，且它是 L9 Outcome Judge 的天然地基。

---

## L3 技能層（核心 IP，已有優秀雛形）

- **我們現況**
  - `Skill`：`origin(UPLOADED/BUILTIN/CLI_GENERATED)`、`kind(PROMPT_MANUAL/TOOL_MODULE/COMPUTER_CONTROL)`、`version(Int)`、`contentMd`（SKILL.md frontmatter+body）、`assets(Json sha256)`、`understanding(Json)`、`reviewStatus`、`executionEnv`。SKILL.md 經 `materialize.ts` 落盤、`--append-system-prompt` 注入（**整份注入，未做 L3 lazy load**）。
  - **understand→confirm 閘（`skills/understand.ts`）非常對味**：跨模型審查（codex 優先、claude fallback）輸出 strict JSON `{summary,capabilities,data_read,data_written,external_calls,irreversible_actions,risks}`＋ TOOL_MODULE 靜態 lint（未宣告的 child_process/network import）→ `AWAITING_USER_CONFIRM` → 人工確認 → `CONFIRMED`；`agents.ts` 掛載時檢查 `reviewStatus==='CONFIRMED'`。`build.ts` CLI 生成技能**永不自動確認**。
  - **缺**：版本只是 `Int` 計數器，**非 content-addressed**（無 SHA-256 內容存 + channel pointer、無 rollback=切指標、無 immutable release、無 canary/stable）；**無 eval harness**（技能靠人眼看理解卡，非自動 pass/fail 測試）；**無自動沉澱 pipeline**（記憶有 log.md 沉澱，但不產技能 candidate）。
- **上海最佳實踐**：Agent Skills 規格＋Promptfoo/DeepEval eval gate＋content-addressed registry＋Promotion Controller（candidate→sandbox eval→human review→immutable→canary→stable）＋Distillation（trace→candidate，只產候選）。
- **判斷**：🔁 **改造沿用**。我們的 understand→confirm 閘其實**已實現 WAIC「只產候選、人審才 promote」的精神，還多了跨模型審查維度**。補：content-addressed 版本化/rollback、eval 閘、沉澱迴路。
- **開源選型**：eval 用 **Promptfoo（MIT）** + **DeepEval（Apache-2.0）** 做技能發佈前 pass/fail 閘；版本改 SHA-256 content store + `stable/canary` pointer；沉澱參考 **AWM（Apache-2.0）／Voyager（MIT）** 的 trajectory→workflow 抽象，接到既有 `summary.ts`／`log.md` 之上，只產 candidate 走既有 understand 閘。
- **第一性接點**：跨模型 understand 閘 = 「技能被對面引擎稽核」；沉澱迴路（軌跡→復盤→Skill 候選→人審→發布）WAIC 與我們第一性都列核心 IP。

---

## L4 記憶層（即時查驗結論：保留我們的，別換 MemOS）

- **我們現況**
  - `memory/memoryService.ts`：L1 wiki（`memory/wiki/` 的 index/facts/log/decisions markdown = 真相來源）＋ L3 Qdrant 向量索引（可重建、`qdrant.ts` 對 agentId 硬過濾）。
  - **紅線 `redactor.ts`：寫 wiki/向量前一律遮罩密鑰/PII**（API key/bearer/base64/台灣身分證/信用卡/email），**不受任何旗標影響**。
  - `cloudEmbedding=false` → 只寫本地 wiki、跳過雲端 embed（真正的在地優先旗標）。
  - Recall：embed query → Qdrant top-k → 注入 execute prompt（`recall()`，只在執行路徑、驗證路徑永不注入）。沉澱：`summary.ts` 決定性摘要（無 LLM）→ append log.md → reindex。`MemoryDoc` 只存索引 metadata（agentId/path/sha256/chunkCount），**永不存正文**。
  - **缺**：單層 per-agent（`agentId`-scoped），**無公司/部門共用知識庫**（synthesis B6）；純向量召回（**無 BM25/keyword/graph 多路 + RRF 融合 + rerank**，且中文 BM25 需自訂分詞——WAIC anti-pattern 已點名）；無 bitemporal/三正交維度/生命週期狀態機。
- **上海最佳實踐**：藍圖原話說借 MemOS；但**即時查驗明確反對整套換 MemOS**（多背 Neo4j+Qdrant、預設遙測需手動關、供應鏈含中國電信研究院；且我們 runner 已與 MemCube/MemScheduler 高度重疊）。真正建議：保留自建 + 選擇性借 Graphiti 做關係記憶。
- **判斷**：✅ **保留我們的（比上海適合我們）** + 🔁 **補強**。這是少數即時查驗直接背書「不要換血」的層。
- **開源選型**：canonical 維持 wiki+Qdrant；**選配 Graphiti（Apache-2.0，鎖 ≥0.28.2、換掉預設 OpenAI endpoint、收緊 Neo4j/FalkorDB 存取）** 做「跨員工/跨部門關係記憶」（誰負責什麼、技能歸屬哪個工作流）；中文檢索補 **BM25（自訂 Jieba/CKIP 分詞）+ RRF 融合 + bge-reranker-v2-m3**。**新增公司/部門層 `CompanyMemoryDoc`**，recall 先個人記憶再共用庫並依角色權限過濾。
- **第一性接點**：**記憶靈魂 + 紅線 + 在地優先**三者都在這層。`redactor` 永遠生效、`cloudEmbedding` 旗標——這是 WAIC 記憶層**沒有**的在地治理優勢，是護城河。

---

## L5 工具與協議層

- **我們現況**
  - 工具：`engine/tools.ts` 動態載入 `agentDir/tools/<name>.ts`（tool 名做 path-traversal 防護），只有一個內建 `upload_to_cloud`（治理寫在工具碼裡：`cloudWrite` 檢查）。**無 MCP gateway、無 per-tool 政策引擎、無 risk tier、無 JIT 憑證**。
  - **新增 `aios-mcp/`（未追蹤）**：我們把 aios-server REST **暴露成 MCP server**（`@modelcontextprotocol/sdk`，stdio 預設 + 選配 http），供 Claude Desktop/Code/Codex 呼叫；http 綁 **127.0.0.1 + `x-aios-mcp-secret` timing-safe**、專用 AIOS 帳號 15 分鐘 JWT + refresh 輪替。**方向是「我們當 MCP server 對外供給」**，不是消費外部 MCP。
  - 雲端存取經 `integrations/cloud.ts` 單一 choke point。無 A2A、無 query/sandbox/prod 三分權 connector。
- **上海最佳實踐**：MCP 事實標準＋Docker MCP Gateway＋IBM ContextForge 組織級 control plane、三分權 connector（Airwallex）＋risk 分級＋JIT 短效憑證、A2A 僅跨組織。
- **即時查驗（關鍵）**：MCP 有**架構級 RCE**（STDIO transport，Anthropic 稱「預期行為」拒改，10+ CVE、20 萬 server）、registry 毒化 9/11、SmartLoader 真實入侵。**MCP 只定義 mechanism、治理必須自建 gateway**。
- **判斷**：我們當 server 這條 🔁 **改造沿用**（起了好頭）；**若未來要消費外部 MCP server，🆕 必須先建 gateway 層**，不可從 public registry auto-run。
- **開源選型**：消費側用 **IBM ContextForge（Apache-2.0，已 GA v1.0.5）** 當 control plane，強制 **admission gate（approved version + image digest + SBOM + risk 分級）為必須而非選配**；開發沙盒用 **Docker MCP Gateway（MIT）**；工具授權加 Casbin（見 L0）。**aios-mcp 自身**：http secret 要夠強、**永不對不可信 web 輸入暴露 stdio transport**。
- **第一性接點**：`cloudWrite` 寫在工具碼是「限制即程式碼」的正確方向，但工具授權太粗（一個內建、無 risk tier、無 per-call 政策）。WAIC「同一能力三介面（人 CLI/程式 SDK/Agent Skill）」——我們 Skill＋REST＋MCP 已部分達成。

---

## L6 執行沙盒層（最弱）

- **我們現況**
  - 沙盒 = **整台電腦、全有全無**。Claude `--dangerously-skip-permissions`（DO 步驟預設 `permissions:'full'`，`runner.ts` compileStep 註解自陳）；Codex `read-only|workspace-write`（驗證走 read-only 是唯一亮點）；Grok `--always-approve`。run 直接在 host、`cwd=agentDir`。
  - **無 Firecracker/E2B/gVisor/Kata、無 snapshot/resume、無 per-agent 資源配額/路徑白名單**（synthesis B4「沙盒＝整台電腦權限的全有全無開關」）。COMPUTER_CONTROL 派給 macOS App 執行，也未沙盒化。
- **上海最佳實踐**：Firecracker microVM 預設、E2B 介面、create/resume/ready 三段延遲驗收、GPU 走 Kata。
- **判斷**：🆕 **採用上海方案（原則）**，但務實裁剪：Firecracker/E2B 需 `/dev/kvm`（Linux）且 E2B 自架需 GCP/AWS 帳號——**與我們 macOS 在地優先衝突**，不宜照搬。應採**原則**（per-agent 小房間收斂），非 microVM 本體。
- **開源選型**：近期用 **macOS `sandbox-exec` + Codex sandbox 收緊 + per-agent 檔案路徑白名單/資源配額**（把 DO 步驟預設 `permissions:'full'` 改為最小權限 + 明確白名單）；中期若上 Linux 執行節點再評估 **Firecracker（Apache-2.0）／gVisor（Apache-2.0）**。借 E2B（Apache-2.0）的 **API/envd 協定與 snapshot 流程設計**，但**不沿用其 BSL 授權的 Nomad/Consul 排程層**。
- **第一性接點**：引擎層限制 + 「沙盒收斂為小房間」（會議 1）。**今天 `shell=true` 預設 + DO 步驟 full 權限 = 一條工作流能做 host user 能做的任何事**——這是與 L0 相扣的最實在安全缺口。

---

## L7 模型網關層（成本盲區 = 最高優先致命缺口）

- **我們現況**
  - **無網關**。三引擎直接以本地 CLI（`spawn` claude/codex/grok）呼叫。**完全沒有 token/成本計量**（synthesis F3：「未見任何 Token/API 用量追蹤或成本異常告警」——業務上已發生「刷到幾個億」事故）。**無四維帳本**（tenant/project/agent/tool）。
  - 唯一雲端呼叫是 memory embedding（OpenRouter），也無 budget/metering。
  - **BYOK/在地天生具備**：引擎用使用者自己的 CLI 授權，**無 key passthrough**——這反而**避開了 LiteLLM 2026-03 供應鏈攻擊那類 gateway 風險**。
- **上海最佳實踐**：LiteLLM 類網關（OpenAI/Anthropic 相容）＋四維帳本＋原子預算 reservation（fail-closed 硬上限）＋BYOK 逃生口。
- **即時查驗**：LiteLLM MIT core 但 2026-03 供應鏈攻擊（須 pin ≥1.83.0、驗 cosign）；Bifrost（Apache-2.0，單一授權）、Envoy AI Gateway（CNCF 中立、v1.0）是更乾淨替代。
- **判斷**：路由 🔁 **改造沿用**（本地 CLI 比 gateway 更在地、避供應鏈風險，是合理設計，不需為了「像 WAIC」而上 LiteLLM proxy）；**帳本 🆕 必補**。
- **開源選型**：**不上 LiteLLM proxy**；改在 `engine/runner.ts` 每次引擎呼叫後**自建成本帳本**：`CostLog` 表（用 `NUMERIC` 非 Float）＋ 每 agent/日/月預算硬上限 **fail-closed 阻斷**（借 WAIC 帳本的 pricing_catalog/reservation 設計，但不引入其程式）。這同時實現第一性「成本殺手 Agent」。
- **第一性接點**：**成本殺手**就在這層。我們的本地 CLI 模型避開了 gateway 供應鏈風險，卻對成本全盲——F3，**P0，最高優先**。

---

## L8 感知與資料層

- **我們現況**
  - 文件解析：**幾乎沒有結構化能力**。`lib/filecontext.ts` 把雲端檔同步成 `data/cloud-files.md` 當純文字讀；xlsx 用 lib 讀狀態欄。**無 OCR/VLM/PaddleOCR/MinerU/Docling**、無 canonical IR、無 parser router。
  - 網頁取數：靠 claude `WebSearch/WebFetch`、grok 內建 web（受 `webSearch` 限制強制），**非自架 SearXNG/Crawl4AI/Playwright pipeline**。
  - RAG ingestion：parse→chunk→embed **只服務 memory wiki，不服務任意文件**。
- **上海最佳實踐**：PaddleOCR-VL 預設 → MinerU 複雜 → VLM 掃描件；DoclingDocument IR schema；SearXNG＋Crawl4AI＋Playwright 三面分離。
- **判斷**：文件解析 🆕 **採用上海方案**（我們基本空白）；網頁取數 🔁 **暫留**（CLI 內建 web 對在地單機夠用，借力 claude/grok 自帶工具）。
- **開源選型**：文件解析引入 **PaddleOCR-VL（Apache-2.0，中文強、輕量）** 當預設，複雜跨頁表格升級 **MinerU**（注意 2026-04 起改自訂 license，以我們規模可免費商用但**須人工詳讀 LICENSE**），中間格式借 **DoclingDocument（MIT）** schema（保留 bbox/page/provenance，Markdown 只當展示層）。
- **第一性接點**：感知×思考×行動×自省的**「感知」**目前弱在文件——agents 讀不了 PDF/掃描件/複雜表格是真實能力缺口。

---

## L9 交付與商模層

- **我們現況**
  - **無多租戶**（單機：User OWNER/TRAINER/MEMBER，無 Tenant/isolation_mode）；**無用量計費**（無 OpenMeter/Lago）；**無 RaaS Outcome Judge/驗收狀態機**；**無十大健康指標燈號**（synthesis F4 空白）；無 license/Helm 交付；無盒子+雲。
  - `dashboard.ts`：summary 計數（active agents、skills by review、workflows enabled、runs today by status、connected accounts）＋ recent runs ＋ audit ＋ 組織圖。是**基礎 ops 儀表板，非紅黃綠燈 + 原因分析**。
  - **「角色即產品數位員工」概念已落地**：agents 有 department/role/skills/workflows，L9 產品框架在。
- **上海最佳實踐**：OpenMeter+Lago 計費、Pool→Bridge→Silo 多租戶、OpenFeature 旗標、Helm+license 交付、**RaaS Outcome Judge（獨立於執行 agent，防球員兼裁判）**＋驗收狀態機＋崗位 KPI（首輪通過率/人工介入率/每成果成本）。
- **判斷**：🆕 **採用上海方案（多數）**，但有一個關鍵**天然對齊**：WAIC 的「Outcome Judge 獨立於執行者」**正是我們跨模型驗證閘的哲學**——我們的 verify gate 就是 Outcome Judge 的現成地基。
- **開源選型**：計量 **OpenMeter（Apache-2.0）**；發票/訂閱 **Lago（AGPL-3.0，須法務評估 copyleft 邊界）**；旗標經 **OpenFeature（Apache-2.0）** 抽象、底層 **Flagsmith（BSD-3）**（Unleash 授權兩來源矛盾，未定案前不採）；交付 **Helm（Apache-2.0）**。**近期最高 ROI**：在既有 `dashboard.ts` + `RunStep` 資料上做**十大健康指標燈號**（驗證通過率/平均重跑輪數/成本超標次數/限制違規攔截數/記憶新鮮度…），紅燈附「原因＋解法」（synthesis F4）。
- **第一性接點**：**跨模型驗證閘 → Outcome Judge**（executor≠judge 是我們既有紀律，可直接複用做 RaaS 驗收）；「角色即產品」已建模。**盒子↔雲同步只能上傳聚合 metering、不可傳原始客戶資料**（守在地不落地）。

---

# 我們真正比上海強、務必保留的護城河

1. **跨模型驗證閘（crown jewel）**——`compileManifest` 於載入時強制 executor≠verifier，`isApproved` fail-closed 決定性 oracle（`REJECTED_RE` 先於 `APPROVED_RE`），驗證器跨回合續命（codex/grok resume + CONCEDE/MAINTAIN）。WAIC 只有**單模型 LLM-as-judge**。這同時是 L2 核心 IP、L9 Outcome Judge 地基、L3 技能稽核維度。**絕不可弱化。**
2. **在地優先（不離地）**——loopback-only、引擎用**使用者自己的 CLI 授權（無 key passthrough）**，反而**天然免疫 L7 gateway 供應鏈攻擊**（LiteLLM 2026-03 事件）；`cloudEmbedding` 旗標讓記憶可完全不出機。WAIC 自架仍有雲依賴（E2B 需 GCP/AWS、MemOS 預設遙測）。
3. **引擎層限制（部分兌現）**——`webSearch/computerUse/cloudWrite/cloudEmbedding` 真的在 CLI flag / 程式碼層攔截（`claude.ts --disallowedTools`、`runComputerControlStep` 硬拒、`upload_to_cloud` throw），WAIC 把政策放獨立引擎，我們烤進執行引擎。
4. **紅線 redactor 永遠生效**——`redactSecrets` 在任何 wiki/向量落地前遮罩密鑰/PII，不受任何旗標影響。WAIC 記憶層沒強調這點。
5. **技能 understand→confirm 閘**——跨模型稽核（`understand.ts` strict JSON + TOOL_MODULE 靜態 lint）+ 人工確認才 `CONFIRMED` 掛載，等同 WAIC「只產候選、人審才 promote」再加跨模型維度。
6. **三引擎原生分工**（Claude 執行 / Codex 交叉驗證 / Grok 快速檢索與建置），已寫進 `Engine` enum 與 `draft.ts`。

---

# 我們最該補的致命缺口（對得上程式碼，依優先序）

| # | 缺口 | 對應程式碼證據 | 層 | 優先 |
|---|---|---|---|---|
| 1 | **成本計量＝0**：引擎呼叫無 token/成本追蹤，已釀真實財務事故 | `runner.ts` runExecuteStep/runVerifyStep 呼叫後無任何 usage 紀錄；無 CostLog 表 | L7 | **P0** |
| 2 | **`sendEmail`/`shell` 只有提示、`shell` 預設開**：不聽話的模型可繞過 | `restrictions.ts` `restrictionsToRules()` 只注入文字；`DEFAULT_RESTRICTIONS.shell=true`；無攔截點 | L0/L6 | **P0** |
| 3 | **HITL 死狀態**：`AWAITING_REVIEW` 無任何程式碼觸發；法規紅線/高風險動作無處暫停 | `RunStatus.AWAITING_REVIEW` 定義於 schema，`runner.ts` finalStatus 只會是 SUCCEEDED/FAILED | L2 | **P0** |
| 4 | **稽核非防竄改**：`AuditLog` 是普通表，DB 管理員可竄改整鏈 | `schema.prisma` `AuditLog` 無 `prevHash/hash` | L0 | P1 |
| 5 | **無耐久執行**：run 是 in-process async，中途 crash 無法 resume；跨天審批做不到 | `runAgent` 單一 while 迴圈；`RunStep` 只落 forensic，無 checkpoint/resume | L2 | P1 |
| 6 | **沙盒全有全無**：DO 步驟預設 `permissions:'full'`，無 per-agent 路徑白名單/配額 | `runner.ts` compileStep DO `permissions ?? 'full'`；無 sandbox-exec | L6 | P1 |
| 7 | **無文件解析**：讀不了 PDF/掃描件/複雜表格 | `lib/filecontext.ts` 只做純文字同步；無 OCR/VLM | L8 | P1 |
| 8 | **無 KPI 健康燈號**：只有計數，無紅黃綠燈 + 原因分析 | `dashboard.ts` 只 groupBy 計數 | L9 | P1 |
| 9 | **技能版本是計數器非 content-addressed**：無 rollback=切指標、無 eval 閘 | `Skill.version Int`；無 SHA 內容存/canary/eval | L3 | P2 |
| 10 | **委派深度鎖 1**：與階層組織（公司大腦→部門大腦→…）目標衝突 | `runner.ts` `MAX_DELEGATION_DEPTH=1` | L2 | P2 |

**一句話總結**：我們在 **L2（編排/驗證閘）、L3（技能治理閘）、L4（記憶+紅線）** 已建立比上海更硬的在地護城河，即時查驗也背書「記憶別換 MemOS」；真正的失血點集中在 **L7 成本盲區、L0/L6 硬約束缺口、L2 的 HITL 與耐久**——這四項全是「安全/成本必須是硬約束」的第一性要求，且都能在現有 `runner.ts / restrictions.ts / dashboard.ts / AuditLog` 上增量補齊，不需推翻架構。