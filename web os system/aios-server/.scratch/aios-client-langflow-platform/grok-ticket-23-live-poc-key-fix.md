Ticket 23 follow-up from Codex live verification:

The seven t20 POC files currently hardcode the deterministic dummy `apiKey`. That fixes construction offline, but when a real production Langflow is healthy it guarantees a 403 and prevents the live branch from passing.

In those seven POCs, resolve a test key as:

`process.env.AIOS_LANGFLOW_PRODUCTION_API_KEY?.trim() || <existing deterministic dummy>`

Use that value only for the LangflowAdapter. Never print it. Keep the dummy fallback for offline/outage tests. Update the ticket-scoped typecheck if needed. Run all ten t20 POCs; for live execution, the caller will supply the real key through the process environment. Do not read or edit `.env`, do not expose values, do not commit/push.
