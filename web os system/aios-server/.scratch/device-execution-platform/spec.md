# AIOS Multi-device Execution Platform

## Goal

Allow FDEs to enroll and manage multiple execution devices. Every COMPUTER_CONTROL or device-local MCP step must target one explicit online, capable device. WebSocket is only a private wake-up channel; PostgreSQL is the durable task source of truth.

## Invariants

1. Server never dispatches arbitrary shell commands. Device work is a typed task referencing an approved Agent, SkillVersion or allowlisted MCP tool.
2. Device authentication is independent from user JWT. Enrollment secrets and device tokens are returned once; only hashes and safe prefixes are stored.
3. Private device events are delivered only to the selected device. Offline, revoked, unbound or incapable devices fail closed and are never silently substituted.
4. Existing governance remains unchanged: execute != verify, approval is DB-backed and fail-closed, redaction always applies, skills never auto-confirm, MEMBER changes stay proposals.
5. LINE Desktop uses a pinned, reviewed `dtwang/line-desktop-mcp` stdio process on the selected device. Sending is high risk and requires a real approval. `operation=send` **must** specify an allowlisted send tool (omit is fail-closed — device defaults must not skip HITL); `operation=read` may omit tool or use a read tool only; op/tool mismatch and unknown tools are rejected at payload validation. Route requires `runId` + DB-backed `isRunApproved` whenever `operation=send` **or** tool is a send tool.
6. Screenshots are scoped to the target app/window where possible, uploaded outside WebSocket, bound to task/device/sequence/hash/TTL and redacted before durable storage.

## Domain models

- Device: owner, platform, lifecycle, token hash/prefix, capabilities, last seen, versions.
- DeviceEnrollment: one-time hashed code, expiry, creator, consumption state.
- AgentDevice: explicit Agent-to-device binding.
- DeviceTask: target device, typed kind, durable state, idempotency key, lease, deadline, redacted payload/result.
- DeviceArtifact: task/device binding, sequence, kind, digest, size, safe path, MIME, TTL and redaction status.

## Task lifecycle

`PENDING -> DISPATCHED -> ACKED -> RUNNING -> AWAITING_CONFIRM -> SUCCEEDED|FAILED|TIMEOUT|CANCELLED`

Terminal writes are idempotent. A lease belongs to one device and expires fail-closed. Device reconnect does not create a second task.

### P1 hardening (review)

1. **confirmationRequired + SUCCEEDED**: DB conditional update requires `confirmedAt IS NOT NULL` (or `confirmationRequired=false`). Precheck alone is insufficient. **FAILED** is allowed without confirmation so devices do not deadlock.
2. **MCP_TOOL eligibility**: maps to `{ kind: 'mcp_tool', mcpKey: payload.serverId, tool: payload.tool }` — never defaults to `computer_use`. Only canonical `line-desktop-mcp` is accepted. LINE **send** tools require `runId` + real DB-backed `isRunApproved`; read tools need eligibility only.
3. **FDE create idempotency**: `COMPUTER_CONTROL` / `SCREENSHOT` / `LINE_DESKTOP` / `MCP_TOOL` require `idempotencyKey`. `CAPABILITY_PROBE` / `MCP_INSTALL` remain optional/server-managed. Runner uses `createAndDispatchTask` with keys and is unaffected.
4. **Enrollment**: `osVersion`/`appVersion` redacted before persistence (same as capabilities). Re-issuing a code **atomically expires** any older unconsumed codes for that device. Concurrent `issueEnrollmentCode` is serialized with `SELECT … FROM "Device" … FOR UPDATE` so two parallel issuers cannot both leave valid codes.

## Capability contract

```json
{
  "platform": "MACOS|WINDOWS|LINUX",
  "osVersion": "string",
  "appVersion": "string",
  "features": {
    "computerUse": true,
    "screenRecording": true,
    "accessibility": true,
    "screenshot": true,
    "codexApp": true,
    "codexCli": false,
    "lineDesktop": true
  },
  "mcpServers": [
    { "name": "line-desktop-mcp", "version": "pinned", "sha256": "...", "tools": ["..."] }
  ],
  "updatedAt": "ISO-8601"
}
```

Wire compatibility: omitted `codexApp` / `codexCli` / `lineDesktop` default to **false** (cannot masquerade as installed apps).

Selectable = ACTIVE + authenticated device WebSocket + fresh heartbeat + required feature/tool + Agent binding.

- **computer_use**: `computerUse` + `codexApp` + (`screenshot` or `screenRecording`) when checkpoint capture is required.
- **line_desktop**: `accessibility` + `lineDesktop` + pinned READY LINE MCP (exact version/sha/tools).

## Interfaces

- FDE REST: list/create/revoke/rotate devices, issue enrollment code, bind/unbind Agent devices; `GET /api/device-tasks` (trainer) filters recent tasks; confirm/reject checkpoints.
- Device REST: enroll, capability update, fetch/ack/lease/progress/result/cancel state, artifact upload.
- Device WebSocket: `/device/ws`, Authorization Bearer only (fixed `aios-device` subprotocol label optional), `device.hello`, heartbeat and targeted `device.task` wake (taskId only).
- User hub (AWP): public lifecycle topics `device.task.ack|progress|result|cancel|confirm|reject|create` with payload `{ taskId, deviceId, status, runId, agentId }` only — never mixed into the device socket registry.
- Web: `/admin/devices`; Computer Use training/step editor lists only eligible online devices and preserves an existing offline binding as unavailable.
- macOS: Keychain device identity, enrollment, dedicated reconnecting device channel, capability probes, local stdio MCP runtime, screenshots and real task results.

## Live-test boundary

Protocol, persistence, routing, governance and fake-device execution are testable locally. A second physical device is required to prove cross-machine targeting. Real LINE reads/sends require a logged-in LINE Desktop. Real GUI automation requires Screen Recording/Accessibility and the upstream Codex Computer Use authorization context; ADR 0005 remains authoritative until live tools/call succeeds. There is no Windows runtime project in this repository, so only the cross-platform contract and installer manifest are in scope for Windows.
