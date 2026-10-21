# Connecting the frontend

The frontend (Next.js, separate repo) serves `brillianda.com` and every `<school>.brillianda.com`.
Browsers never call this API directly. Each school host forwards `/api/*` to it, so cookies stay
pinned to that school's host.

```
Browser ── surebloom.brillianda.com/api/v1/me ──▶ Next.js proxy.ts ──▶ API /v1/me
                                                   adds x-forwarded-host: surebloom.brillianda.com
                                                   adds x-brillianda-proxy-secret: <secret>
```

## proxy.ts (Next.js 16) sketch

```ts
// src/proxy.ts
import { NextResponse, type NextRequest } from "next/server";

const API_URL = process.env.API_URL!;              // e.g. https://brillianda-api.internal
const PROXY_SECRET = process.env.API_PROXY_SECRET!; // same value as the API's PROXY_SHARED_SECRET

export function proxy(req: NextRequest) {
  if (req.nextUrl.pathname.startsWith("/api/")) {
    const target = new URL(req.nextUrl.pathname.replace(/^\/api/, "") + req.nextUrl.search, API_URL);
    const headers = new Headers(req.headers);
    // Never let the browser choose these.
    headers.delete("x-brillianda-proxy-secret");
    headers.set("x-forwarded-host", req.headers.get("host") ?? "");
    headers.set("x-forwarded-proto", req.nextUrl.protocol.replace(":", ""));
    headers.set("x-forwarded-for", req.headers.get("x-forwarded-for") ?? "");
    headers.set("x-brillianda-proxy-secret", PROXY_SECRET);
    return NextResponse.rewrite(target, { request: { headers } });
  }
  // ...subdomain → /s/[school] rewrite as in the plan
}
```

## Calling from Server Components / Server Actions

Server-side fetches go straight to `API_URL` with the same three headers, plus the incoming
`cookie` and `origin` (for POSTs) copied from the browser request. Forward any `set-cookie` from
the API response back to the browser.

## Contract

- `openapi.json` at this repo's root is the contract. Generate types with
  `npx openapi-typescript <path-to>/openapi.json -o src/lib/api/schema.d.ts` and call with `openapi-fetch`.
- Errors are RFC 9457 problem details (`application/problem+json`). Switch on `code`; the full
  list, with what the UI should do for each, is in `docs/api-conventions.md`.
  `validation_failed` carries `errors[]` with a JSON Pointer per field; `rate_limited` carries `Retry-After`.
- Every non-GET needs a same-origin `Origin` header. Browsers send it automatically.

## Errors, mapped to the frontend's ActionResult

Older notes in the frontend's `docs/data-contract.md` describe `{ error: { code, message, details[] } }`.
That shape is gone. Every error is a problem document:

```json
{
  "type": "https://brillianda.com/problems/validation-failed",
  "title": "Some fields need fixing",
  "status": 422,
  "detail": "…",
  "code": "validation_failed",
  "requestId": "…",
  "errors": [{ "pointer": "#/terms/1/startsOn", "code": "custom", "detail": "Starts after First Term ends" }]
}
```

