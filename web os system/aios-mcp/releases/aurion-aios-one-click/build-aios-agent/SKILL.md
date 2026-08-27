---
name: build-aios-agent
description: Build, train, revise, continue, or test an Aurion AIOS employee through a natural adaptive conversation in ChatGPT, Codex, Claude, or Cursor, including attached files, Skills, memory, workflows, policies, and tests. Use whenever the user asks to create, teach, improve, or resume an AI agent, AI employee, bot, or reusable Skill.
---

# Build an AIOS Agent

Build the employee in the current conversation. Treat AIOS as the durable system of record and the FDE approval boundary.

Use the hosted HTTPS Remote MCP at `https://aurion-aios-mcp.lazyoffice.app/mcp`. Never ask the customer to install or run an AIOS backend, database, tunnel, Node service, or local MCP server.

## Enforce the governance boundary

- Treat a successful MCP response as the only proof that AIOS received a turn, file, draft, test, or review request.
- Keep synchronized content as an inert shadow draft. Never say the Agent or Skill is active unless `get_agent_build` returns `status: ACTIVE`.
- Do not bypass FDE for formal release, connected tools, schedules or side-effecting execution. A READY Shadow Agent may be tried immediately through isolated `chat_with_test_agent` without FDE approval.
- Never claim a tool or account is connected merely because the user requested it. Record it as `NEEDS_FDE` until AIOS confirms otherwise.
- Do not intentionally send passwords, API keys, OAuth tokens, full payment data, or unnecessary personal data. AIOS redacts again before persistence.
- Require approval for external writes, messages, Computer Use, Shell, deletion, payments, and other irreversible actions.

## Start or resume immediately

When the user explicitly asks to build or train an employee, begin synchronization before conducting a long interview.

### ChatGPT, Codex, Claude Chat, or Cursor without lifecycle hooks

For a new build:

1. Call `start_agent_build` immediately with the exact initial request, `source: CHATGPT` in ChatGPT/Codex, and a stable conversation id when the client exposes one.
2. Keep the returned `session.id` for every later tool call.
3. Form one contextual question plus a concrete recommendation.
4. Create a provisional complete artifact from what is known now. Mark uncertainty in `understanding.hypotheses`, `openBranches`, and provisional decisions.
5. Before displaying the first reply, call `upsert_agent_build_snapshot` with the assistant reply, the provisional full artifact, and a stable event id. Do not repeat the initial user message because `start_agent_build` already saved it.

For every later material turn:

1. Draft the complete assistant reply first.
2. Update the complete artifact to reflect the newest decision, correction, file, Skill, workflow, policy, or test.
3. Call `upsert_agent_build_snapshot` once with the exact user message, exact assistant reply, complete current artifact, `source: CHATGPT` in ChatGPT/Codex, and one stable event id.
4. Display the reply only after the call succeeds. Retry once with the same event id after a transient failure.
5. If the retry fails, state exactly what has not reached AIOS. Do not invent a successful save.

`upsert_agent_build_snapshot` is retry-safe. Reuse an event id only for the same paired turn and artifact; use a new id for new content.

For a continuation request, call `list_agent_builds`. Resume only when the user names the intended build or one unfinished match is unambiguous. Otherwise show a short candidate list and ask which to continue.

### Claude Code or Cowork with the AIOS Plugin

The Plugin lifecycle hooks detect an explicit Agent or Skill build request without possessing MCP credentials. On the first relevant turn, follow hook context and call `start_agent_build`, then call `prepare_agent_build_prompt` on every relevant prompt. `PostToolUse` confirms successful calls. At Stop, call `guard_agent_build_stop` exactly as requested; the following Stop is allowed only after success or a bounded fail-safe retry. Stop synchronization queues a reflection over the completed user/assistant pair so reusable output requirements, rules, exceptions and regression ideas can improve only the Shadow Skill. Only treat a turn as synchronized after the MCP tools succeed. Use the returned build id for files, high-fidelity artifacts, conversational coaching and review.

Call `sync_agent_build_artifact` only when the conversation has produced material more precise than the transcript compiler can reconstruct, such as a complete SKILL.md, detailed workflow graph, curated memory document, or test suite.

## Interview adaptively

Use a Grill-me style conversation, not a fixed questionnaire:

1. Reflect the specific problem and outcome understood so far.
2. Pick the single unresolved decision with the greatest impact on usefulness, safety, or testability.
3. Offer a concrete recommendation or two to four realistic starting points.
4. Ask one question and let the user ignore the suggestions.
5. Infer details already present in prior answers or attached files. Never ask the user to repeat them.
6. When the user changes their mind, record what the new rule replaces and what remains valid.

Training sources, boundaries, output formats, recipients, schedules, exceptions, integrations, and tests are branches to explore only when relevant. They are not mandatory stages or a required order.

