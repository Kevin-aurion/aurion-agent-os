# Ticket 20 — Phase 5 Exit Report（十大真實負向驗收閘）

**日期：** 2026-08-08
**分支／工作樹：** `web os system/aios-server`（aios-client-langflow-platform）
**對應票：** `.scratch/aios-client-langflow-platform/issues/20-poc-negative-suite.md`
**規格：** `.scratch/aios-client-langflow-platform/spec.md`（Mandatory Negative Matrix、Phase 5、Exit Criteria）
**本票檔案（僅新增／修改這些）：**
- `tests/t20-poc-01-complaint.test.ts` … `tests/t20-poc-10-member-publish.test.ts`
- `reports/20-phase5-exit-report.md`（本檔）

**Production code 變更：** 無（zero `src/**` / `prisma/**` / `package.json` / compose 改動）。

**實跑 log 根目錄：**
`/private/tmp/claude-501/-Users-kaikaiwu-Desktop-LazyOffice-AI-OS-Langflow/b1811c62-a49f-4930-867d-9af46d134e04/scratchpad/`

---

## 1. 執行環境與方法

| 項目 | 實況 |
|---|---|
| Node | v22（`PATH=/opt/homebrew/opt/node@22/bin:$PATH`） |
| 執行方式 | `npx tsx .scratch/aios-client-langflow-platform/tests/t20-poc-NN-*.test.ts` |
| DB | 真 Postgres via `src/lib/db.js` prisma 單例（非 in-memory） |
| HTTP API | live `http://127.0.0.1:8700`（t10 等路由路徑） |
| Live Langflow sandbox | `http://127.0.0.1:7860`（真實 `LangflowAdapter`；health 可通） |
| Dead Langflow | `http://127.0.0.1:7997`（outage 隔離；不停止任何 live container） |
| Mock RuntimeAdapter | **禁止**冒充 live；一律真 `LangflowAdapter` |
| Cleanup | 各腳本 finally 只刪本腳本追蹤 id 的列／目錄；不可刪既有使用者資料 |
| Typecheck | server / web / mcp `npx tsc --noEmit` 全過（本輪驗收彙總） |

---

## 2. 十案逐案結果

### 總表

| # | 腳本 | 判定 | 摘要 |
|---|---|---|---|
| 01 | `t20-poc-01-complaint` | **PASS-with-BLOCKED** | 17P / 0F / 2B |
| 02 | `t20-poc-02-quotation` | **PASS-with-BLOCKED** | 12P / 0F / 2B |
| 03 | `t20-poc-03-refund` | **PASS-with-BLOCKED** | 14P / 0F / 2B |
| 04 | `t20-poc-04-injection` | **PASS** | 19P / 0F |
| 05 | `t20-poc-05-duplicate` | **PASS** | 11P / 0F |
| 06 | `t20-poc-06-outage` | **PASS** | 14P / 0F |
| 07 | `t20-poc-07-digest-drift` | **PASS** | 9P / 0F |
| 08 | `t20-poc-08-same-family` | **PASS** | 16P / 0F |
| 09 | `t20-poc-09-budget` | **PASS** | 9P / 0F |
| 10 | `t20-poc-10-member-publish` | **PASS** | 17P / 0F |

全部 `exit=0`、`0 failed`。
**BLOCKED 唯一根因（01/02/03）：** live Langflow sandbox 對 `POST /api/v1/flows/` 回 `403 {"detail":"No authentication credentials provided"}`；production `LangflowAdapter` 依設計不持有憑證 → live deploy/execute 環境性阻擋；AIOS 端一律 fail-closed（Run 絕未 `SUCCEEDED`）。

---

### 01 complaint（正向全管線）

- **目的：** `email-triage-readonly-v1` complaint IR → compile → FlowArtifact → VALIDATED → deployment gate → 真 `LangflowAdapter@7860` pilot 執行。
- **指令：**
  `npx tsx .scratch/aios-client-langflow-platform/tests/t20-poc-01-complaint.test.ts`
