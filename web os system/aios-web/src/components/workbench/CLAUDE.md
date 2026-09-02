# components/workbench — Agent 工作台共用元件

Phase 1 從員工詳情抽出的可重用塊，供 `/work` 單一對話（交辦＋教學）使用。

| 檔 | 用途 |
|---|---|
| `types.ts` | Agent／Conversation／ChatMessage／SkillUnderstanding／**BuilderSession** 等型別 |
| `AgentBuilderPanel.tsx` | **建立 AI 員工**中欄：Grill 式單題訪談與非同步員工演進並行；每輪顯示「正在學習」與完成摘要，可持續補充／反悔。選填、預設收合的範本／資料；使用者確認後直接啟用。`AgentBuilderRail` 顯示最新 decision graph 與版本數。 |
| `VoiceInput.tsx` | 麥克風 → `/api/voice/transcribe`（OpenAI Whisper） |
| `SkillDraftCard.tsx` | 技能草稿卡：能力／資料讀寫／外部呼叫／不可逆／風險；FDE 確認掛載、MEMBER 送提案 |
| `ChatRunTimeline.tsx` | 使用者訊息下的 `run.*` 步驟時間線 |
| `SkillPalettePanel.tsx` | 唯讀技能／授權／排程面板，業務語言，無 mutation 控制 |

## Agent Builder（業務語言）
- 入口：`/work` 左欄「建立 AI 員工」（不需先選 Agent）；`?mode=builder`。
- 開啟時：建立新員工時續接最近的未完成 session；從既有員工進入時，以 `agentId` 精確續接該員工的同一 session（包含 ACTIVE session 再訓練）。`localStorage` 只作 UI 恢復提示，後端 session 才是權威。
- REST：`GET /api/agent-builder/sessions`（清單）、`GET|PUT /api/agent-builder/draft`（跨裝置草稿）、`POST /sessions` + `messages`／`authorize`；外部 MCP 使用 `/activate`。舊 test/finalize 端點只供歷史相容，不在 UI 顯示。
- 訪談不是固定欄位順序：後端 `progress.turn` 依 decision graph 選一個高價值分支，提供 context／recommendation／question／suggestions；前端讓使用者自由輸入或點建議起點。
- 每輪另建立 append-only `BuilderIteration`；前臺輪詢非同步狀態並用業務語言顯示「這位員工正在學習／這次學會了什麼」。不得向 End User 暴露 Harness、MCP、manifest 等詞。
- 每一輪訪談採 optimistic conversation UI：送出後立即把使用者訊息放進 transcript 視覺區並顯示 AI 思考泡泡，不得讓使用者停留在起始表單或只看送出按鈕轉圈；失敗時保留訊息並提供重試／修改。
- 「提供範本或資料」永遠是選填、預設收合。只有後端判斷能明顯改善格式時才顯示非阻擋式建議；選「暫時不用」後繼續對話。
- 不暴露引擎、manifest、JSON、MCP/A2A 協議詞；正式連線缺口與手動試跑結果分開顯示。
- session owner 可直接把最新訓練內容啟用成 Agent；後續教學續接同一 session。

## 執行安全邊界
- Agent Builder 的技能會在 owner 直接啟用時一併 CONFIRMED；一般手動技能管理仍走既有技能 API。
- 新的員工訓練一律走 Agent Builder session；session owner 直接啟用。舊 `train/message`、錄製轉 Skill 與 SkillDraft UI 暫時隱藏，底層端點僅供歷史相容。
- `confirmSkill`：attach 僅忽略 `ApiError.code === 'CONFLICT'`；CODEX 等錯誤必須顯示。
- 錄製操作示範入口目前隱藏；未重新定義簡化契約前不得在工作台重新露出。
- 後端 `requireTrainer` / 擁有者隔離仍是權限真實來源。
- `run.step` 用 **`phase`**（非 status）；終態 phase 停轉圈。
- 目前唯一訓練入口是 Builder 對話（建立或「訓練這位員工」）；打字訓練意圖也導入同一 Builder session。
- 錄製跨 Agent 匯入：前端 `recordingImportTarget` 會先拒絕（不 stop、不匯入），後端仍是最終守門。
- train 失敗的錯誤泡泡可帶「重試」：原訊息保留在 transcript，用同一 payload 重送。
- 排程與授權在工作台唯讀；變更入口只在 FDE 管理中心（後端 requireTrainer）。
