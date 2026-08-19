# AIOS Skill Production Platform — Implementation Spec

Status: approved for implementation (2026-07-27)

## Outcome

Turn AIOS from a collection of agent features into a governed factory that can capture work from conversation or recording, compile it into a reusable Skill, evaluate it, release it progressively, and expose or consume capabilities through stable protocols without exposing technical details to ordinary users.

## Non-negotiable invariants

1. Execute engine and verify engine remain different; verification remains fail-closed.
2. Budget, restrictions, approval, path safety and promotion gates are code-enforced and fail-closed.
3. `redactSecrets()` applies before Skill, trace, evaluation evidence or audit content is persisted.
4. Generated or changed Skills remain `AWAITING_USER_CONFIRM`; only TRAINER/OWNER can confirm or promote.
5. MEMBER operations create inert drafts or `ChangeProposal` records only.
6. External MCP/A2A peers never become a policy authority. AIOS checks identity, scope, risk, budget and approval before dispatch.
7. Existing Agent folders and existing confirmed Skills remain compatible.

## Domain boundaries

| Domain | Owns | Does not own |
|---|---|---|
| Agent | identity, model routing, permissions, memory, mounted Skill references | executable API implementation |
| Skill | procedural SOP, triggers, exclusions, required capabilities, evaluation contract | credentials or policy bypass |
| Capability/MCP | typed executable operation and data access | agent identity, promotion or approval decisions |
| Workflow | deterministic order, conditions, retries, HITL and durable execution | external autonomous agent identity |
| A2A | discovery and governed task delegation to an independently deployed agent | internal deterministic workflow replacement |
| Memory | facts, history, preferences and learned context | procedural source of truth |

## Slice 1 — Progressive Skill Disclosure

- Add a backward-compatible Skill manifest parser. Metadata: `description`, `whenToUse[]`, `whenNotToUse[]`, `requiredTools[]`, `conflictsWith[]`, `sideEffects[]`, `riskTier`, `tokenBudget`, `evalSuiteId`, `version`.
- Metadata may be stored in structured JSON or parsed from SKILL.md frontmatter, but legacy Skills without metadata must receive deterministic safe defaults.
- `compileManifest()` must not inject all complete Skill bodies into the system prompt.
- L1 prompt contains only a bounded catalog and safe relative paths. L2 is loaded only after selection; L3 resources/scripts/assets are read only on demand.
- Materialized Skill directories remain inside the Agent root and use `safeJoin`/`assertInsideRoot` for any externally influenced path.
- Add an authenticated endpoint for an Agent's available Skill catalog and a trainer endpoint to inspect/update metadata.
- Test prompt size behavior, legacy fallback, malicious paths, conflicting Skills and unconfirmed Skills.

Acceptance: adding a 100 KB mounted Skill does not add its body to the initial system prompt; the Agent can still locate and use the confirmed Skill from its materialized folder.

## Slice 2 — Evaluation and Promotion Gates

- Add persistent evaluation suites/cases/runs/results, or an equivalently auditable schema. Decimal for monetary data; enums multiline; new migration only.
- Evaluation case kinds: positive trigger, negative trigger, confusion pair, trajectory, output rubric, prompt injection/red-team.
- Deterministic checks run without LLM where possible. Nondeterministic output evaluation uses an engine different from the candidate execution engine.
- Store redacted evidence, scores, required/forbidden tools, latency/cost and result status.
- A library regression run checks the candidate against its suite and relevant conflicting Skills.
- Stable promotion is fail-closed: requires FDE, a passing completed evaluation run, no unresolved high-risk result, and the existing confirmation/Codex gates.
- Shadow and canary are explicit release stages. Rollback switches pointers and never deletes versions/evidence.
- Add FDE APIs and UI showing suite, last run, failures, release stage and rollback.

Acceptance: direct promotion without a passing eval is rejected; a MEMBER cannot execute or promote an eval; injection/trajectory negative tests fail safely.

## Slice 3 — Governed MCP Capability Gateway