- **關鍵真實輸出（log）：**
  ```
  PASS  no send/write/gated nodes in artifact
  PASS  live Langflow health healthy — latencyMs=13
  evidence: RuntimeDeployment count before=0
  BLOCKED  activateDeployment live deploy — langflow HTTP 403: {"detail":"No authentication credentials provided"}
  PASS  after failed activate: zero SUCCEEDED runs
  BLOCKED  pilot execute — skipped — no active deployment (activate failed earlier)
  ── summary: 17 passed, 0 failed, 2 blocked ──
  ```
- **DB before/after：** activate 失敗後 `zero SUCCEEDED runs`；無假成功部署。
- **判定：** PASS-with-BLOCKED（Langflow API auth）。

### 02 quotation（正向 + 決定性）

- **目的：** quotation 分類 IR；同一 IR 編譯兩次 byte-identical + 相同 SHA-256。
- **指令：** `…/t20-poc-02-quotation.test.ts`
- **關鍵輸出：**
  ```
  PASS  same IR → same SHA-256 digest
  PASS  canonical JSON byte-identical
  PASS  SHA-256(canonical) === compile digest
  PASS  live health ok — latencyMs=11
  BLOCKED  activateDeployment — langflow HTTP 403: {"detail":"No authentication credentials provided"}
  ── summary: 12 passed, 0 failed, 2 blocked ──
  ```
- **判定：** PASS-with-BLOCKED（同上 Langflow auth）。

### 03 refund（負向 HITL）

- **目的：** `approval-gated-action-v1` checkpoint 在唯一 write 之前；無 APPROVED 則 resume 拒絕。
- **指令：** `…/t20-poc-03-refund.test.ts`
- **關鍵輸出：**
  ```
  PASS  approval.checkpoint is ancestor of unique write node
  PASS  edge checkpoint → gated write
  PASS  resumeRequires='aios.approvalRequest.APPROVED'
  BLOCKED  activateDeployment live — langflow HTTP 403: {"detail":"No authentication credentials provided"}
  PASS  resumePilotRun PENDING → 403 forbidden
  PASS  Run stays AWAITING_REVIEW after rejected resume
  PASS  adapter.resumeRun NOT_APPROVED (Langflow approve has no authority)
  evidence: before/after ApprovalRequest status=PENDING …; Run=AWAITING_REVIEW
  ── summary: 14 passed, 0 failed, 2 blocked ──
  ```
- **判定：** PASS-with-BLOCKED（live deploy）；resume 閘門全綠。

### 04 prompt injection（負向）

- **目的：** 注入字串不擴 node 集合；secret 樣式落地 redact。
- **指令：** `…/t20-poc-04-injection.test.ts`
- **關鍵輸出：**
  ```
  PASS  injection does not change node kind multiset (template-fixed)
  PASS  no send/write/python/filesystem tool from injection
  evidence: DB Run.input (redacted land) = {…"[REDACTED_EMAIL]"…"[REDACTED_API_KEY]"…}
  PASS  secret token not stored plaintext in Run.input
  ── summary: 19 passed, 0 failed ──
  ```
- **判定：** PASS。

### 05 duplicate（負向 idempotency）

- **目的：** 同 messageId 二次 `getOrCreatePilotRun` + 併發 → 單一 Run。
- **指令：** `…/t20-poc-05-duplicate.test.ts`
- **關鍵輸出：**
  ```
  evidence: Run count before first create=0
  evidence: Run count after first create=1
  PASS  second call created=false
  PASS  second call same Run id
  evidence: concurrent Run count for key=1
  PASS  concurrent → single Run row
  ── summary: 11 passed, 0 failed ──
  ```
- **判定：** PASS。

### 06 outage（正向隔離）

- **目的：** dead port 7997 → health/execute fail-closed；Native / compileManifest / MCP 不受影響。
- **指令：** `…/t20-poc-06-outage.test.ts`
- **關鍵輸出：**
  ```
  evidence: health elapsedMs=5 healthy=false detail=langflow unreachable: fetch failed
  evidence: execute status=FAILED DB=FAILED elapsedMs=28
  PASS  explicitly never SUCCEEDED
  PASS  workflow without deployment → NATIVE
  PASS  compileManifest execute≠verify
  PASS  MCP registry query ok — count=0
  ── summary: 14 passed, 0 failed ──
  ```
