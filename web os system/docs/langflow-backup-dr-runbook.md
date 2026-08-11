# Langflow Runtime 備份與災難復原 Runbook（Phase 6）

> 適用範圍：AIOS control-plane（Postgres）+ FlowArtifact／RuntimeDeployment metadata + Langflow Sandbox／Production **stateless** runtime。
> **明確聲明：多租戶／per-tenant isolation 尚未完成**（目前為單租戶產品邊界）；**無跨企業計費**。本 runbook 不宣稱 multi-tenant DR 完成。

最後更新：2026-08-08（票 21）。

---

## 1. 責任邊界

| 元件 | 是否含 durable state | 備援策略 |
|---|---|---|
| AIOS Postgres（`127.0.0.1:5433` / DB `aios`） | **是** — 員工、技能、Artifact、Deployment、Run、Audit、DLQ | `pg_dump` / `psql` restore |
| FlowArtifact / RuntimeDeployment | **是**（在 Postgres） | 隨 DB 備份；restore 後以 count + digest 抽查 |
| Langflow Sandbox（7860） | 可拋棄 named volume | `docker restart` 或 `compose down -v` 後重建 |
| Langflow Production（7861） | **無** durable volume（tmpfs only） | `compose up` 任意重建；Artifact 由 AIOS 再推送 |
| Qdrant（6333） | 記憶向量（非本 runbook 完整範圍） | 另案；Runtime **禁止**直連 Qdrant |

Runtime ≠ Engine：LANGFLOW 永不進入 `Engine` enum。控制平面閘門（預算、核准、service identity、rate/circuit）皆在 AIOS。

---

## 2. AIOS Postgres 備份（pg_dump）

前置：`pg_dump` / `psql`（建議 17.x，`/opt/homebrew/bin`），`DATABASE_URL` 指向 loopback。

```bash
export PATH="/opt/homebrew/bin:$PATH"
# 從 aios-server/.env 取得 DATABASE_URL（勿提交）
set -a && source .env && set +a

# 解析後示例（實際以 .env 為準）
# postgresql://USER:PASS@127.0.0.1:5433/aios

pg_dump -h 127.0.0.1 -p 5433 -U "$PGUSER" -d aios \
  --no-owner --no-acl \
  -f "/path/to/backups/aios-$(date +%Y%m%d-%H%M%S).sql"
```

建議：

- 備份檔權限僅限本機操作者（`chmod 600`）。
- 勿把 dump 上傳到未加密雲端；dump 可能含已 redact 的業務 JSON，但仍屬內部資料。
- 排程可由本機 launchd／cron 執行；AIOS 不內建跨企業備份 SLA。

---

## 3. 還原演練（scratch DB，禁止動原庫）

**紅線：絕不可 `DROP DATABASE aios` 或對正式庫做 destructive restore。**

```bash
SCRATCH="aios_dr_drill_$(date +%s)"
psql -h 127.0.0.1 -p 5433 -U "$PGUSER" -d postgres -c "CREATE DATABASE ${SCRATCH};"
psql -h 127.0.0.1 -p 5433 -U "$PGUSER" -d "$SCRATCH" -v ON_ERROR_STOP=1 -f aios-YYYYMMDD.sql

# 驗證 count
psql ... -d aios -c 'SELECT COUNT(*) FROM "FlowArtifact";'
psql ... -d "$SCRATCH" -c 'SELECT COUNT(*) FROM "FlowArtifact";'
# 同樣比對 RuntimeDeployment / Run / AuditLog

# digest 抽查
psql ... -c 'SELECT id, digest FROM "FlowArtifact" ORDER BY "createdAt" DESC LIMIT 5;'

# 演練結束
psql ... -d postgres -c "DROP DATABASE ${SCRATCH};"
```

自動化腳本（可實跑）：

```bash
cd aios-server
export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
# 完整 restore 需 admin（aios 應用角色通常無 CREATEDB，屬最小權限設計）：
export AIOS_DR_ADMIN_URL='postgresql://kaikaiwu@127.0.0.1:5433/postgres'
npx tsx .scratch/aios-client-langflow-platform/tests/t21-backup-restore-drill.ts
```

腳本會輸出每步 `elapsedMs` 與 `passed/failed/blocked`。

### 3.1 應用角色 vs 演練 admin（最小權限）

| 連線 | 用途 | 可寫目標 |
|---|---|---|
| `DATABASE_URL`（aios 應用角色） | `pg_dump` 來源、count/digest **讀** 正式庫 | **禁止** CREATE/DROP 正式庫；通常 **無 CREATEDB** |
| `AIOS_DR_ADMIN_URL`（可選，本機 superuser／維運角色） | **僅** `CREATE DATABASE aios_dr_drill_*`、restore 進該庫、`DROP DATABASE aios_dr_drill_*` | 程式硬編：目標 DB 名 **必須** 以 `aios_dr_drill_` 開頭，否則拒絕 |

- 未設定 `AIOS_DR_ADMIN_URL` 時：若 aios 角色無法 `CREATE DATABASE`，演練對 restore 步驟誠實標 **BLOCKED**（不得假 PASS）。
- **絕不可** 對 `aios` 原庫執行 DROP／destructive restore；dump 檔只寫 OS `tmpdir`（`fs.mkdtempSync(…/aios-dr-)`），**絕不寫進 repo**，腳本 `finally` 一律 `rmSync`。
- 正式災備 restore 應在**新實例**由維運角色執行，並先驗證 dump 來源與目標庫名。

