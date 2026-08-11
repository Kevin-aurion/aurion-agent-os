# Ticket 21 — Phase 6 企業強化基礎與復原演練報告

**日期：** 2026-08-08
**工作樹：** `web os system/aios-server`（aios-client-langflow-platform）
**對應票：** `.scratch/aios-client-langflow-platform/issues/21-phase6-hardening.md`
**規格：** `.scratch/aios-client-langflow-platform/spec.md`（Phase 6）
**Runbook：** `web os system/docs/langflow-backup-dr-runbook.md`

**本輪缺陷修正（審查後）：**
1. DB dump 不得留在 repo → drill 改 OS `tmpdir` + `finally` 清除；刪除 `.scratch/.../scratchpad/`
2. restore 以 `AIOS_DR_ADMIN_URL` 閉環（僅 `aios_dr_drill_*` CREATE/DROP）
3. 本報告（真實重跑輸出，無捏造 PASS）

---

## 1. 執行環境

| 項目 | 實況 |
|---|---|
| Node | v22.23.2（`PATH=/opt/homebrew/opt/node@22/bin:$PATH`） |
| DB | 真 Postgres `127.0.0.1:5433` / `aios`（`DATABASE_URL`） |
| DR admin | `AIOS_DR_ADMIN_URL=postgresql://kaikaiwu@127.0.0.1:5433/postgres`（僅 drill restore） |
| Qdrant | **6333 未啟動** → Knowledge live 僅驗證 fail-closed 503 |
| Langflow sandbox | `127.0.0.1:7860`（restart + health） |
| Langflow production | compose up/health/down on 7861 |
| Cleanup | 測試只刪自建列；dump 只在 OS tmp，`finally` rmSync |

---

## 2. 型別／Schema／Migration

| 檢查 | 實跑結果 |
|---|---|
| `npx tsc --noEmit`（aios-server） | **零錯誤** |
| `npx prisma validate` | **The schema at prisma/schema.prisma is valid** |
| `npx prisma migrate status` | **32 migrations**；**Database schema is up to date**（含 `20260808140000_phase6_runtime_hardening`） |

---

## 3. t21 五腳本（本輪重跑）

| # | 腳本 | 判定 | Summary（真實） |
|---|---|---|---|
| 1 | `t21-service-identity.test.ts` | **PASS** | `22 passed, 0 failed` |
| 2 | `t21-rate-circuit-dlq.test.ts` | **PASS** | `30 passed, 0 failed` |
| 3 | `t21-knowledge-contract.test.ts` | **PASS**（live 為 fail-closed 503） | `17 passed, 0 failed, 0 blocked` |
| 4 | `t21-slo-alerts.test.ts` | **PASS** | `20 passed, 0 failed` |
| 5 | `t21-backup-restore-drill.ts` | **PASS** | `4 passed, 0 failed, 0 blocked` |

### 3.1 Drill 全文（帶 AIOS_DR_ADMIN_URL）

指令：
```bash
export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
AIOS_DR_ADMIN_URL='postgresql://kaikaiwu@127.0.0.1:5433/postgres' \
  npx tsx .scratch/aios-client-langflow-platform/tests/t21-backup-restore-drill.ts
```

真實輸出：
```
── t21-backup-restore-drill ──
info: AIOS_DR_ADMIN_URL set (user=kaikaiwu@127.0.0.1:5433) — used only for aios_dr_drill_* CREATE/restore/DROP
PASS  pg_dump (95ms) — bytes=279193; path under os.tmpdir (not repo)
PASS  restore+verify (409ms) — counts match; digestSample=e3b0c44298fc; scratch aios_dr_drill_1786166365494 dropped
PASS  langflow-sandbox-restart (18878ms) — 7860/health ok
PASS  langflow-production-rebuild (18742ms) — up+health+down ok

── drill summary ──
  passed   pg_dump                              95ms  bytes=279193; path under os.tmpdir (not repo)
  passed   restore+verify                      409ms  counts match; digestSample=e3b0c44298fc; scratch aios_dr_drill_1786166365494 dropped
  passed   langflow-sandbox-restart          18798ms  7860/health ok
  passed   langflow-production-rebuild       18742ms  up+health+down ok

── total: 4 passed, 0 failed, 0 blocked ──
cleanup: removed tmp dump dir /var/folders/.../T/aios-dr-Po6GWC
```

（上表 sandbox/production elapsed 以 drill summary 為準：18798ms / 18742ms。）

防呆：`assertScratchDbName` 僅允許 `aios_dr_drill_*`；dump 在 OS tmp；`finally` 刪除；repo 內無 `aios-dump.sql`。

**digest 抽查說明（誠實）：** 演練當下來源庫 `FlowArtifact` 列數為 **0**（`SELECT COUNT(*) FROM "FlowArtifact"` → 0），故 digest 樣本字串為空，`digestSample=e3b0c44298fc` 為 **sha256(空字串) 前 12 hex**，不是捏造的 artifact digest。`FlowArtifact`／`RuntimeDeployment`／`Run`／`AuditLog` **count 來源＝scratch 一致** 仍成立，且 scratch DB 已 DROP。若日後庫內有 artifact，同一腳本會比對非空 id|digest 樣本。

