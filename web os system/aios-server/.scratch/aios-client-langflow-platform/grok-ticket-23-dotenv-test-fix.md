Ticket 23 follow-up from Codex live verification:

After the three real local credentials were safely added to the gitignored `web os system/.env`, t17's three negative `docker compose config` checks now fail because Docker Compose auto-loads `.env` and repopulates the variable deleted from `process.env`.

Fix only those three missing-variable negative checks so they explicitly disable project `.env` interpolation (for example `--env-file /dev/null`, using the macOS/Linux environment here) while still supplying the two non-target dummy variables via `env`. Keep normal config/live compose behavior unchanged. Add a concise comment explaining why. Then rerun t17 and the ticket-scoped typecheck. Do not edit `.env`, do not expose values, do not commit/push.
