# Langflow Production Runtime

> **Production Runtime 隔離執行器。** 這不是 FDE Sandbox，也不是 AIOS Engine。
> 對應決策：[ADR 0013 — 乾淨室 Client 與 Langflow Runtime](../docs/adr/0013-clean-room-client-and-langflow-runtime.md)。
> 契約測試：`aios-server/.scratch/aios-client-langflow-platform/tests/t17-production-isolation.test.ts`、
> `t17-artifact-load.test.ts`。

## 這是什麼／不是什麼

| 是 | 不是 |
|---|---|
| 與 Sandbox **完全分離** 的 **Production Runtime** | FDE Authoring／Sandbox Lab（`docker-compose.langflow-sandbox.yml`） |
| 只承載 **已核准**（active + digest 驗證通過）的 Flow Artifact | 正式控制平面（Agent／Skill／核准／成本／稽核仍是 **AIOS**） |
| loopback-only、唯讀 rootfs、tmpfs-only、零 provider credential | Engine（`CLAUDE_CODE` / `CODEX` / `GROK`） |
| `LANGFLOW_BACKEND_ONLY=true`（無 End-User UI） | 預設 `docker compose up -d` 的一部分 |

**Runtime ≠ Engine。** Langflow 在此僅作為 RuntimeKind `LANGFLOW` 的執行器；
AIOS 仍是唯一控制平面。Artifact 必須經 `src/runtime/productionloader.ts` fail-closed 載入後，
再由 `LangflowAdapter.deployArtifact` 推送（建議 `AIOS_LANGFLOW_RUNTIME_URL=http://127.0.0.1:7861`）。

## 隔離保證（必讀）

| 面向 | Production | Sandbox |
|---|---|---|
| Compose project `name` | `aios-langflow-production` | `aios-langflow-sandbox` |
| Network | `aios_langflow_production_net` | `aios_langflow_sandbox_net` |
| Host port | `127.0.0.1:7861` | `127.0.0.1:7860` |
| Volumes | **無**（tmpfs only） | disposable named volume `aios_langflow_sandbox` |
| Credentials | shell 引用 `AIOS_LANGFLOW_PRODUCTION_SECRET_KEY` + `AIOS_LANGFLOW_PRODUCTION_API_KEY` + `AIOS_LANGFLOW_PRODUCTION_SUPERUSER_PASSWORD`（皆非 provider key） | sandbox-only placeholder secret |
| API auth | `LANGFLOW_API_KEY_SOURCE=env`；呼叫端 `x-api-key`（`AUTO_LOGIN=false`） | lab 可另設 |
| UI | backend-only，無 End-User UI | 可本機開啟 lab UI |
| rootfs | `read_only: true` + `cap_drop: ALL` + `no-new-privileges` | 未硬化（lab） |

其他硬化：

1. **唯讀 rootfs** + **cap_drop ALL** + **security_opt: no-new-privileges:true**
2. **tmpfs-only** 可寫目錄（`/tmp`、`/app/langflow` 等）；**禁止** named volume／bind mount
3. **資源限制**（`deploy.resources.limits` + `mem_limit`/`cpus`）
4. **無 `env_file`**、無 AIOS JWT／encryption key、無 OpenAI／Anthropic／xAI／Google／Microsoft／LINE／Postgres／Redis／Qdrant 任何 key
5. **無 Custom Component upload UI**（backend-only ⇒ 無 UI 寫入面）
6. **不隨預設 compose 啟動** — 必須顯式 `-f docker-compose.langflow-production.yml`
7. **容器內零 provider credential** ⇒ 無法直接對 Claude／Codex／Grok／Gmail／Graph 等 provider 出網；正式模型／工具呼叫一律應經 AIOS Model Gateway（`/internal/model/*`）與 Capability Gateway

## Secrets reference（fail-closed）

啟動前必須在 **主機 shell** 設定（**不要**寫進 compose 檔或把真實值寫進版控；本機 `.env` 若使用須 gitignored 且權限 0600）：

```bash
export AIOS_LANGFLOW_PRODUCTION_SECRET_KEY=$(openssl rand -hex 32)
export AIOS_LANGFLOW_PRODUCTION_API_KEY=$(openssl rand -hex 32)
export AIOS_LANGFLOW_PRODUCTION_SUPERUSER_PASSWORD=$(openssl rand -hex 32)
```

