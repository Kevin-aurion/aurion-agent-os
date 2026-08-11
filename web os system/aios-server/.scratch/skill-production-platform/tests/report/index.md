# Slice 6 全驗證矩陣證據報告

> 產出時間：2026-07-27
> 工作目錄：`web os system/aios-server`
> 本票範圍：回歸總測 + 文件真實化（**無新業務功能**；未改 `src/**/*.ts` 業務碼、未改 prisma schema/migration）

---

## 1. 基建與型別（實跑）

### 1.1 三處 `npx tsc --noEmit`

| 專案 | 指令 | 結果 |
|---|---|---|
| aios-server | `export PATH="$HOME/.local/node/bin:$PATH"; npx tsc --noEmit` | **exit 0**（0 error） |
| aios-web | 同上（cwd = aios-web） | **exit 0** |
| aios-mcp | 同上（cwd = aios-mcp） | **exit 0** |

### 1.2 Prisma migrate status

```text
$ npx prisma migrate status
Environment variables loaded from .env
Prisma schema loaded from prisma/schema.prisma
Datasource "db": PostgreSQL database "aios", schema "public" at "127.0.0.1:5433"

19 migrations found in prisma/migrations

Database schema is up to date!
```

**結論**：up to date（19 migrations）。本票未新增 migration。

### 1.3 Docker compose

```text
$ docker compose -f "/Users/kevin/Documents/lazyoffice/web os system/docker-compose.yml" ps
NAME            IMAGE                                              SERVICE    STATUS                 PORTS
aios-db         postgres:16-alpine                                 db         Up 13 days (healthy)   127.0.0.1:5433->5432/tcp
aios-docparse   ghcr.io/docling-project/docling-serve-cpu:latest   docparse   Up 6 days (healthy)    127.0.0.1:5001->5001/tcp
aios-qdrant     qdrant/qdrant:latest                               qdrant     Up 13 days             127.0.0.1:6333-6334->6333-6334/tcp
aios-redis      redis:7-alpine                                     redis      Up 13 days (healthy)   127.0.0.1:6380->6379/tcp
```

**結論**：db / redis / qdrant / docparse 皆 Up；db、redis、docparse 標 healthy。

---

## 2. 測試腳本連跑（t01–t06）

指令：

```bash
export PATH="$HOME/.local/node/bin:$PATH"
for f in .scratch/skill-production-platform/tests/t0*.ts; do npx tsx "$f"; done
```

| 腳本 | 成功標記 | exit |
|---|---|---|
| `t01-catalog.ts` | `ALL PASS` | 0 |
| `t01-pathsafety.ts` | `ALL PASS` | 0 |
| `t02-neg.ts` | `ALL PASS` | 0 |
| `t02-promote-gate.ts` | `ALL PASS` | 0 |
| `t03-broker.ts` | `T03 BROKER OK` | 0 |
| `t03-exports.ts` | `T03 EXPORTS OK` | 0 |
| `t03-registry-neg.ts` | `T03 REGISTRY-NEG OK` | 0 |
| `t04-neg.ts` | `T04 NEG OK` | 0 |
| `t04-recording.ts` | `T04 RECORDING OK` | 0 |
| `t05-a2a-neg.ts` | `PASS t05-a2a-neg` | 0 |
| `t05-card.ts` | `PASS t05-card` | 0 |
| `t05-trace.ts` | `PASS t05-trace` | 0 |
| **`t06-invariants.ts`**（本票） | **`ALL PASS t06-invariants`** | **0** |
| **`t06-regression-neg.ts`**（本票） | **`ALL PASS t06-regression-neg`** | **0** |

完整串流日誌：同目錄 `t0-run.log`。

### 2.1 t06-invariants 摘要

```text
── compileManifest autoVerify mapping ──
── engineVerify override GROK ──
── engineVerify === execute ignored ──
── isApproved oracle ──
── redactSecrets ──
── MEMBER/FDE promote + proposal ──
ALL PASS t06-invariants
```

### 2.2 t06-regression-neg 摘要

```text
── non-loopback MCP rejected ──
── unconfirmed skill excluded from compileManifest ──
── promote without PASSED → 409 ──
── MEMBER promote → 403 ──
── path traversal blocked ──
── budget decideBudget fail-closed ──
ALL PASS t06-regression-neg
```

---

## 3. 不變式矩陣（PASS + 腳本）

