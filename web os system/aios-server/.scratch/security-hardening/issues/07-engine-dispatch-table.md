# 07 — 三引擎派工收斂為單一對照表（含決策路徑補 GROK）

**What to build:** 開發者修改或新增引擎行為時只需改一處：execute／verify／decide 三條路徑共用同一份引擎對照表。GROK 員工在多候選缺陷路由時，會真的用 GROK 決策，成本也記在正確引擎上，而不是靜默改用 Claude。

**Blocked by:** None — can start immediately

**Status:** ready-for-agent

- [ ] 三處 if-cascade 收斂為單一引擎對照表（每引擎一組行為）
- [ ] 決策路徑支援 GROK；成本記錄的引擎欄位與實際呼叫一致
- [ ] 跨模型驗證閘語義零改變（執行≠驗證仍於載入時強制、fail-closed 判決不變）
- [ ] `tsc --noEmit` 與 build 通過；既有執行流測試零回歸
