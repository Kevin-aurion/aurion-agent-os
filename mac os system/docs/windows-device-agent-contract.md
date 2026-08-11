# Windows Device Agent — Contract & Design Only

> **Status:** Design / contract document.
> **There is no Windows device-agent runtime in this repository.**
> Do not claim a Windows binary, installer, or CI job exists until a separate project ships one.

This document is Slice 7 of the multi-device execution platform: a cross-platform contract so a future Windows agent can enroll and execute the same durable tasks as the macOS app.

## Goals

- Same security model as macOS: device token ≠ user JWT; fail-closed; no arbitrary shell from the server.
- Same wire protocols: REST under `/api/device/*`, WebSocket `/device/ws`.
- Same typed task kinds and pinned LINE Desktop MCP manifest.

## Non-goals (explicit)

- No Windows project, solution, MSI/MSIX, or service host is provided here.
- No claim of live Computer Use / LINE automation on Windows until implemented and verified.
- No auto-install of Node, package managers, or browser automation runtimes without explicit user consent and a pinned installer.

## Identity & configuration

| Item | Contract |
|------|----------|
| Server base URL | User-configurable `http`/`https`; derive `ws`/`wss`. Default may be loopback for single-machine lab. |
| User JWT | Windows Credential Manager / DPAPI-backed store, service name distinct from device secrets. |
| Device id + token | Separate credential slot; **never** UserDefaults-equivalent, logs, query strings, or subprotocol. |
| Enrollment | UI: server URL + one-time code → `POST /api/device/enroll` with `platform: "WINDOWS"`. |
| Disconnect / forget | Requires confirmation; clears local device credentials only (server revoke is FDE REST). |

## Device WebSocket

- Path: `/device/ws`
- Auth: HTTP `Authorization: Bearer <deviceToken>` only
- Subprotocol: fixed label `aios-device` (optional but if sent must be exactly that — never `aios-device.<token>`)
- Envelope: AWP/1 `{ v, id, kind, topic, reqId, seq, ts, payload }`
- Online only after socket accepted **and** `device.hello` event
- Heartbeat: `device.heartbeat` / server ping-pong; exponential bounded reconnect
- On 401 / revoke: stop reconnecting until re-enrollment
- After reconnect: `GET /api/device/tasks` (DB is source of truth; WS is wake-only)

