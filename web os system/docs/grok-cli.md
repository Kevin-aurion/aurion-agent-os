# Grok CLI Research (xAI) — for local orchestrator integration

Researched 2026-07-13. Sources are a mix of docs.x.ai (fetched via summarizing WebFetch, not raw HTML)
and secondary blog coverage, since x.ai/cli and x.ai/build/changelog both returned HTTP 403 to direct
fetch. Confidence is marked per fact. **Treat anything marked [UNVERIFIED] as needing a local
`grok --help` / `grok -p --help` check before being hard-coded into the orchestrator.**

## 0. OFFICIAL vs UNOFFICIAL — critical disambiguation

There are TWO unrelated projects both commonly called "Grok CLI", both installing a binary
literally named `grok`. This is a real collision risk for a child-process integration.

| | **Official (xAI)** | **Unofficial clone** |
|---|---|---|
| Product name | **Grok Build** | "grok-cli" |
| Repo/org | xAI, via x.ai/cli, docs.x.ai/build | github.com/superagent-ai/grok-cli |
| Binary name | `grok` | `grok` (also ships as npm/bun package `grok-dev`) |
| Install | `curl -fsSL https://x.ai/cli/install.sh \| bash` (Mac/Linux/WSL); `irm https://x.ai/cli/install.ps1 \| iex` (Windows) | `curl -fsSL https://raw.githubusercontent.com/superagent-ai/grok-cli/main/install.sh \| bash` or `bun add -g grok-dev` |
| Auth env var | `XAI_API_KEY` (primary docs var) | `GROK_API_KEY` |
| Status | Announced 2026-05-25 (x.ai/news/grok-build-cli); beta, gated by subscription tier | Explicit README disclaimer: "community-built, open-source, and **not affiliated with, endorsed by, or sponsored by xAI Corp**" |

**Recommendation:** Since both install a `grok` binary, whichever one is installed on a given
machine's PATH determines which tool actually runs. Before wiring this into the orchestrator,
run `grok --version` / `grok inspect` on the target machine and confirm it reports xAI's Grok
Build (not the superagent-ai fork) — do not assume based on the command name alone. Everything
below concerns the **official xAI Grok Build CLI** unless explicitly marked "(unofficial clone)".

## 1. Install

Official (Grok Build):
```bash
# macOS / Linux / WSL
curl -fsSL https://x.ai/cli/install.sh | bash

# Windows PowerShell
irm https://x.ai/cli/install.ps1 | iex
```
- Binary name after install: `grok`.
- Platforms: macOS, Linux, WSL, Windows (native PowerShell installer). No brew formula found in
  research; curl/PowerShell installers are the documented path. [UNVERIFIED: no official Homebrew
  tap confirmed either way.]
- Config lives under `~/.grok/` (config.toml, sessions/, auth token). Project-level override at
  `.grok/config.toml` in the repo root — one secondary source claims project-level config can
  **only** set `[mcp_servers]` and not permission settings; not confirmed against primary docs
  [UNVERIFIED].

Unofficial clone (for contrast only, do not use for this integration):
```bash
curl -fsSL https://raw.githubusercontent.com/superagent-ai/grok-cli/main/install.sh | bash
# or
bun add -g grok-dev
```

## 2. Auth

Official Grok Build:
- Default flow: running `grok` with no args on first run opens a **browser OAuth sign-in**
  (interactive, not suitable for headless/CI hosts).
- `grok login --device-auth` — device-code auth flow (usable on a headless box where you can
  open the printed URL on another device). `grok logout` clears credentials.
- **Headless/CI auth:** set environment variable **`XAI_API_KEY="xai-..."`**. Create the key at
  console.x.ai (API Keys → Create API Key). With this var set, Grok Build authenticates without
  opening a browser. This is the variable to put in `.env` for the orchestrator.
  - One older/secondary source names a variant `GROK_CODE_XAI_API_KEY` for headless/CI use
    specifically — this may be deprecated/renamed to plain `XAI_API_KEY`, or may be a
    model-specific override. [UNVERIFIED — verify with `grok inspect --json` on the installed
    version; docs describe a credential resolution order: `model.api_key > model.env_key >
    active session token > XAI_API_KEY`, implying `XAI_API_KEY` is the general fallback and
    per-model env-key overrides (of which `GROK_CODE_XAI_API_KEY` might be one) are optional.]
- Billing is **separate** from the consumer SuperGrok subscription — see Pricing section.

Unofficial clone: `export GROK_API_KEY=...`, or `~/.grok/user-settings.json` with `{"apiKey":
"..."}`, or `-k <key>` flag. Not relevant to the official integration but worth knowing so nobody
confuses the two env var names (`GROK_API_KEY` = clone, `XAI_API_KEY` = official).

