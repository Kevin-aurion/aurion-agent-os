# Spec — 技能工廠、兩層授權治理、Codex 錄製與電腦操控

> 由 `/grill-with-docs` 八題確認產生（決策見 `/docs/adr/0001–0006`、用語見 `/CONTEXT.md`）。以 `to-spec` 綜合，無訪談。
> 狀態：ready-for-agent

## Problem Statement

1. 一般操作者不懂 MD／Skill 是什麼，現在要建一個技能只能填「需求 + 選引擎」的表單，門檻高、無法對話式修正。
2. 訓練與使用是同一批人做的，缺少角色分層：操作者在用的時候發現 Agent 答錯或該加限制，沒有管道提出；提出了也沒有「誰能讓它生效」的規則。
3. Agent 若做出越矩行為（試圖執行 shell、寄信、操控電腦、超出身分卡授權），目前只是被擋下來丟個錯誤，**沒有留下治理紀錄、沒有人被通知**。
4. 很多真實工作是「在 App 裡點來點去」，無法用純文字技能描述；使用者希望「做一次給它看」就能變成技能。
5. 電腦操控目前只是「開啟 Codex.app 讓它自己跑」，無法程式化控制、無法驗證結果。

## Solution

- **技能工廠**：一個介面、三個入口（①聊天/口述描述 ②上傳現成 Skill ③錄製操作），全部匯流到同一條治理管線：草稿 → 跨模型 understand → **FDE 人工確認** → 掛載 → 版本化/rollback。
- **兩層授權**：操作者（`MEMBER`）只能**提案**；只有 FDE（`TRAINER`/`OWNER`）能讓變更生效。
- **單一變更提案佇列**：操作者建議與系統偵測到的越矩行為進同一個 FDE 收件匣；核准即產生新 `SkillVersion`（可回滾），駁回則不動。
- **越矩雙軌偵測**：硬攔截即訊號（免 LLM、硬事實）＋ 驗證閘語意審查（帶 severity/confidence 門檻）。
- **Codex 橋接**：以 Codex App 隨附的 MCP（`computer-use` 10 工具、`event-stream` 錄製三工具）實作電腦操控與「錄製→技能」；這類技能強制主引擎為 CODEX。
- **語音**：OpenAI Whisper 轉錄後餵入既有文字端點。

## User Stories

1. 作為操作者，我想用打字或說話描述「我要做發票輸入 ERP 的流程」，讓系統幫我把技能草擬出來，這樣我不用懂 SKILL.md。
2. 作為操作者，我想問「這位員工目前有哪些流程？」並得到白話清單，這樣我知道他會什麼。
3. 作為操作者，我想在對話中要求修改某個既有流程，這樣我不必從零重寫。
4. 作為操作者，我想在發現 Agent 答錯時提出修正建議，這樣問題不會被埋沒。
5. 作為操作者，我想為 Agent 追加一條限制（例如「不要自己承諾折扣」），這樣風險能被收斂。
6. 作為操作者，我的提案不應直接改動 Agent，這樣我不會誤傷生產中的員工。
7. 作為 FDE，我想在**一個收件匣**看到所有待審變更（操作者提案＋系統越矩訊號），這樣我不會漏看。
8. 作為 FDE，我核准提案後系統應自動產生新技能版本並可回滾，這樣我敢核准。
9. 作為 FDE，我駁回提案後系統不應有任何變動，這樣駁回是安全的。
10. 作為 FDE，當 Agent 試圖做被禁止的事（shell／寄信／電腦操控／雲端寫入／超預算／越沙盒）時，我想自動收到一筆帶證據的提案，這樣我能決定是放寬限制還是修技能。
11. 作為 FDE，我不想被大量低信心的語意越矩提案洗版，這樣我的注意力留給真訊號。
12. 作為 FDE，我想看到每個提案的來源（操作者／硬攔截／語意審查）與嚴重度，這樣我能排序處理。
13. 作為使用者，我想「按下錄製 → 做一次 → 停止」就得到一個可重用技能，這樣重複性桌面工作能自動化。
14. 作為使用者，錄製產生的技能不應含我的密碼／OTP／金鑰，這樣錄製是安全的。
15. 作為使用者，錄製出的技能要先給我看懂的摘要（步驟、輸入、假設），這樣我能糾正它。
16. 作為 FDE，錄製或需電腦操控的技能，只能掛在主引擎為 CODEX 的員工上，且系統要在掛載時就阻止我配錯。
17. 作為 FDE，我要能在網頁端啟動／停止錄製，不必自己去 Codex App 操作。
18. 作為員工 Agent，我要能透過 Codex 的 Computer Use 實際點擊、輸入、捲動、讀取視窗狀態，並在動作後驗證結果。
19. 作為 FDE，電腦操控仍必須受 `restrictions.computerUse` 管制，關閉時一律拒絕。
20. 作為使用者，我想用說話代替打字來訓練，這樣更快。
21. 作為老闆，我要知道語音會送往 OpenAI，並且能關掉這個功能。

