# Codex Relay Bridge — Spike Report (Phase 1)

**Binary baseline**: `/Applications/ChatGPT.app/Contents/Resources/codex` — `codex-cli 0.144.2`
**Date**: 2026-07-13
**Scope**: Phase 1 only (fake-server integration + typecheck). Live smoke and GUI questions intentionally incomplete/unverified.

---

## Q1 — Does a thread started by the bridge appear in the desktop ChatGPT/Codex App history?

**Status**: UNVERIFIED, needs manual GUI test

**Suggested steps**:
1. Start the bridge MCP server and call `codex_start_task` with a unique message (e.g. `SPIKE-Q1-<timestamp>`).
2. Note the returned `thread_id`.
3. Open the ChatGPT macOS app → Codex / conversation history.
4. Search for the unique message or thread id.
5. Record: visible? delay? which list/section?

---

## Q2 — If the desktop already has the same thread open, do external turns stream into the UI in real time?

**Status**: UNVERIFIED, needs manual GUI test

**Suggested steps**:
1. Create a thread via bridge; open that thread in the desktop app.
2. Call `codex_continue_task` with a distinctive message.
3. Observe whether the desktop UI updates without refresh, and how soon.
4. Also try the reverse: type in desktop, then `codex_get_status` / `codex_read_output` on the bridge.

---

## Q3 — Dual-client same thread: event/approval ownership?

**Status**: PARTIAL (protocol-only reasoning; no multi-client live test)

App Server JSON-RPC is a single stdio client per `codex app-server` process. Phase 1 spawns **one** child owned by RelayCore. A second client would need another process or the unsupported `daemon`/`proxy` path (out of scope). Approvals are answered only by this bridge process; if desktop and bridge both attached to different runtimes, ownership is undefined until a shared runtime is designed (Phase 2+).

**Action if dual-attach is required**: do not assume exclusive ownership; document conflict; fail-closed on approvals this bridge does not see.

---

## Q4 — Can a custom client load the same Computer Use server/skill as the desktop app?

**Status**: UNVERIFIED, needs manual GUI test

**Suggested steps**:
1. Confirm desktop Computer Use skill works in the ChatGPT app.
2. Via bridge, start a thread in a project that needs Computer Use and request a computer-use action.
3. Observe whether the skill/server is available, and whether TCC prompts appear under the bridge process vs ChatGPT.app.
4. **Stop line**: if custom client cannot reuse desktop Computer Use permissions, do **not** paper over with UI automation; degrade Bridge to “independent Codex thread dispatch.”

---

## Q5 — macOS TCC authorization subject (which process owns Screen Recording / Accessibility)?

**Status**: UNVERIFIED, needs manual GUI test

**Suggested steps**:
1. System Settings → Privacy & Security → Screen Recording / Accessibility.
2. Trigger Computer Use from desktop; note which app is listed.
3. Trigger via bridge-spawned app-server; note whether ChatGPT.app, `codex`, or `node` is the subject.
4. Record whether re-granting is required after bridge use.

---

## Q6 — Schema upgrade compatibility and rollback

**Status**: PARTIAL (tooling verified)

- Types are regenerated on every `npm run gen:types` / `npm test` / `npm run build` from the installed Codex binary.
- `src/generated/CODEX_VERSION` records the generator version; startup logs the path/version hint.
- Generated TS uses extensionless imports (ts-rs); **not** typechecked by our `NodeNext` tsconfig (excluded). Method sets used at runtime are hard-coded from the generated unions and must be re-audited after upgrades.
- Rollback: pin ChatGPT.app / codex binary; keep git history of hard-coded method sets and decision maps.

### Wire-format fact (critical, verified on real binary 0.144.2)

Real `codex app-server` responses and notifications **omit** `"jsonrpc":"2.0"`. Incoming classification must not require that field (fixed Phase 1 blocker). Fake app-server mirrors this (no `jsonrpc` on the wire). Outgoing client messages may still include `jsonrpc`.

### Plan vs generated (0.144.2) discrepancies

| Topic | Plan | Generated 0.144.2 | Bridge choice |
|---|---|---|---|
| ServerRequest count | 11 kinds incl. `currentTime/read` | **10** methods; **no** `currentTime/read` | Implemented 10 + special-case auto-reply for `currentTime/read` (plan/tests) |
| UserInput text | `{type:"text", text}` | requires `text_elements: TextElement[]` | Sends `text_elements: []` |
| Legacy ReviewDecision deny | `denied` / timeout `timed_out` | same | match |
| item command/file approval | `accept` / `decline` | same | match |
| permissions deny | JSON-RPC `-32001` | `PermissionsRequestApprovalResponse` has no decline field | use `-32001` per plan |
| Dynamic tool output item | text content | `{type:"inputText", text}` | match generated |
| ThreadStart sandbox | `sandbox:"workspace-write"` | `SandboxMode` includes `"workspace-write"` | match |
| AskForApproval | `"on-request"` | includes `"on-request"` | match |

