# AIOS Agent Workbench — Phase 1 規格

## 1. 目標

把目前以 Dashboard、Skill、Workflow 為中心的管理介面拆成兩個產品表面：

- **AI 工作台 `/work`**：給 MEMBER 與 FDE 日常交代工作、建立任務 thread、用文字／語音／桌面示範訓練 Agent。
- **FDE 管理中心 `/admin` 與既有管理路由**：保留 Agent、Skill、Workflow、Proposal、整合、成本與稽核管理。

Phase 1 不改變執行引擎、驗證閘、Skill 確認閘、ChangeProposal 或任何安全限制。

## 2. 使用者體驗原則

1. MEMBER 不看 Dashboard、引擎、Skill/Workflow 編排與稽核導覽。
2. 使用者以「Agent → 任務 thread」為心智模型，不必先理解 Skill 或 Workflow。
3. 工作與訓練發生在同一個工作台；使用者可清楚切換「交代工作」與「教它新工作」。
4. FDE 可在工作台日常使用 Agent，並可一鍵切回管理中心。
5. MEMBER 的技能草稿只能送出提案；FDE 才能確認與掛載。
6. 所有既有後端治理紅線維持不變。

## 3. Phase 1 資訊架構

### `/`

- 驗證完成後：所有角色導向 `/work`。

### `/work`

- 左欄：建立新任務、Agent 清單、所選 Agent 的任務 thread。
- 中欄：目前 thread 的訊息、歡迎／空狀態、工作或訓練 composer。
- 右欄：Agent 能力摘要、工作台提示、FDE 管理入口（僅 FDE）。
- URL query 保存 `agent` 與 `conversation`，可重整與分享本機深連結。

### `/admin`

- 原 Dashboard 搬到此處。
- 既有 `/employees`、`/skills`、`/workflows`、`/proposals`、`/settings`、`/audit` 保持 URL，統一使用 FDE 管理導覽。

## 4. 工作台互動

### 交代工作

1. 選 Agent。
2. 選既有 thread 或建立新任務。
3. 透過既有 conversation REST API 送出訊息。
4. 使用既有 `chat.message` WS 事件更新回覆。

### 教它新工作

1. 切換到訓練模式。
2. 文字或語音描述流程，呼叫既有 `/api/agents/:id/train/message`。
3. 顯示 Skill 草稿的摘要、能力、資料讀寫、外部呼叫、不可逆動作與風險。
4. FDE 可確認並掛載；MEMBER 只能送出 ChangeProposal。
5. 桌面錄製沿用既有 `/api/recording/*` 與 `/api/agents/:id/recording/to-skill`，不得宣稱已成功，必須顯示真實錯誤。

## 5. 權限與安全

- AppShell 對非 FDE 存取管理路由採前端導回 `/work`；後端現有 guard 仍是權限真實來源。
- 文字／語音／錄製只放寬到 `requireAuth` 以建立 inert draft；確認、掛載、提案審核與正式設定變更仍須 `requireTrainer`。
- 錄製 session 由後端按使用者持有，轉技能不接受前端指定本機產物路徑。
- 不自動 CONFIRM Skill。
- 不改 execute/verify 引擎規則。
- 不改 redactor、預算或 restriction 行為。

## 6. 後續資料模型（Phase 2，不在本票實作）

### TrainingSession

持久化目標理解、追問、來源、草稿與發布狀態：

`DISCOVERING → NEEDS_INFORMATION → DRAFTING → READY_TO_TEST → TESTING → NEEDS_REVISION → AWAITING_FDE_APPROVAL → PUBLISHED|PAUSED`

### Process IR

模型不可直接修改正式 Skill／Workflow；先輸出受 schema 驗證的中介表示：

- goal / trigger / inputs / outputs
- steps / conditions / variables
- requiredCapabilities / permissions
- successCriteria / failurePolicy
- testCases / generatedArtifacts

由確定性 compiler 產生 Skill draft、Workflow draft、測試與 ChangeProposal。

### Demonstration

錄製以事件流為主、畫面與旁白為輔：Accessibility/UI selector → browser locator → OCR/image anchor → relative coordinate → absolute coordinate。

## 7. Phase 1 驗收標準

1. MEMBER 登入或開 `/` 後進入 `/work`，看不到 Dashboard 管理導覽。
2. FDE 可在工作台與管理中心之間切換。
3. 工作台可選 Agent、建立/切換任務 thread、讀取訊息、送出訊息並接收 WS 回覆。
4. 工作台可切換訓練模式並產生真實 Skill 草稿。
5. MEMBER 只能送提案；FDE 才能確認掛載。
6. 桌面錄製按鈕使用既有真實 API，失敗明確呈現。
7. 既有管理頁仍可使用。
8. `npm run typecheck` 與 `npm run build` 通過；不得在運行中的 `next dev` 上直接 build。
