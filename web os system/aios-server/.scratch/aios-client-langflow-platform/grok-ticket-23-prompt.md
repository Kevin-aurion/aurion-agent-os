You are the implementation agent for Ticket 23 in this existing dirty workspace. Read, follow, and implement exactly:

- root `AGENTS.md`
- `web os system/aios-server/CLAUDE.md`
- `web os system/aios-server/src/CLAUDE.md`
- `web os system/aios-server/src/lib/CLAUDE.md`
- `.scratch/aios-client-langflow-platform/issues/23-langflow-api-auth.md`

Implement production-quality code and tests now. Work only in the ticket's exact likely files plus the ticket test and the minimum necessary t17 test edits. Preserve all unrelated user WIP. Do not edit `.env`, do not generate or print real secrets, do not commit or push, and do not modify migrations or `lazyoffice-system-main`.

Security rules:

1. Keep `LANGFLOW_AUTO_LOGIN=false`, backend-only, loopback-only, read-only rootfs and current isolation.
2. API key is Langflow control-plane credential, not a provider credential. Compose must source it fail-closed from `AIOS_LANGFLOW_PRODUCTION_API_KEY` without hardcoding.
3. Adapter must attach `x-api-key` centrally to every Langflow HTTP request. Constructor input must be trimmed, non-empty, bounded, and reject CR/LF/control characters. Never include the key in errors/logs.
4. Production resolver must require both URL and key fail-closed. Direct mocked adapter tests may provide a test key.
5. Add negative tests for missing/blank/CRLF key, zero network call, header propagation, and secret reflection redaction. Ensure t03 and t17 remain compatible.
6. Do not weaken execute != verify, Skill confirmation, FDE deployment gate, provider credential denylist, redactor, or any fail-closed boundary.

Run at least:

- `npx tsc --noEmit`
- ticket 23 test
- ticket 03 adapter tests
- ticket 17 production isolation test

If Docker/live service behavior is blocked, report it honestly; do not fake-pass. At completion report changed files, test commands/results, security evidence, and any blocker. Keep edits narrow.
