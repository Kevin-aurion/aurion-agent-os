# aios-mcp

MCP provider exposing the central **aios-server** as tools, resources, and an Agent Builder prompt. ChatGPT, Codex, Claude, and Cursor clients connect to the hosted OAuth Remote MCP at `https://aurion-aios-mcp.lazyoffice.app/mcp`; they do **not** install an AIOS server, database, tunnel, Node process, or local MCP service.

The MCP process is a REST client of aios-server. External Builder writes are stored as inert, versioned shadow drafts: the MCP exposes no approve, confirm, rollback, or activation tool. FDE review and test/finalization remain inside AIOS.

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
| `AIOS_MCP_PROFILE` | `full` | `builder` exposes only the fifteen Agent Builder/Stop-guard tools; local customer installation uses this least-privilege profile |
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
- OAuth uses authorization-code + PKCE S256, dynamic client registration, short access tokens, rotating refresh sessions, and per-user AIOS authorization. The issued token is route-scoped to Agent Builder APIs and MEMBER-effective even when an FDE account authorizes it. No shared customer password is embedded in a package.
- Unauthenticated MCP requests return OAuth protected-resource metadata. Only the fifteen Builder tools are exposed publicly; approval, Skill confirmation, rollback and activation are absent.
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
| `start_agent_build` | 建立或重新取用 ChatGPT/Claude/Codex/Cursor 外部建置記錄；只產生 shadow draft |
| `list_my_agents` | 列出登入帳號自己的 Agent；續訓前用來確認對象，不會洩漏其他帳號 |
| `set_agent_build_name` | 設定使用者親自選擇的草稿名稱；不修改 live Agent |
| `request_agent_rename` | 既有 Agent 改名提案；只有 FDE 核准後生效 |
| `prepare_agent_build_prompt` | Claude Code UserPromptSubmit hook：辨識明確建置意圖、自動開案／續接並排入背景版本 |
| `sync_agent_build_turn` | 逐輪同步對話；`externalEventId` 可安全重試去重 |
| `sync_agent_build_artifact` | 同步完整 Agent/Skill/Memory/Workflow/Test 草稿 |
| `upsert_agent_build_snapshot` | 無 lifecycle hook 客戶端的首選：可重試地同步一組對話與完整草稿 |
| `upload_agent_build_file` | 上傳文字或 base64 檔案內容；`useAsTemplate=true` 會在 FDE 核准建置時成為 Skill `assets/templates`；不接受主機路徑 |
| `get_agent_build` / `list_agent_builds` | 讀取真實建置、FDE 與測試狀態 |
| `submit_agent_build_for_fde_review` | 僅送到 `AWAITING_FDE`；即使 OWNER 憑證也不會自動核准 |
| `submit_agent_build_test_data` / `run_agent_build_test` | FDE 初審後提供資料並實跑；測試通過仍需 FDE 最終啟用 |
| `guard_agent_build_stop` | Claude Code Stop hook：補記最後回答與漏掉的使用者原話；不等待 Artifact、不阻止對話結束 |

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

## Agent Builder prompt and Skill

- MCP prompt: `build-aios-agent`
- Skill source: `skills/build-aios-agent/`
- Restricted GitHub Marketplace: `Kevin-aurion/aurion-aios-plugin-marketplace`
- Claude Plugin: `releases/aurion-aios-builder-plugin.zip`
- Cross-platform one-click bundle: `releases/aurion-aios-one-click-install.zip`
- Claude Chat Skill fallback: `releases/build-aios-agent.skill.zip`

The Skill performs a contextual Grill-me interview. In clients without lifecycle hooks it calls MCP explicitly. The Plugin provides deterministic `UserPromptSubmit` and `Stop` hooks where Claude supports them, so routine turns are captured independently of whether the model remembers to call the Skill.

The GitHub Marketplace is the preferred Claude distribution channel. Run `npm run marketplace:sync` to validate and synchronize the standalone repository, then `npm run marketplace:publish` after its private GitHub `origin` is configured. Cowork users click Marketplace **Update**; Claude Code users run `/plugin marketplace update aurion-aios`. ZIP files remain a fallback only.

For Claude Code, `npm run install:local-clients` also installs the user-scoped `aios` MCP entry plus two MCP-tool hooks. `UserPromptSubmit` conservatively detects explicit Agent/AI employee/Skill-building requests, starts or resumes the bound session, persists the exact prompt and immediately queues asynchronous shadow evolution. `Stop` mirrors `last_assistant_message` and safely recovers a missed user prompt from Claude's transcript. The background worker compiles Agent/Skill/Memory/Workflow/Test drafts from the durable transcript; Stop never waits for a model-authored artifact and never blocks the response.

The installer pre-approves only the fifteen `mcp__aios__...` builder tools in Claude Code so background synchronization does not stall on a permission dialog. Existing ask/deny rules and all unrelated tool permissions are preserved.