- Replace the recording/computer-use-only client shape with a reusable MCP client/session abstraction while preserving existing exports during migration.
- Registry fields: server id/name, command or loopback URL, transport, negotiated protocol version, enabled state, trust tier, credential reference (never plaintext response), allowed Agent ids, tool/resource allowlists, read/write class, risk tier, approval requirement, timeout, health and version metadata.
- Only stdio and loopback HTTP are allowed initially. Remote network MCP is disabled unless explicitly configured by FDE.
- Long-lived sessions are reused; concurrent connection creation is deduplicated; crashes invalidate the session and allow bounded reconnect.
- Support current initialization negotiation, notifications/progress, cancellation, per-call timeout, idempotency key and structured error mapping.
- Capability broker order: authenticate → registry/Agent scope → restrictions → risk/HITL → budget → dispatch → redact → cost/audit. Gate failures are fail-closed; audit/cost recording follows current documented semantics.
- Add FDE registry/health APIs. Secrets remain environment/keychain references.
- Existing `aios-mcp` supplier remains functional. Document AIOS as both MCP provider and consumer.

Acceptance: an unauthorized Agent, disallowed tool, non-loopback URL, invalid registry entry and expired timeout are all rejected before unsafe dispatch.

## Slice 4 — Durable Recording to Skill Factory

- Introduce one `RecordingService` used by REST routes and MCP tools; routes no longer own process/session state.
- Server owns sessions and artifact paths. Operations: start, status, stop, compile-to-draft. Return opaque session/artifact ids, never trust client filesystem paths.
- Use the MCP Gateway long-lived event-stream session, progress events and operation-appropriate timeouts.
- Persist enough state to report interrupted/orphaned sessions after server restart. Only one host-global active recorder unless the provider proves otherwise.
- Idempotent start/stop/compile operations; authorization is checked on every operation.
- `compile-to-draft` delegates to the existing Codex Record & Replay + skill-creator behavior, redacts before persistence, and always creates an inert draft awaiting FDE confirmation.
- Expose governed recording tools from `aios-mcp`: `recording_start`, `recording_status`, `recording_stop`, `recording_compile_skill`.
- Add WebSocket progress updates and Workbench UX for recording state, recovery and draft review.

Acceptance: duplicate stop/compile does not create duplicate artifacts/Skills; a different user cannot inspect a session; restart produces a safe interrupted state; no endpoint accepts a raw local output path.

## Slice 5 — Trace-to-Skill and A2A Boundary

- Persist redacted trace summaries for successful/failed runs: selected Skills, capability trajectory, verifier feedback and outcome. Do not store secrets or unrestricted raw prompts.
- Detect repeated successful trajectories conservatively and create a deduplicated Skill improvement/candidate `ChangeProposal`; never auto-confirm or auto-promote.
- Feedback/failure signals can create improvement proposals linked to Skill version and evaluation cases.
- Add internal Agent Card projection: identity, description, supported task/Skill summaries, input/output modes, risk and availability; exclude private prompts, credentials and memory.
- Add an opt-in A2A task gateway for FDE-approved peers only: discovery/card fetch and task submit/status/cancel with bounded payloads, auth reference, timeout and audit. Default disabled.
- Internal Agent-to-Agent workflow remains Temporal/runner based; A2A is only for independent external agents.

Acceptance: no private Skill body, prompt, credential or memory leaks through Agent Cards; MEMBER cannot register peers; remote delegation is disabled by default; repeated traces only create proposals.

## User experience

- MEMBER surface uses plain language: “交代工作”, “教它新工作”, “錄製示範”, “測試技能”, “送交確認”. Do not expose protocol configuration.
- FDE surface adds Skill quality/release state, capability registry health, recording recovery and external Agent peers.
- Every blocked action explains the policy reason and remediation without revealing secrets.

## Verification matrix

For every slice: TypeScript typecheck, production build where safe, focused integration scripts against real local PostgreSQL/Redis where required, and negative security tests. Final verification must additionally cover cross-model invariant, budget/restriction fail-closed behavior, redactor persistence, MEMBER/FDE separation, path traversal and migration integrity.

## Delivery discipline

- Grok CLI writes primary implementation.
- Claude Opus independently reviews diffs and runs verification; findings return to the same Grok session for repair.
- Codex performs final integration review and may apply only focused closing fixes.
- Preserve all pre-existing dirty work and never develop under `lazyoffice-system-main`.