- **判定：** PASS。（Round 2 補 `rm(agentDir)` cleanup。）

### 07 digest drift（負向）

- **目的：** 竄改 artifactJson → verify 拒絕；activate 零新 deployment。
- **指令：** `…/t20-poc-07-digest-drift.test.ts`
- **關鍵輸出：**
  ```
  evidence: RuntimeDeployment skill count before=0 global=0
  PASS  activateDeployment throws on digest drift
  evidence: RuntimeDeployment skill count after=0 global=0
  PASS  zero new RuntimeDeployment for skill
  ── summary: 9 passed, 0 failed ──
  ```
- **判定：** PASS。

### 08 same-family（負向）

- **目的：** deployment gate + `chooseVerifyEngine` 永不同 family。
- **指令：** `…/t20-poc-08-same-family.test.ts`
- **關鍵輸出：**
  ```
  PASS  chooseVerifyEngine(CODEX, CODEX) ignores same-family config
  evidence: RuntimeDeployment count before=0
  PASS  same-family activate throws conflict
  evidence: RuntimeDeployment count after=0
  ── summary: 16 passed, 0 failed ──
  ```
- **判定：** PASS。

### 09 budget（負向）

- **目的：** 預算耗盡 → `gatewayExecute` / pilot 在 dispatch 前拒絕；CostLog 不增。
- **指令：** `…/t20-poc-09-budget.test.ts`
- **關鍵輸出：**
  ```
  evidence: CostLog total before=1 non-seed=0 spyCalls=0
  PASS  gatewayExecute → 403 BUDGET_EXCEEDED
  PASS  spy dispatch NOT called (reject before dispatch)
  evidence: CostLog total after=1 non-seed=0 spyCalls=0
  PASS  pilot output records BUDGET_EXCEEDED (before adapter dispatch)
  ── summary: 9 passed, 0 failed ──
  ```
- **判定：** PASS。

### 10 MEMBER publish（負向 live HTTP）

- **目的：** MEMBER 對 runtime activate/rollback/deactivate 等 403；deployment 計數不變；confirm skill / approve proposal 403。
- **指令：** `…/t20-poc-10-member-publish.test.ts`
- **關鍵輸出：**
  ```
  evidence: RuntimeDeployment skill before=1 global=1
  PASS  MEMBER activate HTTP 403
  PASS  MEMBER rollback HTTP 403
  PASS  MEMBER deactivate HTTP 403
  evidence: RuntimeDeployment skill after=1 global=1
  PASS  skill deployment count unchanged
  PASS  MEMBER skill confirm HTTP 403
  PASS  skill stays AWAITING_USER_CONFIRM
  PASS  MEMBER proposal approve HTTP 403
  PASS  proposal stays PENDING
  ── summary: 17 passed, 0 failed ──
  ```
- **判定：** PASS。（Round 2 收緊 restrictions 斷言為嚴格 `!includes('t20poc10')`。）

---

## 3. 「所有拒絕發生在 side effect 之前」證據對照

| 案 | 拒絕點 | Side-effect 證據（真實 log） |
|---|---|---|
| 07 digest | `activateDeployment` throw | `before=0 global=0` → `after=0 global=0` |
| 08 same-family | activate conflict | `count before=0` → `after=0` |
| 09 budget | gateway / pilot | `spyCalls=0`；`CostLog total before=1 after=1` |
| 10 MEMBER | HTTP 403 | `skill before=1 global=1` → `after=1 global=1`；skill 仍 `AWAITING_USER_CONFIRM`；proposal 仍 `PENDING` |
| 03 resume | 403 / NOT_APPROVED | `ApprovalRequest still PENDING`；`Run=AWAITING_REVIEW` |
| 05 duplicate | 冪等 | 二次 `created=false`；concurrent `count=1` |
| 06 outage | adapter 失敗 | `status=FAILED` never `SUCCEEDED` |
| 01/02 activate fail | Langflow 403 | `zero SUCCEEDED runs`；不寫假成功 deployment |
| 04 inject | template allowlist | node 集合不變；DB input 已 redact |

