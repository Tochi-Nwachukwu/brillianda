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
