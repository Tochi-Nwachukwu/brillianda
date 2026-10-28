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

## 4. Enterprise SSO (SAML/OIDC) and SCIM: its own phase, provider decided later (Oct 7, 2026)

Brillianda is enterprise-focused, so schools will ask for SAML SSO and SCIM provisioning.
Decided:
- **Our auth stays the session authority.** SSO only replaces how identity is proven; after the
  school's IdP confirms someone we mint the usual school-bound session. SCIM is another way
  members are created and deactivated (deactivation revokes sessions everywhere).
- **Phase 1 ships password signup/login first.** SSO is its own phase right after it.
- **The protocol provider is chosen when the first enterprise school needs it**, behind a
  provider-agnostic adapter. Options weighed: WorkOS (managed, ~$125/connection/month each for
  SSO and SCIM per a Jul 2026 third-party summary, US-hosted), Ory Polis (ex-BoxyHQ SAML Jackson,
  Apache-2.0, self-hosted), or in-house (node-saml + own SCIM 2.0; SAML is the risky part).
- **SSO phase scope:** verified school email domains (DNS TXT), per-school SSO connections with an
  "SSO required" switch, directory (SCIM) connections with group→role mapping, external identity
  links per member, email-first login routing, and an owner break-glass login (password + 2FA).
- Better Auth was never installed; it remains out (its organisation model fights per-tenant SSO).

## 5. The subject catalogue lives in code, not a table (14 October 2026)

**Plan:** a read-only `subject_catalog` table, changed only by seed migrations.

**Instead:** the catalogue is `packages/core/src/catalogue.ts`, the same list the frontend uses.
`school_subjects.catalogue_id` holds an entry's stable id; the API checks ids against the list.

**Why:** a seed migration and a code change are reviewed and shipped the same way, and both sides
reading one list means the frontend's pre-ticks and the API's default links can't drift. The cost
is no database foreign key to the catalogue, which the API's own check covers. Moving it into a
table later is a seed migration plus a foreign key, with no API change.

## 6. School logos live in Postgres, not object storage (14 October 2026)

**Plan:** logos in private object storage, served through short-lived signed URLs.

**Instead:** a `school_logos` table (one row per school, at most 300 KB, PNG, JPEG or WebP, at
most 512 px), served by `GET /v1/school/logo` on the school's own address. The URL carries the
image's hash (`?v=…`), so browsers cache it for a year and a new logo is a new URL.

**Why:** a logo is public (the sign-in page shows it) and tiny, so signed URLs protect nothing,
and it saves choosing, paying for and securing a storage provider before v1. The frontend's
Content Security Policy needs no extra host. **Student photos are different**: thousands of them
per school would bloat the database and backups, so they go to object storage (Cloudflare R2
suggested) when that feature is built, and logos can move with them.

## 7. The team console picks a school by name, and counts across schools (21 October 2026)

**Rule elsewhere:** the school comes from the host, never from input; cross-school reads go
through a SECURITY DEFINER function.

**Here:** the Brillianda team console (`/v1/team/*`, main site only) lists every school and opens
one by its subdomain in the path. Its reads across schools all come from one function,
`app_console_schools()` (migration 0026): counts, the owner's name and email, contact details and
setup flags, never a student's own record. Its two writes into a school, the "viewed the summary"
line (at most once an hour per person) and pausing or reactivating with a reason, go through
`withSchool` for that school and show in the school's own change history under the team member's
name with "(Brillianda)".

**Why:** the plan says Brillianda staff reach a school only through the console, with each access
logged and shown to the school. Team accounts are separate from school accounts (their own table,
`__Host-bd_team` cookie, 12-hour sessions, no sign-up: `team:add` creates them), so a school
session can't open the console and a team session can't open a school. Pausing takes effect at
once on the instance that served it and within a minute everywhere (the school lookup cache).

## 8. Profile photos live in Postgres for now (21 October 2026)

`user_photos`, one row per person, at most 150 KB and 1024 px (the browser sends 256×256 JPEGs),
served to the person themselves at `GET /v1/me/photo`. Same reasoning as logos (#6): small, one per
person, no storage provider needed yet. They move to R2 with student photos.

## 9. The timetable PDF lives in Postgres too (25 October 2026)

One per school, at most 2 MB (a CHECK enforces it), on the `timetables` row. Same reasoning as #6
and #8; it moves to R2 with the other files.

## 10. Students sign in, and see only themselves (25 October 2026)

The front end's B6 adds a `student` role. Students are often under 18, so:

- A student account belongs to one student record (`student_links`, unique both ways), made only
  through an invitation from an owner or admin, to an email nobody else at the school uses.
- Every other route names the roles it serves and none names `student`; the only routes open to
  them besides `/v1/me/student`, `/v1/me/timetable` and `/v1/me/report-card` are their own
  account's (`GET /v1/me`, profile, password). A test walks the staff and parent routes as a student.
- What they see: their own record, class, timetable (teachers by name only), attendance and
  published results. No other student, guardian or staff contact detail.
- Ending access deletes the membership (and with it the link and every session at the school);
  the record stays.
- AI features (B7) are not offered to students, and need the provider decision in the front end's
  `docs/ai-integration.md` (Step 0) before they're built.

## 11. AI drafting is built, and switched off until the terms are settled (28 October 2026)

B7's generator calls Gemini over plain fetch behind a small interface (`apps/api/src/lib/ai.ts`), so
the provider is a setting (`AI_PROVIDER=off|gemini`) and another provider is one more class. It is
**off by default**: Google's Gemini API and Vertex AI terms restrict use in a service likely to be
accessed by under-18s, and Brillianda has a student portal. We've asked Google in writing whether a
teacher-only feature is allowed. Until a written yes (and a lawyer's read):

- staging may turn it on for testing with test schools only;
- production refuses to start with AI on unless `AI_TERMS_CLEARED=true`;
- only owners, admins and teachers reach it, for the subjects and classes they teach;
- only subject matter goes to the model (subject, class level, topics, the teacher's notes, the
  counts); never a student's name, record, score or answer;
- nothing it drafts is saved until a teacher checks it;
- `ai_usage` keeps each generation (model, tokens, never the prompt), append-only, against the
  school's monthly allowance (`AI_MONTHLY_LIMIT`, default 300).

Use a paid-tier key: on the free tier Google may use prompts to improve its products. The default
model is `gemini-3.1-flash-lite` (28 October: `gemini-3.8-flash` was overloaded and timed out on
staging; Flash-Lite drafted six correct questions in about 20 seconds). `AI_MODEL` changes it.
