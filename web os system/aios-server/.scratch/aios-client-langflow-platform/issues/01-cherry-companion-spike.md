# 01 — Cherry Companion Client 安全與 UX Spike

**Phase:** 1
**Blocked by:** None — can start immediately
**Status:** ready-for-agent

## What to build

以未修改的外部 Cherry Studio 作為既有 AIOS Remote MCP builder profile 的純 Client，驗證只能建立惰性 AgentBuildSession，並產出乾淨室 Workbench 的 UX 研究報告。

## To-Do List

- [ ] 用測試帳號完成 builder OAuth 與一輪建立 AI 員工對話
- [ ] 確認結果只落在 AgentBuildSession／Iteration
- [ ] 嘗試 confirm Skill、approve Proposal、MCP registry write、Agent CRUD
- [ ] 記錄值得吸收的 Thread、Artifact、Skill、Schedule、Approval 互動，不複製程式或資產

## Acceptance criteria

- [ ] 產生一個可由 FDE 審查的 shadow draft，未直接建立正式 Agent／Skill／Workflow
- [ ] 所有越權 route 均 403 且資料零變更
- [ ] 完成 spike report 與清晰 clean-room 設計輸入

## Exact likely files

- 新增 reports/01-cherry-spike-report.md；不修改 production source

## Existing patterns to reuse

- Remote MCP builder profile、assertScopedRoute、AgentBuildSession 狀態機

## Must not modify

- aios-mcp 與 aios-server 授權程式
- 任何 Cherry source／asset／package

## Verification

- Browser 完成 OAuth 與建立流程
- 用 scoped token 對四類禁止 route 做 HTTP 負向測試
- 查 DB 比對 AgentBuildSession 與 Agent／Skill／Workflow 數量

## Positive / negative tests

- 正向：shadow draft 可見於 FDE build queue
- 負向：confirm／approve／registry write／Agent CRUD 全部 403
