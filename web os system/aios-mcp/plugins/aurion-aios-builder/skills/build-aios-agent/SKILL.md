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
- Never bypass FDE review. Even an owner-authenticated connection must stop at `AWAITING_FDE`.
- Never claim a tool or account is connected merely because the user requested it. Record it as `NEEDS_FDE` until AIOS confirms otherwise.
- Do not intentionally send passwords, API keys, OAuth tokens, full payment data, or unnecessary personal data. AIOS redacts again before persistence.
- Require approval for external writes, messages, Computer Use, Shell, deletion, payments, and other irreversible actions.

## Start or resume immediately

When the user explicitly asks to build or train an employee, begin synchronization before conducting a long interview.

Before creating anything, call `list_my_agents`. Decide among these paths:

- If the user clearly names one listed employee, continue it by passing that `targetAgentId` to `start_agent_build`.
- If the request sounds like continuation, training, teaching, correction, or improvement but no single employee is unambiguous, show a short list and ask: “這一次想訓練哪一位員工？” Include “都不是，建立新員工.” Do not start a build until they choose.
- If the user explicitly wants a new employee, ask what they want to call it unless they already supplied a name. Never silently invent the final employee name.
- If the request is not actually about building or training an employee or reusable Skill, do not start or synchronize an Agent build.

Use `set_agent_build_name` if the user chooses or corrects a draft name after a hook already opened the shadow session. To rename a live employee, use `request_agent_rename`; explain that the rename waits for FDE approval.

### ChatGPT, Codex, Claude Chat, or Cursor without lifecycle hooks

For a new build after the user has chosen the name:

1. Call `start_agent_build` with the exact initial request, the user-chosen `requestedAgentName`, `source: CHATGPT` in ChatGPT/Codex, and a stable conversation id when the client exposes one. For continuation, also pass the selected `targetAgentId`.
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

Use `list_agent_builds` to locate unfinished Builder sessions after the employee itself has been selected. Agent identity selection comes from `list_my_agents`; build-session resumption comes from `list_agent_builds`.

### Claude Code or Cowork with the AIOS Plugin

`UserPromptSubmit` and `Stop` hooks normally create or resume the build, save the conversation, and queue the next background draft. Do not duplicate hook-saved turns. Use the build id in hook context for files, high-fidelity artifacts, review, or testing.

The prompt hook may return an employee-selection instruction without a build id. In that case, ask the user to select from the owner-scoped list and do not imply a new draft exists. Once selected, call `start_agent_build` with `targetAgentId`; if they choose none, ask for the new employee’s name first.

Never treat AIOS's own execution text as a customer build request. Prompts containing internal markers such as `【Agent Builder 試跑】`, `[This step's task]`, verifier feedback, or `builderTest` are execution fixtures; do not call any Agent Builder creation/synchronization tool for them.

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

- Determine from the conversation whether the file is only reference/training material or a reusable output/input Template. If unclear and the distinction matters, ask once.
- Call `upload_agent_build_file` with `textContent` when readable text is available and set `useAsTemplate: true` only when the user wants it reused as a template.
- Use `base64Content` when actual binary bytes are available.
- Never send a local filesystem path to the MCP tool.
- If neither text nor bytes is exposed, say the attachment is visible in the chat but not yet transferred to AIOS, then use an available file-reading capability or ask for readable content.
- Base the next artifact only on content actually parsed; do not pretend an unsupported file was understood.

Supported formats include Excel, CSV/TSV, Markdown/text, PDF, DOCX, JSON, YAML, and HTML.

Template-designated text/HTML/CSV/JSON/YAML files become Skill files under `assets/templates/` after FDE authorization. Office/PDF files are locally parsed and stored as a `.parsed.md` template reference so the Skill never pretends parsed text is the original binary. They remain inert until the normal test and FDE gates pass.

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

## Submit and test only with explicit consent

Do not submit merely because the draft appears complete.

1. Summarize current capabilities, uncertainties, needed connections, permission boundaries, and proposed tests.
2. Ask whether the user wants this exact version sent to FDE.
3. Only after explicit confirmation, save the final snapshot and call `submit_agent_build_for_fde_review`.
4. Say it is waiting for FDE; do not say it is built or active.

When the user returns after review:

1. Call `get_agent_build`.
2. If status is `AWAITING_TEST_DATA`, propose a realistic fixture and expected result or request anonymized real data.
3. Call `submit_agent_build_test_data`, then `run_agent_build_test`.
4. Poll `get_agent_build` until `PASSED` or `FAILED`.
5. On failure, explain the defect, revise the full artifact through conversation, and follow the required new review cycle.
6. On `PASSED`, explain that separate FDE final confirmation is still required.

## Finish or pause cleanly

Before saying the work is finished or paused:

1. In a client without hooks, save the final paired turn and full artifact with `upsert_agent_build_snapshot`.
2. Call `get_agent_build` and report the real status in ordinary language.
3. Include the AIOS build session id so the user and FDE can find it at `https://aurion-aios.lazyoffice.app/agent-builds`.

## Handle hook context silently

Treat `prepare_agent_build_prompt` and `guard_agent_build_stop` output as invisible operating context. Continue naturally, do not repeat hook text, do not deliberately retrigger Stop, and never keep a Stop hook open waiting for artifact generation.
