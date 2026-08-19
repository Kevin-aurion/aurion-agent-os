# 09 — 需 FDE 核准的單一動作模板

**Phase:** 3
**Blocked by:** 07 — Compiler Core
**Status:** ready-for-agent

## What to build

新增 approval-gated-action-v1，最多一個已允許 write capability，且 approval checkpoint 在任何 side effect 之前。

## To-Do List

- [ ] 定義 approval reason、risk、single-write slots
- [ ] 在 graph 結構上強制 checkpoint-before-write
- [ ] 拒絕多 write、self-approval、publish／permission tools
- [ ] 加入 refund／prompt-injection fixture

## Acceptance criteria

- [ ] 任何 write 前一定產生 approval.required
- [ ] 最多一個 allowlisted write tool
- [ ] Langflow approval 不具治理效力
- [ ] self-approval 與二次 write 編譯期拒絕

## Exact likely files

- src/compiler/templates/approval-gated-action-v1.ts
- compiler registry
- tests/t09-*

## Existing patterns to reuse

- requiresApproval／isRunApproved contract、MCP capability allowlist

## Must not modify

- approval.ts
- Langflow native approval authority
- free-form write nodes

## Verification

- server tsc
- checkpoint-order test
- multi-write／self-approval negative

## Positive / negative tests

- 正向：refund escalation template
- 負向：write-before-checkpoint、two writes、confirm Skill tool
