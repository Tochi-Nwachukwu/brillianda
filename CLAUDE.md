# Brillianda backend

Multi-tenant school registry API. The product plan is `docs/plan.md`; deviations from it are in
`docs/decisions.md`. The frontend is a separate Next.js repo that reaches this API through its
`/api/*` rewrite (`docs/frontend-integration.md`).

## Commands

```bash
docker compose up -d          # Postgres on :5433 (5432 is left free for any local Postgres)
cp .env.example .env          # then set AUTH_SECRET and PROXY_SHARED_SECRET
pnpm install
pnpm db:bootstrap             # roles + database (idempotent)
pnpm db:plan                  # show pending migrations, change nothing
pnpm db:migrate               # apply as brillianda_owner (remote: Neon snapshot first)
pnpm db:check                 # migration safety guard (also in CI)
pnpm db:seed                  # Surebloom demo school; prints a curl with a session cookie
pnpm dev                      # API on :4000 (school = Host header, e.g. surebloom.localhost:4000)
pnpm check                    # typecheck + lint + all tests (needs Postgres running)
pnpm db:generate              # after editing packages/db/src/schema → new SQL migration
pnpm --filter @brillianda/api openapi   # regenerate openapi.json after changing a route
```

## Packages

- `apps/api` — Hono HTTP API. Routes, middleware, `schoolRoute()`. No SQL client of its own.
- `packages/core` — pure TypeScript, no I/O: subdomain rules, host parsing. Unit-tested.
- `packages/db` — Drizzle schema, migrations, `withSchool()`, the only place that talks to Postgres.
- `packages/auth` — our own auth: Argon2id passwords, DB sessions, email codes, link tokens.

## Rules

- **Tenancy**: read `.claude/skills/brillianda-tenancy/SKILL.md` before touching a school table
  or a school-scoped route. The school comes from the host, never from input.
- **Every school-scoped handler goes through `schoolRoute()`** (session → membership → role →
  rate limit → `withSchool` → audit). The only exception is logout, which must work without a
  valid session.
- **Nothing outside `packages/db` imports `pg` or `drizzle-orm/node-postgres`.** ESLint enforces it.
- **Zod on every input** via the route's `createRoute` schema. Errors leave as `{ error: { code, message, requestId, details? } }`.
- **Auth is ours.** Do not add Better Auth, Lucia, Passport or similar. Never store a raw token;
  store `AuthSecret.hash(...)`. Never compare secrets with `===`.
- **Ask before adding a dependency.**
- Tests run against real Postgres with the production roles. Do not mock the database.
- **Schema changes follow expand → migrate → contract** (`docs/safety.md`). Never edit a shipped
  migration; never add `-- safety: allow ...` without a reason a reviewer can check.

## Gotchas

- `set_config('app.school_id', id, true)` — the `true` (transaction-local) is load-bearing under
  pooled connections. Never change it.
- `app_current_school_id()` uses `nullif(..., '')` because a reused connection returns '' not NULL.
- drizzle-kit cannot emit `FORCE ROW LEVEL SECURITY`; a new school table needs a custom migration
  (`pnpm --filter @brillianda/db exec drizzle-kit generate --custom`). `rls-coverage.test.ts` fails if forgotten.
- Platform policies check `current_user = 'brillianda_platform'`, not `TO brillianda_platform`:
  `TO role` policies also apply to role *members*, and the owner role is a member.
- Use node-postgres (TCP/pooled). HTTP drivers (neon-http) cannot hold a transaction, so `withSchool` breaks.
- Drizzle wraps Postgres errors: the real message is on `err.cause`.
- Cookies are `__Host-bd_session` in https mode (no Domain, Path=/), plain `bd_session` locally.
- `pg_dump` as the owner fails on FORCE RLS tables by design. Backups use `brillianda_backup`
  with `--enable-row-security`; every school table needs the `backup_read` policy.
- Migrations that grant to a role need that role to exist: new roles go in `bootstrapCluster()`,
  then `pnpm db:bootstrap` runs before `pnpm db:migrate` on every environment.