| Host env | 注入容器為 | 用途 |
|---|---|---|
| `AIOS_LANGFLOW_PRODUCTION_SECRET_KEY` | `LANGFLOW_SECRET_KEY` | Langflow 內部加密用 secret |
| `AIOS_LANGFLOW_PRODUCTION_API_KEY` | `LANGFLOW_API_KEY`（搭配 `LANGFLOW_API_KEY_SOURCE=env`） | **控制平面** Flow API 認證（`x-api-key`） |
| `AIOS_LANGFLOW_PRODUCTION_SUPERUSER_PASSWORD` | `LANGFLOW_SUPERUSER_PASSWORD` | 本機 bootstrap 密碼（**與 SECRET_KEY 分離**，可獨立輪替） |

- 任一未設定時，`docker compose … config` / `up` **fail-closed 拒絕**（`${…:?…}`）。
- 三者都是 **Langflow 本機 runtime 祕密**，**不是** provider API key，也不是 AIOS JWT／encryption key。
- 禁止把 Anthropic／OpenAI／xAI／Google／Microsoft／LINE 等真實金鑰注入本容器。
- AIOS 後端：`resolveRuntimeAdapter('LANGFLOW')` 同樣要求 `AIOS_LANGFLOW_RUNTIME_URL` + `AIOS_LANGFLOW_PRODUCTION_API_KEY`；`LangflowAdapter` 對所有 HTTP（health／deploy／execute／resume）統一附加 `x-api-key`。

### 輪替（API key）

1. 產生新 key：`export AIOS_LANGFLOW_PRODUCTION_API_KEY=$(openssl rand -hex 32)`
2. 同步更新 AIOS 主機環境（後端讀同一變數）
3. `docker compose -f docker-compose.langflow-production.yml up -d --force-recreate --wait`
4. 舊 key 立即失效（`LANGFLOW_API_KEY_SOURCE=env` 只認當前 env 值）
5. **不要**在 log、trace、ticket 報告或 git 中印出 key 值

## Header 契約

| Header | 誰送 | 說明 |
|---|---|---|
| `x-api-key: <AIOS_LANGFLOW_PRODUCTION_API_KEY>` | AIOS `LangflowAdapter` 共用 HTTP helper | 所有 Langflow HTTP 請求必帶；key 不得出現在錯誤訊息／log |
| （無此 header 或錯誤 key） | — | Flow API **403** fail-closed（`LANGFLOW_AUTO_LOGIN=false`） |

不得改成 `LANGFLOW_AUTO_LOGIN=true` 或 skip-auth。

## 指令（一律顯式 `-f`）

工作目錄：`web os system/`（本檔與 compose 同層）。

### 啟動

```bash
export AIOS_LANGFLOW_PRODUCTION_SECRET_KEY=$(openssl rand -hex 32)
export AIOS_LANGFLOW_PRODUCTION_API_KEY=$(openssl rand -hex 32)
export AIOS_LANGFLOW_PRODUCTION_SUPERUSER_PASSWORD=$(openssl rand -hex 32)
docker compose -f docker-compose.langflow-production.yml up -d --wait
```

### 健康檢查

```bash
curl -sS -o /dev/null -w "%{http_code}\n" http://127.0.0.1:7861/health
# 預期：200（/health 可能不要求 key；Flow API 需要）

# 無 header → 預期 403
curl -sS -o /dev/null -w "%{http_code}\n" http://127.0.0.1:7861/api/v1/flows/

# 帶控制平面 key（值來自 env，勿貼到版控）→ 預期 2xx
curl -sS -o /dev/null -w "%{http_code}\n" \
  -H "x-api-key: ${AIOS_LANGFLOW_PRODUCTION_API_KEY}" \
  http://127.0.0.1:7861/api/v1/flows/
```

### 停止

```bash
docker compose -f docker-compose.langflow-production.yml down
```

無 durable named volume 需保留；容器狀態皆可丟棄。

### 重建 drill（durable state 在 AIOS Postgres）

```bash
# 1) 記錄 AIOS 表列數（flowArtifact / runtimeDeployment / skill / user 等）
# 2) 重建容器
docker compose -f docker-compose.langflow-production.yml down
docker compose -f docker-compose.langflow-production.yml up -d --wait
# 3) 再讀同一批 counts — 必須完全相同
```

