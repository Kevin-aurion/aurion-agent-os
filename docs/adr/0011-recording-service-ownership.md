# ADR 0011 — RecordingService 所有權與產物信任邊界

**Status**: Accepted（2026-07）

## Context

錄製 session 在主機層是全域資源（同時通常僅一個），但多使用者可能同時操作 Web UI。前端若可指定本機產物路徑，會造成任意讀檔與跨使用者污染。

## Decision

1. **所有權**：host-global 錄製 session **依 user 持有／隔離**（`RecordingSession`）；他ユーザー不得 stop／to-skill 別人的 session。
2. **不信任前端路徑**：產物路徑一律後端持有 + `safepath` 守門；to-skill **不接受** client 任意本機路徑。
3. **匯入治理**：`origin=RECORDED`、停在 `AWAITING_USER_CONFIRM`、內容經 `redactSecrets`；永不 auto-confirm（ADR 0003）。
4. **中斷可復原**：`recoverInterrupted` 清理／復原異常中斷的 session。
5. **轉譯策略**：委派 Codex 自產（ADR 0005），本服務負責 session 生命週期與安全匯入。

## Consequences

- 錄製 API 可 requireAuth（MEMBER 建草稿），生效仍靠 FDE。
- live Computer Use 未通不影響所有權與匯入路徑的單元／整合驗收（`t04-recording` 等）。