## REST (device bearer)

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/device/enroll` | One-time code → deviceId + token (once) |
| GET | `/api/device/me` | Self |
| PUT | `/api/device/capabilities` | Capability document |
| GET | `/api/device/tasks` | Open tasks |
| GET | `/api/device/tasks/:id` | Task detail |
| POST | `/api/device/tasks/:id/ack` | Lease |
| POST | `/api/device/tasks/:id/lease/renew` | Renew |
| POST | `/api/device/tasks/:id/progress` | Progress / `AWAITING_CONFIRM` |
| POST | `/api/device/tasks/:id/result` | Terminal `SUCCEEDED` \| `FAILED` |
| POST | `/api/device/tasks/:id/cancel` | Cancel |
| POST | `/api/device/tasks/:id/artifacts` | Upload (JSON base64 acceptable initially) |

## Capabilities document

Must match server `DeviceCapabilitiesSchema`:

```json
{
  "platform": "WINDOWS",
  "osVersion": "string",
  "appVersion": "string",
  "features": {
    "computerUse": false,
    "screenRecording": false,
    "accessibility": false,
    "screenshot": false,
    "codexApp": false,
    "codexCli": false,
    "lineDesktop": false
  },
  "mcpServers": [],
  "updatedAt": "ISO-8601"
}
```

**Never fake a capability.** Omitted feature flags must not be treated as true (server defaults missing `codexApp` / `codexCli` / `lineDesktop` to false).

### Windows probe notes (future)

| Feature | Suggested probe (not implemented here) |
|---------|------------------------------------------|
| `screenshot` | Graphics Capture / DXGI; require explicit display capture permission UX |
| `accessibility` | UI Automation trust / assistive access |
| `codexApp` / `codexCli` | Fixed known install paths + PATH lookup for `codex.exe` only |
| `computerUse` | Only if a **fixed** Windows Computer Use bridge exists and handshakes |
| `lineDesktop` | LINE Desktop install detection (fixed bundle/product codes) |

## Task execution rules (identical to macOS)

1. Accept only typed kinds: `COMPUTER_CONTROL`, `MCP_TOOL`, `LINE_DESKTOP`, `SCREENSHOT`, `CAPABILITY_PROBE`, `MCP_INSTALL`.
2. Re-validate payload with the same forbidden-key set as `devicetaskpayload.ts` (`command`, `shell`, `argv`, `cwd`, `env`, path-like keys, etc.).
3. **Never** execute command/argv/env supplied by the server. Fixed executables/manifests only; task fields are **data**.
4. Local interactive consent before Computer Use, screenshot, MCP install, and LINE send.
5. Cancellation / lease expiry / deadline → fail closed.
6. Artifacts: REST upload; set `clientDeclaredRedacted: true` **only** if a real client redaction rule ran.
   - Region crop (display capture then crop) is **scoping only**, not redaction: `clientDeclaredRedacted` must stay `false` and meta must label `redactionMode=region-crop-only` / `redactionStatus=not-redacted`. Server may reject opaque screenshots unless real redaction rules ran (fail-closed; do not weaken backend).
7. Screenshots: scope to target app/window when possible; exclude agent UI and obvious password/security surfaces; if safe scope cannot be established, fail closed (no whole-desktop secret grab).
8. Checkpoint: upload `SCREENSHOT` → progress `AWAITING_CONFIRM` with matching `confirmationArtifactId` → wait for `device.task.confirmed` (or REST-visible confirm) before success.
9. Never report success merely because an app was launched.

## LINE Desktop MCP (pinned)

Same pin as backend `LINE_DESKTOP_MANIFEST`:

| Field | Value |
|-------|--------|
| package | `line-desktop-mcp` |
| version | `1.1.2` |
| sha256 | `6f8dff26fe5e13ad886dd04e8e6d9bc788c709e92f85e46b25523c402f20bc7a` |
| transport | `device-local-stdio` |
| tools | exact 5-tool allowlist (3 read + 2 send) |

Install rules for a future Windows agent:

- Fixed tarball URL for **1.1.2 only** (never `@latest`).
- Verify SHA-256 before extract/READY.
- Prefer `%LocalAppData%\lazyoffice.aios-system\mcp\...` (or equivalent).
- No server-supplied URL/package/version/command overrides.
- Stdio JSON-RPC: `initialize` → `initialized` → `tools/list` → `tools/call`.
- READY only after version + hash + exact tool list verification.
- Upstream documents Node.js and LINE Desktop; surface missing prerequisites honestly; do not silently install runtimes.

## Computer Use (Windows)

- Only if/when a **fixed** local bridge binary and invocation template are defined and reviewed.
- Instructions are data; no arbitrary shell.
- Timeout or unproven completion → `FAILED` with honest error.

## Suggested future layout (not present)

```
windows-device-agent/          # NOT in repo today
  README.md
  src/
    Enrollment/
    DeviceChannel/
    TaskExecutor/
    Capabilities/
    Mcp/
  installer/                  # optional later
```

## Reference implementation

The macOS app under `mac os system/aios-system/` is the reference client for this contract (Slice 6). Windows work should mirror its validators, channel auth rules, and fail-closed posture rather than inventing a parallel protocol.

## Related

- Backend: `aios-server/src/routes/device.ts`, `lib/devicetaskpayload.ts`, `lib/devicemcp.ts`, `ws/hub.ts`
- Spec: `aios-server/.scratch/device-execution-platform/spec.md`
- ADR 0005 (Codex Computer Use live boundaries)