## 3. Headless / non-interactive mode (the critical part)

Official Grok Build supports three modes: interactive TUI (bare `grok`), headless one-shot
(`-p`), and ACP (Agent Client Protocol, JSON-RPC over stdio) for embedding in other apps.

**One-shot prompt, analogous to `claude -p` / `codex exec`:**
```bash
grok -p "List TODO comments"
```
- Flag is `-p` (long form appears in docs as both `--print` and `--single` in different
  fetches — inconsistent secondary summaries; **verify locally with `grok -p --help`** before
  depending on the long-form spelling; the short flag `-p` itself is consistent everywhere).
- Runs once, prints result, exits with **non-zero exit status if the model refused or a tool
  call failed** (documented behavior; exact numeric exit codes not enumerated in any source
  found — plan to treat "0 = success, nonzero = failure" only, do not branch on specific codes
  without empirical verification).

**Output format** — flag `--output-format`:
| Value | Behavior |
|---|---|
| `plain` (default) | human-readable text |
| `json` | single JSON object emitted at completion — best for orchestrator parsing of a finished run |
| `streaming-json` | newline-delimited JSON events streamed incrementally — best if you want to tail progress |

Examples from docs:
```bash
grok -p "List TODO comments" --output-format json
grok -p "Explain the architecture" --output-format streaming-json
```

**Other scripting-relevant flags:**
| Flag | Purpose |
|---|---|
| `--cwd <dir>` | set working directory for the run |
| `--always-approve` (alias `--yolo`) | auto-approve all tool calls, no interactive confirmation — required for unattended CI use |
| `--no-auto-update` | skip background update check (recommended for every scripted invocation: `grok --no-auto-update -p "..."`) |
| `--no-alt-screen` | don't take over the terminal with fullscreen UI (relevant even in `-p` mode if any UI chrome would otherwise appear) |
| `-m, --model <MODEL>` | select model (see `grok models` for the list) |
| `--max-turns <N>` | cap agent turn count — useful safety valve for a child process you don't want running away |
| `-s, --session-id <ID>` | create/resume a **named** headless session |
| `-r, --resume [<ID>]` | resume a session by ID, or the most recent if omitted |
| `-c, --continue` | continue the most recent session |
| `--fork-session` | branch the current session into a new session ID |
| `--rules <TEXT>` | **append** to system prompt (closest analog to `claude --append-system-prompt`) |
| `--system-prompt-override <TEXT>` | **replace** the system prompt entirely |
| `--no-plan`, `--no-subagents`, `--no-memory`, `--disable-web-search` | disable specific agentic subsystems — worth disabling `--no-subagents`/`--no-plan` for a tightly-scoped verifier role to keep behavior predictable |
| `--timeout` | referenced by user's own ask but **not found in any fetched doc** — [UNVERIFIED/MISSING: no explicit CLI timeout flag surfaced in research; assume you must wrap the child process with your own timeout/kill, same as you'd need for any CLI without a built-in `--timeout`]. |

Config-file alternative for auto-update: set `auto_update = false` under `[cli]` in
`~/.grok/config.toml`.

Headless sessions are stored at `~/.grok/sessions`. To resume interactively later: `grok resume`
(per one secondary source; not cross-checked against the `-r/--resume` flag naming, may be the
same thing exposed as a subcommand alias).

**ACP mode** (for tighter process embedding than a plain one-shot `-p` call):
```bash
grok agent stdio
```
Runs Grok Build as a JSON-RPC agent over stdin/stdout — this is the more "SDK-like" integration
path if the orchestrator wants a persistent process with structured turn-by-turn messages rather
than spawning a fresh `grok -p` process per prompt. Given the existing pattern (spawn `claude -p`,
spawn `codex exec` per task), the one-shot `-p` model is the more direct analog and probably the
right starting point; `agent stdio` is worth a follow-up spike if per-process spawn overhead
becomes a problem.

## 4. Agentic abilities / sandbox

- Full agentic coding tool: reads/edits files, runs shell commands, does multi-file/codebase-wide
  analysis (e.g. `@src/main.rs Walk me through this file` style file references shown in docs).
- **Plan Mode**: for complex tasks, produces a plan the user (or an `--always-approve`d run)
  reviews before edits are applied; every edit is blocked until approved unless auto-approve is
  set.
- **Parallel subagents**: can spin up subagents that run concurrently, each with its own context
  window, reportedly using **git worktree isolation** per subagent — relevant if the orchestrator
  ever wants Grok Build itself to fan out work rather than being one leaf in the orchestrator's
  own fan-out.
