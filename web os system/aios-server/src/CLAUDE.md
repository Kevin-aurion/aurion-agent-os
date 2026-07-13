# src — 後端原始碼

Fastify 應用的所有 TypeScript。ESM 模組，**相對 import 需帶 `.js` 副檔名**（編譯後對應）。

## 進入點
- `index.ts` — 建 Fastify、註冊 `routes/*`、掛 `ws/hub`、`startScheduler()`。
- `config.ts` — 集中設定：`engines.{claudePath,codexPath,grokPath}`、`google.scopes`/`microsoft.scopes`、`paths.{agents=MyAgent,runs,skills…}`、`tz`。

## 模組（各有自己的 CLAUDE.md）
| 目錄 | 職責 |
|---|---|
| `engine/` | 代理執行核心：三 CLI 適配、execute↔verify 迴圈、工具、限制、具現化 |
| `routes/` | REST 端點（agents/workflows/skills/conversations/runs/dashboard/auth/health） |
| `workflow/` | 工作流執行器與觸發（keyword） |
| `scheduler/` | BullMQ 定期工作流 |
| `integrations/` | Google/Microsoft/LINE OAuth + 雲端硬碟 |
| `channels/` | LINE 收發（webhook + push） |
| `skills/` | 技能理解（understand）流程 |
| `ws/` | WebSocket hub（AWP/1、pub/sub、onReq） |
| `lib/` | 共用工具（DB、auth、crypto、audit、http guard、filecontext） |
| `scripts/` | seed / doctor |

## 慣例
- 所有可觀察事件經 `ws/hub` 的 `hub.publish(topic, payload)` 廣播。
- 錯誤走 `lib/http.ts` 的 `ok()/errors/sendError()`。
- 存取控制是**程式碼**（`lib/guard.ts` + 工具層綁定），不是提示。
