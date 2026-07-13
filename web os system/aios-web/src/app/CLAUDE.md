# app — Next.js App Router 頁面

## 版面/入口
- `layout.tsx` / `providers.tsx` — 全域版面與 React Query provider。
- `page.tsx` — 首頁（總覽 Dashboard）。
- `globals.css` — 全域樣式。
- `login/` — 登入頁。

## 功能頁
- `employees/` — 員工列表與 **`[id]/page.tsx` 詳情**（7 分頁：概況/技能/雲端檔案/工作流/執行紀錄/訓練/對話）。含限制卡、引擎/驗證選擇（含 GROK）、LiveRunTimeline、RunsTab、ChatTab（歷史記憶 + 即時渲染）。用 `?tab=` 深連結。
- `workflows/` — 工作流列表與 `[id]` 編輯（返回連到 `/employees/<id>?tab=workflows`）。
- `skills/` — 技能。
- `settings/` — 連動 Google/Microsoft/LINE 帳號、環境設定。
- `org/` — 組織圖與權限（OWNER/TRAINER/MEMBER；Kevin 為 OWNER 最高管理）。
- `audit/` — 中文稽核紀錄。

## 實測修過的重點
- 開關元件跑版 → flex 佈局修正（`inline-flex h-5 w-9 items-center` + `translate-x-[18px]`）。
- 對話回覆不顯示 → 訂閱 `chat.*` 並以 `payload.conversationId` 過濾、`run.finished` 重抓訊息。
