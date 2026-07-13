# aios-web — 網頁前端

Next.js 14（App Router）／React 18／TypeScript／Tailwind 3／@tanstack/react-query／lucide-react。開發跑 `127.0.0.1:3100`，把 `/api/*` 代理到後端 `8700`。

## 結構
```
src/
  app/          App Router 頁面（見 app/CLAUDE.md）
  components/    共用元件（AppShell 導覽、ui 基礎元件）
  lib/           api client、awp(WS)、auth、cn、中文對照
next.config.mjs  /api → 8700 代理
tailwind.config.ts / postcss.config.mjs
```

## 指令
```bash
npm run dev     # 開發（3100），熱重載
```
⚠️ **切勿在 `next dev` 執行中跑 `next build`** — 會汙染共用的 `.next` 快取 → 白畫面。解法：`rm -rf .next` 後重啟 dev。

## 既有頁面/功能
員工列表與詳情（概況/技能/雲端檔案/工作流/執行紀錄/訓練/對話 7 分頁）、工作流編輯、技能、設定（連動帳號）、組織圖與權限、中文稽核。即時更新靠 `lib/awp` 訂閱 WS 主題。

## 狀態
本輪修過：開關（toggle）跑版、返回導向到特定員工、對話回覆即時渲染、對話歷史記憶。
