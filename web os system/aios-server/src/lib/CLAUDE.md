# lib — 共用工具

跨模組的基礎工具。

## 檔案
- `db.ts` — Prisma client 單例。
- `auth.ts` — 密碼雜湊（argon2）與 JWT（jose）簽發/驗證。
- `crypto.ts` — AES-256-GCM 加解密（雲端 token 用）。
- `guard.ts` — `requireAuth` 等 preHandler；存取控制以**程式碼**落實。
- `http.ts` — 統一回應：`ok()`、`errors.*`（notFound/badRequest/unauthorized…）、`sendError()`。
- `audit.ts` — 稽核紀錄 `audit(userId, action, entity, entityId, meta?)`（中文對照在前端 `auditzh.ts`）。
- `filecontext.ts` — `gatherAgentFileContext()`：把員工指派的雲端檔案彙整成文字，供引擎寫入 `data/cloud-files.md`。

## 慣例
- 任何對外副作用（寄信、發佈、刪除）都應留稽核紀錄。
