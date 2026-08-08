# ADR 0008 — 成本與限制的 fail-closed 硬約束

**Status**: Accepted（2026-07）

## Context

模型 prompt 中的「請勿超預算／請勿越權」不可靠。AIOS 的安全與成本是硬約束：限制與預算必須在**程式碼層**攔截，判不準時一律拒絕。

## Decision

1. **成本閘（fail-closed）**：
   - `decideBudget(policy, todayUsd, monthUsd)` 純函式：日／月預算達標或超過 → `allowed: false`（`hardStop === false` 才軟放行）。
   - `guardBudget(agentId, policy)` 查 CostLog 後若超限 **throw `BudgetExceededError`**，中止步驟，不燒更多錢。
2. **限制閘（引擎層強制）**：`restrictions`（webSearch / computerUse / sendEmail / cloudWrite / shell / …）在 runner／工具適配層攔截；硬拒與 throw 是可觀測訊號（見 ADR 0004）。
3. **分工原則**：
   - **閘門類**（限制、預算、核准、路徑守門、升級閘）→ **fail-closed**：出錯就拒絕。
   - **附屬類**（記憶沉澱、成本記錄 best-effort 後、越矩提案、文件解析、軌跡）→ **fail-safe**：出錯只 log，**絕不可**讓 run 失敗。

## Consequences

- 預算與限制不靠模型自覺；回歸以 `decideBudget`／負向 promote／限制攔截腳本覆蓋。
- 營運需正確設定 `costPolicy`；`null` 政策表示不限額（明確 opt-in 限制）。
- 超限路徑會觸發 `recordViolation`（fail-safe），進入 FDE 提案佇列但不阻斷既有 throw 語意。
