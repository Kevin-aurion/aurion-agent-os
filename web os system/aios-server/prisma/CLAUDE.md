# prisma — 資料庫 schema 與遷移

PostgreSQL（Docker，`127.0.0.1:5433`）的 schema 與遷移。真實來源（source of truth）在此，`MyAgent/`、`aios-data/` 只是檔案側產物。

## 檔案
- `schema.prisma` — 資料模型。
- `migrations/` — 遷移歷史（由 Prisma 產生，勿手改）。

## 本輪加入的重點
- 列舉：`Engine`（CLAUDE_CODE / CODEX / GROK）、`UserRole`（OWNER / TRAINER / MEMBER）、`ExecutionEnv`。
- `Agent`：新增 `department`、`engineVerify (Engine?)`、`restrictions (Json?)`。
- `CloudFileRef.webUrl`、`Skill.executionEnv`。
- 主要資料表：User / Agent / Skill / Workflow / Step / Run / RunStep / Conversation / Message / Schedule / CloudFileRef / AuditLog / ComputerControlTask…
- `AgentBuildSession` + `AgentBuildSessionStatus`（Agent Builder 耐久訪談／計畫／試跑／啟用；`draftState` 保存既有流程未送出欄位；內容一律 deep-redact 後落地）。
- `AgentBuilderWorkspace`（每位使用者一筆、保存尚未建立 Session 的首段需求草稿，供跨裝置恢復）。
- `RecordingSession`（使用者錄製操作示範；opaque session/artifact id，主機路徑不外流，並綁定開始錄製時的 Agent）。
- `ReflectionCycle` / `ReflectionFeedback` / `ReflectionSuggestion`（時段冪等、遮罩後證據、僅供 FDE 決策的建議）；`Agent.systemManaged` 隔離內部反思 Agent。
- `McpOAuthCode`（公開 Remote MCP 的一次性 authorization code；只存 code/client hash、PKCE challenge、redirect、scope、到期與消耗時間，不落 access／refresh token 明文）。

## 慣例與雷點
- 列舉**多行**書寫（單行無效）；欄位文件用 `///` doc comment（不是 `/** */`）。
- 改 schema 後 `npm run prisma:migrate`（或 `prisma db push`）＋ `prisma generate`。
- `Run` 排序用 `startedAt`（無 `createdAt`）。
- 權限：OWNER（Kevin，最高管理）> TRAINER（可訓練）> MEMBER（僅使用）。
