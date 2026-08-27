# routes — REST 端點

Fastify 路由，全部掛在 `/api/*`。多數以 `requireAuth` preHandler 保護；回應走 `lib/http.ts` 的 `ok()/sendError()`。

## 檔案
- `agents.ts` — 員工 CRUD。含 `engineExecute`/`engineVerify`（含 GROK）、`department`、`restrictions`；掛載技能時 RECORDED/COMPUTER_CONTROL 強制 CODEX；attach 冪等（已連結則回傳既有列）。
- `workflows.ts` — 工作流 CRUD 與觸發設定（`schedule`/`keyword`/`manual`）；`syncSchedule` 通知即時排程；`kickOffRun` 預先產生 `runId`。
- `skills.ts` — 技能。**`/api/skills/build` 為非同步**。`POST /:id/confirm` 僅 FDE；走 `confirmAwaitingSkill`（AWAITING + CODEX 閘）。
- `training.ts` — 口述訓練。`train/message` 為 **requireAuth**（MEMBER 可建 inert 草稿）；永不 auto-confirm。`skillId` 必須已掛在該 agent。
- `agentbuilder.ts` — **Agent Builder**（CEO 友善工廠）。`external-snapshot` 供無 lifecycle hook 客戶端可重試同步完整草稿；`external/prompt-hook` 保存 prompt 並排入背景演進，`external/stop-guard` 於完整 user/assistant pair 後排入 Shadow 反思（不阻塞等 Artifact）。`POST /sessions/:id/shadow-chat` 是 Claude MCP 對話試教（safe mode、無工具、無外部副作用）。`GET /agents` 僅列登入帳號建立的非系統 Agent；草稿可 PATCH 名稱，live Agent 改名只能建立 ChangeProposal 待 FDE 核准。上傳 `?useAsTemplate=true` 會在建置時產生 Skill template asset。`GET /evolution-queue` 永遠只回登入帳號本人的建置（含版本／反思／FDE 放行）；FDE 全域紀錄改走 trainer-only `GET /admin/evolution-queue`。背景 READY 僅 shadow 草稿，FDE 才能建立 PAUSED Agent + `AWAITING_USER_CONFIRM` 技能；正式 finalize 仍需 PASSED 且只有 FDE。`GET /sessions/:id/export` 匯出可攜 Agent package（不含憑證／啟用排程）。
- `voice.ts` — 語音轉錄 **requireAuth**（草稿輔助；redact 後回傳）。
- `recording.ts` — 錄製 start/status/stop/to-skill 皆 **requireAuth**（草稿）；host-global 錄製 session 由後端按 user + 開始時選定的 Agent 持有，to-skill 只接受 opaque sessionId、不接受前端指定本機產物路徑；永不 auto-confirm。
- `conversations.ts` — 對話。**擁有者隔離**：list 只回 `userId=req.user.sub`；GET/POST messages 與 WS `chat.send` 皆驗證 `conversation.userId`。
- `proposals.ts` — 提案。MEMBER 可建；FDE approve 支援 `action=confirm_skill` 與 `action=archive_agent`（封存時同步停用 Workflow／Schedule，保留 Agent 資料；見 `lib/changeproposal`）。
- `reflections.ts` — **FDE only** 反思中心：列出整理時段／遮罩後回饋／優化建議，支援手動排程、送交提案、忽略；不能直接套用變更。
- `runs.ts` — 執行紀錄查詢。
- `dashboard.ts` — 總覽統計。
- `auth.ts` — 登入 / token。
- `mcpoauth.ts` — 公開 Agent Builder Remote MCP 的 OAuth 2.1 邊界：discovery、DCR、Claude／ChatGPT hosted callback、登入／同意、authorization code + PKCE S256、RFC 8707 resource audience、refresh rotation、revoke。OAuth 回應依協議直接回 JSON／HTML，不包 `ok()`；scope 固定 `aios:agent-builder`，不可取得 FDE 生效能力。
- `agentruntime.ts` — 公開 Remote MCP 的帳號隔離 Runtime：只列/讀/呼叫登入者自己的 ACTIVE Agent；Run 以 idempotency key 去重；高風險沿用 HITL。排程與封存只能建立 ChangeProposal，FDE 核准前不得生效；封存要求完整名稱確認且 foreign id 一律 404。
- `health.ts` — 健康檢查。

## 注意
- DELETE 請求**不要**帶 `content-type: application/json` 又空 body（Fastify 會 500）。
- 全頁導向的 OAuth `/start` 無法帶 header，改接受 `?token=` query。
- **生效閘**：只有 FDE confirm / approveProposal 能把技能變 CONFIRMED；草稿捕捉端點可放寬到 requireAuth。
- `Agent.systemManaged=true` 不出現在 `/api/agents` 工作台清單，也不可由一般 Agent CRUD 修改或刪除。

- 新增：`evals.ts`（trainer：EvalSuite/Case CRUD、跑評測、`promoteWithGate` 升級閘）、`mcp.ts`（trainer：外部 MCP loopback-only 註冊；`POST /mcp/call` 仍經 agent scope/tool/restriction/approval/budget Broker）、`googleworkspace.ts`（user-scoped Gmail/Drive read；write 需 FDE + 同 Agent 的真核准 Run；可安裝五個分權 MCP preset）、`a2a.ts`（peer 註冊需 trainer；AgentCard/task 預設停用邊界）。
- 階段 1 S1-6 停寫：Langflow runtime／A2A／Reflection 舊表／Recording／Eval 新建／（內部）RunTrace 寫入端點回 501 `{ error:'stage1-stop-write' }`；GET 與 SkillVersion promote/rollback 保留。裝置叢集在用，不停寫。詳見 `lib/stopwrite.ts`。
