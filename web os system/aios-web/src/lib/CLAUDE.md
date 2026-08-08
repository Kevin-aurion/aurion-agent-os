# lib — 前端基礎設施

- `api.ts` — REST 封裝（`API.get/post/...`）；`normalize()` 自動補 `/api` 前綴，帶 bearer token。
- `awp.ts` — `useAwp(topics, handler)`：訂閱 WebSocket（AWP/1）主題並在事件到達時回呼。支援 `*` 萬用主題。
- `auth.tsx` — 登入狀態、token 保存、受保護頁面守衛。
- `auditzh.ts` — 稽核動作/實體中文對照（ACTION_ZH / ENTITY_ZH）。
- `cn.ts` — className 合併工具。
- `devices.ts` — 裝置／任務 DTO 對齊後端：`SafeDeviceTaskListItem`（list metadata）、`DeviceTaskLifecyclePayload`、`deviceTasksQuery`、能力旗標含獨立 `codexApp` / `codexCli` / `lineDesktop`；enrollment/token 不寫 localStorage。

## 慣例
- WS 事件到達 → `queryClient.invalidateQueries([...])` 觸發 React Query 重抓，而非手動改狀態。
- 對話類事件用 `chat.*` 訂閱 + `payload.conversationId` 過濾（後端主題是 `chat.message`）。
- 裝置任務生命週期用 `device.task.*`（create/ack/progress/result/cancel/confirm/reject）；payload 僅 `taskId/deviceId/status/runId/agentId`，重抓 list/detail，無樂觀完成。
- 角色：`isFdeRole(role)`（OWNER/TRAINER）；工作台 MEMBER 只能提案、不可呼叫 trainer-only 確認。
