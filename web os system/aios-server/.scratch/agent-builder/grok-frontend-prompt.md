Implement FRONTEND ONLY for the already-created Agent Builder backend.

Read:
- `/Users/kevin/Documents/lazyoffice/web os system/aios-server/.scratch/agent-builder/spec.md`
- `/Users/kevin/Documents/lazyoffice/AGENTS.md`
- `web os system/aios-server/src/routes/agentbuilder.ts`
- exported DTOs in `web os system/aios-server/src/lib/agentbuilder.ts`
- current `web os system/aios-web/src/app/work/page.tsx`, workbench components/types,
  API/auth helpers and module CLAUDE.md files.

In `web os system/aios-web` add the CEO-friendly Agent Builder experience:

1. Add a prominent sidebar entry `建立 AI 員工` above `新任務`. It must work without
   selecting an Agent. When active, the center panel becomes a focused chat-like
   builder, and the right rail shows a simple progress/checklist instead of an Agent.
2. Prefer a new `src/components/workbench/AgentBuilderPanel.tsx` with focused types in
   workbench/types.ts rather than bloating page.tsx. Integrate surgically with existing
   dirty WIP.
3. Initial empty state: headline `告訴我你想請一位 AI 員工做什麼`, short examples,
   textarea and send. POST `/api/agent-builder/sessions`.
4. Render the durable transcript. In DISCOVERY show progress and exactly the backend's
   one current question/recommendation; submit replies to `/messages`.
5. PLAN_READY/AWAITING_FDE show a business-language plan: recommendation, reusable
   employees, existing skills, missing connections, least-privilege note. Do not show
   engines, manifests, JSON, MCP/A2A protocol terms or database ids. Provide explicit
   `沿用建議員工` and `建立新的員工` authorization actions. For MEMBER explain it is
   sent to FDE; OWNER/TRAINER may build.
6. AWAITING_TEST_DATA/FAILED/PASSED show required test fixture and expected-result
   inputs, POST `/test-data`, then `/test`. Test endpoint currently returns after the
   real run; show a clear busy state and prevent double submit. Display production
   connector blockers separately from manual test pass/fail.
7. PASSED gives OWNER/TRAINER an explicit `確認技能並啟用` action calling `/finalize`.
   MEMBER sees `等待 FDE 最終確認`. ACTIVE gives a link/button to open the built/reused
   Agent in `/work?agent=<id>`.
8. Preserve existing work/teach interactions and URL behavior. Selecting an Agent or
   new task exits builder mode. The builder entry re-enters it. No technical settings
   leak to end users.
9. Use existing Tailwind/ui conventions, accessible buttons/labels and responsive
   overflow. Update frontend module CLAUDE.md minimally.
10. Run `npx tsc --noEmit`. Do not run `next build` while dev is live. Do not touch
    backend, AGENTS.md, lazyoffice, or unrelated WIP. Do not commit/push.

Implement now, then report files and typecheck outcome.
