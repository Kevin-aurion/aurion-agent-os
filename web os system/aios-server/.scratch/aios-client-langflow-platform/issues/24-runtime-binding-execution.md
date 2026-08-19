# 24 — Runtime Binding 正確路由到 Langflow Flow ID

**Phase:** 6
**Blocked by:** 23 — Langflow API auth
**Status:** ready-for-agent

## Defect（live 證據）

部署已成功回傳並保存 `runtimeBinding.bindingRef = langflow:flow:<flowId>`，但 `executePilotRun()` 呼叫 Adapter 時傳的是 AIOS `FlowArtifact.id`。Langflow `/api/v1/run/{id}` 需要真正的 Langflow Flow ID，因此 live POC 01/02 在認證修好後由 403 前進到 404。

## What to build

- 在 Runtime execution 路徑從 `RuntimeDeployment.runtimeBinding` fail-closed 解析 Langflow Flow ID。
- 只接受 plain object、`kind=LANGFLOW`、`bindingRef` 精確符合 `langflow:flow:<non-empty-safe-id>`；不得接受其他 runtime、空值、額外 prefix/suffix、控制字元。
- `adapter.execute().artifactId` 必須傳解析出的 Langflow Flow ID，不再傳 AIOS artifact ID。
- binding 缺失／畸形時，Run 標為 FAILED、zero adapter call、稽核／錯誤先 redact；不可 fallback 回 artifact ID。

## Acceptance criteria

- [ ] 正向測試證明 Adapter 收到部署回傳的 Flow ID。
- [ ] malformed/missing/wrong-kind/control-character binding 全部 fail-closed 且 zero adapter call。
- [ ] t20 POC 01/02 live execute 不再 404；deploy + execute + cleanup/DB cleanup 完成。
- [ ] server typecheck、ticket-scoped typecheck、t18 runtime execution tests、t20 全綠。
- [ ] 不改 FDE gate、Skill confirm、execute≠verify、budget/rate/circuit/DLQ red lines。

## Likely files

- `src/lib/runtimeexecution.ts`
- 新測試 `.scratch/aios-client-langflow-platform/tests/t24-runtime-binding-execution.test.ts`
- `tsconfig.ticket23.json`（納入新測試即可）

## Must not modify

- Adapter wire format、Production/Sandbox credentials、`.env`
- migrations、既有治理閘、`lazyoffice-system-main`
- 不 commit/push
