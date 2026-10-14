# Brillianda API

Backend for Brillianda, the self-serve school registry. Schools sign up at brillianda.com and run
their school at `<school>.brillianda.com`.

- **Stack:** Node 22, TypeScript, Hono, Zod 4 + OpenAPI, Drizzle ORM 0.45, PostgreSQL 16+ with
  row-level security, our own auth (Argon2id + database sessions), Upstash rate limits.
- **Tenancy:** one database, every school's rows isolated by forced RLS. The school is always
  derived from the request host.
- **Plan:** [`docs/plan.md`](docs/plan.md) · deviations: [`docs/decisions.md`](docs/decisions.md) ·
  frontend wiring: [`docs/frontend-integration.md`](docs/frontend-integration.md)

## Getting started

```bash
docker compose up -d
cp .env.example .env     # set AUTH_SECRET and PROXY_SHARED_SECRET (commands in the file)
pnpm install
pnpm db:bootstrap && pnpm db:migrate && pnpm db:seed
pnpm dev
curl -H "Host: surebloom.localhost:4000" http://localhost:4000/v1/school
```

`pnpm check` runs typecheck, lint and every test against your local Postgres.

## Status

| Phase | Scope | State |
|---|---|---|
| 0 Foundations | Monorepo, roles, forced RLS, `withSchool`, `schoolRoute`, auth primitives, isolation gate, CI | ✅ |
| 1 Signup and tenancy | Subdomain check, 4-step signup, email code, provisioning, handover, login, magic link, password reset, Find my school, invites | ✅ API (email: Resend, `MAIL_PROVIDER=resend`; console locally) |
| SSO | SAML/OIDC + SCIM per school, provider chosen later (`docs/decisions.md` #4) | after Phase 1 |
| 2 Calendar, classes, arms | First session at signup, members, calendar, checklist, Home summary, classes and arms | ✅ |
| 3 Subjects | Catalogue, school subjects, class links, departments | ✅ |
| 4 Students | Students, guardians, admission numbers, class history, import with undo, change history | ✅ |
| 5 Hardening | Branding and logos ✅, trial requests ✅; speed, security review, production setup | in progress |

## Email

`MAIL_PROVIDER=console` prints every email in the terminal (or Vercel's logs). `MAIL_PROVIDER=resend`
sends through Resend: set `RESEND_API_KEY`. Until a sending domain is verified in Resend,
`MAIL_FROM="Brillianda <onboarding@resend.dev>"` works but delivers **only to the Resend account's own
email**; any other recipient makes the API answer `503 service_unavailable`. Production refuses that test sender.

## Production database setup

1. Create the database server (Neon or RDS, London region).
2. Run `pnpm db:bootstrap` once with the provider's admin role in `DATABASE_ADMIN_URL`.
3. Rotate the two role passwords it set and store them in the secret manager.
4. Point `DATABASE_OWNER_URL` (migrations only, in CI/CD) and `DATABASE_URL` (the API, pooled
   endpoint) at them. The API never receives the owner credentials.
