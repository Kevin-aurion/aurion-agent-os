# AIOS Client × Agent Runtime × Langflow FDE Platform

狀態：2026-08-08 已核准進入開發
依據：`AGENTS.md`、`CONTEXT.md`、ADR 0013、融合評估、Sonnet 5 唯讀程式盤點
開發方式：Codex 定義規格與驗收；Claude Code Workflow 編排；Grok CLI 實作；Fable 獨立整合審查；Codex 實跑與瀏覽器驗收。

## Problem Statement

目前 AIOS 已擁有企業控制平面的核心能力，但 End User 工作台仍未完整呈現 Agent Session、工具、核准、執行進度、Artifacts、排程與技能的整合體驗；FDE 也缺少一個安全隔離的視覺流程 Authoring／Sandbox 後台。若直接 fork Cherry Studio，會引入授權、雙重 Registry、雙重 Approval、雙重 Runtime 與長期合併成本；若全面改寫成 Langflow，又會弱化 AIOS 已有的跨模型驗證、成本限制、FDE 治理與不可變技能版本。

## Solution

以乾淨室方式重新建構 AIOS Client：只參考公開可觀察的互動邏輯，所有程式、資訊架構、視覺、文字與狀態管理均由 AIOS 獨立設計。AIOS 繼續作為 Agent、Skill、Tool、Approval、Policy、Cost、Audit、Schedule、Memory 與 Run 的唯一真實來源。

Langflow 分為兩個隔離角色：FDE Authoring／Sandbox Lab 與受限 Production Runtime。Langflow 永遠只是 `RuntimeAdapter` 的一個實作，不加入 `Engine` enum，不持有 Production Provider 憑證，也不能自行核准或發布。所有模型呼叫經 AIOS Model Gateway；所有 Tool／MCP 呼叫經既有 AIOS Capability Gateway。

## Non-negotiable Invariants

1. `compileManifest()` 的 execute engine ≠ verify engine 閘不可弱化；任何 Langflow Run 亦須留下不同 model family 的證據。
2. 預算、限制、核准、Artifact digest、Runtime route 都是程式碼層 fail-closed。
3. Skill IR、Flow Artifact、Runtime Binding、Trace、Eval、Audit 落地前都必須 `redactSecrets()`。
4. Skill 永不自動確認；只可停在 `AWAITING_USER_CONFIRM`，由 FDE 確認。
5. MEMBER 只能產生惰性草稿或 ChangeProposal；正式變更唯一路徑仍是 FDE。
6. Runtime ≠ Engine：`NATIVE | LANGFLOW` 與 `CLAUDE_CODE | CODEX | GROK` 是正交維度。
7. Langflow 不持有 Production Credential，不具治理投票權，不是任何 Registry 的來源。
8. Native Runner 必須在 Langflow 完全離線時仍可正常運作。

## Clean-room Rules

- 不複製、vendoring、轉譯或參照 Cherry Studio 原始碼、元件樹、CSS token、圖示、圖片、文案與建置產物。
- 不加入 `@cherrystudio/*` 依賴。
- Workbench V2 只從本規格所描述的公開行為與人工觀察建構。
- Phase 1 若使用原版 Cherry，只把它視為未修改的外部 MCP Client，不重新散布、不嵌入 AIOS。
- Grok／Claude／Codex 實作 Client 時不得開啟 Cherry repository 作為程式參考。

## Domain Model

- **AIOS Client**：End User `/work` 與 FDE `/admin` 的正式產品介面。
- **Agentic Session Runtime**：Conversation、Run、RunStep、ApprovalRequest、Artifact 的 AIOS 投影與協調層，不是另一個模型執行器。
- **Runtime Adapter**：將核准工作交給 Native 或 Langflow Runtime，並回傳統一事件的受治理邊界。
- **Model Gateway**：非 Native Runtime 的所有模型呼叫入口；強制模型分離、預算、限制與成本記錄。
- **Capability Gateway**：現有 MCP Registry／Broker 的產品名稱；所有 Production Tool Call 的唯一出口。
- **Skill IR**：`SkillVersion.specJson` 的版本化、機器可讀意圖。
- **Flow Artifact**：由固定 Template 確定性編譯、內容定址、不可手改的 Runtime 產物。
- **Runtime Deployment**：FDE 將一個已驗證 Artifact 綁定至環境與 channel 的啟用紀錄。
- **FDE Authoring Lab**：只有 FDE 可進入、無正式憑證的 Langflow 視覺編排與測試環境。

## User Stories