### 3.2 其餘 t21 摘要摘錄

```
── t21-service-identity ── summary: 22 passed, 0 failed ──
── t21-rate-circuit-dlq ── summary: 30 passed, 0 failed ──
── t21-knowledge-contract ── summary: 17 passed, 0 failed, 0 blocked ──
  (Qdrant down: recallHitsStrict throw / route 503 fail-closed，非空陣列假成功)
── t21-slo-alerts ── summary: 20 passed, 0 failed ──
```

---

## 4. 回歸（本輪重跑）

| 腳本 | Summary |
|---|---|
| `t16-model-gateway-negative.test.ts` | **60 passed, 0 failed** |
| `t06-deployment-gate-negative.test.ts` | **28 passed, 0 failed** |
| `t18-idempotency.test.ts` | **14 passed, 0 failed** |
| `t18-killswitch-fallback.test.ts` | **19 passed, 0 failed** |
| `t18-hitl-resume.test.ts` | **20 passed, 0 failed** |

Legacy model gateway（KEYS 未設）零回歸；Runtime ≠ Engine（t06 Engine enum 無 LANGFLOW）維持。

---

## 5. 交付對照（Phase 6 六件事）

| 項 | 狀態 | 證據 |
|---|---|---|
| A Service identity + env binding | 完成 | t21-service-identity 22P；wrong-env 403 + spy 0 |
| B Rate / circuit / DLQ / replay | 完成 | t21-rate-circuit-dlq 30P；replay 409 exactly-once |
| C Knowledge capability contract | 完成 | 純 contract 403；route 403；Qdrant 503 fail-closed；compose 無 qdrant/6333 |
| D Backup / DR drill + runbook | 完成 | drill 4P；runbook §3.1 admin URL；tmpdir dump |
| E SLO alerts | 完成 | evaluateSloAlerts + `/api/dashboard/slo-alerts`；t21-slo 20P |
| F AGENTS 已知限制 | 完成 | AGENTS.md §10 第 10 條 |

---

## 6. 五條紅線對應證據

| 紅線 | 證據 |
|---|---|
| 1. execute ≠ verify 閘不可弱化 | model gateway 仍 server-side `chooseVerifyEngine`；t16 same-family → CODEX；t18 回歸綠 |
| 2. 限制／預算／閘門 fail-closed | rate/circuit/env/identity 程式碼層 403/FAILED；budget 路徑 t18-hitl 綠 |
| 3. redact 落地永遠生效 | DLQ `redactSecrets`/`deepRedactSecrets`；gateway 回傳 text redact |
| 4. Skill 永不自動確認 | 本票未改 skill confirm 路徑；部署閘 t06 仍需 CONFIRMED + eval |
| 5. 變更生效唯一 FDE | DLQ list/replay/discard 皆 `requireTrainer`；MEMBER replay 403 |

---

## 7. Blockers（誠實）

1. **Qdrant 6333 未啟動** → Knowledge **live 語意檢索**未做端對端命中驗證；僅驗證 **fail-closed 503**（不得回空陣列假成功）。列 **BLOCKED：live recall hits**。
2. **多租戶／per-tenant isolation 未實作**（單租戶邊界）；**無跨企業計費**。
3. **aios 應用角色無 CREATEDB** 屬最小權限；完整 restore 演練需 `AIOS_DR_ADMIN_URL`（已文件化）。未設時 restore 步驟 **BLOCKED**（不假 PASS）。
4. Langflow production **live 業務執行**仍受既有環境限制（本票 drill 只驗證 stateless rebuild health，不宣稱 production 業務 E2E）。

---

## 8. 資料外洩修正（缺陷 1）

| 檢查 | 結果 |
|---|---|
| 刪除 `.scratch/aios-client-langflow-platform/scratchpad/` | **已刪**（目錄不存在） |
| `find .scratch -name aios-dump.sql` | **無** |
| `git status --porcelain` 含 dump | **無** |
| dump 路徑 | `fs.mkdtempSync(path.join(os.tmpdir(), 'aios-dr-'))` + `finally` rmSync |

---

## 9. 主要檔案清單

**新增：** `src/lib/serviceidentity.ts`、`runtimeguard.ts`、`knowledgecapability.ts`、`slo.ts`、`src/routes/knowledgegateway.ts`、`prisma/migrations/20260808140000_phase6_runtime_hardening/`、`docs/langflow-backup-dr-runbook.md`、`tests/t21-*.ts`、`reports/21-phase6-hardening-report.md`

**修改：** `modelgateway` lib/routes、`runtimeexecution`、`runtime` routes、`dashboard`、`index`、`memoryService`/`index`、`schema.prisma`、`AGENTS.md`

**未** commit / push。
