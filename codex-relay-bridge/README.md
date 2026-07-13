# codex-relay-bridge

Phase 1 MCP server that relays Claude Code tool calls to a single local **Codex App Server** child process (`codex app-server` over stdio JSON-RPC 2.0).

## Requirements

- Node.js ≥ 22 (`~/.local/node/bin`)
- Codex binary (default): `/Applications/ChatGPT.app/Contents/Resources/codex` (codex-cli 0.144.2)

## Setup

```bash
export PATH="$HOME/.local/node/bin:$PATH"
cd /Users/kevin/Documents/aurion/codex-relay-bridge
npm install
npm run gen:types   # regenerates src/generated/ from codex app-server
npm run build       # gen:types + tsc → dist/
```

## Run as MCP server

```bash
export PATH="$HOME/.local/node/bin:$PATH"
node /Users/kevin/Documents/aurion/codex-relay-bridge/dist/main.js
```

### Claude Code registration

```bash
claude mcp add codex-relay -- ~/.local/node/bin/node /Users/kevin/Documents/aurion/codex-relay-bridge/dist/main.js
```

Optional env:

| Env | Meaning |
|---|---|
| `CODEX_BIN` | Override path to the `codex` binary (tests use a fake wrapper) |

## Tools

| Tool | Purpose |
|---|---|
| `codex_start_task` | New thread + first turn (`project`, `message`, `idempotency_key`) |
| `codex_continue_task` | Resume/continue (`thread_id`, `message`) |
| `codex_get_status` | Status + pending approvals + diagnostics |
| `codex_read_output` | Cursor-based event stream |
| `codex_respond_approval` | Human allow/deny for queued ServerRequests |

Project paths must be absolute and under the allowlist (after `realpath`):

- `/Users/kevin/Documents/aurion`
- `/Users/kevin/Documents/Codex`

## Tests

```bash
npm test
# Live smoke (real binary) — not run by default:
# LIVE=1 node --import tsx --test tests/live/live-smoke.test.ts
```

## Docs

- [Architecture](docs/architecture.md)
- [Spike / Go-No-Go](spike-report.md)

## Phase 1 limits

- In-memory only (no SQLite)
- No app-server auto-restart on crash
- No HTTP/SSE transport
- High-risk approvals never auto-allow; some kinds deny even on human “allow”
