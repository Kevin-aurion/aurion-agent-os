# ADR 0009 — EvalSuite 與技能升級閘（promoteWithGate）

**Status**: Accepted（2026-07）

## Context

技能一旦 `stable` 會進入生產掛載路徑。僅靠 FDE 人工確認不足以覆蓋注入與輸出品質；需要可重複的評測套件與 fail-closed 升級閘。

## Decision

1. **資料模型**：`EvalSuite` / `EvalCase` / `EvalRun` / `EvalResult`；案例含 `POSITIVE_TRIGGER`、`PROMPT_INJECTION`（紅隊）、`OUTPUT_RUBRIC` 等。
2. **`promoteWithGate` 閘序（fail-closed）**：
   - FDE only（非 OWNER/TRAINER → 403）；
   - Skill 必須已 `CONFIRMED`；
   - 該 version 必須有 `EvalRun.status = PASSED`，否則 409；
   - 存在未解決 `highRisk` → 409；
   - RECORDED/COMPUTER_CONTROL 連 Codex 掛載閘；
   - 通過後才 `promoteToStable` 並 audit。
3. **跨模型沿用**：`runSuite` 強制 `verifyEngine !== executeEngine`（同引擎 → 400）。
4. **證據落地前**：`redactSecrets` 處理 evidence（API key／email 等不得入庫明文）。

## Consequences

- MEMBER 無法 promote；FDE 也不能跳過 eval（409）。
- 回歸：`t02-promote-gate` / `t02-neg` / `t06-*`。
- 回滾走 `rollbackWithGate`：切指標、不刪版本歷史。
