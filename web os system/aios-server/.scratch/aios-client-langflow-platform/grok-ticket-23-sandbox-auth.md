Ticket 23 sandbox auth follow-up from Codex live verification.

Facts:

- t20 POC 01/02/03 intentionally target the FDE Sandbox at `127.0.0.1:7860`.
- Langflow 1.11.2 now requires API auth there too; using the Production API key is wrong and violates isolation.
- Sandbox may use a fixed, explicit local-only placeholder because it is loopback-only, disposable, and contains no production data/credentials.

Implement narrowly:

1. In `docker-compose.langflow-sandbox.yml`, keep `LANGFLOW_AUTO_LOGIN=true` for the lab but add `LANGFLOW_API_KEY_SOURCE=env` and a fixed non-production placeholder `LANGFLOW_API_KEY`. Use a clearly named value that does NOT begin with `sk-`, e.g. `sandbox-flow-api-key-not-production-local-only-v1`.
2. Update `README.langflow-sandbox.md` with the Sandbox Flow API auth/header contract and explicit warning never to use the Production key there.
3. Update t02 sandbox validator/tests to require exactly `LANGFLOW_API_KEY_SOURCE=env` and the approved fixed placeholder; reject absence, any different value, interpolation, or provider/production key patterns. Keep the provider denylist intact.
4. Update t20 POC 01/02/03 to use the exact sandbox placeholder key, never `AIOS_LANGFLOW_PRODUCTION_API_KEY`. The other t20 adapters whose purpose is outage/digest/etc. may retain deterministic dummy handling as appropriate, but no test targeting 7860 should use Production credential.
5. Update ticket-scoped typecheck if needed. Run t02, typecheck, and all t20 tests. Live tests may restart/down the sandbox; report its final state.

Do not read/edit `.env`, do not expose real secrets, do not touch Production compose/key, do not commit/push, preserve unrelated WIP.
