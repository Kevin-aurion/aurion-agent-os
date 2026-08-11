# 07 — Skill IR Compiler 與唯讀郵件分類模板

**Phase:** 3
**Blocked by:** 04, 05 — Skill IR 與 FlowArtifact
**Status:** ready-for-agent

## What to build

以 Zod Skill IR、固定 template registry 與確定性 compiler 產生 email-triage-readonly-v1 Artifact。

## To-Do List

- [ ] 先寫 IR schema／unknown intent／forbidden node tests
- [ ] 實作 template registry、slot validation、canonical compilation
- [ ] 建立唯讀 email triage graph，只允許 read／classify／summary／verify
- [ ] 將編譯結果交給 FlowArtifact service

## Acceptance criteria

- [ ] 相同 IR 可重現同 digest
- [ ] 模板不含 send／write／direct provider／Python／filesystem
- [ ] 無匹配模板時 REJECTED，不自由生成
- [ ] 所有 tool reference 必須是 AIOS capability id

## Exact likely files

- src/compiler/skillir.ts
- src/compiler/registry.ts
- src/compiler/compile.ts
- src/compiler/templates/email-triage-readonly-v1.ts
- tests/t07-*

## Existing patterns to reuse

- workflow compose 作為 sibling precedent、MCP capability ids、flowartifact digest

## Must not modify

- workflow/compose.ts
- direct Gmail／Graph credentials
- arbitrary generated graph

## Verification

- server tsc
- compiler deterministic test
- forbidden-node structural negative

## Positive / negative tests

- 正向：complaint／quotation IR compile
- 負向：send request、Python node、unknown template、direct credential
