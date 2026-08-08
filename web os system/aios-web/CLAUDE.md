# aios-web — 網頁前端

Next.js 14（App Router）／React 18／TypeScript／Tailwind 3／@tanstack/react-query／lucide-react。開發跑 `127.0.0.1:3100`，把 `/api/*` 代理到後端 `8700`。

## 結構
```
src/
  app/          App Router 頁面（見 app/CLAUDE.md）
    work/       AI 工作台（Agent → thread；交代工作 / 教它新工作）
    admin/      FDE 管理中心總覽（原 Dashboard）
  components/   共用元件（AppShell 雙表面、ui、workbench/*）
  lib/          api client、awp(WS)、auth、cn、中文對照
next.config.mjs  /api → 8700 代理
tailwind.config.ts / postcss.config.mjs
```

## 指令
```bash
npm run dev        # 開發（3100），熱重載
npm run typecheck  # tsc --noEmit
```
⚠️ **切勿在 `next dev` 執行中跑 `next build`** — 會汙染共用的 `.next` 快取 → 白畫面。解法：`rm -rf .next` 後重啟 dev。

## 產品表面（Phase 1）
| 路由 | 角色 | 說明 |
|---|---|---|
| `/` | 全部 | auth 後 → `/work` |
| `/work` | 全部 | Codex 風格 Agent／任務 thread 工作台 |
| `/admin` + `/employees`… | FDE | 管理中心；MEMBER 前端導回 `/work` |

## 既有頁面/功能
員工列表與詳情（概況/技能/雲端檔案/工作流/執行紀錄/訓練/記憶/對話）、工作流編輯、技能、設定（連動帳號）、組織圖與權限、提案審核、中文稽核。即時更新靠 `lib/awp` 訂閱 WS 主題。

## 狀態
本輪：Agent Workbench Phase 1（雙表面 + 工作台 Work/Teach）＋ **建立 AI 員工**（Agent Builder 前端，接既有 backend）。不改 Prisma、不弱化治理閘。

## 登入續期
- Access Token 為短效憑證；`lib/api.ts` 以單一進行中請求 + Web Locks 跨分頁序列化 Refresh Token 輪替，避免多個 401 互相撤銷而提前登出。
- 登入最長 3 天（後端絕對期限）；暫時網路中斷不得清除仍有效的 Refresh Token。WebSocket 建連前也走同一套續期。