## Implementation Decisions

- **角色**：沿用 `UserRole`：FDE＝`TRAINER`（`OWNER` 亦可，`requireTrainer` 已存在）；操作者＝`MEMBER`。
- **新增 `ChangeProposal`**（不復用死 schema `Lesson`）：`agentId / runId? / source(operator|violation|semantic) / proposedBy / targetType(skill|restriction|identityCard) / targetId? / proposedChange(Json) / severity / confidence? / status(PENDING|APPROVED|REJECTED) / decidedBy? / decidedAt? / resultingVersionId?`，索引 `(status, createdAt)`。
- **核准效果**：`targetType=skill` → 產生新 `SkillVersion`（既有 lib）並依需要 promote；`targetType=restriction|identityCard` → 更新對應 Json 欄位。全程寫稽核鏈。
- **硬攔截訊號**：現有攔截點（`restrictions` 的 shell/sendEmail/computerUse/cloudWrite、`guardBudget` 預算、sandbox 拒寫）在拒絕時**額外**生成 `ChangeProposal(source='violation', severity='high')`。攔截行為本身不得改變（仍 fail-closed 拒絕）。
- **語意審查**：在既有驗證閘 rubric 增加「是否超出身分卡 cannotDo／授權」一問；僅 `severity>=high` 或 `confidence>=門檻` 才建立提案，其餘僅記錄。
- **`SkillOrigin` 新增 `RECORDED`**；掛載端點新增「`RECORDED`/`COMPUTER_CONTROL` ⇒ `agent.engineExecute==='CODEX'` 否則拒絕」的檢查。
- **Codex MCP 橋接層**：新模組以 stdio JSON-RPC 連 Codex App 的兩個 MCP（`computer-use`、`event-stream`），路徑與 cwd 由 config 提供（預設讀 `~/.codex`），工具清單於連線時探測並在缺失時給明確錯誤（版本漂移防護）。
- **錄製→技能（委派，不自建翻譯器）**：`event_stream_start/status/stop` 只做起停與取得產物路徑；**把錄製變成 Skill 交給 Codex 自己**（其 `record-and-replay` skill ＋ `~/.codex/skills/.system/skill-creator`），我們用 CODEX 引擎下指令觸發，再把 Codex 產出的 `~/.codex/skills/<name>/SKILL.md` **匯入**成我們的 `Skill(origin=RECORDED)` → 走既有 understand 閘 → `AWAITING_USER_CONFIRM` → FDE 確認。匯入時套用紅線 redactor。**不產生 JSON／腳本中間格式。**
- **語音**：OpenAI Whisper `audio/transcriptions`；轉錄文字經 redactor 後餵 `POST /api/agents/:id/train/message`。需 `OPENAI_API_KEY`（目前 `.env` 尚無）。
- **前端**：員工詳情「訓練」tab 由現有一次性表單擴充為聊天式技能工廠（訊息串 + 流程清單 + 草稿卡 + FDE 確認）；另需 FDE「待審提案」頁。

## Testing Decisions

好的測試只驗**外部行為**：給輸入、斷言可觀察結果，不碰內部實作；安全項一律加**負向測試**。

**受測 seams（測試只寫在這些邊界上）**：
1. `lib/changeproposal.ts` 的公開函式（建立／列出／核准／駁回）— 純邏輯與 DB 效果。
2. REST 端點層：`/api/proposals*`、`/api/agents/:id/skills`（掛載檢查）、`/api/agents/:id/train/*`、`/api/recording/*`。
3. `engine/runner.ts` 的既有攔截點**行為不變** + 額外產生提案（透過查 DB 觀察，不改攔截語義）。
4. `lib/codexmcp.ts` 的橋接介面（對 MCP 握手/工具清單/錯誤路徑），以真實 MCP server 實跑。
5. 既有不可回歸的行為：跨模型驗證閘（executor≠verifier、isApproved fail-closed）、紅線 redactor。

**既有測試典範**：本專案採「臨時 `.ts` 腳本 + `tsx` 實跑 + 真 DB/真服務 + 用完清理」，沿用此模式（非 vitest 套件）。每項改動後跑 `tsc --noEmit` 與 `npm run build`。

## Out of Scope

- Browser Use（`browser`/`chrome` 外掛）整合。
- 本地 Whisper 自架（已改採 OpenAI；日後可換，port 已預留）。
- 語意越矩的自動修復（只產提案，不自動改）。
- 多租戶與計費。
- `Lesson` 表的移除（僅標記為死 schema）。

## Further Notes

- 依賴 **Proprietary** 的 OpenAI 外掛與 Codex App 版本；橋接層需容忍工具介面變動並明確失敗。
- Computer Use 需 macOS「輔助使用」權限；缺權限時要清楚回報。
- 錄製限制：單次 30 分鐘、同時僅一個。
