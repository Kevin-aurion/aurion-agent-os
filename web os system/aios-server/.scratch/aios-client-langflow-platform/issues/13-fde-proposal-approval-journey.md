# 13 — FDE 統一 Proposal／Approval 審核旅程

**Phase:** 4
**Blocked by:** None — can start immediately
**Status:** ready-for-agent

## What to build

將既有 ChangeProposal 與 ApprovalRequest 整合進同一 FDE inbox／detail experience，保留原後端權威。

## To-Do List

- [ ] 建立 inbox filter、risk、diff、source、requester views
- [ ] 串接既有 approve/reject，顯示真 DB 結果
- [ ] 將 tool approval card 與 proposal card 明確區分
- [ ] 加入 hash-audit／zero-change rejection evidence

## Acceptance criteria

- [ ] FDE 可完成 proposal 與 run approval
- [ ] MEMBER 無審核入口
- [ ] reject 後目標物零變更
- [ ] UI 不把 Langflow checkpoint 當核准

## Exact likely files

- aios-web admin/proposals/approvals journey components/tests

## Existing patterns to reuse

- 現有 proposals page、approvals routes、auditzh

## Must not modify

- approval/changeproposal server semantics
- member role expansion

## Verification

- web typecheck
- server existing governance tests
- Browser FDE approve/reject + MEMBER deny

## Positive / negative tests

- 正向：FDE review decisions persisted
- 負向：MEMBER route/UI denied、rejected target unchanged