---

## 4. 五條紅線 → 證明來源

| 紅線 | 本票證明 | 回歸補強 |
|---|---|---|
| **1. 跨模型驗證閘 execute≠verify** | t20-08 `chooseVerifyEngine` 永不回同 family；same-family activate 拒絕；t20-06 `compileManifest execute≠verify` | t16-model-gateway-negative **60P**；t06-deployment-gate-negative same-family |
| **2. 安全與成本硬約束（fail-closed）** | t20-09 budget 在 dispatch 前 403；CostLog 不增 | t18-hitl-resume budget/dead runtime；t06-regression-neg **ALL PASS** |
| **3. redactor 永遠生效** | t20-04 `Run.input` 存 `[REDACTED_API_KEY]` / `[REDACTED_EMAIL]` | t06-invariants **ALL PASS**；t19-trace-parity trajectory redact |
| **4. 技能永不自動確認** | t20-10 MEMBER confirm → 403；skill 仍 `AWAITING_USER_CONFIRM` | confirm-skill-proposal.test.ts 全過；draft 仍待 FDE |
| **5. 變更生效唯一路徑是 FDE** | t20-10 MEMBER activate/rollback/deactivate/approve proposal → 403；deployment/proposal 零變 | t06-invariants；atg-t02 MEMBER approve 403 |

---

## 5. 回歸結果總表

### 5.1 aios-client-langflow-platform（本 feature 閘）

| 套件 | Log | 結果 |
|---|---|---|
| t06-deployment-gate-negative | `t06-deployment-gate-negative.log` | **28 passed, 0 failed** |
| t16-model-gateway-negative | `t16-model-gateway-negative.log` | **60 passed, 0 failed** |
| t18-idempotency | `t18-idempotency.log` | **14 passed, 0 failed** |
| t18-hitl-resume | `t18-hitl-resume.log` | **20 passed, 0 failed** |
| t18-killswitch-fallback | `t18-killswitch-fallback.log` | **19 passed, 0 failed** |
| t19-audit-chain | `t19-audit-chain.log` | **5 passed, 0 failed** |
| t19-health-isolation | `t19-health-isolation.log` | **16 passed, 0 failed** |
| t19-trace-parity | `t19-trace-parity.log` | **18 passed, 0 failed** |
| t19-pilot-slo | `t19-pilot-slo.log` | **10 passed, 0 failed** |
| t17-production-isolation | `t17-production-isolation.log` | **43 passed, 0 failed (GREEN)** |
| t17-artifact-load | `t17-artifact-load.log` | **13 passed, 0 failed** |

### 5.2 skill-production 五紅線

| 套件 | Log | 結果 |
|---|---|---|
| t06-regression-neg | `t06-regression-neg.ts.log` | **ALL PASS t06-regression-neg** |
| t06-invariants | `t06-invariants.ts.log` | **ALL PASS t06-invariants** |

### 5.3 workbench

| 套件 | Log | 結果 |
|---|---|---|
| confirm-skill-proposal | `confirm-skill-proposal.test.ts.log` | 全過（含 RECORDED 非 CODEX 400 閘） |
| draft-auth-scope | `draft-auth-scope.test.ts.log` | PASS [1]–[4] 全過 |

### 5.4 agent-training-governance

| 套件 | Log | 結果 | 分類 |
|---|---|---|---|
| atg t01 | `atg-t01.log` | **ALL t01 TESTS PASSED** | 綠 |
| atg t02 | `atg-t02.log` | **ALL t02 TESTS PASSED** | 綠 |
| atg t06 | `atg-t06.log` | **ALL t06 TESTS PASSED** | 綠 |
| atg t03 | `atg-t03.log` | `EACCES: permission denied, mkdir '/Users/kevin'` | **environmental** — `.env` `AIOS_DATA_DIR` 指向他機 home；非本票、非 production 回歸失敗 |
| atg t04 | `atg-t04.log` | EACCES `/Users/kevin` + Computer Use 輔助使用未授權 | **environmental** + **known limit #1**（AGENTS.md Computer Use） |
| atg t05 | `atg-t05.log` | EACCES `/Users/kevin` + CU timeout | 同上 |
| atg t08 | `atg-t08.log` | OpenAI Whisper **HTTP 429** `insufficient_quota` / `credit_balance_exhausted` | **environmental**（帳戶額度） |