1. As a MEMBER, I want to choose an AI employee and continue a task thread, so that work has durable context.
2. As a MEMBER, I want one composer with distinct「交代工作」and「教它新工作」modes, so that I do not need technical vocabulary.
3. As a MEMBER, I want to teach through text, voice, upload or recording, so that common office work can be trained codelessly.
4. As a MEMBER, I want every teaching result to be a visible draft or proposal, so that I know it is not live yet.
5. As a MEMBER, I want a live task timeline showing thinking, tool calls, approvals and results, so that the Agent is accountable.
6. As a MEMBER, I want artifacts and cited sources beside the conversation, so that output can be inspected and reused.
7. As a MEMBER, I want to see skills, tools and schedules in business language, so that I understand what an employee can do.
8. As a MEMBER, I want risky actions to pause for an FDE instead of silently failing or executing.
9. As an FDE, I want one review inbox for Skill, restriction, identity and runtime deployment changes.
10. As an FDE, I want to inspect versions, diffs, tests, risks, model separation and cost before activation.
11. As an FDE, I want to open an approved Skill Version in a Langflow Sandbox, so that I can visually debug it.
12. As an FDE, I want only fixed, governed templates to become Production artifacts, so that arbitrary Python cannot ship.
13. As an FDE, I want canary then stable promotion and one-click rollback without deleting history.
14. As an OWNER, I want Native and Langflow runtimes to be interchangeable without changing the Agent definition.
15. As an OWNER, I want Langflow failure to affect only Langflow runs, not the AIOS registry or Native Runner.
16. As a security reviewer, I want every Production tool call to traverse the Capability Gateway.
17. As a security reviewer, I want every Langflow model call to traverse the Model Gateway.
18. As a security reviewer, I want a digest mismatch, unknown node, same-family verification or insufficient budget to refuse before execution.
19. As an auditor, I want deployment, rollback, approval and kill-switch events in the existing AuditLog hash chain.
20. As an operator, I want duplicate triggers to resolve to one Run, so that side effects are idempotent.
21. As an operator, I want a stopped run to resume only after a real approved ApprovalRequest exists.
22. As an FDE, I want sandbox data and credentials isolated from Production.
23. As an administrator, I want health, latency, tool errors, approval latency, cost and runtime reachability visible.
24. As an administrator, I want backup and recovery to depend on AIOS Postgres, not Langflow container state.
25. As a developer, I want one Runtime Adapter contract and normalized events, so that UI and governance do not depend on Langflow API shapes.

## Architecture

```text
AIOS Client (/work, /admin)
        │ REST + AWP/1
Agentic Session Runtime projection
        │
AIOS Control Plane
Agent · SkillVersion · Workflow · ChangeProposal · Approval · Eval · Audit · Cost
        │                                  │
Skill IR → Template Compiler               compileManifest (unchanged)
        │                                  │
Flow Artifact                              Native manifest
        │ FDE deployment gate              │
Runtime Deployment                         │
        └──────── Runtime Adapter ──────────┤
                         │                  └─ Native Runner
                         └─ Langflow Runtime
                                ├─ AIOS Model Gateway
                                └─ AIOS Capability Gateway
```

## Runtime Adapter Contract

```ts
interface RuntimeAdapter {
  readonly kind: 'NATIVE' | 'LANGFLOW'
  health(): Promise<RuntimeHealth>
  validateArtifact(input: ValidateArtifactRequest): Promise<ValidationResult>
  deployArtifact(input: DeployArtifactRequest): Promise<RuntimeBinding>
  execute(input: ExecuteRequest): AsyncIterable<NormalizedRunEvent>
  getRun(runId: string): Promise<RuntimeRunState>
  cancelRun(runId: string): Promise<void>
  resumeRun(input: ResumeRequest): Promise<void>
}
```

Langflow wire formats不得離開 Langflow Adapter；Client 只認識 `NormalizedRunEvent`。

## Data Model Decisions

第一批 additive migration：

- `SkillVersion.schemaVersion String?`
- `SkillVersion.specJson Json?`
- `RuntimeKind { NATIVE LANGFLOW }`
- `FlowArtifactStatus { COMPILED VALIDATED REJECTED SUPERSEDED }`
- `FlowArtifact`：來源 SkillVersion／Workflow、template、artifactJson、digest、compilerVersion、status、redacted metadata。
- `DeploymentEnvironment { SANDBOX STAGING PRODUCTION }`
- `DeploymentChannel { CANARY STABLE }`
- `RuntimeDeployment`：artifact、environment、channel、opaque runtimeBinding、deployedBy、active、timestamps。
- `Run.runtimeKind?`、`artifactId?`、`idempotencyKey?`、`executionModelFamily?`、`verificationModelFamily?`。

