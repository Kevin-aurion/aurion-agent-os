# LazyOffice AIOS Studio

Independent configuration client for LazyOffice AIOS. It provides progressive
Agent, model, Tool/MCP, Knowledge, Skill and Deployment workspaces while reusing
the existing governed AIOS API.

- Local: `http://127.0.0.1:3300`
- Public: `https://aios-studio.lazyoffice.app`
- Backend: same-origin rewrite to `http://127.0.0.1:8700`
- Rollback: stop `app.lazyoffice.aios-studio`; the existing AIOS web client is
  independent and remains available.

## Verification

```bash
npm test
npm run typecheck
npm run build
npm audit --audit-level=high
```
