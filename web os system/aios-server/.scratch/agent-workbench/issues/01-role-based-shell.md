# 票 01 — 雙介面與角色導向

## 範圍

- 將原 Dashboard 搬到 `/admin`。
- `/` 在 auth 載入後導向 `/work`。
- AppShell 依 `/work` 與管理路由呈現不同 shell。
- MEMBER 進入管理路由時導回 `/work`。
- FDE 工作台提供「管理中心」入口；管理中心提供「回工作台」入口。

## 驗收

- 不改後端 guard。
- MEMBER 看不到管理導覽。
- FDE 原有管理路由可達。
- 深連結與登出仍正常。