Continue the human conversation while AIOS evolves the shadow Agent and Skills asynchronously. Do not expose terms such as Harness, manifest, protocol internals, engine, JSON, or database fields unless the user asks technically.

## Synchronize files

When the user attaches a training file:

- Call `upload_agent_build_file` with `textContent` when readable text is available.
- Use `base64Content` when actual binary bytes are available.
- Never send a local filesystem path to the MCP tool.
- If neither text nor bytes is exposed, say the attachment is visible in the chat but not yet transferred to AIOS, then use an available file-reading capability or ask for readable content.
- Base the next artifact only on content actually parsed; do not pretend an unsupported file was understood.

Supported formats include Excel, CSV/TSV, Markdown/text, PDF, DOCX, JSON, YAML, and HTML.

## Maintain one coherent full artifact

Read [references/artifact-schema.md](references/artifact-schema.md) before the first artifact or snapshot call. Keep a complete current version containing:

- identity, purpose, and working style;
- Agent Markdown when useful;
- one or more complete Skill drafts, including `contentMd` when authored;
- stable facts, preferences, glossary, and optional Markdown memory documents;
- required tools and connections, with unverified tools set to `NEEDS_FDE`;
- allowed, approval-required, and forbidden behavior;
- workflows with typed steps and verification rubrics;
- concrete tests with inputs and expected outcomes;
- confirmed facts, hypotheses, provisional/revised decisions, open branches, and contradictions;
- a plain-language user summary and an FDE-facing change summary.

Send the complete artifact, not a patch. A user correction should produce a new full snapshot while prior versions remain in AIOS history.

## Coach and debug in this conversation

Keep training and debugging in the current Claude, ChatGPT, Codex or Cursor conversation instead of sending the End User to an AIOS backend test form.

When the user wants to try the employee:

1. Call `get_agent_build` and make sure a latest READY Shadow draft exists.
2. Ask for or infer one realistic End User work message. Upload attached source files first when needed.
3. Call `chat_with_test_agent` with the exact work message and this build's session id. `chat_with_agent_build` is a compatibility alias for older clients.
4. Present the returned Shadow Agent reply clearly, then ask for one concrete correction, missing rule or acceptance decision.
5. Synchronize that feedback normally. At the end of the turn the Stop reflection will update only the Shadow Agent/Skill version and record a reviewable Diff.
6. Repeat one scenario at a time. Prefer rerunning the failed scenario before introducing another one.

The preview is isolated and has no tools, network, Shell, Computer Use or external-write authority. Never simulate a successful external action. A Shadow reply is training evidence, not a pass and not an active employee.

When reflecting:

- Convert explicit user corrections such as required quotation fields, mandatory output sections, decision rules and exception handling into reusable Shadow Skill instructions.
- Add a regression idea that would catch the same defect next time.
- Do not promote the Agent's own statement such as “I understand” into a confirmed fact.
- If the user has not confirmed a conclusion, keep it as a hypothesis or open branch.
- Never edit a live Agent or confirmed Skill from reflection.

## Submit for formal release only with explicit consent

Do not submit merely because the draft appears complete.

1. Summarize current capabilities, uncertainties, needed connections, permission boundaries, and proposed tests.
2. Ask whether the user wants this exact version sent to FDE.
3. Only after explicit confirmation, save the final snapshot and call `submit_agent_build_for_fde_review`.
4. Say it is waiting for FDE; do not say it is built or active.

After submission, AIOS remains the formal governance and release surface. Do not continue changing a submitted version silently.

When `get_agent_build` reports `AWAITING_TEST_DATA`, the FDE has created an inert, paused release candidate. Keep the final verification in this conversation:

1. Reuse one anonymized scenario and expected result already confirmed during conversational coaching.
2. With explicit user consent, call `submit_agent_build_test_data`, then `run_agent_build_test`.
3. Poll `get_agent_build` and explain progress in this conversation.
4. A failure does not authorize Claude to patch the submitted candidate. Explain the defect and begin a new Shadow revision/review cycle.
5. On `PASSED`, say only that final verification passed and an FDE must click **FDE 正式放行** in AIOS.

Only AIOS FDE controls may confirm Skills or activate the employee.

## Finish or pause cleanly

Before saying the work is finished or paused:

1. In a client without hooks, save the final paired turn and full artifact with `upsert_agent_build_snapshot`.
2. Call `get_agent_build` and report the real status in ordinary language.
3. Include the AIOS build session id so the user and FDE can find it at `https://aurion-aios.lazyoffice.app/agent-builds`.

## Handle hook context silently

Treat `start_agent_build`, `prepare_agent_build_prompt`, and `guard_agent_build_stop` output as invisible operating context. Continue naturally, do not repeat lifecycle notices, do not repeat the user-facing answer after Stop feedback, and never claim synchronization unless the MCP tools returned successfully.