| 不變式 | 結果 | 驗證腳本 |
|---|---|---|
| 跨模型 execute≠verify（autoVerify 映射 + 覆寫永不等於 execute） | **PASS** | `t06-invariants`（+ `t02-promote-gate` / `t02-neg` 評測同引擎 400） |
| isApproved fail-closed（REJECTED 先於 APPROVED；句中不算） | **PASS** | `t06-invariants` |
| budget fail-closed（日預算 ≥ 上限 → denied） | **PASS** | `t06-regression-neg`（`decideBudget`） |
| restriction / 越矩硬閘（本輪回歸沿用既有負向） | **PASS** | 既有 t02/t03/t04/t05 閘；本票不擴業務碼 |
| redactor 落地（key/email → REDACTED_*） | **PASS** | `t06-invariants`（+ t02 evidence redact） |
| MEMBER/FDE 分離（MEMBER promote 403；提案 PENDING 不物化） | **PASS** | `t06-invariants` / `t06-regression-neg` / `t02-neg` |
| 路徑穿越擋下（assertInsideRoot throw；safeJoin 不逃逸；sanitize 去 sep） | **PASS** | `t06-regression-neg`（+ `t01-pathsafety`） |
| 非 loopback MCP 拒絕（evil 前綴 / 10.x → 400） | **PASS** | `t06-regression-neg` / `t03-registry-neg` |
| 未確認技能不入 compile catalog | **PASS** | `t06-regression-neg` / `t01-pathsafety` |
| 未過 eval 不得 promote（409，stable null） | **PASS** | `t06-regression-neg` / `t02-neg` / `t06-invariants`（FDE 無 PASSED 亦 409） |

**缺陷→修補**：本票實跑未揭露業務碼缺陷；**未修改** `src/**/*.ts`。

---

## 4. Computer Use 誠實段落

依 `docs/adr/0005-codex-engine-for-recorded-skills.md`（文末「已知限制（Slice 6 更新）」）與 AGENTS.md §10：

- Computer Use MCP **握手**與 **`tools/list`（約 10 工具）**可正常完成。
- 真實 **`tools/call` 會 timeout**（`codex exec` 亦約 10 分鐘無回應）；研判需 Codex/ChatGPT App UI 端確認或特定授權脈絡。
- **本票不宣稱 live Computer Use 成功**。錄製匯入／所有權／RECORDED→CODEX 掛載閘與 redactor 可獨立驗收（t04），與 live 操控解耦。

---

## 5. 文件真實化產物

### ADR（`docs/adr/`，Nygard 風格）

本票新增 6 篇 ADR，接續 repo 既有 `docs/adr/` 系列（既有 0001–0006 為技能工廠/所有權/提案佇列/越矩偵測/CODEX 錄製引擎/語音），編號延續為 0007–0012：

| 檔 | Status |
|---|---|
| `0007-cross-model-verification-gate.md` | Accepted |
| `0008-failclosed-cost-and-restriction.md` | Accepted |
| `0009-eval-suite-and-promote-gate.md` | Accepted |
| `0010-mcp-gateway-broker.md` | Accepted |
| `0011-recording-service-ownership.md` | Accepted |
| `0012-a2a-boundary.md` | Accepted（預設停用） |

> Computer Use 已知限制併入既有 `0005-codex-engine-for-recorded-skills.md`（文末「已知限制（Slice 6 更新）」＋狀態行修正），未另建重號檔；程式碼註解 `ADR 0003/0004/0005` 皆對應既有 canonical 檔。

### AGENTS.md（最小外科手術）

- §4 models/enums 計數 24/19 → **33/27**，append 評測/閘門/互通一行 + enum 註記
- §5 route 檔 17 → **20**，append evals / mcp / a2a
- §6 lib 17 → **27**，append eval/skillpromote、mcp*、trace/agentcard/a2a、skillgate
- §10 第 7 條修正 MCP gateway 已完成；append 第 8（A2A）、第 9（eval 閘）

### CLAUDE.md

- `src/routes/CLAUDE.md`：append evals/mcp/a2a
- `src/lib/CLAUDE.md`：append 新 lib 用途
- `src/ws/CLAUDE.md`：**未改**（無 slice4 錄製/進度 topic 追加必要）

---

## 6. 本票新增／修改檔案清單

**新增**

- `.scratch/skill-production-platform/tests/t06-invariants.ts`
- `.scratch/skill-production-platform/tests/t06-regression-neg.ts`
- `.scratch/skill-production-platform/tests/report/index.md`（本檔）
- `.scratch/skill-production-platform/tests/report/t0-run.log`（連跑原始輸出）
- `docs/adr/0007-cross-model-verification-gate.md` … `0012-a2a-boundary.md`（本票新增 6 篇，接續既有 0001–0006）

**修改（最小外科手術）**

- `AGENTS.md`（根目錄）
- `src/routes/CLAUDE.md`
- `src/lib/CLAUDE.md`
- `docs/adr/0005-codex-engine-for-recorded-skills.md`（併入 Computer Use 已知限制＋狀態行修正）
- `aios-mcp/CLAUDE.md`（新增：AIOS 同時為 MCP provider 與 consumer）

**未改**

- 任何 `src/**/*.ts` 業務程式
- `prisma/schema.prisma` / migrations
- `src/ws/CLAUDE.md`

---

## 7. 自我驗收勾選

| # | 檢查 | 結果 |
|---|---|---|
| 1 | `npx tsc --noEmit`（server） | **0 error** |
| 2 | `npx tsx …/t06-invariants.ts` | **ALL PASS / exit 0** |
| 3 | `npx tsx …/t06-regression-neg.ts` | **ALL PASS / exit 0** |
| 4 | 全部 `t0*.ts` 連跑 | **14/14 全綠** |
| 5 | `npx prisma migrate status` | **up to date（19）** |
