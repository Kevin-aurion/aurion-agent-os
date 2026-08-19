# src — 網頁原始碼

## 目錄
- `app/` — App Router 頁面與版面（各功能頁）。見 `app/CLAUDE.md`。
  - **`/work`** — Agent 工作台（Phase 1 主表面）
  - **`/admin`** — FDE Dashboard 總覽
  - `/` — 導向 `/work`
- `components/` — 共用 UI：
  - `AppShell.tsx` — 雙表面（工作台頂欄 vs 管理側欄）
  - `ui.tsx` — 基礎元件
  - `workbench/` — 工作台可重用塊
- `lib/` — 前端基礎設施：
  - `api.ts` — fetch 封裝；`normalize()` 自動補 `/api` 前綴；401 續期在頁內與跨分頁 single-flight，網路錯誤不清登入。
  - `awp.ts` — `useAwp(topics, handler)` 訂閱 WebSocket 主題；連線前共用 auth 續期。
  - `auth.tsx` — 登入狀態 / token；接收登入失效事件與跨分頁清除；`isFdeRole()`。
  - `auditzh.ts` — 稽核動作/實體的中文對照字典（ACTION_ZH / ENTITY_ZH）。
  - `cn.ts` — className 合併工具。

## 慣例
- 資料抓取用 React Query；WS 事件到達時 `qc.invalidateQueries(...)` 觸發重抓。
- 後端回應形狀以 `routes/*` 為準，頁面需對齊（曾因形狀不符把物件當 React child 而報錯）。
- 工作台不另建聊天後端；沿用 conversations/messages REST + `chat.message` WS。
