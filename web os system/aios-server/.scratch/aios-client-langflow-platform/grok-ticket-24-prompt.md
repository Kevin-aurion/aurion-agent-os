Implement Ticket 24 exactly as specified in `issues/24-runtime-binding-execution.md`.

Read root AGENTS.md and relevant CLAUDE.md files first. Preserve unrelated WIP. Write tests first. Keep changes narrow to runtimeexecution, a new t24 test, and the ticket-scoped tsconfig if needed.

Important:

- Runtime binding is untrusted persisted JSON. Parse deterministically and fail-closed.
- Accept only a plain object whose `kind` is exactly `LANGFLOW` and whose `bindingRef` exactly matches `langflow:flow:<safe non-empty flow id>`. Reject controls, whitespace ambiguity, wrong prefix/kind, arrays, null, and missing values.
- On invalid binding, mark the Run FAILED using existing safe path and make zero adapter calls. Never fall back to AIOS artifact id.
- On valid binding, pass only the extracted flow id as `adapter.execute({ artifactId })`.
- Do not weaken FDE, approval, Skill confirmation, execute≠verify, cost/rate/circuit/DLQ or redaction boundaries.
- Do not touch `.env`, compose credentials, migrations, or production data. Do not commit/push.

Run server typecheck, ticket-scoped typecheck, new t24 positive/negative tests, relevant t18 runtime tests, and t20 POC 01/02 live against the already-running authenticated sandbox. Fix until zero failures and no 404 execute blocker. Report exact results.
