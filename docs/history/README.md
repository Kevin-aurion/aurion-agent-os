# Aurion Agentic OS — 技術參考文獻（L0–L9 開源選型）

> 來源：WAIC 2026 開發藍圖（Codex+Grok 雙軌查證，逐一核對 LICENSE 原檔）＋ 本輪 WebSearch 即時查驗。所有效能數字均為廠商/第三方單方宣稱，寫入正式 SLO 前須自有硬體重測。

## 逐層檔案

- **[L0](L0_治理與信任層.md)** 治理與信任層（Agent Registry、政策引擎、稽核鏈） — 混合：🟢借用（OPA/Casbin/OpenFGA/SPIRE/Keycloak… （14 個開源候選）
- **[L1](L1_互動層.md)** 互動層（Chat＋畫布/任務看板雙面、語音原語） — 混合：🟢借用（AG-UI 協議 ＋ assistant-ui/CopilotKi… （10 個開源候選）
- **[L2](L2_編排層.md)** 編排層（多 Agent 協作、結構化交接、HITL、耐久執行） — 混合：🟢借用雙引擎（LangGraph＋Temporal）為執行底座 ＋ 🔴自研… （6 個開源候選）
- **[L3](L3_技能層.md)** 技能層（SKILL.md 格式、技能測試/版本化/回滾、技能市集、自動沉澱） — 混合：🟢借用開放規格與測試框架（Agent Skills 規格＋Promptfo… （13 個開源候選）
- **[L4](L4_記憶層.md)** 記憶層（分層記憶、生命週期、混合檢索、Token budget） — 混合：🟢借用（框架借模式不借整套：Mem0 抽取管線／Graphiti bite… （8 個開源候選）
- **[L5](L5_工具與協議層.md)** L5 工具與協議層（MCP 深入、MCP Gateway、A2A、工具權限） — 🟪混合（🧠借用7／💰採購1／📚文獻57／⚠️缺口12）。定案：MCP 只定義 m… （7 個開源候選）
- **[L6](L6_執行沙盒層.md)** L6 執行沙盒層（Firecracker/E2B 自架、隔離技術比較、snapshot） — 🟧多後端混合（🧠借用10／💰採購2／📚文獻64／⚠️缺口11）。定案：Firec… （10 個開源候選）
- **[L7](L7_模型網關層.md)** L7 模型網關層（LiteLLM 類開源、路由、四維帳本、快取） — 🟩借用起步＋自研帳本（🧠借用5／💰採購0／📚文獻43／⚠️缺口11）。定案 Li… （5 個開源候選）
- **[L8](L8_感知與資料層.md)** L8 感知與資料層（文件解析、網頁取數、RAG ingestion） — 🟦混合可插拔（🧠借用9／💰採購1／📚文獻19／⚠️缺口9）。解析路由定案：預設 … （9 個開源候選）
- **[L9](L9_交付與商模層.md)** L9 交付與商模層（多租戶、用量計費、私有化交付） — 🟨混合（🧠借用10／💰採購1／📚文獻30／⚠️缺口9）。計費雙引擎：OpenMe… （10 個開源候選）

## 即時查驗摘要（2026-07，WebSearch）

見 [_即時查驗.md](_即時查驗.md)：涵蓋 MemOS、L2 編排耐久執行、E2B/Firecracker 沙盒、LiteLLM 網關、AG-UI/MCP/A2A 協議的現況/授權/資安風險。

## ⚠️ 授權地雷（法務先過）

- **Lago** AGPL-3.0（copyleft）· **MinerU** 2026-04 起自訂 license · **immudb** BSL 1.1（非 OSI）· **Arize Phoenix** ELv2（禁受管服務轉售）· **MinIO** 已封存（AGPLv3）· **Graphiti** 預設打 OpenAI endpoint 須改本地 · **LiteLLM/Temporal/LangGraph** 須 pin 修復版