---

## 4. FlowArtifact / RuntimeDeployment metadata 驗證清單

還原後至少檢查：

1. `FlowArtifact` 列數與來源一致。
2. 最近 N 筆 `digest`（sha256 hex）與來源一致。
3. `RuntimeDeployment`：`active` pointer 列數、`environment`/`channel` 分佈合理。
4. 抽一筆 active PRODUCTION deployment：`artifactId` 指向 `status=VALIDATED` 的 artifact。
5. `Run.runtimeKind` / `artifactId` / `idempotencyKey` 抽樣可讀。
6. `RuntimeDeadLetter`（若有）：`PENDING` 列可在 FDE UI／API 重放（exactly-once）。

---

## 5. Langflow Sandbox 重建（可拋棄）

```bash
cd "web os system"
# 重啟（保留 disposable volume）
docker restart aios-langflow-sandbox
# 輪詢
curl -sf http://127.0.0.1:7860/health

# 完全拋棄 lab state
docker compose -f docker-compose.langflow-sandbox.yml down -v
docker compose -f docker-compose.langflow-sandbox.yml up -d
```

Sandbox 僅 FDE authoring；不承載 production durable state。

---

## 6. Langflow Production 無狀態重建

Production compose：**tmpfs only**、無 named volume／bind mount；容器可任意銷毀。

```bash
export AIOS_LANGFLOW_PRODUCTION_SECRET_KEY=$(openssl rand -hex 32)
docker compose -f docker-compose.langflow-production.yml up -d --wait
curl -sf http://127.0.0.1:7861/health

# 銷毀（無 durable state 需保留）
docker compose -f docker-compose.langflow-production.yml down
```

重建後需由 AIOS `productionloader` + Runtime Adapter **重新推送** active + digest 驗證通過的 Flow Artifact（控制平面在 Postgres，不在 Langflow 容器）。

---

## 7. 災難情境對照

| 情境 | 症狀 | 處置 |
|---|---|---|
| Postgres 損毀 | API／runner 全掛 | 從最新 dump restore 到**新**實例或驗證過的主機；校驗 Artifact digest；重啟 aios-server |
| Langflow sandbox 掛掉 | 7860 health fail | `docker restart` 或 `down -v` + `up`；不影響 production control-plane |
| Langflow production 掛掉 | 7861 health fail | `compose down` + `up --wait`；重新 deploy artifact；circuit 可能 OPEN |
| Circuit OPEN | Run `CIRCUIT_OPEN`、DLQ PENDING | 修復 runtime → 冷卻後 HALF_OPEN 探測；FDE `POST /api/runtime/dead-letters/:id/replay`（exactly-once） |
| Rate limit 打滿 | Run `RATE_LIMITED`、DLQ | 調 `AIOS_RUNTIME_RATE_LIMIT_PER_MIN` 或降載；manual replay |
| Service identity 過期／錯環境 | Gateway 403 | 輪替 `AIOS_SERVICE_IDENTITY_KEYS`（kid.secret）；確認 environment 綁定 |
| Qdrant 不可達 | Knowledge Gateway 503 | **不得**回空陣列假成功；修 Qdrant 後再查。Runtime 禁止直連 |

Dead-letter API（皆 `requireTrainer`）：

- `GET /api/runtime/dead-letters?status=PENDING`
- `POST /api/runtime/dead-letters/:id/replay` — `updateMany` PENDING guard，第二次 409
- `POST /api/runtime/dead-letters/:id/discard`

---

## 8. SLO 與告警

- `GET /api/dashboard/pilot-slo` — 7 日 LANGFLOW 聚合。
- `GET /api/dashboard/slo-alerts` — `evaluateSloAlerts`（errorRate、p95、approval latency、adapterTimeout）。
- **no-data ≠ breach**（`insufficientData: true` 且 alerts 為空）。

---

## 9. 已知限制（不得誇大）

1. **多租戶／per-tenant isolation 未實作**；備份還原不代表跨企業隔離。
2. **無跨企業計費**／無租戶級 quota 報表。
3. Qdrant／embedding 為記憶子系統；本 runbook 以 Postgres + Langflow 為主。
4. Computer Use 真執行、部分 live production 路徑仍受環境限制時應標 **BLOCKED**，不得假成功。
5. Shadow DB 權限不足時，Prisma migrate 可能需 `migrate diff` + 手動 apply（見開發紀錄）；**禁止** `migrate reset` 清正式資料。
6. Postgres 應用角色若無 `CREATEDB`，scratch restore 演練會 **BLOCKED**（`permission denied to create database`）；仍可完成 `pg_dump` 與 Langflow 重建。正式 restore 需具 CREATEDB／superuser 的維運角色在**新實例**執行，絕不可 DROP 正式 `aios`。

---

## 10. 演練建議頻率

| 項目 | 建議 |
|---|---|
| pg_dump 成功性 | 每週 |
| scratch restore + count/digest | 每月或重大 schema 後 |
| Langflow sandbox restart | 每月 |
| Langflow production up/down | 每季或 release 前 |
| DLQ replay 演練 | 變更 runtime guard 後 |

演練輸出應保留 `elapsedMs` 與 passed/failed/blocked，供 Phase 6 驗收與事後檢討。
