# 25 — Langflow 環境隔離與 2xx 執行結果 Fail-Closed

**Phase:** 6
**Blocked by:** 23, 24
**Status:** ready-for-agent

## Defects confirmed by independent review

1. `resolveRuntimeAdapter('LANGFLOW')` always selects the Production endpoint/key, so activating or executing a Sandbox/Staging deployment may send the Production credential to the wrong environment.
2. `LangflowAdapter.execute()` treats every HTTP 2xx as success and discards the body. A malformed/error-bearing/empty result can therefore become a false `SUCCEEDED` Run.
3. Deploy accepts any non-empty Flow ID; binding parsing duplicates a stricter rule and reflects an untrusted wrong `kind` in errors.
4. Resume has no durable environment selection and can silently resolve the Production adapter.

## What to build

- Implement the environment configuration contract in `spec-25-langflow-runtime-boundary.md`; require an explicit environment for all LANGFLOW network adapter resolution and prohibit fallback.
- Keep Langflow artifact validation local/deterministic without requiring a credential.
- Pass deployment environment into activate and execute. On approval-required, store server-generated deployment id/environment in ApprovalRequest payload; resume must validate and use that exact deployment.
- Add one shared safe Langflow Flow ID parser and use it for deploy responses and runtime bindings. Replace reflected wrong-kind error with a constant message.
- Parse 2xx run responses fail-closed. Require a valid non-empty effective output, reject explicit errors, emit a bounded/deep-redacted normalized output event, persist it, then emit `run.finished: SUCCEEDED`.
- Reject loopback URLs with embedded username/password.

## Acceptance criteria

- [ ] Sandbox/Staging/Production each use only their named URL/key; matrix tests prove no Production key is ever sent to Sandbox/Staging.
- [ ] Missing environment, URL, or key rejects before network I/O; no cross-environment fallback.
- [ ] `validateArtifactForRuntime()` remains local and succeeds without any Langflow environment secret.
- [ ] Valid 2xx Langflow response emits `run.output` followed by success; output is persisted and deep-redacted/bounded.
- [ ] Malformed JSON, missing/empty effective outputs, and explicit error-bearing 2xx each emit failure and never success.
- [ ] Unsafe deploy Flow IDs and malformed bindings fail closed without reflecting the hostile value.
- [ ] Approval resume uses the server-bound deployment environment; missing/stale/mismatched binding rejects before adapter call.
- [ ] Userinfo loopback URLs are rejected.
- [ ] New Ticket 25 tests, t03, t17, t18, t23, t24, t20, server typecheck, and web typecheck pass.

## Likely files

- `src/runtime/adapter.ts`
- `src/runtime/langflow.ts`
- `src/lib/runtimedeployment.ts`
- `src/lib/runtimeexecution.ts`
- `src/lib/mcpregistry.ts` (userinfo rejection only)
- `.scratch/aios-client-langflow-platform/tests/t25-langflow-runtime-boundary.test.ts`
- `.scratch/aios-client-langflow-platform/tsconfig.ticket23.json`
- existing t18/t23/t24 tests only where contract fixtures must change

## Must not modify

- Production/Sandbox compose authentication posture or real secret values
- Prisma schema/migrations
- FDE, Skill confirmation, cross-model, Eval, budget, rate/circuit/DLQ gates
- `lazyoffice-system-main`, unrelated WIP
- no commit/push

## Verification order

1. Write negative tests first.
2. Ticket-scoped typecheck and t25.
3. t03, t17, t18, t23, t24, all t20 POCs.
4. Full server/web typecheck.
5. Independent review; fix and rerun from the start.
