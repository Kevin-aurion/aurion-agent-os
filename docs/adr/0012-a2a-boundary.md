# ADR 0012 — Agent-to-Agent（A2A）預設停用邊界

**Status**: Accepted（預設停用）（2026-07）

## Context

Agent 互通（發現、委派 task）有橫向移動與資料外洩風險。本輪只建立邊界與資料模型，不開放預設跨主機編排。

## Decision

1. **預設停用**：A2A 功能預設關閉；啟用路徑仍受後續旗標／設定約束。
2. **僅 loopback**：peer 位址比照 MCP 消費，不對公網／任意私網開放。
3. **註冊權限**：`A2APeer` 註冊在 route 層 **`requireTrainer`**；MEMBER 不得註冊 peer。
4. **AgentCard 投影**：`projectAgentCard` **先** `redactSecrets` 再外露，避免金鑰／個資進卡片。
5. **模型**：`A2APeer` / `A2ATask` 等已落地，供未來可控開啟。

## Consequences

- 負向測試（`t05-a2a-neg`）覆蓋未授權與邊界。
- 尚未跨主機實測；文件不得宣稱多機 A2A 生產就緒。
- 與 ADR 0003 一致：互通配置屬治理變更，需 FDE 路徑。
