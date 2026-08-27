# Langflow FDE Sandbox（Runtime Sandbox Lab）

> **FDE-only。** 這不是 AIOS Engine，也不是 Production Runtime。
> 對應決策：[ADR 0013 — 乾淨室 Client 與 Langflow Runtime](../docs/adr/0013-clean-room-client-and-langflow-runtime.md)。

## 這是什麼／不是什麼

| 是 | 不是 |
|---|---|
| FDE（`TRAINER` / `OWNER`）用的 **Authoring／Sandbox Lab** | 正式執行引擎（Engine：`CLAUDE_CODE` / `CODEX` / `GROK`） |
| 未來 Runtime Adapter 的 **隔離實驗場** | Production Runtime 或預設 `docker compose` 的一部分 |
| loopback-only、可丟棄（disposable）沙盒 | 持有 AIOS／provider **Production credential** 的環境 |

**Langflow = Runtime Sandbox（沙盒執行器候選），不是 Engine。**
AIOS 仍是 Agent、Skill、Tool、核准、成本與稽核的唯一控制平面；本 lab 不承接正式憑證、不掛載正式資料、不進入預設基建啟動路徑。

## 隔離保證（必讀）

1. **Top-level project name 隔離**
   compose 檔頂層固定 `name: aios-langflow-sandbox`，與同目錄預設 compose 的 project scope（例如目錄推導名或 `aios`）**分離**，避免 volume／network／container 命名空間互相污染。

2. **僅綁 127.0.0.1:7860**
   不對 LAN／公網暴露。

3. **無 `env_file`、無 provider key**
   不引用 `../.env`、`.env` 或任何 AIOS／OpenAI／OpenRouter／Google／Microsoft／LINE 正式金鑰。Sandbox 內僅有 lab 用的 placeholder（例如 `LANGFLOW_SECRET_KEY` 的 sandbox-only 字串、固定 `LANGFLOW_API_KEY`），**不是** Production credential。

4. **獨立 disposable volume／network**
   - volume：`aios_langflow_sandbox`（可 `down -v` 整包丟棄）
   - network：`aios_langflow_sandbox_net`
   - **不**使用 `aios_pgdata`、`aios_redis`、`aios-data` 等正式資源。

5. **預設 compose 不會啟動它**
   必須顯式 `-f docker-compose.langflow-sandbox.yml`。對 `docker-compose.yml` 執行 `up -d` **不會**拉起 Langflow。

6. **只能使用去識別測試資料**
   禁止匯入真實客戶／員工個資、正式 token、正式 DB dump。Lab 內 SQLite 與設定皆可丟棄。

## 指令（一律顯式 `-f`）

工作目錄：`web os system/`（本檔與 compose 同層）。

### 啟動

```bash
docker compose -f docker-compose.langflow-sandbox.yml up -d
```

可選：等待健康就緒

```bash
docker compose -f docker-compose.langflow-sandbox.yml up -d --wait
```

### 健康檢查

```bash
curl -sS -o /dev/null -w "%{http_code}\n" http://127.0.0.1:7860/health
# 預期：200
```

瀏覽器（僅本機）：`http://127.0.0.1:7860`（lab UI；`LANGFLOW_AUTO_LOGIN=true` 僅此 sandbox）

### Sandbox Flow API 認證（`x-api-key`）

Langflow 1.11+ 的 Flow API 需要 API key。本 sandbox **固定**本機 placeholder（可寫死在 compose／測試），與 Production **完全分離**：

| 項目 | 值 |
|---|---|
| `LANGFLOW_API_KEY_SOURCE` | `env` |
| `LANGFLOW_API_KEY` | `sandbox-flow-api-key-not-production-local-only-v1` |
| 呼叫端 header | `x-api-key: sandbox-flow-api-key-not-production-local-only-v1` |

```bash
# 無 header → 預期 401/403（Flow API）
curl -sS -o /dev/null -w "%{http_code}\n" http://127.0.0.1:7860/api/v1/flows/

# 帶 sandbox placeholder → 預期 2xx（本機 lab only）
curl -sS -o /dev/null -w "%{http_code}\n" \
  -H "x-api-key: sandbox-flow-api-key-not-production-local-only-v1" \
  http://127.0.0.1:7860/api/v1/flows/
```

**禁止**把 `AIOS_LANGFLOW_PRODUCTION_API_KEY`／Production Runtime key 用在 `127.0.0.1:7860`。
Production 用獨立 compose（`7861`）與獨立 fail-closed host 變數；Sandbox 用上述固定 placeholder（非 `sk-…`、非 provider key、可丟棄）。

### 停止（保留 volume）

```bash
docker compose -f docker-compose.langflow-sandbox.yml down
```

### 完全重置（刪除 disposable volume）

```bash
docker compose -f docker-compose.langflow-sandbox.yml down -v
```

`down -v` 會清空 lab 狀態（SQLite、設定目錄等）。需要乾淨重來時用此指令。

### 其他常用

```bash
# 檢視解析後設定（應含 name: aios-langflow-sandbox，且無正式憑證）
docker compose -f docker-compose.langflow-sandbox.yml config

# 服務列表
docker compose -f docker-compose.langflow-sandbox.yml config --services

# 容器日誌
docker compose -f docker-compose.langflow-sandbox.yml logs -f
```

## 版本與埠

| 項目 | 值 |
|---|---|
| Image | `langflowai/langflow:1.11.2`（固定 pin，禁止 `latest`） |
| Host bind | `127.0.0.1:7860` → container `7860` |
| Container name | `aios-langflow-sandbox` |
| Compose project name | `aios-langflow-sandbox` |
| DB | 容器內 SQLite（named volume），**不是** Production Postgres |

## 與 ADR 0013 的對齊

- AIOS **不**把 Langflow 當成控制平面或第二套 Registry／Approval／Scheduler。
- FDE Authoring Lab 與 Production Runtime **必須隔離**（本檔即 Lab 邊界）。
- 正式模型與 Tool 呼叫仍經 AIOS 治理閘；本 sandbox **不**注入 Production credential。
- 未來若經 Runtime Adapter 接正式執行，須另走核准與內容定址的 Flow Artifact 路徑——**不**等於直接把本 lab 升格為 Production。

## 安全檢查清單（啟動前）

- [ ] 指令使用 `docker compose -f docker-compose.langflow-sandbox.yml …`，未改到預設 `docker-compose.yml`
- [ ] `config` 輸出無 `env_file`、無正式 `DATABASE_URL`／API keys
- [ ] `LANGFLOW_API_KEY_SOURCE=env` 且 `LANGFLOW_API_KEY` 恰為 sandbox placeholder（非 Production key）
- [ ] **絕不**在 7860 使用 `AIOS_LANGFLOW_PRODUCTION_API_KEY`
- [ ] 埠僅 `127.0.0.1:7860`
- [ ] 僅準備去識別測試資料
- [ ] 實驗結束可執行 `down -v` 丟棄全部 lab 狀態
