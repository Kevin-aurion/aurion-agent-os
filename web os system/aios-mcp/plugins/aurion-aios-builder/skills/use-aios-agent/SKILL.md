---
name: use-aios-agent
description: Find, invoke, schedule, or request archival of an approved Aurion AIOS employee, or immediately talk to a READY test employee in an isolated no-tools preview without FDE approval. Use when the user asks Claude, ChatGPT, Codex, or Cursor to use, try, test, talk to, continue training, delete, remove, retire, or archive an existing AIOS Agent, inspect its capabilities or result, or request a governed recurring schedule.
---

# Use an AIOS Agent

Use the hosted `aios` MCP as the system of record. The signed-in account may invoke its ACTIVE employees or talk to its READY test employees through isolated Shadow Chat. Never present a test employee as production-approved.

## Select the employee

1. Call `list_available_agents` before the first production execution request in a conversation.
2. Match the user's wording against employee names, descriptions, and workflows.
3. If more than one employee could fit, show the short matching list and ask which one to use. Do not guess.
4. If the user explicitly wants to try an employee that is still being built, or no ACTIVE employee matches, call `list_testable_agents` and offer only the matching rows returned for this account.
5. If none fit and the user wants a new employee, switch to `$build-aios-agent`; do not invoke a different employee as a substitute.
6. Call `get_agent_capabilities` for a selected ACTIVE employee before execution. Use only confirmed Skills and enabled workflows returned by that tool.

## Talk to a test employee without FDE approval

1. Select the exact `sessionId` from `list_testable_agents`. Ask the user when more than one test employee could match.
2. Call `chat_with_test_agent` with the user's exact work message. Continue follow-up turns through the same tool and session.
3. Present the returned answer as a real isolated test response, not as a completed external action.
4. When relevant, explain that test mode has no tools, network, Shell, Computer Use, schedules or external writes. It can reason over the current Agent, Skill, memory and workflow draft while AIOS records redacted coaching feedback.
5. Do not require FDE approval for this safe conversation. FDE remains required before production activation, confirmed Skills, schedules, connected tools or side-effecting execution.
6. Never call `get_agent_capabilities` or `invoke_agent` with a test build `sessionId`; those tools are only for an ACTIVE production Agent id.

## Invoke work

1. Prefer the workflow whose purpose and input schema most closely match the request. Omit `workflowId` only when the Agent's general capability is the correct route.
2. Ask only for missing required inputs. Never invent recipients, target systems, approval decisions, or credentials.
3. Treat the user's explicit request to run the employee as execution authority. If the selected capability can create an external side effect and the target is unclear, confirm the target before calling it.
4. Call `invoke_agent` with a stable `idempotencyKey` for this one intended execution. Reuse that exact key when retrying a failed network call; use a new key only for a new intended run.
5. Poll `get_agent_run` using the returned `runId` until a terminal state appears. Do not claim success while the status is `QUEUED` or `RUNNING`.
6. Report terminal states truthfully:
   - `SUCCEEDED`: summarize the verified output and any relevant step results.
   - `FAILED`: state the failing step and available error; do not present partial output as complete.
   - `AWAITING_REVIEW`: explain that the task is paused for FDE approval and has not executed yet.
   - `CANCELLED`: state that the run was cancelled.

## Request a schedule

1. Call `list_agent_schedules` and identify the exact enabled workflow.
2. Resolve the requested cadence to a cron expression and an IANA timezone. Ask when timing or timezone is ambiguous.
3. Keep scheduled input non-secret. Do not place passwords, tokens, API keys, or private credentials in it.
4. Call `request_agent_schedule` with a stable `requestKey` and one action:
   - `UPSERT` to add or change a schedule; include `cron` and `timezone`.
   - `PAUSE`, `RESUME`, or `DELETE` for an existing schedule.
5. Tell the user that the result is a pending proposal. It is not active until an FDE approves it and `list_agent_schedules` shows the schedule enabled.

## Request Agent archival

Treat user wording such as delete, remove, retire, deactivate permanently, or archive as a request to **archive** the Agent. AIOS retains the record and audit trail; it does not hard-delete the Agent.

1. Call `list_available_agents` immediately before the archival request. Never use an Agent id remembered from another account or an earlier ambiguous conversation.
2. Match one exact Agent. If more than one name could fit, show the matching names and ask which one. Do not guess.
3. Explain that FDE approval will make the selected Agent unavailable, disable its workflows and schedules, and remove it from the callable list. Ask the user to explicitly confirm the exact Agent name.
4. Only after that confirmation, call `request_agent_archive` with the selected `agentId`, the exact returned name as `confirmAgentName`, and a stable `requestKey`. Reuse the key only when retrying this same request.
5. Report the response as a pending archival proposal. The Agent remains usable until an FDE approves it. Never claim it is archived merely because the proposal was accepted.
6. After approval, `list_available_agents` no longer returns it and direct invocation fails closed. Do not attempt to bypass that status with a stored id.

## Governance guarantees

- MCP authentication determines ownership. Never claim to see or invoke another account's employee.
- READY test employees are callable only through isolated Shadow Chat. This is the temporary no-FDE testing path.
- The runtime cannot activate drafts, confirm Skills, change Agent configuration, or approve its own run.
- Agent execution keeps AIOS restrictions, budget gates, cross-model verification, and high-risk approval behavior.
- Scheduling never bypasses FDE review. A successful proposal response means "submitted", not "scheduled".
- Archival never bypasses FDE review. It is a reversible status change, not a hard delete, and archived Agents cannot be invoked.