To build `ActionResult`: `error` = `detail ?? title`; `fieldErrors` = each `errors[]` entry keyed by its
pointer without `#/` and with `/` → `.` (`#/terms/1/startsOn` → `terms.1.startsOn`, the same keys
as the frontend's `fieldErrorsOf`). Query-string problems carry `parameter` instead of `pointer`.

## Staging without school subdomains

Staging API: `https://api-rouge-nine-18.vercel.app` (`/docs` there is a live test page). Its
`PROXY_SHARED_SECRET` is shared privately, never in a repo or chat.

`*.vercel.app` can't give every school its own subdomain, so on staging the frontend's `proxy.ts`
addresses schools by path instead. For `/s/<school>/api/...` (or an `/api/...` call made from a
`/s/<school>/` page):

1. Check the browser's `Origin` is the frontend's own address (refuse otherwise).
2. Send `x-forwarded-host: <school>.<API ROOT_DOMAIN>` and `origin: https://<school>.<API ROOT_DOMAIN>`
   with the proxy secret. The API then treats the request exactly as if it came from that school's address.

With a real domain on staging (`*.staging.brillianda.com`) none of this is needed: forward the host as
in production. That is the better end state.

**Links in emails on staging.** With `FRONTEND_URL` set on the API (staging only), every link the
API builds points at your app in the path form: `FRONTEND_URL/s/<school>/auth/handover?token=…`,
`/s/<school>/auth/magic?token=…`, `/s/<school>/reset-password?token=…`, `/s/<school>/invite?token=…`,
and `FRONTEND_URL/s/<school>` for a school's home. `handoverUrl` and `school.url` from signup too.

**Reading emails on staging.** Resend only delivers to our own address until a domain is verified.
Every email the staging API sends is also kept for 7 days, and the flow never stops because the
provider refused. Read them with:

```
GET https://api-rouge-nine-18.vercel.app/v1/dev/outbox?to=you@example.com&limit=5
x-brillianda-outbox-key: <sent privately>
```

Each email comes with `code` (the 6-digit code, if any) and `links` pulled out. The route doesn't
exist in production.

**For testers, in a browser:** open
`https://api-rouge-nine-18.vercel.app/dev/outbox?key=<the key>` (add `&to=you@example.com` to filter).
It lists the last 20 emails with codes in large type and links you can click, and refreshes every 10
seconds. Bookmark it while testing.

## Pages the API's emails and responses link to

The API builds these links; the frontend must serve these paths on each school's address:

| Path (school address) | Reads | Calls |
|---|---|---|
| `/auth/handover?token=` | token | `POST /v1/auth/handover` → then go to Home (setup checklist) |
| `/auth/magic?token=` | token | `POST /v1/auth/magic-link/confirm` |
| `/reset-password?token=` | token | form → `POST /v1/auth/password-reset/confirm` |
| `/invite?token=` | token | `GET /v1/invitations/lookup` → if `existingAccount` just accept, else ask name + password → `POST /v1/invitations/accept` |

Signup lives on the main site (`brillianda.com/signup`): `POST /v1/signup/school` → `/owner` →
`/verify-email` → `/complete`, with `GET /v1/signup` to resume and `GET /v1/signup/subdomain-check`
while typing (debounce ~300 ms). The draft travels in an HttpOnly cookie; the frontend stores nothing.
`complete` returns `handoverUrl`: navigate the browser to it.

## Local development

- API: `pnpm dev` → `http://localhost:4000`, `ROOT_DOMAIN=localhost`, `PUBLIC_PROTOCOL=http`
- Frontend: `http://surebloom.localhost:3000` with `API_URL=http://localhost:4000` and the same proxy secret.
- Chrome resolves `*.localhost` without hosts-file changes.

## What changed for the frontend

**13 October 2026** (answers `docs/backend-asks.md` in the frontend repo)

- `POST /v1/signup/school` takes `sessionStart: { month, year }` (optional; defaults to September of
  the current session) and `GET /v1/signup` returns it under `school.sessionStart`.
  `levelsOffered` accepts any case (`PRIMARY` or `primary`); responses use lowercase.
- `POST /v1/signup/complete` also creates the school's first session, named `2026/2027` from
  `sessionStart.year`, with three suggested terms (the same dates as the frontend's
  `defaultTerms`), current and **unconfirmed**. The calendar endpoints that read and confirm it
  come next.
- `GET /v1/members` (owner and admins): `{ data: [{ userId, fullName, email, role, joinedAt }] }`,
  owner first. `DELETE /v1/members/{userId}` (owner only): 204; 403 for the owner or a non-owner
  caller; 404 if not a member here. The removed admin's sessions at this school end immediately.

**13 October 2026, later** (batch 5: Home and the calendar)

| Frontend function | Endpoint (school address, owner or admin) | Notes |
|---|---|---|
| `getSession` | `GET /v1/session` → `{ startYear, name, terms[{ name, startsOn, endsOn }], confirmed }` | Never null for a member: suggested dates when nothing is saved |
| `saveSession` | `PUT /v1/session` `{ startYear, terms }` → the same shape, `confirmed: true` | Same rules as `sessionSchema`; 422 pointers like `#/terms/1/startsOn`; 409 if another session already uses that year |
| `getSetupProgress` | `GET /v1/setup` → `{ items[{ id, done }], hidden }` | Ids in order: branding, calendar, classes, arms, subjects, students, admins |
| `hideChecklist` | `PUT /v1/setup/hidden` `{ hidden }` → 204 | |
| `getHomeSummary` | `GET /v1/home` → `{ students, classes, arms, subjects, admins, recent[{ id, at, who, what }] }` | `at` is ISO 8601 (the fake uses milliseconds: `Date.parse(at)`). Classes, arms, subjects and students are 0 until their endpoints ship |

`recent[].what` is a sentence written when the change happens, in the frontend's wording ("Set the
2026/2027 calendar", "Invited ada@x.ng as an admin", "Removed Bisi Ade as an admin"). Sign-ins
are recorded for security but never listed.

**13 October 2026, evening** (batch 6: classes and arms)

Shapes are the fake's `ClassStructure`, `ClassLevel`, `ArmName` and `ClassArm`. Owners and admins.

| Frontend function | Endpoint | Notes |
|---|---|---|
| `getClassStructure` | `GET /v1/classes` | `levelsOffered` is lowercase (`secondary`); upper-case it for `SchoolLevel`. `studentCount` is 0 until students ship |
| `setupClasses` | `POST /v1/classes/setup` (`classSetupSchema`) → 201 with the new structure | 409 if classes already exist |
| `addLevel` | `POST /v1/class-levels` `{ name, short, section }` → 201 `{ id }` | Goes at the end of its section, with the first arm |
| `renameLevel`, `setLevelArchived` | `PATCH /v1/class-levels/{id}` `{ name?, short?, archived? }` → 204 | |
| `removeLevel` | `DELETE /v1/class-levels/{id}` → 204 | 409 while it has students |
| `addArm` | `POST /v1/class-levels/{id}/arms` `{ armNameId }` or `{ name, code }` → 201 `{ id }` | |
| `renameArmName` | `PATCH /v1/arm-names/{id}` `{ name, code }` → 204 | Renames it in every class |
| `setArmDepartment`, `setArmArchived` | `PATCH /v1/arms/{id}` `{ department?, archived? }` → 204 | 409 for a department on a non-senior class |
| `removeArm` | `DELETE /v1/arms/{id}` → 204 | 409 with students, or for a class's only arm |
| `saveArmLayout` | `PUT /v1/arms/layout` (`armLayoutSchema`) → `{ summary }` | All or nothing; 409 when the screen is stale |

Name and code clashes are 422 with a pointer (`#/name`, `#/code`), so they land under the field.
Refusals that aren't about one field (has students, stale screen, already set up) are 409 with the
same sentence the fake returns in `detail`.

**14 October 2026** (the rest of v1: batches 7, 8, 9, branding, change history, trial requests)

Every v1 function in `docs/data-contract.md` now has an endpoint. All are on the school's address,
owners and admins, unless noted.

| Frontend function | Endpoint | Notes |
|---|---|---|
| `getSubjectsSetup` | `GET /v1/subjects` | The catalogue is served from here (the API holds the same 57 entries) |
| `addSubjects` | `POST /v1/subjects` `{ catalogueIds, custom[] }` → 201 `{ added }` | Catalogue subjects attach to their default classes; already-added ones are skipped |
| `renameSubject` | `PATCH /v1/subjects/{id}` `{ name, code }` | |
| `removeSubject` | `DELETE /v1/subjects/{id}` | |
| `setSubjectLink` | `PUT /v1/subjects/{id}/levels/{levelId}` `{ kind }` | `kind: null` unticks |
| `setSubjectDepartment` | `PUT /v1/subjects/{id}/department` `{ department }` | |
| `listStudents` | `GET /v1/students` | `gender` is lowercase (`male`, `female`); it's accepted in any case |
| `getStudent` | `GET /v1/students/{id}` | No `parentAccess` or `attendance` yet: those belong to the after-v1 parents and register work |
| `addStudent` / `updateStudent` | `POST /v1/students` → 201 `{ id, admissionNo, fullName }` / `PUT /v1/students/{id}` | Body is `studentSchema`'s fields |
| `moveStudents` | `POST /v1/students/move` `{ studentIds, armId }` → `{ moved }` | |
| `setStudentsStatus` | `POST /v1/students/status` `{ studentIds, status }` → `{ changed }` | |
| `deleteStudent` | `DELETE /v1/students/{id}` | Soft |
| `findGuardian` | `GET /v1/guardians?phone=` → `{ guardian: GuardianMatch \| null }` | |
| `getAdmissionSettings` / `setAdmissionFormat` | `GET` / `PUT /v1/admission-numbers` `{ pattern, digits }` | |
| `getImportSetup` | `GET /v1/imports/setup` | Batch `at` is ISO 8601 |
| `checkImport` | `POST /v1/imports/check` `{ rows, armId }` → `{ rows: CheckedRow[] }` | Same `checkRows` as yours; genders come back lowercase |
| `commitImport` | `POST /v1/imports` `{ rows, armId, update, fileName }` → 201 `ImportResult` | Up to 5,000 rows, 4 MB |
| `undoImport` | `POST /v1/imports/{id}/undo` → `{ removed }` | |
| `saveImportMapping` | `PUT /v1/imports/mapping` `{ mapping }` | |
| `listChanges` | `GET /v1/changes?who=&search=&from=&to=&studentId=&limit=` | `at` is ISO 8601 |
| history CSV | `GET /v1/changes/export?…` | Same filters; you can proxy it instead of building the CSV |
| `updateBranding` | `PATCH /v1/school/branding` `{ name, brandColor }` → `PublicSchool` | Owner only |
| `uploadLogo` | `PUT /v1/school/logo`, multipart, one file `logo` → `PublicSchool` | Owner only. PNG, JPEG or WebP, ≤ 300 KB, ≤ 512 px |
| `removeLogo` | `DELETE /v1/school/logo` → `PublicSchool` | Owner only |
| `requestTrial` | `POST /v1/trial-requests` (main site, no session) → 202 | Honeypot `website` accepted silently |

**Logos** are served from the school's own address: `logoUrl` is now a relative path,
`/api/v1/school/logo?v=…`, which your `proxy.ts` already forwards. No storage host is needed in your
Content Security Policy (`docs/decisions.md` #6).

**16 October 2026** (your "What the front end needs", section A)

- A1: emails no longer stop any flow on staging; read them from `GET /v1/dev/outbox` (above). Links
  in emails open your pages (`FRONTEND_URL`).
- A2: a test school, made by `pnpm --filter @brillianda/api seed:test-school`; logins sent privately.
- A3: production gets its own secret when production exists.
- A4: `/openapi.json` is generated from the code on every deploy, so it's always current. Changes are
  also listed here and sent as a note per deploy.

**16 October 2026, B1** (invitations carry a name)

- `POST /v1/invitations` accepts an optional `fullName` (2 to 120 characters; empty means none).
- `Invitation` (create and list) and `GET /v1/invitations/lookup` return `fullName`, or `null`.
- The invitation email greets the person by first name when one was given.
- `POST /v1/invitations/accept`: a new person may leave out `fullName` when the invitation has
  one; sending it still wins, so they can correct it.

**16 October 2026, later** (staging moves to `staging.brillianda.com`)

- Staging addresses become `staging.brillianda.com` (main site), `<school>.staging.brillianda.com`
  (each school) and `api.staging.brillianda.com` (the API).
- Once switched, the API sets `ROOT_DOMAIN=staging.brillianda.com` and drops `FRONTEND_URL`, so
  email links go to `https://<school>.staging.brillianda.com/…` instead of `/s/<school>/…`.
- Your proxy sends `x-forwarded-host` = the browser's real host (`greenfield.staging.brillianda.com`
  or `staging.brillianda.com`) — the same as production, just a different root.
- `/s/<school>/` and `?school=` keep working on staging for now.

**16 October 2026, C1 + B2** (teachers and the daily register)

A third role, `teacher`. `GET /v1/me` and `GET /v1/me/schools` return `role: "teacher"`; send
teachers to their own screens. **Every other existing endpoint answers 403 to a teacher.**

| Your function | Endpoint | Who | Notes |
|---|---|---|---|
| `inviteTeacher` | `POST /v1/invitations` `{ email, fullName, role: "teacher" }` → 201 `Invitation` | owner, admin | Admins may invite teachers only. Inviting an email that has an open admin invite answers 409 to an admin. The email says "as a teacher". Lookup and accept work as for admins (`role` in the lookup is `teacher`) |
| `getTeachersPage` | `GET /v1/teachers` → `TeachersPage` | owner, admin | Active teachers by name, then open invites (`status: "invited"`, `id` = the invitation id, `invitedAt` in ms, `fullName` empty if none was given). Subject class `label` is `"Mathematics, JSS 1 Gold"`, as in your fake |
| `removeTeacher` | `DELETE /v1/teachers/{id}` → 204 | owner, admin | A user id removes the teacher (signed out at once, their classes freed, registers keep their name); an invitation id cancels the invite. 404 otherwise |
| `setFormTeacher` | `PUT /v1/arms/{armId}/form-teacher` `{ userId \| null }` → 204 | owner, admin | One per class; replaces the last. 422 `#/userId` if not a teacher here |
| `setSubjectClasses` | `PUT /v1/teachers/{id}/subject-classes` `[{ armId, subjectId }]` → 204 | owner, admin | The whole list; a class taken here leaves its last teacher. 409 if a class or subject is gone |
| `getRegister` | `GET /v1/arms/{armId}/register?date=` → `Register` | owner, admin, that class's form teacher | Default day: the latest school day. `taken.at` / `updatedAt` in ms. Students: active ones, by surname. 403 for another teacher |
| `saveRegister` | `PUT /v1/arms/{armId}/register` `{ date, marks: [{ studentId, mark, note? }] }` → `{ present, absent }` | same | 422 `#/date` with your `registerDayProblem` wording; 422 `#/marks` if not every student is marked once; 409 if a student isn't in the class any more (reload). Late counts as present |
| `getTeacherHome` | `GET /v1/me/teaching` → `TeacherHome` | anyone on the staff | |
| `getSubjectClass` | `GET /v1/arms/{armId}/subjects/{subjectId}/students` → `SubjectClass` | that subject's teacher, owner, admin | 403 for another teacher |
| `getRegistersToday` | `GET /v1/registers/today` → `RegistersToday` | owner, admin | `total` counts classes with at least one active student |

Changed:

- `GET /v1/members` lists the owner and admins only; `DELETE /v1/members/{userId}` answers 404 for a
  teacher (use `DELETE /v1/teachers/{id}`).
- `GET /v1/invitations` lists open **admin** invitations only; teacher invites are on the Teachers page.
- The setup checklist's "admins" step and Home's `admins` count ignore teachers.
- The rules in `packages/core/src/attendance.ts` are copied verbatim into the API's core
  (`termOf`, `isSchoolDay`, `registerDayProblem`, `schoolDaysSoFar`, `latestSchoolDay`,
  `attendanceSummary`). Days follow the school's saved calendar, or your `defaultTerms` until it
  is saved, as in your fake.

**Testing:** `pnpm --filter @brillianda/api seed:test-teachers -- fecheck` adds a form teacher
(form class JSS 1 Gold; Mathematics in the first two classes) and a subject-only teacher
(English in the first four) to `fecheck`. Their passwords are printed once and sent privately.

Not yet: attendance and parent access on the student page (B3) come with parents (C2).

**16 October 2026, C2 + B3** (parents)

A fourth role, `parent`. `GET /v1/me` returns `role: "parent"`; send them to My children. A
parent's account follows a guardian record, and every parent read is limited to that guardian's
children. **Every staff endpoint answers 403 to a parent** (and every parent endpoint to staff).

| Your function | Endpoint | Who | Notes |
|---|---|---|---|
| `getParentsPage` | `GET /v1/parents` → `ParentsPage` | owner, admin | Guardians with at least one student, by name |
| `inviteParent` | `POST /v1/guardians/{id}/invite` → 201 `{ access, resent }` | owner, admin | Uses the email on the record: 422 if none. 409 if they already use the app, if the email belongs to the staff, or if it has another open invitation. Inviting again sends a fresh link (`resent: true`). If the same email already uses the app for another family record, that record is linked at once (`access: "active"`, no email) |
| `inviteAllParents` | `POST /v1/parents/invite-all` → `{ invited, withoutEmail, skipped, remaining }` | owner, admin | At most 50 per call so the request stays quick: call again while `remaining > 0`. `skipped`: emails that belong to the staff or are shared with another family |
| `removeParentAccess` | `DELETE /v1/guardians/{id}/access` → 204 | owner, admin | Ends access (signed out at once) or cancels the invite. Records stay |
| `getParentHome` | `GET /v1/me/children` → `ParentHome` | parent | Active children only. `recent`: the latest ten school days this term, newest first, without notes. `results` is `null` and `pastTerms` empty until results exist (C4–C6) |
| `getStudent` | `GET /v1/students/{id}` | owner, admin | Gains `attendance` (`AttendanceSummary`, null outside a term) and `guardian.parentAccess` (`none`, `invited`, `active`) |

The invitation email says the school invited them to its parent app and greets them by first name.
`GET /v1/invitations/lookup` returns `role: "parent"` and the guardian's name as `fullName`; accept
with just `{ token, password }` (or `{ token }` for an existing account).

Changed: `GET /v1/members` and Home's `admins` count stay owner and admins only; `POST
/v1/invitations` accepts `admin` and `teacher` only (parents are invited from their guardian record).

**Testing:** `pnpm --filter @brillianda/api seed:test-parent -- fecheck` adds a parent account for
the Okafor siblings' guardian on `fecheck`. The password is printed once and sent privately.

**21 October 2026, C14** (my profile, every role)

| Your function | Endpoint | Notes |
|---|---|---|
| who am I | `GET /v1/me` | Gains `photo` (an address for `<img src>`, through your `/api` rewrite like the logo, or `null`) and `phone` (a parent's comes from their family's record; shown locked). The other endpoints that return `Me` (login, accept, handover) don't include them |
| save my name | `PATCH /v1/me` `{ fullName }` → 204 | Your `joinName`: everything before the last space is the first name. 422 `#/fullName` if either part is empty or over 60 characters |
| set my photo | `PUT /v1/me/photo` `{ photo }` → 204 | Your `photoSchema` data URL (PNG, JPEG or WebP). The API reads the bytes: at most 150 KB and 1024 px, else 422 `#/photo` |
| remove my photo | `DELETE /v1/me/photo` → 204 | |
| the photo itself | `GET /v1/me/photo?v=` | Your own only, behind the session; cached privately for a year when `v` matches |
| change my password | `POST /v1/me/password` `{ current, password }` → 204 | 422 `#/current` when it's wrong, `#/password` when it's the same or too short. Signs the person out on their other devices, in every school; this session stays |

Every role can call these, for their own account only. `DELETE /v1/me` now answers 405 with
`Allow: GET, HEAD, PATCH`.

**21 October 2026, C1** (the team console)

All on the **main site** (your apex: `x-forwarded-host` = the root domain). On a school's address
these paths answer 404. Team accounts are separate: a school account can't sign in here and a team
session can't open a school.

| Your function | Endpoint | Notes |
|---|---|---|
| `teamSignIn` | `POST /v1/team/login` `{ email, password }` → `TeamMember` | Sets `__Host-bd_team` (Path=/, SameSite=Strict, 12 hours). Copy the `set-cookie` back like the school session; your fake used `Path=/console`, which `__Host-` doesn't allow. 401 `invalid_credentials`, 429 after too many tries |
| `teamSignOut` | `POST /v1/team/logout` → 204 | Clears the cookie |
| `getTeamMember` | `GET /v1/team/me` → `TeamMember` | 401 when not signed in |
| `getConsoleOverview` | `GET /v1/team/overview` → `ConsoleOverview` | `activity`: the team's actions and sign-ups, newest first, 12 at most |
| `listConsoleSchools` | `GET /v1/team/schools` → `ConsoleSchool[]` | By name. Setup has your seven steps (Calendar … Branding) |
| `getConsoleSchool` | `GET /v1/team/schools/{subdomain}` → `ConsoleSchoolDetail` | Writes "Viewed the school’s summary from the Brillianda team console" to the school's change history, at most once an hour per person; `who` there is "Ada Okoro (Brillianda)" |
| `setSchoolStatus` | `PUT /v1/team/schools/{subdomain}/status` `{ status: "active" \| "suspended", reason }` → 204 | Reason 3 to 200 characters (422 `#/reason`). 409 if already so. The school's history gets "Paused the school’s account: <reason>"; a paused school's addresses answer 404 `school_unavailable` |
| `listTrialRequests` | `GET /v1/team/trial-requests` → `TrialRequestRow[]` | Newest first |
| `setTrialStatus` | `PATCH /v1/team/trial-requests/{id}` `{ status, note }` → 204 | Note up to 500 characters; empty clears it |

Team accounts are made with `pnpm --filter @brillianda/api team:add -- email "Full Name"` (the
password is printed once); `-- --disable email` turns one off and signs it out.

**21 October 2026, C2** (results: settings and score entry)

Totals, grades and positions use your `grading.ts` and `results.ts`, copied verbatim into the API's
core (the Zod schemas sit in `apps/api/src/lib/results-rules.ts` with the same rules and messages).
The term is your `ResultsTerm`: `"<session start year>-<term number>"`, the session's first term
not closed, once it has started.

| Your function | Endpoint | Who | Notes |
|---|---|---|---|
| `getResultsSettings` | `GET /v1/results/settings` → `ResultsSettingsData` | owner, admin | Defaults until saved |
| `saveResultsSettings` | `PUT /v1/results/settings` (`resultsSettingsSchema`) → 204 | owner, admin | 422 with your messages; 409 if parts or marks change after scores are in this term. The scale is stored highest first |
| `getResultsOverview` | `GET /v1/results` → `ResultsOverview` | owner, admin | Classes with at least one active student. `term: null` and `next` before the term starts |
| `getArmSheets` | `GET /v1/arms/{armId}/sheets` → `{ term, armLabel, sheets }` | owner, admin | 404 when no term is open |
| `getMySheets` | `GET /v1/me/sheets` → `{ term, sheets }` | staff | The teacher's subject classes |
| `getScoreSheet` | `GET /v1/arms/{armId}/subjects/{subjectId}/sheet` → `ScoreSheetData` | that subject's teacher; owner, admin | 403 for another teacher; 404 if the class doesn't take the subject or no term is open |
| `saveScore` | `PUT …/sheet/scores` `{ studentId, componentId, raw }` → `{ status }` | same | `raw` per your `parseScoreInput`; 422 `#/raw` with its message. 409 when complete (teachers), when the student is left out, or when the student or part isn't on the sheet any more |
| `setExcluded` | `PUT …/sheet/excluded` `{ studentId, excluded }` → 204 | same | Electives only (409 otherwise); clears their scores |
| `markComplete` | `POST …/sheet/complete` → 204 | same | 409 with "N students still have empty scores…" |
| `requestUnlock` | `POST …/sheet/unlock-request` `{ reason }` → 204 | same | Reason 5 to 200 (422 `#/reason`); 409 if not locked or already asked |
| `resolveUnlock` | `POST …/sheet/unlock` `{ approve }` → 204 | owner, admin | Approve reopens (with or without a request); decline needs a request (409 otherwise) |

Saving single scores isn't written to the change history (too many); completing, unlocking,
requests, leaving a student out and settings are, with your fake's sentences.

**21 October 2026, C3 + C4** (broadsheet, remarks, ratings, publishing, report cards; parents see results)

| Your function | Endpoint | Who | Notes |
|---|---|---|---|
| `getBroadsheet` | `GET /v1/arms/{armId}/broadsheet` → `Broadsheet` | owner, admin, the class's form teacher | `canPublish` false for the form teacher; positions null when the school hides them |
| `getClassReports` | `GET /v1/arms/{armId}/reports` → `ClassReports` | same | |
| `saveRemark` | `PUT /v1/arms/{armId}/students/{studentId}/remarks/{teacher\|principal}` `{ text }` → 204 | teacher remark: form teacher or admin; principal: owner, admin | Up to 300 characters (422 `#/text`); empty clears. 409 if the student left the class |
| `saveRating` | `PUT /v1/arms/{armId}/students/{studentId}/ratings` `{ trait, value }` → 204 | form teacher or admin | 1 to 5, or null to clear. 409 if ratings are off or the trait isn't on the list |
| `getRatingSettings` / `saveRatingSettings` | `GET` / `PUT /v1/results/ratings` `{ enabled, traits }` | owner, admin | Off with no traits until set (your `ratingSettingsSchema`) |
| `setPublished` | `PUT /v1/arms/{armId}/published` `{ published }` → 204 | owner, admin | 409 "2 subjects aren’t complete yet: Mathematics, French." or already so |
| `getReportCard` | `GET /v1/students/{id}/report-card?term=` → `ReportCardData` | owner, admin; the form teacher of the student's class | `term` defaults to the open one. `school.brandColor` is null when the school has none, as on `GET /v1/school` |
| `getReportTerms` | `GET /v1/students/{id}/report-terms` → `ReportTerm[]` | owner, admin | Newest first |
| parent home | `GET /v1/me/children` | parent | Each child's `results` is now `{ term, published: false }` until the class is published, then `{ term, published: true, average, position, of }`; `pastTerms` lists closed, published terms |
| `getParentReportCard` | `GET /v1/me/children/{studentId}/report-card?term=` → `ReportCardData` | parent | Their own children, published terms only; anything else 404 |

A past term's card uses the class the student had scores in then. Closing a term (C5) comes next,
which makes past terms appear.
