# Agent Builder — CEO-friendly Agent factory

## Problem proven by Chrome acceptance test

The current `/work` UI requires choosing an existing Agent first. “Teach it” calls
`POST /api/agents/:id/train/message`, immediately tries to compile one Skill, and
returned only `bad response` for a non-technical CEO request. It has no durable
requirements interview, capability reuse/gap analysis, build authorization, or
test-data gate.

## Product contract

An authenticated non-technical user can start with a business outcome. AIOS asks
exactly one important question at a time, with a recommended answer, until these
decisions are explicit:

1. objective and success criteria;
2. inputs and source systems/files;
3. outputs, recipients, and timing;
4. happy-path process;
5. exceptions and escalation;
6. permissions/irreversible actions;
7. representative test data and expected result.

Facts may be inferred from the user's own description. Decisions must not be
invented. The final plan inventories existing Agents, confirmed Skills, connected
accounts, registered MCP servers, and approved A2A peers. It recommends reuse or
creation and calls out missing connections in plain language.

## Durable state machine

`DISCOVERY -> PLAN_READY -> AWAITING_FDE | BUILDING -> AWAITING_TEST_DATA -> TESTING -> PASSED | FAILED -> ACTIVE`

- Only the session owner and FDE may read a session.
- MEMBER may interview and request a build, but never apply a change. Their request
  stops at `AWAITING_FDE`.
- OWNER/TRAINER must explicitly authorize `reuse` or `create` before any Agent or
  Skill row is changed.
- New Skills always stop at `AWAITING_USER_CONFIRM`; a builder test does not confirm
  or mount an effective Skill.
- The built Agent remains `PAUSED` until an FDE explicitly finalizes a passed test.
- Finalize is fail-closed unless the latest real cross-model run passed.
- Existing Agent updates never happen during discovery or planning. Linking a new
  inert draft requires FDE authorization.

## Persistence and redaction

Add `AgentBuildSession` in Prisma. Persist transcript, brief, plan, and test evidence
only after recursively applying `redactSecrets()`. Never persist resolved MCP
credentials, raw access tokens, or unredacted uploaded/test data.

## REST

- `POST /api/agent-builder/sessions` `{ message }`
- `GET /api/agent-builder/sessions/:id`
- `POST /api/agent-builder/sessions/:id/messages` `{ message }`
- `POST /api/agent-builder/sessions/:id/authorize` `{ strategy: reuse|create, targetAgentId? }`
- `POST /api/agent-builder/sessions/:id/test-data` `{ data, expected }`
- `POST /api/agent-builder/sessions/:id/test` (async real `runAgent`, never fake pass)
- `POST /api/agent-builder/sessions/:id/finalize` (FDE only; requires PASSED)

Responses use `ok()`/`sendError()`. Builder messages return plain-language
`assistantMessage`, current `status`, `progress`, and the safe session DTO.

## Build behavior

- Create strategy: create a least-privilege `PAUSED` Agent and one redacted Skill
  draft linked to it. The Agent's execute/verify engines remain different through
  the existing compile gate.
- Reuse strategy: do not rewrite the existing Agent identity/role/restrictions;
  create and link only the new inert Skill draft after FDE authorization.
- Never enable an MCP server, grant it to an Agent, connect an account, submit A2A,
  send email, or write to cloud automatically. Surface those as FDE actions/gaps.
- Finance/email/cloud-write requirements default to `sendEmail:false`,
  `cloudWrite:false`, `shell:false`, `computerUse:false`; proposed sends remain drafts.

## Test behavior

- Test data is mandatory and redacted before persistence.
- `test` uses the built/reused Agent through existing `runAgent`; the execution and
  verifier models remain different and restrictions remain enforced.
- Missing live integrations do not prevent a manual fixture test, but the result and
  UI must say production rollout remains blocked until the named connections pass
  health/authorization.
- A timeout, verifier rejection, budget/approval failure, malformed output, or engine
  error results in `FAILED`, never `PASSED`.
- Finalize requires `PASSED`, FDE role, and a still-existing Agent/Skill draft.

## User interface

Add a prominent `建立 AI 員工` entry to `/work`, independent of selecting an Agent.
The center panel is a chat-like interview. Show one question, a recommended answer,
progress, a plain-language reuse/create plan, missing connections, explicit build
authorization, test-data input, live test state, and FDE finalize. Do not expose
engine names, manifests, JSON, MCP protocol details, or workflow internals to the
end user.

## Acceptance tests

1. CEO finance prompt skips facts already stated and asks one unresolved question.
2. Answers progress deterministically to `PLAN_READY`; plan finds the existing
   finance Agent and flags Gmail/Drive gaps when unavailable.
3. MEMBER authorize produces `AWAITING_FDE` and no Agent/Skill mutation.
4. FDE authorize creates only a paused Agent/inert Skill draft, never confirmed.
5. Foreign user cannot read or mutate another user's session.
6. Test without data fails closed; engine/verifier failure cannot produce PASSED.
7. Finalize before PASSED or by MEMBER fails; successful FDE finalize is audited.
8. Existing compileManifest execute != verify, restriction, cost, redactor, proposal,
   and skill-confirmation tests remain green.
