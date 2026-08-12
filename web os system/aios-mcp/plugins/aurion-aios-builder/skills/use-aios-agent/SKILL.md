---
name: use-aios-agent
description: Find and invoke an FDE-approved Aurion AIOS employee, inspect its confirmed capabilities, follow a run through completion, or request a governed recurring schedule. Use when the user asks Claude, ChatGPT, Codex, or Cursor to hand work to an existing AIOS Agent, continue using a trained employee, check its execution result, or make it run on a recurring cadence.
---

# Use an AIOS Agent

Use the hosted `aios` MCP as the system of record. Only the signed-in account's ACTIVE employees are callable. Never treat a draft build as an executable Agent.

## Select the employee

1. Call `list_available_agents` before the first execution request in a conversation.
2. Match the user's wording against employee names, descriptions, and workflows.
3. If more than one employee could fit, show the short matching list and ask which one to use. Do not guess.
4. If none fit and the user wants a new employee, switch to `$build-aios-agent`; do not invoke a different employee as a substitute.
5. Call `get_agent_capabilities` for the selected employee before execution. Use only confirmed Skills and enabled workflows returned by that tool.

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

## Governance guarantees

- MCP authentication determines ownership. Never claim to see or invoke another account's employee.
- The runtime cannot activate drafts, confirm Skills, change Agent configuration, or approve its own run.
- Agent execution keeps AIOS restrictions, budget gates, cross-model verification, and high-risk approval behavior.
- Scheduling never bypasses FDE review. A successful proposal response means "submitted", not "scheduled".
