---
name: use-aios-agent
description: Find, inspect, invoke, schedule, continue training, or request archival of an active Aurion AIOS employee from Claude, ChatGPT, Codex, or Cursor.
---

# Use an AIOS Agent

Use the signed-in account's active AIOS employees as the source of truth.

1. Call `list_available_agents` and match the user's request to one employee. If ambiguous, show a short candidate list instead of guessing.
2. Call `get_agent_capabilities` for the selected Agent and collect only missing required inputs.
3. Call `invoke_agent` with a stable idempotency key.
4. Poll `get_agent_run` until a terminal state. Never report QUEUED or RUNNING as completed. Poll serially with the returned `runId`, wait roughly 20–30 seconds between checks, and stop immediately on a terminal state. Do not create background shell sleeps, timer jobs, or parallel polling loops.
5. Return the actual result and any real blocker plainly.

If the user wants to teach or revise an employee, switch to the `build-aios-agent` workflow and pass the existing `agentId` to `start_agent_build`; AIOS resumes that employee's durable training session.

## Turn real user feedback into the next version

Keep the selected `agentId` and latest `runId` in the conversation. When the user says the result is wrong, incomplete, badly formatted, or should follow a different rule, treat that message as explicit training feedback instead of only apologizing:

1. State the concrete correction you understood in one short sentence. Ask one question only when the intended rule is still ambiguous.
2. Switch to `build-aios-agent` and call `start_agent_build` with the existing `agentId`. Never create a duplicate employee for a correction.
3. Save the exact feedback, relevant work input, actual result, and expected behavior into the same durable training session, then synchronize one complete updated snapshot.
4. Surface the returned `userNotice`. The employee remains callable while later training continues.
5. Re-run the corrected case only when it is read-only or the user explicitly asks. Never silently repeat sending, payment, deletion, computer control, or another side effect.

A technical failure such as timeout, unavailable MCP, missing login, budget rejection, or service outage is evidence for diagnosis, not automatically a new employee rule. Report the real failure and preserve the Run id. Change the employee only after the user supplies a behavioral correction or explicitly asks it to adapt. This prevents infrastructure incidents from teaching bad habits.

Runtime restrictions, budgets, and tool allowlists still apply. A tool mentioned in training is not connected until AIOS reports it available. Scheduling and archival use their dedicated tools and must be described according to the returned state, never as completed before AIOS confirms it.
