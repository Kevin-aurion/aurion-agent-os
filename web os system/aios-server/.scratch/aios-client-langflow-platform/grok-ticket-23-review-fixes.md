Opus independent review returned REQUEST_CHANGES. Continue Ticket 23 and make narrow fixes:

1. Add a deterministic non-secret test apiKey to all seven existing t20 LangflowAdapter constructions: t20-poc-01, 02, 03, 06, 07, 08, 09. Run all t20 tests that can run; do not claim blocked tests pass.
2. Split LANGFLOW_SUPERUSER_PASSWORD from LANGFLOW_SECRET_KEY in production compose. Add a fail-closed host variable `AIOS_LANGFLOW_PRODUCTION_SUPERUSER_PASSWORD` with `${AIOS_LANGFLOW_PRODUCTION_SUPERUSER_PASSWORD:?…}` reference. Update t17 synthetic/config/missing-variable tests and README. It remains a Langflow local runtime credential, not a provider key.
3. Harden key validation to reject C1 controls U+0080-U+009F plus U+2028/U+2029. Add tests.
4. Make t17 hardcoded `LANGFLOW_API_KEY` detection reject any non-`${...}` literal, including short literals. Add a negative mutation proving it.
5. Add a ticket-scoped TypeScript config or equivalent typecheck that includes the touched `.scratch` Langflow tests so missing required `apiKey` cannot hide outside main tsconfig. Keep it narrow and run it.
6. Run server tsc, t23, both t03 tests, t17, and every t20 POC. Fix regressions.

Do not edit `.env`, do not run live secrets, do not commit/push, and preserve unrelated WIP. Report exact pass/fail/blocked.
