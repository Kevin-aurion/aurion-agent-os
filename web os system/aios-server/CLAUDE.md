# aios-server — 後端

Node 22（ESM，import 帶 `.js` 副檔名）／Fastify 5／Prisma + PostgreSQL／BullMQ + Redis／Zod／argon2+jose／AES-256-GCM。**跑在主機**（需呼叫主機的 `claude`/`codex`/`grok` CLI，故不進 Docker）。監聽 `127.0.0.1:8700`（HTTP + `/ws`）。

## 結構
```
src/
  index.ts        進入點（註冊路由、WS hub、啟動排程）
  config.ts       設定（引擎路徑、OAuth scopes、paths、tz）
  channels/       通訊管道（LINE）
  engine/         代理執行引擎（三 CLI + 驗證閘 + 工具 + 限制）
  integrations/   雲端整合（Google/Microsoft/LINE OAuth + Drive）
  lib/            共用（DB、auth、crypto、audit、http、guard、filecontext）
  routes/         REST 端點
  scheduler/      BullMQ 排程（定期工作流）
  skills/         技能理解流程
  workflow/       工作流執行與觸發
  ws/             WebSocket hub（AWP/1）
  scripts/        seed / doctor
prisma/           schema + migrations
builtin-skills/   內建技能 SKILL.md
scripts/          雜項腳本
```

## 常用指令
```bash
npm run dev             # tsx watch（會熱重載）— 開發用
npm run start           # tsx（不熱重載）
npm run prisma:migrate  # 建/改表
npm run doctor          # 檢查 DB/Redis/CLI/整合金鑰
npm run seed            # 種子資料
npx tsc --noEmit        # 型別檢查
```
Node 在 `~/.local/node/bin`（`export PATH="$HOME/.local/node/bin:$PATH"`）。

## 狀態
- 三引擎、驗證閘、三種觸發、雲端讀寫、對話（含記憶）、限制強制皆完成並實測。
- API Key 放 `.env`（不進版控）。深入設計見 [`../ARCHITECTURE.md`](../ARCHITECTURE.md)。
