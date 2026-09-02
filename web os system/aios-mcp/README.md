# aios-mcp

MCP provider exposing the central **aios-server** as tools, resources, Agent Builder, and approved-Agent Runtime prompts. ChatGPT, Codex, Claude, and Cursor clients connect to the hosted OAuth Remote MCP at `https://aurion-aios-mcp.lazyoffice.app/mcp`; they do **not** install an AIOS server, database, tunnel, Node process, or local MCP service.

The MCP process is a REST client of aios-server. External Builder writes are stored as inert, versioned shadow drafts: the MCP exposes no approve, confirm, rollback, or activation tool. A READY Shadow Agent may be tried immediately without FDE through isolated no-tools chat; production release and side-effecting execution remain inside AIOS governance.

## Customer one-click install

Use `releases/aurion-aios-one-click-install.zip`:

- macOS: double-click `Install Aurion AIOS.command`.
- Windows: run `Install-Aurion-AIOS.ps1` with PowerShell.
- Claude Code/Cowork plugin-only upload: `releases/aurion-aios-builder-plugin.zip`.
- Claude Chat fallback: add the Remote MCP URL in Claude Connectors, then upload `releases/build-aios-agent.skill.zip`.
- ChatGPT/Codex: install the Universal Plugin from `releases/aurion-aios-builder-plugin.zip`, or register the same Remote MCP in ChatGPT Developer mode and add the bundled Skill.

The Universal Plugin bundles the adaptive Skill and Remote MCP connector while retaining supported Claude lifecycle hooks. First use starts OAuth in the browser; each customer signs in with their own AIOS account. Completed turns then appear at `https://aurion-aios.lazyoffice.app/agent-builds`.

Claude Chat custom Skill ZIPs cannot themselves add a Connector. That product surface requires the one-time Connector step above and has no Claude Code-equivalent Stop hook; the Skill explicitly synchronizes each turn instead.

## Central host / local development setup

```bash
export PATH="$HOME/.local/node/bin:$PATH"   # Node 22
cd "/Users/kevin/Documents/aurion/web os system/aios-mcp"
npm install
cp .env.example .env    # then fill in AIOS_MCP_EMAIL / AIOS_MCP_PASSWORD
npm run build           # -> dist/index.js
```

For local stdio development on the AIOS host, the least-privilege setup is automated:

```bash
export PATH="$HOME/.local/node/bin:$PATH"
cd "/Users/kevin/Documents/aurion/web os system/aios-mcp"
npm run build
npm run provision:local-user
npm run install:local-clients
```

The provisioner creates or rotates a dedicated `MEMBER` account, keeps its generated password only in `.env` (mode `0600`), and never prints it. See [`docs/INSTALLATION.zh-TW.md`](docs/INSTALLATION.zh-TW.md).

`.env` variables:

| Var | Default | Purpose |
|---|---|---|
| `AIOS_MCP_BASE_URL` | `http://127.0.0.1:8700` | aios-server base URL |
| `AIOS_MCP_EMAIL` / `AIOS_MCP_PASSWORD` | — | Required only for stdio or shared-secret HTTP mode; dedicated local AIOS account |
| `AIOS_MCP_CLIENT_NAME` | `mcp` | `client` string for login/refresh sessions |
| `AIOS_MCP_PROFILE` | `full` | `builder` exposes only 22 Agent Builder/Stop-guard/Agent Runtime tools (15 builder + 7 runtime); local customer installation uses this least-privilege profile |
| `AIOS_MCP_STATE_DIR` | `~/.aios-mcp` | Where the rotated refresh token persists (`session.json`, mode 0600) |
| `AIOS_MCP_TRANSPORT` | `stdio` | `stdio` or `http` |
| `AIOS_MCP_HTTP_PORT` | `8701` | HTTP transport port (loopback only) |
| `AIOS_MCP_HTTP_AUTH` | `secret` | `oauth` on the central public Remote MCP host; `secret` for legacy private HTTP |
| `AIOS_MCP_HTTP_SECRET` | — | Required only for `AIOS_MCP_HTTP_AUTH=secret` |
| `AIOS_MCP_PUBLIC_URL` | — | Required for OAuth HTTP mode; currently `https://aurion-aios-mcp.lazyoffice.app/mcp` |
| `AIOS_MCP_LOGOUT` | — | Set `1` for a one-shot run that revokes the refresh token and exits |

Auth: logs in via `POST /api/auth/login`, keeps the 15-minute access JWT in memory, proactively rotates it every 10 minutes via `POST /api/auth/refresh` (the single-use refresh token is re-persisted on every rotation), and on any 401 retries the call exactly once after a forced refresh-or-login.