- **Sandbox**: Landlock on Linux (kernel 5.13+), Seatbelt on macOS. Controlled via `--sandbox
  workspace` flag or a `[sandbox]` profile in a `requirements.toml`/config file [source naming
  inconsistent across secondary docs — verify exact filename locally]. Always-write-protected
  paths regardless of profile: `~/.ssh`, `~/.gnupg`, `~/.grok/auth`, `~/.aws`, `~/.config/gcloud`,
  `~/.azure`. Stricter profiles add a seccomp BPF filter blocking child-process network access.
- **Permission model**: default `permission_mode = "ask"` (prompts per tool call), configurable
  in `~/.grok/config.toml` (global) or `.grok/config.toml` (project). `--always-approve`/`--yolo`
  bypasses prompting; an admin-level setting `disable_bypass_permissions_mode` under `[ui]` can
  forcibly disable that bypass fleet-wide, and there's a `--permission-mode dontAsk` variant
  described as safer than full yolo for reviewing untrusted code combined with narrow allow rules.
  [UNVERIFIED naming for a couple of these — different secondary sources use slightly different
  flag spellings; confirm against `grok --help` on the installed version before scripting.]

## 5. Models, context window, speed

Genuinely conflicting across sources — flagging all variants found rather than picking one:
- One official-docs-summarized fetch says the primary/default model is **"Grok 4.5"**.
- A more recent (dated) secondary source says the CLI now defaults to a coding-specific model
  called **`grok-build-0.1`**, described as replacing a deprecated **`grok-code-fast-1`**, with a
  cited **256K-token context window**, text+image input.
- Another secondary source flatly says the launch-week "2M-token context" claims circulating are
  out of date.
- `grok models` lists what's actually available/selectable on the installed CLI — **this is the
  authoritative source of truth, run it locally rather than trusting any doc snapshot**, since
  xAI appears to be renaming/rotating the default coding model actively (May 2026 launch → later
  2026 changes).
- No SWE-bench or other benchmark speed claims were found in any fetched source; several blog
  posts claim to compare it to Claude Code/Codex but the primary docs pages fetched here made no
  speed claims either way. Do not repeat unverified benchmark numbers into the orchestrator's
  decision logic.

## 6. MCP support, session resume, system-prompt injection — summary

- **MCP**: supported "out of the box" per official overview page. Config discovered via
  `grok inspect`. One secondary source claims Grok Build can read **existing Claude Code MCP
  config files directly** (`.mcp.json` or `claude_desktop_config.json`) without reconfiguration —
  if true, this is very convenient for an orchestrator that already has Claude Code MCP servers
  defined, since the same server definitions could apply to Grok Build with zero duplication.
  [UNVERIFIED — worth a 5-minute local test: point Grok Build at a repo with an existing
  `.mcp.json` and run `grok inspect --json` to see if it lists those servers.]
- **Session resume**: `-r/--resume [ID]`, `-c/--continue`, `-s/--session-id <ID>` to name a
  session up front (important for headless use — lets the orchestrator address a specific
  child-process run later), `--fork-session` to branch. Sessions on disk at `~/.grok/sessions`.
  `grok sessions list|search|delete` and `grok export <session-id> [output]` for transcript
  extraction — useful if the orchestrator wants to pull the full transcript rather than just
  final stdout.
- **System prompt injection**: `--rules <TEXT>` appends to the system prompt (closest analog to
  `claude --append-system-prompt`); `--system-prompt-override <TEXT>` replaces it wholesale.

## 7. Pricing

Two independent billing surfaces — do not conflate them:
- **SuperGrok consumer subscriptions** (control access to the CLI itself, at least during beta):
  SuperGrok Lite $10/mo, SuperGrok $30/mo, X Premium+ $40/mo, SuperGrok Heavy $300/mo (or ~$25/mo
  effective if billed annually at $300/yr — read the fine print, the $300 figure appears in both
  a monthly-price and an annual-discounted context in different sources, verify at x.ai/pricing
  before relying on this). At CLI launch (announced 2026-05-25), **CLI access itself was gated to
  SuperGrok and X Premium+ subscribers** during the beta phase — plain free-tier/no-subscription
  API-only users may not have been able to use the interactive TUI at all, though headless use via
  `XAI_API_KEY` for the API-billing path appears to be the intended production route regardless.
- **xAI API pay-per-token billing** (what actually meters `XAI_API_KEY` headless usage): general
  xAI API rates cited elsewhere are ~$1.25/1M input, ~$0.20/1M cached input, ~$2.50/1M output for
  the general-purpose Grok 4.x line — note these are **not confirmed to be the specific rate for
  whatever coding model Grok Build defaults to** (grok-build-0.1 / grok-code-fast-1 may be priced
  differently as a coding-specialized SKU). Batch jobs get a 50% discount. xAI offers up to
  $175/month in free API credits for developers who opt into a data-sharing program.
