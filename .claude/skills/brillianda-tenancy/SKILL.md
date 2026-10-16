---
name: brillianda-tenancy
description: Rules for anything that stores or reads school data in Brillianda — adding a school table, writing a school-scoped route, or touching withSchool, RLS policies, sessions or roles. Use before changing packages/db/src/schema or any route that uses schoolRoute().
---

# Brillianda tenancy

One Postgres database holds every school. Isolation is enforced by Postgres row-level security,
not by remembering to add `where school_id = ?`.

## The three rules

1. **The school comes from the host.** `requestContext` resolves it from `Host` (or
   `x-forwarded-host`, only when the proxy secret matches). Never accept a school id, subdomain or
   tenant header from the body, query or cookies. `requireSchool(c)` is the only way to get it.
2. **Every school-data query runs inside `withSchool()`.** In routes that means inside
   `schoolRoute(c, opts, async ({ tx, school, auth, audit }) => ...)` and using `tx`, never `deps.db`.
   Outside `withSchool` school tables return zero rows: if a query "returns nothing", that is why.
3. **Cross-school reads go through a SECURITY DEFINER function** owned by `brillianda_platform`
   with a pinned `search_path`, wrapped in `packages/db/src/platform.ts`. Add one only when a
   feature truly needs to look across schools (login picker, Find my school). Return the minimum.

## Checklist: adding a school table

In `packages/db/src/schema/tenant.ts`:

- [ ] `schoolId: schoolId()` — NOT NULL, FK to schools, cascade
- [ ] `id: id()` (UUIDv7), `createdAt`, `updatedAt`, `createdBy`, `updatedBy`
- [ ] `unique("<table>_school_id_id_key").on(t.schoolId, t.id)` so children can reference it
- [ ] Children reference parents with a **composite** FK:
      `foreignKey({ columns: [t.schoolId, t.classArmId], foreignColumns: [classArms.schoolId, classArms.id] })`
      so a row can never point at another school's record
- [ ] Indexes lead with `school_id`
- [ ] `schoolIsolation(t.schoolId)` and `backupRead()` in the extra-config array, and `.enableRLS()` on the table
- [ ] Soft delete (`deletedAt`) or `archivedAt` instead of hard deletes where the plan says so

Then:

- [ ] `pnpm db:generate` (the table, policy and RLS enable)
- [ ] `pnpm --filter @brillianda/db exec drizzle-kit generate --custom --name=force_rls_<table>` and write
      `ALTER TABLE <table> FORCE ROW LEVEL SECURITY;` plus any REVOKEs (e.g. append-only)
- [ ] Add a row for the table in `packages/db/test/fixtures.ts` `seedSchool()` so the isolation suite
      checks it (the suite discovers tables automatically and fails on an empty one)
- [ ] `pnpm check` — `rls-coverage.test.ts` fails if RLS, FORCE, either policy or `unique (school_id, id)` is missing
- [ ] Changing an existing table? Follow expand → migrate → contract in `docs/safety.md`

## Checklist: a school-scoped route

- [ ] `createRoute` with Zod schemas for params/query/body and every response, including `ErrorSchema` ones
- [ ] Handler body is `schoolRoute(c, { roles }, async ({ tx, school, auth, audit }) => { ... })`
- [ ] Owner-only actions (delete school, transfer ownership, change primary email) pass `roles: ["owner"]`
- [ ] Every create/update/delete calls `audit({ action: "student.updated", entity: "student", entityId, changes })`
- [ ] Throw `ApiError` for expected failures; anything else becomes a generic 500
- [ ] Add an API test that hits the route as school A with school B's data and gets nothing
- [ ] `pnpm --filter @brillianda/api openapi` and commit `openapi.json`

## Never

- Never connect the API as `brillianda_owner`, or give `brillianda_app` BYPASSRLS.
- Never call `set_config('app.school_id', ..., false)`.
- Never cache school data between requests (only the subdomain → school identity lookup is cached).
- Never write a policy `TO brillianda_platform`; check `current_user` instead (see CLAUDE.md).
