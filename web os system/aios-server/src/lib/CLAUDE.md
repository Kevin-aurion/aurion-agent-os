# lib — 共用工具

跨模組的基礎工具。

## 檔案
- `db.ts` — Prisma client 單例。
- `auth.ts` — 密碼雜湊（argon2）與 JWT（jose）簽發/驗證。Access JWT 維持 15 分鐘；登入 Session 絕對期限為 3 天，Refresh Token 每次輪替但不得延長原始期限。
- `crypto.ts` — AES-256-GCM 加解密（雲端 token 用）。
- `guard.ts` — `requireAuth` / `requireTrainer` preHandler；存取控制以**程式碼**落實。
- `http.ts` — 統一回應：`ok()`、`errors.*`（notFound/badRequest/unauthorized…）、`sendError()`。
- `audit.ts` — 稽核紀錄 `audit(userId, action, entity, entityId, meta?)`（中文對照在前端 `auditzh.ts`）。`AuditLog.detail` 落地前無條件 `deepRedactSecrets`；hash 與 Prisma 寫入共用同一份 JSON 正規化值（object 省略 undefined/function/symbol，array 非 JSON 值為 null）。失敗 fail-safe，不得破壞 request。不要在請求路徑跑 `backfillAuditChain`。
- `filecontext.ts` — `gatherAgentFileContext()`：把員工指派的雲端檔案彙整成文字，供引擎寫入 `data/cloud-files.md`。
- `skilltraining.ts` — 口述草稿；`skillId` 必須已 `AgentSkill` 連結到該 agent（fail-closed）。
- `agentbuilder.ts` — Agent Builder 對話管線：Grill 決策樹每輪自行選擇最重要分支（`fallbackFocus` 只供離線退路，不控制順序），提出一題＋具體建議；可重訪／推翻舊決策。**開始路徑只建 DISCOVERY `AgentBuildSession`，零 Agent 列**；使用者明確要求完成時進 `PLAN_READY`，session owner 直接 materialize 並啟用 Agent、確認 Builder-owned Skills。既有 Agent 後續訓練以 `agentId` 續接同一 session，且保留 Agent id。舊 authorize／test／finalize 狀態僅供歷史資料相容。
- `agentbuilderevolution.ts` — Agent Builder 演進管線：每一輪對話／檔案新增 append-only `AgentBuildIteration`，由背景 worker編譯 decision graph 與 shadow Harness（identity／skills／memory／tools／policies／testIdeas）。READY 代表可供 session owner 直接啟用的最新訓練快照；所有輸入、輸出、錯誤落地前 deep-redact。`catalogContext` 排除尚未 ACTIVE 的 Builder Agent，避免未完成員工污染演進 prompt。
- `agentaccess.ts` — 帳號可見員工守門。`requireVisibleAgent` 對未釋出 Builder Agent 一律 404（與缺失／外人 id 不可區分），走 `isBuilderAgentReleased`，不複製判斷。
- `externalagentbuilder.ts` — ChatGPT／Claude／Codex／Cursor ingress。**開始同樣是 DISCOVERY：create 不建 Agent 列；既有 `agentId` 會續接該員工既有 Builder session；同對話重試冪等。** 無 lifecycle hook 的客戶端可用 `external-snapshot` 可重試地同步一組對話與完整 shadow draft；Claude Code hook 保存對話與排入演進 iteration。`activateExternalBuilderSession` 由 owner 直接把最新 READY 快照啟用，不經 FDE 或 Builder test。
- `builderrelease.ts` — Builder 可呼叫狀態守門。曾由 Builder 建立／訓練的 Agent，只有在所有關聯 session 都是 `ACTIVE`，且至少掛有一個未刪除的 `CONFIRMED` Skill 時，才進入一般 list/detail/invoke；這會隱藏舊 working-agent 機制留下的空白影子員工。DB session + Skill linkage 是交易內權威，不依賴 fail-safe AuditLog。查詢錯誤一律 fail-closed。從未由 Builder 關聯的一般員工不受影響。
- `builderconversation.ts` — 歷史 Shadow 試教相容模組；簡化 Builder 的 Web／MCP／Plugin 不再暴露或要求這條路徑。
- `mcpoauth.ts` — Remote MCP OAuth 的 fail-closed 純邏輯：簽署 DCR client id 與短效 authorize ticket、限制 Claude／ChatGPT hosted callback 或 RFC 8252 loopback redirect、PKCE S256、固定且不允許額外 scope、resource indicator 與 JWT audience 精確綁定。簽發 token 一律 MEMBER-effective；`guard.ts` 再把 scoped token 限制在 `/api/agent-builder/*` 與 `/api/auth/me`，且禁止 FDE、一般 WS 與 integrations OAuth。
- `skillgate.ts` — `confirmAwaitingSkill` / `assertCodexGateForLinkedAgents`（RECORDED/COMPUTER_CONTROL → CODEX）。
- `changeproposal.ts` — 提案佇列。SKILL：`action=confirm_skill`（伺服器確認，不信 client content）或 `contentMd`（SkillVersion）。
- `recording.ts` — Record & Replay durable session；user/Agent 雙重歸屬、artifact 路徑只留主機、錄製提示先 redact，匯入後停在待 FDE 確認。
- `reflection.ts` — 定時反思服務：收集指定 window 內所有非系統 Agent 的 USER 訊息，先 `redactSecrets` 再交給獨立 GROK Agent、CLAUDE_CODE 交叉驗證。模型輸出只可落成 `ReflectionSuggestion`，不得直接修改 Agent/Skill。
- `changeproposal.ts` — `REFLECTION` 建議需先由 FDE 送交提案，再於提案頁第二次核准；`append_role_guidance` / `append_guidance` 只在核准交易中生效，Skill 同時產生並升級穩定版本。
- `promptassembly.ts` — Builder Prompt v2 組裝器：`assemblePrompt()` 以 section 檔（`aios-data/prompts/builder/*.section.md`，mtime 快取、`safepath` 錨定）overlay 出廠段；同名衝突與 `{{var}}` 未註冊／未賦值／格式錯誤 fail-closed；壞段 skip + warn（組裝永遠能產出可用 prompt）。出廠檔在 `builtin-prompts/builder/`。

## 慣例
- 任何對外副作用（寄信、發佈、刪除）都應留稽核紀錄。
- 閘門類 fail-closed。Agent Builder 由 session owner 直接啟用；非 Builder 的技能／治理變更仍依各自既有權限規則。

- 新增：`eval.ts`/`skillpromote.ts`（評測套件 + promote/rollback 閘）、`mcpclient.ts`/`mcpbroker.ts`/`mcpregistry.ts`（消費外部 MCP：client/broker/loopback 註冊表）、`mcpcapability.ts`（INTERNAL MCP 每次呼叫的 30 秒一次性 HMAC 能力票；Broker 覆寫注入）、`trace.ts`/`agentcard.ts`/`a2a.ts`（軌跡 fail-safe、AgentCard 先 redact、A2A 預設停用）、`skillgate.ts`/`identitycard.ts`（RECORDED→CODEX 掛載閘、身分卡）。
- `stopwrite.ts` — 階段 1 S1-6 停寫守衛（不 drop 表）。HTTP 寫入端點回 501 `{ error:'stage1-stop-write' }`；內部寫入點 env 旗標預設關（`AIOS_REFLECTION_ENABLED` 等）。讀取路徑與 SkillVersion promote 閘保留；builderlessons 不受 `AIOS_REFLECTION_ENABLED` 影響。
