# Aurion AIOS Studio V2 — Product & Technical Spec

## Outcome

Create a clean-room, independently deployable AIOS client at
`aios-studio.lazyoffice.app`. It reuses Aurion AIOS APIs and governance,
but does not replace or modify the current `aios-new.lazyoffice.app` client.

Create a shadow copy of the `AI 知識採集` builder draft for an isolated
Langflow Sandbox pilot. The original builder draft remains unchanged.

## Product principles

1. Progressive configuration: show the safe minimum first; advanced options
   remain available without overwhelming the operator.
2. One control plane: Agent, Model, Tool/MCP, Knowledge, Skill and Deployment
   all share the same navigation, status vocabulary and detail patterns.
3. Truthful runtime states: Draft, Awaiting FDE, Sandbox, Active, Failed and
   Blocked are never collapsed into a generic success state.
4. Governance is visible: every production-affecting action explains its FDE,
   evaluation and approval requirements.
5. Clean-room UI: learn from public configuration patterns, but do not copy
   Cherry Studio source, components, CSS, icons, wording or data model.

## Langflow pilot boundary

The full knowledge collector is not safe as a first Langflow flow because it
can download media, invoke local CLIs, write to an Obsidian vault and schedule
jobs. The pilot therefore copies only the read-only interaction contract:

- accept a knowledge question or validation fixture;
- return a deterministic, traceable response in Sandbox;
- make no network, shell, scheduler or filesystem mutation;
- never activate Production;
- preserve FDE gates for any later promotion.

Pilot name: `AI 知識採集 — Langflow Sandbox`.

## Studio information architecture

- Overview: health, agents and guarded deployment status.
- Agents: browse employees and open a configuration workspace.
- Agent workspace:
  - Overview: identity and execution status.
  - Models: execute/verify engines; they must differ.
  - Tools & MCP: capability boundary and approval state.
  - Knowledge: sources, file targets and read/write scope.
  - Skills: mounted skills and FDE review state.
  - Deployment: native/Langflow environment and gates.
- Tools & MCP: registry, trust tier, connectivity and enabled state.
- Models: supported engine families and cross-model rule.
- Knowledge: knowledge boundaries grouped by Agent.
- Skills: registry and confirmation state.
- Runtime: deployment records, environment and failure reason.

## Security and governance acceptance criteria

- No secret or credential is shipped to the browser.
- No production action is exposed to MEMBER users.
- The UI does not claim a flow is active when it is only saved in Sandbox.
- Execute and verify engines cannot be selected as the same family.
- Tool/MCP, skill confirmation and deployment controls disclose FDE gating.
- Langflow flow is private, Sandbox-only, and has no external side effects.
- Original AgentBuildSession is byte-for-byte unchanged by the clone process.

## Rollback

Studio V2 uses its own directory, port, launch service and Cloudflare hostname.
Rollback stops only the Studio service and removes its ingress route. The
existing client, backend, MCP endpoint and Agent data remain untouched.
