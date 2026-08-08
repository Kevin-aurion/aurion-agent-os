# components/workbench — Agent 工作台共用元件

Phase 1 從員工詳情訓練／對話分頁抽出的可重用塊，供 `/work` 使用。

| 檔 | 用途 |
|---|---|
| `types.ts` | Agent／Conversation／ChatMessage／SkillUnderstanding／**BuilderSession** 等型別 |
| `AgentBuilderPanel.tsx` | **建立 AI 員工**中欄：Grill 式單題訪談與非同步員工演進並行；每輪顯示「正在學習」與完成摘要，可持續補充／反悔。選填、預設收合的範本／資料；再進行授權／試跑／啟用。`AgentBuilderRail` 顯示最新 decision graph 與版本數。 |
| `VoiceInput.tsx` | 麥克風 → `/api/voice/transcribe`（OpenAI Whisper） |
| `SkillDraftCard.tsx` | 技能草稿卡：能力／資料讀寫／外部呼叫／不可逆／風險；FDE 確認掛載、MEMBER 送提案 |
| `ChatRunTimeline.tsx` | 使用者訊息下的 `run.*` 步驟時間線 |

## Agent Builder（業務語言）
- 入口：`/work` 左欄「建立 AI 員工」（不需先選 Agent）；`?mode=builder`。
- 每次進入固定先顯示建立方式與本人未完成清單，`localStorage` 只標示「上次開啟」，不得自動續接。
- REST：`GET /api/agent-builder/sessions`（清單）、`GET|PUT /api/agent-builder/draft`（跨裝置草稿）、`POST /sessions` + `messages`／`authorize`／`test-data`／`test`／`finalize`。
- 訪談不是固定欄位順序：後端 `progress.turn` 依 decision graph 選一個高價值分支，提供 context／recommendation／question／suggestions；前端讓使用者自由輸入或點建議起點。
- 每輪另建立 append-only `BuilderIteration`；前臺輪詢非同步狀態並用業務語言顯示「這位員工正在學習／這次學會了什麼」。不得向 End User 暴露 Harness、MCP、manifest 等詞。
- 每一輪訪談採 optimistic conversation UI：送出後立即把使用者訊息放進 transcript 視覺區並顯示 AI 思考泡泡，不得讓使用者停留在起始表單或只看送出按鈕轉圈；失敗時保留訊息並提供重試／修改。
- 「提供範本或資料」永遠是選填、預設收合。只有後端判斷能明顯改善格式時才顯示非阻擋式建議；選「暫時不用」後繼續對話。
- 不暴露引擎、manifest、JSON、MCP/A2A 協議詞；正式連線缺口與手動試跑結果分開顯示。
- MEMBER 授權只到 `AWAITING_FDE`；FDE 才 `finalize`；選 Agent／新任務會退出 builder。

## 治理（不可弱化）
- 技能**永不**自動 CONFIRM；MEMBER 只走 `POST /api/agents/:id/proposals`（`action: confirm_skill`）。
- 草稿捕捉（train/voice/recording）為 requireAuth；確認／掛載仍是 FDE + 後端 guard。
- `confirmSkill`：attach 僅忽略 `ApiError.code === 'CONFLICT'`；CODEX 等錯誤必須顯示。
- 前臺「教它新工作」可用「錄製操作示範」；開始前須確認隱私提醒與示範目的。錄製工作階段綁定開始時選定的 Agent，錯誤原樣顯示，不假成功。
- 後端 `requireTrainer` / 擁有者隔離仍是權限真實來源。
- `run.step` 用 **`phase`**（非 status）；終態 phase 停轉圈。
