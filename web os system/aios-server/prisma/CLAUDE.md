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

## 慣例與雷點
- 列舉**多行**書寫（單行無效）；欄位文件用 `///` doc comment（不是 `/** */`）。
- 改 schema 後 `npm run prisma:migrate`（或 `prisma db push`）＋ `prisma generate`。
- `Run` 排序用 `startedAt`（無 `createdAt`）。
- 權限：OWNER（Kevin，最高管理）> TRAINER（可訓練）> MEMBER（僅使用）。
