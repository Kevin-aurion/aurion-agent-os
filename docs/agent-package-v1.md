# LazyOffice AIOS Portable Agent Package v1

`Agent Package` is the exchange format produced by **Agent Building → 匯出 Agent ZIP**. The ZIP expands to a normal folder and is intentionally readable without an AIOS database.

## Export eligibility

An export is allowed only when all of these are true:

- the Builder session is `ACTIVE` (it has passed the existing test and FDE finalization gates);
- the live Agent is `ACTIVE`, customer-owned and not system-managed;
- at least one attached Skill is `CONFIRMED`;
- the caller owns the Builder session, or is an unscoped web FDE (`OWNER` / `TRAINER`).

A public Claude/GPT Builder OAuth token remains owner-only even if its account role is `OWNER`; it cannot use FDE visibility to export another account's Agent.

## Folder layout

```text
manifest.json
README.md
IMPORTING.md
schema/agent-package.schema.json
agent/
  AGENT.md
  CLAUDE.md
  AGENTS.md
  identity.json
skills/<skill-slug>/
  SKILL.md
  skill.json
  assets/templates/*
memory/wiki/*.md
workflows/*.json
tests/builder-test.json
provenance/builder.json
```

`manifest.json.kind` is `lazyoffice.aios.agent-package`, and `schemaVersion` is `1.0`. Every payload file except `manifest.json` has a SHA-256 entry in `checksums`.

Internal ZIP entry paths are ASCII-only for compatibility with older macOS, Windows and command-line extractors. Human-readable CJK Agent/Skill names and original slugs remain in `manifest.json` and the Markdown/metadata files.

## Security and governance contract

- Every string is passed through the mandatory AIOS secret/PII redactor again at export time.
- Raw Builder transcripts, connected accounts, OAuth tokens, MCP credentials and run directories are excluded.
- Only confirmed Skills are included; pending/rejected Skills are omitted.
- Workflows and schedules preserve their source definitions for review, but `enabledOnImport` is always `false`.
- A destination importer must validate checksums, create a paused draft, map tools locally, run the supplied test fixture, and require human approval before activation.
- Template paths are resolved inside the confirmed Skill directory. Traversal paths, symbolic links, missing assets, excessive file counts or oversized exports fail closed.

## Destination mappings

- Generic agent systems: use `agent/AGENT.md` as the role instructions.
- Claude-compatible systems: use `agent/CLAUDE.md` and copy each `skills/*/SKILL.md` into its Skill registry.
- Codex-compatible systems: use `agent/AGENTS.md` and the same confirmed Skill folders.
- Workflow engines: translate each disabled JSON workflow after mapping its `type`, `config`, permissions and destinations.

The format transports Agent behavior and knowledge; it does not claim that another runtime will execute AIOS workflow semantics identically. The destination must re-test before enabling it.
