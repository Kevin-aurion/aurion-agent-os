# ADR 0010 — MCP Gateway：同時為 Provider 與 Consumer

**Status**: Accepted（2026-07）

## Context

AIOS 需要把既有 REST 能力供給外部代理（Claude/Codex 當 client），也需要消費本機外部 MCP 工具。雲端任意 MCP 會擴大攻擊面，必須 loopback-only 與憑證隔離。

## Decision

1. **雙向角色**：
   - **Provider**：`aios-mcp` 將 REST 暴露為 MCP server；
   - **Consumer**：server 內 `mcpclient` / `mcpbroker` / `mcpregistry`。
2. **Broker 語意**：request→response 對應與排序、逾時、crash 後重連；派工前先過 allowlist／enabled／agent 授權閘（`BrokerDeniedError`）。
3. **註冊只允許 loopback**：
   - `assertLoopbackUrl` 對 hostname **精確比對**（`127.0.0.1` / `localhost` / `::1`）；
   - 拒絕 `127.0.0.1.evil.com`、`0.0.0.0`、私網（如 `10.0.0.1`）；
   - `REMOTE_HTTP` 預設禁用。
4. **憑證**：僅存 `credentialRef`（`env:NAME` / `keychain:…`）；`toSafeDto` 不外洩密鑰明文。

## Consequences

- 外部 MCP 消費已落地（見 AGENTS.md §10 修正「未做 gateway」）；跨主機／公網 MCP 仍不做。
- 負向回歸：`t03-registry-neg`、`t06-regression-neg`。