## Dev loop

```bash
npm run dev        # tsx watch src/index.ts (same convention as aios-server)
npm run typecheck  # tsc --noEmit
```

## Register with Claude Desktop

`~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "aios": {
      "command": "node",
      "args": ["/Users/kevin/Documents/aurion/web os system/aios-mcp/dist/index.js"]
    }
  }
}
```

(Run `npm run build` first. The package's private `.env` is loaded via dotenv, so credentials do not need to appear in the desktop config.)

## Register with Claude Code

```bash
claude mcp add aios -- node "/Users/kevin/Documents/aurion/web os system/aios-mcp/dist/index.js"
```

or a project-level `.mcp.json`:

```json
{
  "mcpServers": {
    "aios": {
      "command": "node",
      "args": ["/Users/kevin/Documents/aurion/web os system/aios-mcp/dist/index.js"]
    }
  }
}
```

## Register with Codex CLI

`~/.codex/config.toml`:

```toml
[mcp_servers.aios]
command = "node"
args = ["/Users/kevin/Documents/aurion/web os system/aios-mcp/dist/index.js"]
```

## Hosted OAuth Remote MCP

The central host runs:

```bash
AIOS_MCP_TRANSPORT=http \
AIOS_MCP_HTTP_AUTH=oauth \
AIOS_MCP_PROFILE=builder \
AIOS_MCP_PUBLIC_URL=https://aurion-aios-mcp.lazyoffice.app/mcp \
node dist/index.js
```

- The process still binds **127.0.0.1:8701 only**. Cloudflare Tunnel on the AIOS host publishes only the required `/mcp`, OAuth, discovery, and health routes.
- OAuth uses authorization-code + PKCE S256, dynamic client registration, short access tokens, rotating refresh sessions, and per-user AIOS authorization. The issued token is route-scoped to Agent Builder and account-owned Agent Runtime APIs and MEMBER-effective even when an FDE account authorizes it. No shared customer password is embedded in a package.
- Unauthenticated MCP requests return OAuth protected-resource metadata. Only the nineteen Builder/Runtime tools are exposed publicly; approval, Skill confirmation, rollback and activation are absent.
- stdio and http are mutually exclusive per process — run two processes if both are needed.

## Tools

| Tool | aios-server endpoint |
|---|---|
| `list_agents` | `GET /api/agents` |
| `get_agent` | `GET /api/agents/:id` |
| `list_skills` | `GET /api/skills` |
| `get_skill` | `GET /api/skills/:id` |
| `list_workflows` | `GET /api/agents/:agentId/workflows` |
| `get_workflow` | `GET /api/workflows/:id` |
| `run_workflow` | `POST /api/workflows/:id/run` (returns `runId` immediately; poll `get_run`) |
| `test_workflow` | `POST /api/workflows/:id/test` |
| `list_runs` | `GET /api/runs` |
| `get_run` | `GET /api/runs/:id` (includes `steps[]` — the actual output/logs) |
| `cancel_run` | `POST /api/runs/:id/cancel` |
| `list_conversations` | `GET /api/agents/:agentId/conversations` |
| `list_messages` | `GET /api/conversations/:id/messages` |
| `converse_with_agent` | `POST /api/agents/:agentId/conversations` (if needed) + `POST /api/conversations/:id/messages` |
| `list_memory_files` | `GET /api/agents/:agentId/memory/files` |
| `read_memory_file` | `GET /api/agents/:agentId/memory/file?path=` |
| `search_memory` | `POST /api/agents/:agentId/memory/search` |
| `reindex_memory` | `POST /api/agents/:agentId/memory/reindex` |
| `get_dashboard_summary` | `GET /api/dashboard/summary` |
| `get_health` | `GET /api/health` (no auth) |
| `get_preflight` | `GET /api/preflight` (no auth) |
| `google_workspace_status` | `GET /api/google-workspace/status` |
| `gmail_search` / `gmail_get_message` | Gmail 唯讀工具；對應 `/api/google-workspace/gmail/*` |
| `drive_search` / `drive_read_text` | Drive 唯讀工具；對應 `/api/google-workspace/drive/*` |
| `gmail_create_draft` / `gmail_send` | 外部寫入；FDE + 真核准 Run + `cloudWrite`/`sendEmail` 才可執行 |
| `drive_create_text_file` | 外部寫入；FDE + 真核准 Run + `cloudWrite` 才可執行 |
| `start_agent_build` | 建立或重新取用 ChatGPT/Claude/Codex/Cursor 的同一個訓練 session；此時尚未有完整員工快照 |
| `prepare_agent_build_prompt` | Claude Code UserPromptSubmit hook：辨識明確建置意圖、自動開案／續接並排入背景版本 |
| `sync_agent_build_turn` | 逐輪同步對話；`externalEventId` 可安全重試去重 |
| `sync_agent_build_artifact` | 同步完整 Agent/Skill/Memory/Workflow/Test 快照；成功後自動建立或更新同一位可呼叫員工 |
| `upsert_agent_build_snapshot` | 無 lifecycle hook 客戶端的首選：可重試地同步一組對話與完整快照，成功後立即可呼叫 |
| `upload_agent_build_file` | 上傳文字或 base64 檔案內容；不接受主機路徑 |
| `get_agent_build` / `list_agent_builds` | 讀取真實訓練狀態、目前 Agent ID 與最新完整快照 |
| `activate_agent_build` | 僅供舊版待處理資料與中斷復原相容；正常訓練不需要呼叫 |
| `guard_agent_build_stop` | Claude Code Stop hook：補記最後回答與漏掉的使用者原話；不等待 Artifact、不阻止對話結束 |
| `list_available_agents` | 只列登入帳號自己、已 ACTIVE 的可呼叫員工 |
| `get_agent_capabilities` | 讀取目前可用技能、流程、輸入規格與風險，不暴露內部訓練紀錄 |
| `invoke_agent` | 以 idempotency key 呼叫員工；保留限制、預算、跨模型驗證與高風險 HITL |
| `get_agent_run` | 追蹤 MCP 呼叫結果，不洩露主機 `runDir` |
| `list_agent_schedules` | 查看該員工可用流程與目前排程狀態 |
| `set_agent_schedule` | 帳號擁有者直接新增、暫停、恢復或刪除員工排程 |
| `archive_agent` | 確認完整員工名稱後直接封存該帳號自己的 Agent／Workflow／Schedule，保留稽核資料 |

Async note: `run_workflow`, `test_workflow`, and `converse_with_agent` return immediately with ids; the work completes in the background — poll `get_run(runId)` / `list_messages(conversationId)`.

## Resources

- `aios-agents://list` — agent roster (GET /api/agents)
- `aios-agent://{agentId}` — one agent profile
- `aios-skill://{skillId}` — skill definition incl. contentMd
- `aios-workflow://{workflowId}` — workflow steps + schedules
- `aios-memory://{agentId}/{path}` — one memory/wiki markdown file
- `aios-system://health`, `aios-system://preflight`
- `aios-builds://list` — 目前登入者的 Agent 建置記錄
- `aios-build://{sessionId}` — 對話、版本、草稿、FDE 與測試狀態

## Agent Builder / Runtime prompts and Skills

- MCP prompt: `build-aios-agent`
- MCP prompt: `use-aios-agent`
- Skill source: `skills/build-aios-agent/`
- Runtime Skill source: `skills/use-aios-agent/`
- Restricted GitHub Marketplace: `Kevin-aurion/aurion-aios-plugin-marketplace`
- Claude Plugin: `releases/aurion-aios-builder-plugin.zip`
- Cross-platform one-click bundle: `releases/aurion-aios-one-click-install.zip`
- Claude Chat Skill fallback: `releases/build-aios-agent.skill.zip`
- Runtime Skill fallback: `releases/use-aios-agent.skill.zip`

The Skill performs a contextual Grill-me interview and calls MCP explicitly. The Claude Plugin uses `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PermissionRequest`, `PostToolUse`, and `Stop` command hooks as a bounded state machine. The first relevant turn calls `start_agent_build`, each relevant prompt calls `prepare_agent_build_prompt`, and Stop calls `guard_agent_build_stop`. A bare start remains inert; the first successfully synchronized complete snapshot becomes callable automatically, while external tools still remain `NEEDS_SETUP` until actually connected. The hooks own no credentials and never read Claude's OAuth cache.

For the GitHub-distributed Claude Plugin, `SessionStart` initializes content-free state. `UserPromptSubmit` conservatively activates only for explicit Agent/AI employee/Skill-building requests, or later turns in an already active build. It requires the session handshake and prompt synchronization before the answer; Stop requires the final-message guard before the turn closes. Missing calls are requested again at Stop, with two bounded retries before fail-safe release. The background worker compiles Agent/Skill/Memory/Workflow/Test drafts from the durable transcript. Ordinary sessions remain a no-op.

The local installer pre-approves only the fourteen non-runtime `mcp__aios__...` builder and isolated test-chat tools in Claude Code so synchronization and safe preview do not stall on a permission dialog. The six production Runtime tools are intentionally not pre-approved because invoking an ACTIVE Agent can have side effects. Existing ask/deny rules and all unrelated tool permissions are preserved.
