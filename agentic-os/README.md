# Lazyoffice Agentic OS — 重構工作區

> 由 WAIC 2026 上海參展情報（L0–L9 藍圖）＋ 我們的「AI 第一性原理」融合而成的 Agentic OS 重構規劃與前端雛形。
> 產出時間：2026-07。方法：Sonnet 精讀 → WebSearch 即時查驗 → Opus 逐層 Review（實讀 aios-server 程式碼）→ Opus 融合 Spec → Fable 架構＋派工開發前端。

## 一句話結論
以上海 L0–L9 為技術骨架，**第一性治理層統攝全棧**；我們原本更硬的護城河（**跨模型驗證閘、在地優先、引擎層限制、紅線 redactor、understand→confirm 閘**）保留並強化為差異化。**真正在流血的是 3 個 P0 硬約束缺口：成本計量＝0、shell/sendEmail 未硬攔截、HITL 是死狀態。先止血，再對齊。**

## 目錄
```
agentic-os/
├─ README.md                     ← 你在這裡
├─ spec/
│  ├─ 00_現況Review_AIOS_vs_WAIC.md   逐層程式碼實讀對照（保留/改造/採用）
│  ├─ 01_融合架構Spec.md              融合版重構 Spec（總架構圖、自研/借用/採購總表、
│  │                                  第一性治理層、每Agent獨立資料夾/沙盒/記憶、
│  │                                  語音生員工流程、P0/P1/P2 遷移路線、前端IA）
│  └─ 02_誠實評估_給Kevin.md          「我是否被上海帶偏」的直白評估
├─ 技術參考文獻/
│  ├─ README.md                      L0–L9 開源選型索引 + 授權地雷清單
│  ├─ L0…L9_*.md                     每層：借用開源(含授權)/採購/自研Spec/反模式/查證缺口
│  └─ _即時查驗.md                    WebSearch 即時查驗（MemOS/L2/E2B/LiteLLM/協議）
└─ web/
   └─ index.html                     Agentic OS 主控台前端雛形（單檔、自足、可直接開）
```

## 前端雛形（web/index.html）
本地優先「AI 員工」作業系統主控台，6 個視圖：
1. **Agent 列表**（部門資料夾樹＋員工卡：健康燈號/成本條/風險分級/`execute≠verify` 雙引擎徽章）
2. **Agent 詳情**（身分卡／獨立沙盒／記憶／限制／成本／執行時間軸／Computer Use）
3. **Skill 庫**（理解卡跨模型審查／eval／版本 channel／確認閘）
4. **Workflow 編排**（DAG／結構化交接 WorkOrder／HITL 閘門／觸發器）
5. **建立虛擬員工**（語音/文字描述 → 意圖 → 挑 Skill → 身分卡草稿 → 跨模型驗證閘 → 人審啟用）
6. **Dashboard/健康**（十大燈號＋根因／成本告警／防竄改稽核鏈／階層組織圖）

> 直接用瀏覽器開啟 `agentic-os/web/index.html` 即可（純前端 mock 展示，尚未接後端）。

## 融合分頁
既有 `AI_Agent_第一性優化建議.html` 已新增「🌏 上海融合架構」分頁：第一性治理層統攝 L0–L9 的總架構圖、逐層判斷、護城河 vs P0 缺口、P0/P1/P2 路線。

## 下一步（P0 止血，可接 Grok 寫 / Opus 審 迴圈）
1. **成本帳本**（L7）：`runner.ts` 每次引擎呼叫後寫 `CostLog`（NUMERIC）＋每 agent 日/月預算 fail-closed 硬阻斷。
2. **硬攔截點**（L0/L6）：`sendEmail`/`shell` 補真正攔截；`DEFAULT_RESTRICTIONS.shell` 改預設 `false`。
3. **HITL 復活**（L2）：讓 `AWAITING_REVIEW` 真的被觸發＋approval service＋resume token＋逾時升級。
