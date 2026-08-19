# 15 — FDE Flow Artifact／Deployment 管理旅程

**Phase:** 4
**Blocked by:** 06 — Runtime Deployment Gate
**Status:** ready-for-agent

## What to build

在 Admin 顯示 Skill IR、Flow Artifact digest、validation、Runtime Deployment、canary/stable、rollback 與 Sandbox 入口。

## To-Do List

- [ ] 新增 runtime client types/API calls
- [ ] 建立 artifact list/detail/digest status
- [ ] 建立 activate CANARY、promote STABLE、rollback、kill-switch UI
- [ ] Sandbox deep-link 只給 FDE 且不等同發布

## Acceptance criteria

- [ ] 所有生效動作呼叫 FDE gate
- [ ] digest drift／eval／same-family 阻擋原因可見
- [ ] MEMBER 不載入 runtime admin data
- [ ] Sandbox Save 不改 Production

## Exact likely files

- aios-web admin runtime pages/components/lib/tests

## Existing patterns to reuse

- admin shell、proposal/skill governance、runtime routes

## Must not modify

- backend gate bypass
- MEMBER access
- direct Langflow publish button

## Verification

- web typecheck
- runtime API contract test
- Browser FDE canary/stable/rollback + MEMBER denial

## Positive / negative tests

- 正向：validated artifact activation
- 負向：drifted/rejected artifact controls disabled and server refused