Production 容器可任意重建；**不影響** AIOS Postgres 中的 FlowArtifact／RuntimeDeployment 等 durable 資料。

### 其他常用

```bash
# 解析後設定（需已 export secret；應見 name: aios-langflow-production）
docker compose -f docker-compose.langflow-production.yml config

# 日誌（若 health 未就緒）
docker compose -f docker-compose.langflow-production.yml logs
```

## Artifact 載入路徑

1. FDE 核准並 **activate** 的 `RuntimeDeployment`（`environment=PRODUCTION`、`active=true`）
2. 關聯 `FlowArtifact` 必須 `status=VALIDATED`
3. `src/runtime/productionloader.ts`：
   - `loadProductionArtifact(deploymentId)` — fail-closed 依序驗證 deployment／env／active／status／digest
   - `listLoadableProductionArtifacts()` — 僅回傳通過者；digest drift／inactive 進 `skipped`，**永不**進 loadable
4. 通過後由 `LangflowAdapter.deployArtifact` 推送到 Runtime（`AIOS_LANGFLOW_RUNTIME_URL=http://127.0.0.1:7861`）

| 情況 | 結果 |
|---|---|
| active + VALIDATED + digest 相符 | 可載入 |
| `active=false` | `NOT_ACTIVE`（拒絕） |
| `environment≠PRODUCTION` | `WRONG_ENVIRONMENT` |
| `status≠VALIDATED` | `NOT_VALIDATED` |
| artifactJson 被竄改（digest drift） | `DIGEST_MISMATCH` |
| id 不存在 | `NOT_FOUND` |

## Egress 姿態與已知限制（誠實邊界）

- **容器內零 provider credential** ⇒ Production Langflow **不能**直接對外部 LLM／郵件／Graph API 出網完成正式工作。
- 正式模型與工具呼叫 **一律應經** AIOS：
  - Model Gateway：`/internal/model/*`
  - Capability Gateway（權限／限制／預算）
- **已知限制（不得謊稱已完成）**：AIOS server 綁 `127.0.0.1:8700`，**容器內 flow 要回呼 host gateway 的 live 路徑尚未打通**（屬票 16／18 的 live 整合範圍）。本票只建立 **隔離的 Production Runtime 底座** + **fail-closed artifact loader**，不宣稱端到端 model 回呼已可用。

## 版本與埠

| 項目 | 值 |
|---|---|
| Image | `langflowai/langflow:1.11.2`（固定 pin，禁止 `latest`） |
| Host bind | `127.0.0.1:7861` → container `7860` |
| Container name | `aios-langflow-production` |
| Compose project name | `aios-langflow-production` |
| Network | `aios_langflow_production_net` |
| DB | tmpfs 上 SQLite（`sqlite:////tmp/langflow/production.db`），**不是** AIOS Postgres |
| UI | 無（`LANGFLOW_BACKEND_ONLY=true`） |

## 安全檢查清單（啟動前）

- [ ] 指令使用 `docker compose -f docker-compose.langflow-production.yml …`，未改預設／sandbox compose
- [ ] 已 `export` `AIOS_LANGFLOW_PRODUCTION_SECRET_KEY`、`AIOS_LANGFLOW_PRODUCTION_API_KEY`、`AIOS_LANGFLOW_PRODUCTION_SUPERUSER_PASSWORD`（任一未設定應 fail-closed；後者與 SECRET 分離）
- [ ] `LANGFLOW_API_KEY_SOURCE=env`、`LANGFLOW_AUTO_LOGIN=false`、backend-only
- [ ] `config` 無 `env_file`、無 provider／AIOS 正式 key、無 `postgresql://`／`redis://`
- [ ] 埠僅 `127.0.0.1:7861`，與 sandbox `7860` 不相交
- [ ] 無 named volume／bind mount；`read_only` + `cap_drop: ALL` + tmpfs
- [ ] 只推送經 productionloader 驗證的 active＋VALIDATED＋digest 相符 Artifact
- [ ] AIOS Adapter 以 `x-api-key` 呼叫 Flow API；無 header 應 403
- [ ] 不把 Claude／Codex／Grok／Gmail／Graph provider key 注入本容器
- [ ] 不假設容器可直接回呼 AIOS gateway（live 整合見票 16／18）
- [ ] 實驗／輪替結束可 `down`（無 durable volume 需 `down -v`）
