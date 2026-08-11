# 19 — Runtime Observability、SLO 與 Audit

**Phase:** 5
**Blocked by:** 18 — Production Pilot
**Status:** ready-for-agent

## What to build

讓 Native／Langflow Run 共用 Trace、Audit、AWP timeline、Cost 與 health 指標，建立可觀察的 pilot SLO。

## To-Do List

- [ ] RunTrace trajectory 加 optional runtimeKind/artifactId
- [ ] 部署、rollback、kill-switch 寫既有 AuditLog
- [ ] Langflow event 翻成既有 run.step/run.log
- [ ] dashboard 增加 sandbox/production health，不影響既有燈號
- [ ] 量測 latency、tool error、approval latency、cost、adapter timeout

## Acceptance criteria

- [ ] 同一 Client timeline 不需分支 Runtime
- [ ] Langflow health failure只影響新增 signal
- [ ] Audit hash chain 驗證通過
- [ ] dashboard 有明確 pilot SLO／error counters

## Exact likely files

- src/lib/trace.ts
- src/runtime/langflow.ts
- dashboard health route
- WS publish callsites
- tests/t19-*

## Existing patterns to reuse

- RunTrace fail-safe、audit helper、AWP topics、health signals

## Must not modify

- 既有 health signal semantics
- required trace fields
- 新 audit system

## Verification

- server/web tsc
- trace/AWP parity
- audit chain
- health isolation/SLO metrics

## Positive / negative tests

- 正向：Langflow run full trace
- 負向：legacy trace compatibility、Langflow down leaves other signals correct