### 5.5 agent-builder

| 套件 | Log | 結果 | 分類 |
|---|---|---|---|
| agent-builder.test.ts | `agent-builder.test.ts.log` | `ASSERT FAIL: expected PLAN_READY got DISCOVERY` | **pre-existing**；兩次重跑一致（`agent-builder.retry.log` 同錯）→ **route 回 agent-builder 票**，不得標通過 |
| agent-builder.retry | `agent-builder.retry.log` | 同上 | 同上 |

### 5.6 Typecheck

- server / web / mcp：`npx tsc --noEmit` **全過**（本輪驗收彙總）。

---

## 6. Blockers 清單

| ID | 描述 | 影響 | 建議歸屬 |
|---|---|---|---|
| B1 | Live Langflow sandbox（1.11.2, AUTO_LOGIN=true）對 `POST /api/v1/flows/` 回 **403 No authentication credentials provided**；`LangflowAdapter` 不持憑證 | t20-01/02/03 live deploy/execute 只能 BLOCKED；AIOS 端已 fail-closed | Langflow sandbox 設定／adapter 認證策略（獨立票；**非**本票 mock 繞過） |
| B2 | `AIOS_DATA_DIR=/Users/kevin/...` 指向他機 home → atg t03–t05 `EACCES mkdir '/Users/kevin'` | agent-training-governance 部分腳本 | 本機 `.env` 路徑修正（環境） |
| B3 | Codex Computer Use 輔助使用授權未完成（AGENTS.md 已知限制 #1） | atg t04/t05 tools/call | 系統設定授權 / 後續 Computer Use 票 |
| B4 | OpenAI Whisper 帳戶 credit 耗盡（HTTP 429） | atg t08 語音轉錄 | 帳單／額度 |
| B5 | 真 Cherry GUI / Browser journey 未在本票執行 | Exit Criteria 中 browser 路徑 | root Codex / browser handoff 票 |
| B6 | agent-builder `PLAN_READY` vs `DISCOVERY` 不一致 | agent-builder 回歸紅 | **route 回 agent-builder 票**（pre-existing） |

---

## 7. 結論

1. **Phase 5 十大 PoC 驗收閘（可執行部分）全綠：** 10/10 腳本 `exit=0`、`0 failed`；其中 01/02/03 對 live Langflow deploy 誠實 **BLOCKED**，且 AIOS 端零假成功。
2. **拒絕皆發生在 side effect 之前**（§3 表：deployment 計數、CostLog、spy dispatch、ApprovalRequest 狀態、Run 非 SUCCEEDED）。
3. **五條紅線零回歸**（本票 t20-04/08/09/10 + skill-production t06 + workbench confirm 路徑）。
4. **aios-client-langflow-platform 主線回歸全綠**（t06/t16/t17/t18/t19）；環境性失敗已在 §5 標為 pre-existing / environmental，**未寫成通過**。
5. **Production 零改動**完成本票；live Langflow 認證（B1）列為 Phase 5 剩餘 blocker，不得用 mock 宣稱 Production Runtime 完成。

### Round 2 測試修正（審查缺陷）

| 檔案 | 修正 |
|---|---|
| `t20-poc-10-member-publish.test.ts` | restrictions 斷言改為嚴格 `!restrictions.includes('t20poc10')`（移除弱化 OR） |
| `t20-poc-06-outage.test.ts` | `agentDir` 提到 try 外；finally `rm(agentDir, { recursive: true, force: true })` |

重跑（Round 2）：
```
── summary: 14 passed, 0 failed ──   # t20-poc-06-outage
── summary: 17 passed, 0 failed ──   # t20-poc-10-member-publish
```

---

*本報告僅引用 scratchpad 真實 log 與本輪重跑輸出；未捏造 PASS/FAIL。*
