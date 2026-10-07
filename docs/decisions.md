# Decisions that differ from docs/plan.md

`docs/plan.md` (Oct 6, 2026) is the product plan. These are the places the build deliberately departs
from it, and why. Add to this file whenever another one is made.

## 1. Separate API instead of Server Actions (Oct 7, 2026)

**Plan:** one Next.js app; Server Components read, Server Actions write, no API service.
**Now:** this repo is a standalone API (Hono on Node). The frontend lives in its own repo.

What carries over unchanged: the school comes from the host; `withSchool()`; FORCE row-level
security; composite foreign keys; the `schoolAction()` pipeline (here `schoolRoute()`); host-only
session cookies; the two-school isolation gate.

What changes:
- The frontend's `proxy.ts` forwards `/api/*` on each school's host to this API with
  `x-forwarded-host` and a shared secret. The API trusts forwarded headers only with that secret.
  This keeps cookies host-only per school, which a shared `api.brillianda.com` could not.
- Zod schemas produce an OpenAPI 3.1 document (`openapi.json`) that the frontend generates its
  typed client from, replacing shared imports.
- A future mobile app can call the same API with bearer tokens instead of cookies.

## 2. Our own auth instead of Better Auth (Oct 7, 2026)

**Plan:** Better Auth for identity; roles in `school_members`.
**Now:** auth is written in `packages/auth` on vetted primitives.

Why: Brillianda's model is "a session belongs to a user *in a school*", with a cookie pinned to each
school's host. That is the default here rather than something to configure around. Full control of
tables, tokens, audit and rate limits; no library upgrade risk.

How it stays safe:
- Argon2id (`@node-rs/argon2`) with OWASP parameters, NFKC-normalised input, a dummy verify for
  unknown accounts so timing does not reveal them, and `needsRehash()` for future parameter bumps.
- 256-bit random session tokens; only an HMAC-SHA256 (keyed by `AUTH_SECRET`) is stored.
  Sliding 30-day expiry with a 90-day absolute cap. Sessions live under RLS, so a token minted
  for school A does not exist when presented to school B.
- 6-digit codes: HMAC-stored, 10-minute expiry, 5 attempts spent atomically before comparing,
  constant-time compare, older codes retired when a new one is sent.
- Link tokens (magic link, reset, the 60-second signup handover): single-use via one conditional
  `UPDATE ... RETURNING`, so a race cannot redeem one twice.
- CSRF: SameSite=Lax plus a strict Origin/Referer check on every non-GET.
- Reference: OWASP Authentication, Session Management and Password Storage cheat sheets; the
  Lucia session guide (lucia-auth.com) for the token/hash model.

## 3. Platform policies check `current_user` (Oct 7, 2026)

Postgres applies a `TO role` policy to every member of that role. The migration owner must be a
member of `brillianda_platform` (to hand it function ownership), so a `TO brillianda_platform`
policy would have let the owner role read every school. The platform policies use
`current_user = 'brillianda_platform'` instead, which only matches inside its SECURITY DEFINER
functions. Verified by `isolation.test.ts` ("subjects the owner role to the policies too").
