# 05 — 不可變 Flow Artifact 與 Digest

**Phase:** 3
**Blocked by:** 04 — SkillVersion 的機器可讀 Skill IR
**Status:** ready-for-agent

## What to build

建立 FlowArtifact、RuntimeKind、Artifact 狀態與 canonical JSON digest；所有內容落地前遮罩。

## To-Do List

- [ ] 先寫 digest stability／drift／redaction tests
- [ ] 新增 additive model、relations、indexes 與 migration
- [ ] 實作 canonicalize、sha256、verifyArtifactDigest
- [ ] 建立 createArtifact，只接受 redacted canonical content

## Acceptance criteria

- [ ] 相同輸入與 compiler version 產生相同 digest
- [ ] 任何 artifactJson 改動被偵測並拒絕
- [ ] secret 不以明文存在 artifactJson 或 metadata
- [ ] LANGFLOW 未加入 Engine enum

## Exact likely files

- prisma/schema.prisma
- new migration
- src/lib/flowartifact.ts
- tests/t05-*

## Existing patterns to reuse

- skillversion contentHash、redactSecrets、safepath discipline

## Must not modify

- Engine enum／runner.ts
- workflow/compose.ts
- 既有 migration

## Verification

- prisma validate／generate
- server tsc
- digest／drift／redaction negative suite

## Positive / negative tests

- 正向：deterministic digest、content-addressed reuse
- 負向：tamper、secret fixture、invalid runtime kind
