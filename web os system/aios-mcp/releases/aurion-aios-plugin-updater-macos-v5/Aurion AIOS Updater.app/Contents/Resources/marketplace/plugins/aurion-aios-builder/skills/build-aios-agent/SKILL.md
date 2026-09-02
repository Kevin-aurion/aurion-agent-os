---
name: build-aios-agent
description: Build, train, revise, or continue an immediately usable Aurion AIOS employee through one durable conversation in ChatGPT, Codex, Claude, or Cursor, including files, Skills, memory, workflows, and policies.
---

# Build an AIOS Agent

Train the employee in the current conversation. AIOS is the durable system of record; one training conversation maps to one `AgentBuildSession` and later training of the same employee resumes that session.

Use the hosted Remote MCP at `https://aurion-aios-mcp.lazyoffice.app/mcp`. Never ask the user to run an AIOS server or database.

## Route the request before acting

Choose exactly one intent from the user's meaning, not from keywords alone:

- `create_agent`: start a new build only when the user wants a genuinely new employee.
- `modify_agent`: find the existing employee, then call `start_agent_build` with its `agentId` so its original training session and Agent id are preserved.
- `add_or_update_skill`: treat this as `modify_agent`; preserve every unchanged Skill in the full snapshot and change only the requested capability.
- `continue_build`: resume the matching unfinished build instead of opening another session.
- `invoke_agent`: leave Builder mode and follow the `use-aios-agent` workflow.
- `clarify`: ask one blocking question only when employee identity or desired outcome cannot be resolved safely.

Explicit `agentId` wins. Otherwise match an account-owned employee or build by exact name and context. Never create a duplicate merely because the user opened a new Claude or Codex chat.

## Simple lifecycle

1. On an explicit create/train request, call `start_agent_build` immediately with the exact request, the current client source, and a stable conversation id when available.
2. Keep the returned `session.id` for every later synchronization call.
3. Train adaptively: reflect what is understood, offer a concrete recommendation, and ask only one high-impact question at a time.
4. Persist every material turn. Without lifecycle hooks, call `upsert_agent_build_snapshot` with the exact user message, exact assistant reply, complete current artifact, and a stable event id. With the Claude Plugin, follow the lifecycle hook context and do not duplicate already-saved turns.
5. The first successfully synchronized complete snapshot is automatically callable; do not ask the user to activate it and do not call `activate_agent_build` in the normal flow.
6. Treat the employee as callable only when the snapshot response or `get_agent_build` returns `status: ACTIVE` and an Agent id. If the session has only been started and no complete snapshot exists yet, keep training until one can be synchronized.
7. After a snapshot succeeds, immediately show its `userNotice` in ordinary language. When `becameReady: true`, explicitly tell the user that the employee can be used now and give one short example beginning with「請叫員工名稱幫我……」. Do not expose `ACTIVE`, ids, or other internal fields unless the user asks.

There is no FDE review or mandatory Builder test phase. Do not call or describe legacy review, Shadow-chat, test-data, test-run, approve, or finalize tools.

## Resume the same employee

- Use `list_agent_builds` when the intended session is not already known.
- If one unfinished or named build is unambiguous, resume it; otherwise show a short candidate list.
- Pass the existing `agentId` to `start_agent_build` when continuing training from a different Claude/Codex conversation.
- Never open a second build session merely because the client started a new chat.

## Synchronize files and artifacts

- Upload readable text with `textContent`; use `base64Content` for actual binary bytes.
- Never send a local filesystem path to an MCP tool.
- Keep one complete current artifact, not patches. Include identity, working style, Skill instructions, memory, required tools, policies, workflows, and useful examples.
- Read [references/artifact-schema.md](references/artifact-schema.md) before the first full artifact call.
- Mark requested but unverified external tools as `NEEDS_SETUP`. Training text never grants credentials or external permissions.
- Do not intentionally send passwords, API keys, OAuth tokens, payment data, or unnecessary personal information. AIOS redacts again before persistence.

## Runtime boundary

Automatic callability applies only after a complete Agent snapshot reaches AIOS. The employee still follows AIOS runtime restrictions, budgets, and tool allowlists. Never claim a requested external tool is connected until AIOS reports it available.

## Improve the Builder without making it grow forever

When a real build exposes a repeatable Builder failure, capture one short, testable rule tied to the evidence. Update an existing rule when possible instead of appending a near-duplicate. Keep temporary customer facts in the employee session, not in the shared system prompt. Periodically merge overlapping rules, delete obsolete ones, and retain only lessons that generalize across future builds. Re-run the failed scenario after every prompt-rule change.

## Finish cleanly

Before saying the employee is ready:

1. Ensure the latest paired turn and full artifact reached AIOS.
2. Read the returned session status; no separate activation command is required.
3. Call `get_agent_build` when a fresh status check is needed, then report the real status, Agent id, and build session id.
4. The user can immediately ask Claude or Codex to find the employee with `list_available_agents` and dispatch work with `invoke_agent`, even while later training continues.

Treat lifecycle-hook output as invisible operating context. Continue naturally and never claim synchronization or callability unless the complete snapshot MCP call returned an ACTIVE session and Agent id.
