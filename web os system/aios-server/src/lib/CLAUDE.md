# lib — 共用工具

跨模組的基礎工具。

## 檔案
- `db.ts` — Prisma client 單例。
- `auth.ts` — 密碼雜湊（argon2）與 JWT（jose）簽發/驗證。Access JWT 維持 15 分鐘；登入 Session 絕對期限為 3 天，Refresh Token 每次輪替但不得延長原始期限。
- `crypto.ts` — AES-256-GCM 加解密（雲端 token 用）。
- `guard.ts` — `requireAuth` / `requireTrainer` preHandler；存取控制以**程式碼**落實。
- `http.ts` — 統一回應：`ok()`、`errors.*`（notFound/badRequest/unauthorized…）、`sendError()`。
- `audit.ts` — 稽核紀錄 `audit(userId, action, entity, entityId, meta?)`（中文對照在前端 `auditzh.ts`）。
- `filecontext.ts` — `gatherAgentFileContext()`：把員工指派的雲端檔案彙整成文字，供引擎寫入 `data/cloud-files.md`。
- `skilltraining.ts` — 口述草稿；`skillId` 必須已 `AgentSkill` 連結到該 agent（fail-closed）。
- `agentbuilder.ts` — Agent Builder 對話管線：Grill 決策樹每輪自行選擇最重要分支（`fallbackFocus` 只供離線退路，不控制順序），提出一題＋具體建議；可重訪／推翻舊決策。使用者明確要求送審才進 `PLAN_READY`。能力計畫、authorize／test／finalize 與原治理閘不變。
- `agentbuilderevolution.ts` — Agent Builder 演進管線：每一輪對話／檔案新增 append-only `AgentBuildIteration`，由背景 worker 編譯 decision graph 與 shadow Harness（identity／skills／memory／tools／policies／testIdeas）。READY 僅代表草稿完成，**不得**建立或改動 live Agent/Skill；FDE authorize 時才把最新 READY snapshot 編譯為 PAUSED Agent + `AWAITING_USER_CONFIRM` 技能。所有輸入、輸出、錯誤落地前 deep-redact。
- `externalagentbuilder.ts` — ChatGPT／Claude／Codex／Cursor ingress。無 lifecycle hook 的客戶端可用 `external-snapshot` 可重試地同步一組對話與完整 shadow draft；Claude Code `UserPromptSubmit` 會保守辨識明確建置意圖、自動開案／續接、保存 user turn 並排入背景 iteration，`Stop` 補存 assistant turn 與漏接 user turn且不阻擋停止。續接前先用 `createdBy` 做帳號隔離的 Agent 清單／名稱比對；無法唯一判斷時只回候選、不得新建。Agent Builder 內部試跑與 verifier prompt 必須略過 hooks，避免遞迴建員工。
- `agentbuilder.ts` — 使用者標記為 Template 的上傳內容，在 FDE 建置 inert Skill 草稿時另存於 `assets/templates/` 並登錄 `Skill.assets`；解析型二進位文件使用 `.parsed.md`，不得假裝保存了原始 binary。失敗補償需移除整個本次新建的 Skill 目錄。
- `mcpoauth.ts` — Remote MCP OAuth 的 fail-closed 純邏輯：簽署 DCR client id 與短效 authorize ticket、限制 Claude／ChatGPT hosted callback 或 RFC 8252 loopback redirect、PKCE S256、固定且不允許額外 scope、resource indicator 與 JWT audience 精確綁定。簽發 token 一律 MEMBER-effective；`guard.ts` 再把 scoped token 限制在 `/api/agent-builder/*` 與 `/api/auth/me`，且禁止 FDE、一般 WS 與 integrations OAuth。
- `skillgate.ts` — `confirmAwaitingSkill` / `assertCodexGateForLinkedAgents`（RECORDED/COMPUTER_CONTROL → CODEX）。
- `changeproposal.ts` — 提案佇列。SKILL：`action=confirm_skill`（伺服器確認，不信 client content）或 `contentMd`（SkillVersion）。
- `recording.ts` — Record & Replay durable session；user/Agent 雙重歸屬、artifact 路徑只留主機、錄製提示先 redact，匯入後停在待 FDE 確認。
- `reflection.ts` — 定時反思服務：收集指定 window 內所有非系統 Agent 的 USER 訊息，先 `redactSecrets` 再交給獨立 GROK Agent、CLAUDE_CODE 交叉驗證。模型輸出只可落成 `ReflectionSuggestion`，不得直接修改 Agent/Skill。
- `changeproposal.ts` — `REFLECTION` 建議需先由 FDE 送交提案，再於提案頁第二次核准；`append_role_guidance` / `append_guidance` 只在核准交易中生效，Skill 同時產生並升級穩定版本。

## 慣例
- 任何對外副作用（寄信、發佈、刪除）都應留稽核紀錄。
- 閘門類 fail-closed；草稿捕捉可 requireAuth，生效一律 FDE。

- 新增：`eval.ts`/`skillpromote.ts`（評測套件 + promote/rollback 閘）、`mcpclient.ts`/`mcpbroker.ts`/`mcpregistry.ts`（消費外部 MCP：client/broker/loopback 註冊表）、`mcpcapability.ts`（INTERNAL MCP 每次呼叫的 30 秒一次性 HMAC 能力票；Broker 覆寫注入）、`trace.ts`/`agentcard.ts`/`a2a.ts`（軌跡 fail-safe、AgentCard 先 redact、A2A 預設停用）、`skillgate.ts`/`identitycard.ts`（RECORDED→CODEX 掛載閘、身分卡）。
