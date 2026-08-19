# 以乾淨室 Client 重建 Cherry 式體驗，Langflow 僅作可替換 Runtime

AIOS 不 fork、複製或依賴 Cherry Studio 的程式碼與產品資產，而是依公開行為與產品邏輯重新設計 AIOS Client；AIOS 仍是 Agent、Skill、Tool、核准、成本與稽核的唯一控制平面。Langflow 僅能透過 Runtime Adapter 接收已核准且內容定址的 Flow Artifact，FDE Authoring Lab 與 Production Runtime 必須隔離，所有正式模型與 Tool 呼叫仍經 AIOS 的治理閘。這個決策避免雙重 Registry／Approval／Scheduler，也保留 Native Runner 與未來替換 Runtime 的能力。
