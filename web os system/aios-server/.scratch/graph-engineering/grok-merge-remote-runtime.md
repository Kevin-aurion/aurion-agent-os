# Resolve current Git merge without losing either feature set

The repository is currently in a merge conflict between local commit `35a4846` and `origin/feat/agentic-os-p0-p1` (`6e75e32`). Work in the repository root. Resolve all current conflicts, but **do not commit or push**.

## Required integration intent

1. Preserve the local clean-room rename: the product/plugin/marketplace identity is **Aurion / aurion-aios-builder**. Do not restore tracked `aurion-aios-builder` plugin, installer, release, or marketplace paths.
2. Preserve all local GraphSpec v2, Graph Workbench, Langflow runtime, lifecycle Start/Prompt/Stop hooks, Studio v2, governance and account-isolation behavior.
3. Integrate all four remote commits' functionality:
   - governed Agent runtime over MCP,
   - portable Agent package export,
   - external build deduplication,
   - account isolation.
4. Port the remote `use-aios-agent` skill/plugin additions into the **Aurion** plugin source and all generated one-click/marketplace release structures. Update manifests, docs, package scripts/checksums consistently. Do not keep Aurion-branded duplicate artifacts.
5. Backend conflicts (`agentbuilder.ts`, `externalagentbuilder.ts`, routes/docs) must preserve both the newer local training/reflection/account-bound behavior and remote runtime/package/idempotency behavior. Security and FDE gates remain fail-closed.
6. Frontend conflicts must preserve both the local newer Agent Builds/Proposal UI and the remote Agent package export/runtime/account-isolation controls.
7. For generated zip/checksum release files, use the repository packaging script after sources are merged; do not choose an arbitrary conflicted binary. Ensure all published artifacts are Aurion-branded and include both build and use skills.
8. Remove every conflict marker and make `git status` show no unmerged paths. Stage the resolved files, but do not create a merge commit.

## Verification

- Run `git diff --check` and verify no conflict markers.
- `web os system/aios-server`: Prisma validate, typecheck, build, and remote tests for agent package/runtime/idempotency/account isolation where available.
- `web os system/aios-mcp`: lifecycle/plugin marketplace tests, typecheck, build/package validation.
- `web os system/aios-web`: typecheck and build.
- Re-run the Graph Engineering static tests if backend conflict resolution touched shared routes/index/schema.
- Report exact conflicts resolved, exact tests, and any remaining issue.

Never weaken a negative test or delete functionality merely to make compilation pass.
