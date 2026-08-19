Repair Ticket 02 in the existing implementation. Read AGENTS.md and the relevant module CLAUDE.md first.

Problem found by independent Opus review: in src/lib/eval.ts, HIGH_RISK_KINDS evaluation initializes output to inputPhrase and catches execution errors, then continues to judge the original input. This is a fail-open/ambiguous fallback for a promotion gate.

Required repair:
- A PROMPT_INJECTION or RED_TEAM case whose candidate execution, budget check, engine dispatch, or evidence preparation throws must deterministically fail the case. It must never substitute inputPhrase as candidate output and continue as though execution succeeded.
- Persist only redactSecrets-sanitized error evidence. Do not leak prompts, credentials, raw provider output or stack traces.
- Preserve the cross-model rule: when an LLM judge runs, judge engine must differ from candidate execution engine.
- Keep cost/audit ancillary recording semantics consistent with AGENTS.md; the evaluation/promotion decision itself is fail-closed.
- Add or extend a focused negative test under .scratch/skill-production-platform/tests that injects a failing execute function for a high-risk case and asserts a failed result with no input-as-output fallback and no stable promotion eligibility.
- Preserve all existing exports and WIP. Do not commit, push or modify lazyoffice-system-main.

After editing, run npx tsc --noEmit and the focused Ticket 02 tests against the real local DB. Report changed files and exact test results.
