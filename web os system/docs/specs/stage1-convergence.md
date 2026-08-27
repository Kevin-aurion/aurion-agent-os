# 階段 1 收斂 — 施工契約

> 依據：《AIOS 輕量化藍圖》§06、《AIOS 瘦身施工計畫》§06、治理鏈研究 §7.2。
> 原則不變：減法優先；不動五資產（跨模型驗證機器閘、restrictions、redactor、執行期 AWAITING_REVIEW、SkillVersion 回滾）；每票 Grok 寫→Opus 實跑審→獨立 commit。
> 撰寫：Claude ｜ 2026-08-27 ｜ Kevin 已授權「按照計畫做完」

## 票序（依風險由低到高）

| 票 | 內容 | 驗收核心 |
|---|---|---|
| S1-1 | **「核准並上線」單鍵化**：新端點 `POST /api/agent-builder/sessions/:id/approve-and-activate`（requireTrainer）內部串 approve-build→materialize→（測試資料已備則）run test→驗證證據機器閘→confirm skills→activate；任一步失敗回收件匣附原因，狀態機 fail-closed 不變；`/proposals` 的「Agent 建立審核」卡改為一顆按鈕（保留分步 API 相容） | 端到端測試：PASSED session 一鍵 ACTIVE；證據閘失敗時停在原狀態附原因；MEMBER 呼叫 403 |
| S1-2 | **跨模型驗證 3 套→1**：`modelgateway.ts` 的 `chooseVerifyEngine`／verifier prompt 與 `eval.ts` 的 `crossVerifyEngine` 收斂為 runner 的 `ENGINE_ADAPTERS` 單一來源（抽出共用 `resolveVerifyEngine()`，三處呼叫同一實作） | 三處 grep 僅剩單一實作；eval 與 gateway 行為測試不變 |
| S1-3 | **builder 軌收斂**：刪除 live design 軌（`lib/liveagentdesign.ts` 739 行＋`routes` 對應＋`_ref` 已無 MCP 工具）；`agentbuilderevolution`／`builderconversation` 已與主軌共用組裝管線，維持 | 零引用證據；typecheck＋全測試套件綠 |
| S1-4a | **前端減法**：封存 aios-studio 整包（→ aurion-archive，Langflow 裁決前不動後端）；aios-web 移除 `/training-studio`、builder 的 chooser 攔截頁與必填測試表單（testIdeas 預填、一鍵採用）；`/agent-builds` 併入 `/proposals` 導覽 | 路由清單；建員工互動數實測下降；typecheck |
| S1-4b | **前端整併 34→7**：`/work` 三模式合一為單一對話；`/employees` 9 分頁降為「概況＋對話」＋卡片；技能／工作流頁降級為對話卡片與收件匣視圖 | 7 路由清單；核心旅程 smoke |
| S1-5 | **macOS 瘦身**：保留 `Core/Device/`＋選單列＋設定，刪 8 個管理分頁（約 4,500 行 SwiftUI） | Swift 引用乾淨；App 可建置 |
| S1-6 | **Schema 收斂 55→約 11**（兩步走）：先 stop-write（Langflow/Device/A2A/Reflection 舊表停止寫入、read 路徑防衛）；觀察一輪後第二個 migration drop。本階段只做 stop-write，drop 待 Kevin 確認 | migrate status；全 smoke |
| P-1 | **dsh 探針（無金鑰部分）**：鎖 commit 安裝、persona waterfall 插件、MyAgent skills symlink 掛載、--dump-config canary 快照；需要 DeepSeek API key 的對話實測列為 BLOCKED 待 Kevin 自行貼入（安全規範：Claude 不代輸入金鑰） | 探針報告一頁 |

## 不做清單（本階段邊界）
- 不刪 Langflow 後端程式（裁決仍懸置，僅前端 studio 封存）。
- 不做 schema drop（只 stop-write）。
- 不動 aios-mcp 對外工具面（S2 再議 23→10）。