既有 migration 不得修改；所有新欄位保持 nullable 或有安全預設，使 Native path 零回歸。

## Template Compiler

MVP 只允許三個固定 Template：

1. `email-triage-readonly-v1`：讀取、分類、摘要、驗證；無 send／write node。
2. `scheduled-report-v1`：Schedule 仍由 AIOS 擁有；Runtime 只執行一次報表 Run。
3. `approval-gated-action-v1`：最多一個已允許 write capability，執行前一定建立 ApprovalRequest 並等待 FDE。

禁止節點：任意 Python／Custom Component、直接 Gmail／Graph、直接 DB／filesystem／shell、直接模型 provider、未註冊 MCP、可修改 Skill／權限／核准／發布的節點。

同一 Skill IR、Template Version、Compiler Version 必須產生 byte-stable canonical JSON 與相同 SHA-256 digest。不符合模板不得退回自由生成，必須 `REJECTED`。

## Deployment Gate

啟用順序：

1. `requireTrainer`。
2. Artifact digest 重新計算並完全相符。
3. Artifact 狀態必須 `VALIDATED`。
4. 來源 Skill 必須已由 FDE 確認。
5. 必須有通過的 EvalRun，且無未解決 highRisk。
6. 執行與驗證 model family 必須不同。
7. Runtime Adapter validation 必須通過。
8. 才能建立／啟用 RuntimeDeployment 並寫入 AuditLog。

Rollback 只切換 active pointer，不刪 Artifact／Deployment。

## Model Gateway

內部 loopback、service-to-service 身分，非一般使用者 JWT：

- `POST /internal/model/execute`
- `POST /internal/model/verify`
- `GET /internal/model/health`

Server 不信任 Runtime 傳來的 model family、restrictions、budget 或 approval；必須由 `agentId`、`runId`、`deploymentId` 回查真實資料。`verify` 必須 server-side 選擇不同 engine。每次 dispatch 前先 guardBudget，再執行，再記 CostLog；任何狀態查詢失敗皆拒絕。

## HITL Resume

```text
Langflow checkpoint
→ approval.required normalized event
→ AIOS 建立／查找真 ApprovalRequest
→ FDE 使用既有 approval route 決定
→ AIOS isRunApproved() 為真
→ RuntimeAdapter.resumeRun()
```

Langflow UI 本身的 Approve 不具治理效力。

## Agentic Session Runtime and Client

Session Runtime 是投影層，不建立第二份 Run／Approval 真相。它聚合：Conversation、Messages、Run、RunSteps、ApprovalRequests、ChangeProposals、Artifacts、Schedules 與 AWP events。

Workbench V2 採獨立設計：

- 左側：AI 員工、搜尋、置頂／最近 Thread、建立 AI 員工。
- 中央：對話、任務／教學模式、語音、上傳、錄製、即時 Run 狀態。
- 右側：Artifact、來源、Run timeline、Tool call、Approval、Skill palette、Schedule。
- FDE Admin：Proposal／Approval inbox、Skill version／diff／eval、Flow Artifact、Deployment、Langflow Sandbox 入口、Health／Cost。
- 一般使用者不看到 MCP、manifest、Flow JSON、model family 等技術詞。
- 不提供「Full Auto」權限開關；所有 autonomy 顯示都映射現有 restrictions／riskTier，Client 不能擴權。

## Langflow Isolation

### Authoring/Sandbox

- 獨立 compose 檔、版本 pin、只綁 `127.0.0.1`。
- 無 Production provider credential、無正式資料 volume。
- 允許 FDE UI；測試資料使用 mock／去識別 fixture。
- 不因 sandbox 的 Save／Publish 改變 AIOS Production state。

### Production Runtime

- 與 Sandbox 不同 compose／network／storage。
- 無 End User UI、唯讀 rootfs、drop capabilities、無任意 Custom Component upload。
- 只載入 active、digest 驗證通過的 Artifact。
- 只允許呼叫 AIOS Model／Capability Gateway；不得直接對外 provider egress。
- Durable state 全在 AIOS Postgres；容器可重建。

## Idempotency, Canary and Recovery

- `Run.idempotencyKey` 使用來源事件穩定 ID；duplicate key 返回既有 Run，不再派送。
- Production 先 CANARY；FDE 觀察通過後才 STABLE。
- Kill switch 取消 active deployment；有 Native fallback 才切回，否則 fail-closed 至 review，不可沉默執行。
- Langflow crash 不得把 Run 標成成功；保留已發生成本與步驟，進入明確錯誤／timeout。

