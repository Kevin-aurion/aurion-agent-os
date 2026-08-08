# components — 共用 UI 元件

- `AppShell.tsx` — 三表面外框：
  - **工作台**（`/work`）：頂欄 + 全寬主區；FDE 可進「管理中心」。
  - **管理中心**（`/admin`、`/admin/devices`、`/employees`、`/skills`…）：側欄導覽 +「回工作台」；MEMBER 進管理路由會導回 `/work`。
  - **Agent 建置入口**（`/agent-builds`）：同帳號、獨立品牌與單一「Agent 建置」選單；不顯示管理中心其他頁籤。
- `ui.tsx` — 基礎元件（卡片、按鈕、徽章、開關等）。
- `devices/` — 裝置選擇器 `DeviceSelector`、任務檢查點面板 `DeviceTaskPanel`（對齊 `devices.ts`/`device.ts` REST + `toSafeDeviceTaskDto` 列表形狀）。
- `workbench/` — 工作台共用塊（AgentBuilderPanel、VoiceInput、SkillDraftCard、ChatRunTimeline、types）。見 `workbench/CLAUDE.md`。

## 注意
- 開關（toggle）採 flex 佈局避免跑版。
- 樣式用 Tailwind + `lib/cn.ts` 合併 className。
- 權限：前端 gate 只是 UX；後端 `requireAuth` / `requireTrainer` 才是真實來源。
