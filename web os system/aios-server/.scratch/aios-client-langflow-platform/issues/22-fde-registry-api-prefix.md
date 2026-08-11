# 22 — FDE Registry API Prefix Contract 修復（MCP/A2A panels 404）

**Phase:** 6
**Blocked by:** None — release-blocking integration defect from root Codex Computer Use UI 驗收
**Status:** ready-for-agent

## Defect（實測證據，非猜測）

FDE Dashboard 的 MCP 與 A2A panels 顯示無法載入。根因是三層 prefix contract 不一致：

1. 前端 `aios-web/src/lib/api.ts` 的 `normalize()`（line 114-116）把所有路徑固定加上 `/api` prefix。
2. `aios-web/next.config.mjs` rewrite：`/api/:path*` → backend `${API}/api/:path*`。
3. 但 backend FDE registry 路由註冊在**裸路徑**：`src/routes/mcp.ts` 全部在 `/mcp/*`（`/mcp/call`、`/mcp/servers` CRUD、`/mcp/servers/:id/health|enable|disable`）；`src/routes/a2a.ts` 全部在 `/a2a/*`（peers、cards、tasks）。

直接證據：backend `GET /mcp/servers` 存在並回 401（未帶 auth 時），但前端實際打的 `/api/mcp/servers` 經 rewrite 轉發到 backend `/api/mcp/servers` → **404**。A2A 同一 prefix contract，同病。

## What to build

讓前端經 `/api` prefix 能到達所有 FDE registry 路由（MCP + A2A），同時**不破壞既有裸路徑**：

- 裸路徑 `/mcp/*` 是既有 Remote MCP／OAuth-scoped client 的公開 contract（ticket 01 的 t01-builder-scope-negative 直接以 `/mcp/servers` 打負向測試），**必須原樣保留、guard 不變**。
- `/oauth/*`（mcpOAuthRoutes）完全不動。
- 建議方向（由 Grok 依現有程式碼選最小實作）：在 route 註冊層為 mcp.ts 與 a2a.ts 的每條路由增加 `/api` prefix 別名（同一 handler、同一 preHandler guard 陣列，勿複製貼上 handler 邏輯），或以 Fastify prefix re-register 方式掛第二份。禁止改 next.config rewrite 或前端 normalize 來繞過（那會破壞其他既有 /api 路由與部署面 contract）。

## Scope（同一 contract 影響面，必須全部處理）

- `src/routes/mcp.ts`：`/mcp/call`、`/mcp/servers`（GET/POST）、`/mcp/servers/:id`（GET/PATCH/DELETE）、`/mcp/servers/:id/health`、`/mcp/servers/:id/enable`、`/mcp/servers/:id/disable`。
- `src/routes/a2a.ts`：`/a2a/peers`（GET/POST）、`/a2a/peers/:peerId/card`、`/a2a/peers/:peerId/enabled`、`/a2a/peers/:peerId`（DELETE）、`/a2a/agents/:agentId/card`、`/a2a/tasks`、`/a2a/tasks/:taskId`、`/a2a/tasks/:taskId/cancel`。
- 若掃描發現其他「前端 FDE Dashboard 會呼叫、但 backend 註冊在裸路徑」的 registry 路由群，一併納入並在報告列出；`/oauth/*` 與 MCP wire-protocol endpoint 除外。

## Acceptance criteria

- [ ] `/api/mcp/servers` 經 FDE（OWNER/TRAINER）auth 回 200 與正確清單；未帶 token 回 401；builder-scoped token 回 403（zero DB change）。
- [ ] `/api/a2a/peers` 同上三態。
- [ ] 既有裸路徑 `/mcp/*`、`/a2a/*` 行為 byte-for-byte 不變：t01-builder-scope-negative 重跑全綠（仍以 `/mcp/servers` 為攻擊面）。
- [ ] `/api` 別名與裸路徑使用**同一** requireAuth/requireTrainer guard 實例；任何寫入路由維持 fail-closed；無任何 auto-confirm 行為新增。
- [ ] 前端路徑整合測試：模擬 normalize() 輸出的實際路徑（`/api/mcp/servers`、`/api/a2a/peers` 等）逐條打 live backend，正負向皆過。
- [ ] `npx tsc --noEmit`（server 與 web）exit 0；web 不需改碼（若 Grok 判定需要改 web，必須在報告說明為何 server-side alias 不足）。

## Exact likely files

- `aios-server/src/routes/mcp.ts`（或其註冊處 index.ts/routes 聚合層）
- `aios-server/src/routes/a2a.ts`
- 新測試：`.scratch/aios-client-langflow-platform/tests/t22-fde-registry-api-prefix.test.ts`

## Existing patterns to reuse

- t01-builder-scope-negative.test.ts 的 live HTTP + DB zero-drift 驗證模式
- 既有 requireAuth/requireTrainer preHandler 陣列

## Must not modify

- `/oauth/*` mcpOAuthRoutes 與任何 OAuth/DCR/PKCE 流程
- `aios-web/next.config.mjs` rewrite 與 `src/lib/api.ts` normalize（修 server contract，不是修 client）
- guard.ts、approval.ts、skillpromote.ts、既有 migrations、lazyoffice-system-main、使用者 WIP
- 不 commit/push

## Verification

1. PRE/POST alternate-index tree diff：只允許 mcp.ts / a2a.ts（或路由聚合層）+ 新測試檔。
2. t22 新測試全綠（live，三態 × MCP/A2A）。
3. t01-builder-scope-negative 重跑全綠。
4. server + web `npx tsc --noEmit` exit 0。
5. 報告結構：pass / changed files / tests / security（guard 與 fail-closed 證據）/ remaining blockers。