- **Rate limits**: subscription-based interactive use has an unspecified, tighter default rate
  limit ("generous for prototypes, tight for production" per one source); switching to
  `XAI_API_KEY` billing puts you under standard xAI API rate limits instead, and xAI will grant
  a rate-limit increase on request for production integrations. No numeric limits were found in
  any source — get exact current numbers from console.x.ai directly before depending on this for
  the orchestrator's throughput planning.

## Integration recommendation

**Spawn command template** (child process, one-shot, matching the existing `claude -p` / `codex
exec` pattern):

```bash
grok --no-auto-update -p "<PROMPT>" \
  --output-format json \
  --always-approve \
  --cwd "<REPO_ROOT>" \
  --no-plan --no-subagents \
  -m "<MODEL_ID_FROM_grok_models>"
```

Rationale per flag:
- `--no-auto-update` — always include; prevents a background update check from adding latency or
  noise to a scripted run.
- `-p "<PROMPT>"` — the one-shot entry point, direct analog to `claude -p`/`codex exec`.
- `--output-format json` — gives one parseable JSON blob on stdout at completion; use this over
  `streaming-json` unless the orchestrator specifically wants to stream partial progress, since a
  single JSON object is far simpler for a child-process wrapper to consume than NDJSON.
- `--always-approve` — mandatory for unattended use; without it, Grok Build will block on an
  interactive tool-approval prompt and the child process will hang forever waiting for stdin.
- `--cwd` — pass the target repo root explicitly rather than relying on process cwd, for the same
  reason you'd want to for any spawned child process.
- `--no-plan --no-subagents` — for the two proposed roles (skill/agent BUILDER and CODEBASE
  VERIFIER), keep behavior tight and predictable rather than letting Grok Build launch its own
  internal fan-out; revisit if a task genuinely needs Grok's own subagent parallelism.
- `-m` — pin an explicit model ID rather than trusting whatever the CLI's current default is,
  since the default has already changed at least once in 2026 (grok-code-fast-1 →
  grok-build-0.1 per secondary sources). Get the exact ID by running `grok models` on the actual
  installed CLI version before hard-coding it into orchestrator config.

**Env var for `.env`:**
```
XAI_API_KEY=xai-...
```
This is the one to put in the orchestrator's `.env` / secrets store, created at console.x.ai
(API Keys → Create API Key). Do not use `GROK_API_KEY` (that's the unofficial clone's variable)
or assume `GROK_CODE_XAI_API_KEY` is required — start with `XAI_API_KEY` and only add a
model-specific override var if `grok inspect --json` on the real installed binary shows one is
expected.

**Caveats / before wiring this in for real:**
1. **Binary name collision is the single biggest risk.** Run `grok --version` (or `grok inspect`)
   on whatever machine will run the orchestrator and confirm it's actually xAI's Grok Build and
   not the superagent-ai clone, before writing any code that shells out to `grok`. Consider
   recording the absolute resolved binary path in orchestrator config rather than relying on
   `$PATH` lookup of a generic `grok` command.
2. **No confirmed `--timeout` flag** was found for Grok Build. The orchestrator must enforce its
   own wall-clock timeout on the child process (same as it should for any CLI), rather than
   trusting a CLI-native timeout.
3. **Exit codes are not enumerated anywhere found** — only "0 vs nonzero" semantics are
   documented. Don't branch orchestrator logic on specific nonzero values without empirically
   testing them against the installed CLI version first.
4. **CLI access may be gated behind a SuperGrok/X Premium+ subscription** independent of API-key
   billing, at least as of the May 2026 beta launch. Confirm whether the account tied to the
   `XAI_API_KEY` actually has CLI access before assuming API billing alone is sufficient — this
   gating may have loosened since launch, but wasn't confirmed either way in this research pass.
5. **Model naming/context-window figures are actively changing and inconsistent across sources**
   (Grok 4.5 vs grok-build-0.1 vs grok-code-fast-1; 256K vs 2M context claims). Always resolve the
   actual model ID via `grok models` at deploy time rather than hard-coding one now.
6. **Exact long-form spelling of the one-shot flag is inconsistently reported** (`--print` vs
   `--single` in different summarized fetches of the same docs page) even though the short form
   `-p` is consistent everywhere. Run `grok -p --help` locally and use whatever it reports if the
   orchestrator wants to use the long-form flag in scripts/logs for clarity.
7. **MCP config sharing with Claude Code's `.mcp.json`** is a promising but unverified claim from
   a secondary source — test it directly (5 minutes: point Grok Build at a repo that already has
   a working Claude Code MCP config and see if `grok inspect` picks up the same servers) before
   assuming zero-config reuse.
