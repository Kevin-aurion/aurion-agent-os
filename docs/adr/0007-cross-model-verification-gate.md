# ADR 0007 — 跨模型驗證閘（執行引擎 ≠ 驗證引擎）

**Status**: Accepted（2026-07）

## Context

單一模型對自己產出的自我背書會讓「通過驗證」失去獨立性。AIOS 以本機 CLI 三引擎（`CLAUDE_CODE` / `CODEX` / `GROK`）執行工作流步驟，需要在程式碼層強制「誰執行、誰驗證」分離，且判決必須決定性、可回歸。

## Decision

1. **載入時強制分離**：`compileManifest()` 讀取 Agent 後計算：
   - `autoVerify = engineExecute === 'CLAUDE_CODE' ? 'CODEX' : 'CLAUDE_CODE'`
   - `engineVerify = (agent.engineVerify && agent.engineVerify !== engineExecute) ? agent.engineVerify : autoVerify`
   - 因此 **永遠** `engineVerify !== engineExecute`（即使 Agent 把 verify 設成與 execute 相同，也會被忽略並回退 auto）。
2. **判決 oracle fail-closed**：`isApproved(text)`（`src/engine/codex.ts`）：
   - 先掃 `REJECTED_RE`（行首 `ISSUES FOUND` / `REMAINING ISSUES`）→ 一律 false；
   - 再認標準 `## Verdict` 後獨立行 `APPROVED`，或最後非空行為裸 `APPROVED`；
   - 句中出現 APPROVED 不算通過。
3. **適用範圍**：真實工作流步驟走 verify；對話 ad-hoc 步驟可 `skipVerify`（產品決策），不削弱工作流閘。

## Consequences

- 跨模型不變式可在回歸腳本（`t06-invariants`）無 LLM 成本下驗證。
- 驗證器可與執行器不同（含顯式指定 GROK 加速），但不得同模型。
- 判決格式漂移時仍 fail-closed：寧可不通過，不可誤放行。