## Phases

### Phase 0 — Safe Baseline

不用 commit；以 alternate Git index 產生不碰真 index 的 tree snapshot，記錄現有 dirty work，先跑 server/web/MCP typecheck 與既有關鍵回歸。每票以 pre/post tree 精準審查。

### Phase 1 — Companion Client Spike

驗證既有 Remote MCP builder profile 只能建立 shadow draft，不能 confirm Skill、approve Proposal、寫 MCP registry 或 Agent CRUD。若原版 Cherry 無法穩定接 Remote MCP，記為 UX 研究證據，不在 AIOS 新增繞過能力。

### Phase 2 — Langflow Sandbox + Runtime Adapter

建立隔離 Sandbox 與 Runtime contract，完成 health、validate、deploy、execute stream、get、cancel、resume 的 mock／live adapter 測試，不寫正式 Registry。

### Phase 3 — Skill IR + Compiler + Deployment Gate

完成資料模型、三模板、digest、validation、FDE gate、rollback、redaction 與負向測試。

### Phase 4 — Workbench V2

完成乾淨室 Client、Agentic Session Runtime projection、三欄工作區、Artifact／Approval／Tool／Skill／Schedule 面板與 FDE runtime 管理。

### Phase 5 — Restricted Production Pilot

完成 Model Gateway、Production isolation、read-only email triage、idempotency、canary／stable／rollback、Langflow outage 與十大負向案例。

### Phase 6 — Enterprise Hardening

在不虛構完成度的前提下建立可驗證基礎：service identity／environment binding、Knowledge ACL／retention contract、rate limit／circuit breaker／dead-letter、backup／restore drill、SLO metrics。完整多租戶 Tenant isolation 若會改變現有單租戶產品邊界，作為後續獨立 migration，不在本輪假裝完成。

## Testing Decisions

- 純函式與 adapter contract 可用 Node test；安全與 DB 狀態沿用 `.scratch/<feature>/tests/*.ts + npx tsx + 真 DB`。
- 先寫負向測試，再實作最小通過邏輯。
- 最高測試 seam：Runtime Adapter contract、Model／Capability Gateway、Deployment Gate、Browser-visible user journey。
- Client 以真後端／Browser 驗收，不只 snapshot。
- 不接受「程式看起來會擋」；安全測試必須觀察實際 403／throw／refuse／零資料變更。

### Mandatory Negative Matrix

1. Builder scoped token confirm Skill → 403。
2. Builder scoped token approve Proposal → 403。
3. Builder scoped token寫 MCP／Agent CRUD → 403。
4. 非 loopback Langflow URL → 拒絕。
5. Sandbox 停機 → timeout 可控，AIOS state 不變。
6. Artifact JSON 被改 → digest drift 拒絕。
7. 不符合三模板 → REJECTED，不自由生成。
8. MEMBER activate deployment → 403、零變更。
9. 無 passing Eval／有 highRisk → 拒絕。
10. execute／verify 同 family → 拒絕。
11. budget 不足 → model／tool dispatch 前拒絕。
12. Flow default 含 secret → 落地前遮罩或拒絕。
13. refund email → ApprovalRequest 前不得呼叫 write tool。
14. prompt injection 要求擴權／寄送 → 不產生未允許 tool call。
15. duplicate message id → 單一 Run。
16. Langflow-side approve 但 DB 無 APPROVED request → resume 拒絕。
17. Production template 出現 Python／direct provider／filesystem → compile 拒絕。
18. Langflow outage → Native Runner 與 Registry 回歸通過。
19. MEMBER 看不到 FDE Runtime activation controls。
20. UI 不存在可繞過 backend restriction 的 autonomy control。

## Exit Criteria

- server、web、MCP typecheck 全過。
- Prisma validation／migration status 合理且未改既有 migration。
- 新功能正向與全部可執行負向測試通過。
- Native 五條紅線回歸通過。
- Browser 實測 MEMBER golden path 與 FDE golden path。
- Langflow Sandbox／Production 的 live 部分有真實 health／execution 證據；若外部環境阻擋，必須明確列為 blocker，不得用 mock 宣稱 Production 完成。

## Out of Scope

- fork、重散布或嵌入 Cherry Studio。
- 把 Langflow 變成 AIOS 唯一 Runtime／Registry／Scheduler／Approval authority。
- 允許一般 MEMBER 使用 Langflow Canvas。
- 任意 LLM 生成 Langflow graph／Python component。
- 本輪直接擴大到跨企業多租戶正式計費；只建立不阻礙未來 Tenant migration 的邊界。