---

## Test results summary

### `npx tsc --noEmit`

Passes with zero errors (see final report for full log).

### `npm test` (integration suites on fake-app-server)

Suites (post Phase-1 review fix):

1. `new-thread`
2. `resume`
3. `concurrent-resume` (exactly one `thread/resume` under concurrent continue)
4. `concurrent-turn`
5. `approval-fail-closed` (parameterized 11 kinds)
6. `crash-during-approval` (both directions)
7. `strict-reject`

### Live smoke — real end-to-end dispatch (VERIFIED 2026-07-13, by reviewer Opus)

Driven through the **actual MCP tool surface** against the **real** `codex app-server` 0.144.2 (not the fake server):

- `codex_start_task` { project: `/Users/kevin/Documents/aurion`, message: "reply with exactly PONG…", idempotency_key } → returned `task_id`, `thread_id`, `status: active` (`idempotent_replay: false`).
- Normalized event sequence observed via `codex_read_output`: `turn_started → item_started → item_completed → agent_message_delta ×2 → agent_message → turn_completed`.
- Final `codex_get_status` → `status: idle`, `summary: "PONG"`. No approvals were raised for this plain-text turn.
- **Result: end-to-end dispatch works** — Claude → MCP → Relay Bridge → real Codex turn → agent output read back. No `jsonrpc` protocol-violation errors after the framing fix.

Prerequisite bug fixed during review: the real app-server omits the `jsonrpc` field on messages; the bridge's strict parser wrongly required `jsonrpc:"2.0"` and rejected every real message. Parser relaxed (incoming classified by `id`+`result`/`error` = response, `method` = request/notification, regardless of `jsonrpc`), and `fake-app-server` updated to omit `jsonrpc` so tests match reality. Re-verified: `tsc` clean, 7/7 tests, real-binary handshake completes, MCP `tools/list` returns all 5 tools, `claude mcp list` → `codex-relay ✔ Connected`.

`tests/live/live-smoke.test.ts` (the `LIVE=1` gated test) remains present/skipped for CI.

---

## Known limitations (Phase 1)

1. In-memory registry/events only (`// TODO(phase2): SQLite`).
2. **No auto-restart** of app-server after exit/crash.
3. Single app-server child; no process pool.
4. Project allowlist is a hard-coded constant.
5. Some ServerRequest kinds never allow (`item/permissions/requestApproval`, `item/tool/requestUserInput`, elicitation Phase1 deny-only).
6. `currentTime/read` handled though absent from generated `ServerRequest`.
7. Generated types excluded from `tsc` due to extensionless imports.
8. GUI / Computer Use / TCC questions unverified.
9. **Phase 2 TODO — compile-time binding to `src/generated`**: relay-core hand-builds JSON-RPC params (e.g. `thread/start`, `turn/start`, `turn/steer`) without `import type` / `satisfies` against generated types, so field drift is not caught by `tsc`. Ideal fix is `const params = { ... } satisfies ThreadStartParams` (etc.). **Blocked in Phase 1**: generated files use extensionless relative imports from ts-rs; including them under `moduleResolution: NodeNext` reintroduces hundreds of TS2835 errors. Options for Phase 2: (a) post-process generate-ts to append `.js` extensions, (b) a thin hand-written ambient module that re-exports only the few param types we need, or (c) a separate non-NodeNext typecheck project for protocol payloads only.

---

## Go / No-Go draft (toward Phase 2)

| Gate | Criterion | Status |
|---|---|---|
| (1) Six fake-server tests green | Required | **PASS** |
| (2) Live smoke green | Required for full Go | **NOT RUN** (blocked by Phase 1 stop rule) |
| (3) 11 ServerRequest fail-closed per-kind tests | Required | **PASS** (incl. special-case #11) |
| (4) Crash both directions | Required | **PASS** |
| (5) `tsc --noEmit` zero errors | Required | **PASS** |
| (6) Spike Q1–Q6 filled | GUI may be UNVERIFIED | **PASS** (Q1/Q2/Q4/Q5 UNVERIFIED + steps) |

**Draft recommendation**: **CONDITIONAL GO** for Phase 2 engineering (persistence / multi-client design) **after** live smoke passes and at least Q1/Q2/Q5 are filled by a human.
**No-Go triggers still open**: live smoke failure on 0.144.2 stdio app-server; any fail-closed regression; confirmation that Computer Use cannot be shared (then re-scope Bridge as independent thread dispatch only).
