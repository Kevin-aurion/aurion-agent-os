# src — 網頁原始碼

## 目錄
- `app/` — App Router 頁面與版面（各功能頁）。
- `components/` — 共用 UI：`AppShell.tsx`（側邊導覽，含組織 nav）、`ui.tsx`（基礎元件）。
- `lib/` — 前端基礎設施：
  - `api.ts` — fetch 封裝；`normalize()` 自動補 `/api` 前綴。
  - `awp.ts` — `useAwp(topics, handler)` 訂閱 WebSocket 主題。
  - `auth.tsx` — 登入狀態 / token。
  - `auditzh.ts` — 稽核動作/實體的中文對照字典（ACTION_ZH / ENTITY_ZH）。
  - `cn.ts` — className 合併工具。

## 慣例
- 資料抓取用 React Query；WS 事件到達時 `qc.invalidateQueries(...)` 觸發重抓。
- 後端回應形狀以 `routes/*` 為準，頁面需對齊（曾因形狀不符把物件當 React child 而報錯）。
