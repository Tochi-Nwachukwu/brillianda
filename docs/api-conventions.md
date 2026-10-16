# API conventions

Every Brillianda endpoint follows these rules, so the frontend can handle any response the same
way. Errors are [RFC 9457](https://www.rfc-editor.org/rfc/rfc9457) problem details; rate limits use
the IETF [RateLimit headers draft](https://datatracker.ietf.org/doc/draft-ietf-httpapi-ratelimit-headers/)
(-11). The machine-readable contract is `openapi.json` at the repo root. Tests in
`apps/api/test/conventions.test.ts` enforce this page, and fail if an error code is missing from it.

## Requests

| Rule | Detail |
|---|---|
| Base path | `/v1/...`, reached through the frontend's `/api/*` rewrite on the school's own address |
| School | Always from the host. Never send a school id; it is ignored |
| Body | JSON only, `Content-Type: application/json`, at most 256 KB. Anything else → `415` / `413` |
| Origin | Every non-GET request needs an `Origin` (or `Referer`) matching the school's address → else `403 csrf_rejected` |
| Auth | The `__Host-bd_session` cookie (`bd_session` locally), set by the API, HttpOnly |
| Request id | Optional `X-Request-Id` (8–64 of `A-Za-z0-9-`) is kept and echoed, so logs line up across services |

## Successful responses

| Status | When | Body |
|---|---|---|
| `200 OK` | Read or update | The resource itself, no wrapper: `{ "id": "...", "name": "..." }` |
| `201 Created` | Create | The created resource, plus a `Location` header with its URL |
| `204 No Content` | Delete, logout, actions with nothing to return | Empty |

Lists use cursor pagination, never page numbers (stable while rows are added, fast at any depth):

```json
{ "data": [ { "id": "..." } ], "nextCursor": "eyJpZCI6Ij..." }
```

`?limit=` defaults to 50, max 200. `nextCursor` is `null` on the last page. Pass it back as `?cursor=`.

### Field formats

| Kind | Format | Example |
|---|---|---|
| Keys | camelCase | `firstName`, `admissionNumber` |
| Ids | UUIDv7 strings (sort by creation time) | `"01a117b4-b7be-7cf9-9a16-f011d64be40a"` |
| Timestamps | ISO 8601, UTC, milliseconds | `"2026-10-07T19:00:00.000Z"` |
| Calendar dates | `YYYY-MM-DD`, no time zone | `"2014-03-14"` (date of birth) |
| Phone numbers | E.164 | `"+2348030000001"` |
| Enums | lowercase snake_case strings | `"active"`, `"senior_secondary"` |
| Money (later) | integer minor units + currency | `{ "amount": 1500000, "currency": "NGN" }` = ₦15,000 |
| Empty values | `null`, field always present | `"logoUrl": null` |

Fields are never omitted to mean "empty", and booleans are never strings.

## Errors

Every error is `application/problem+json`:

```json
{
  "type": "https://brillianda.com/problems/validation-failed",
  "title": "Some fields need fixing",
  "status": 422,
  "detail": "2 field(s) need fixing.",
  "instance": "/v1/students",
  "code": "validation_failed",
  "requestId": "7a3996b7-b7f2-475a-a08e-3942291b6761",
  "errors": [
    { "pointer": "#/firstName", "detail": "Too small: expected string to have >=1 characters", "code": "too_small" },
    { "pointer": "#/guardian/phone", "detail": "Enter a Nigerian number, e.g. 0803 000 0001", "code": "invalid_format" }
  ]
}
```

- **Switch on `code`**, never on `title` or `detail`. `status` always equals the HTTP status.
- `detail` is written for people and may change wording; show it, don't parse it.
- `errors[].pointer` is a JSON Pointer into the request body (`#/guardian/phone`); query and path
  problems use `errors[].parameter` instead. Map them straight onto form fields.
- Always show or log `requestId` with an error; it finds the server log line.
- **Schemas carry human messages.** Any format rule (regex, enum, custom check) passes a message a
  school admin understands: `z.string().regex(PHONE, "Enter a Nigerian number, e.g. 0803 000 0001")`.
  Zod's default for a regex would show the raw pattern.

### Error codes

| Code | Status | When | What the frontend should do |
|---|---|---|---|
| `bad_request` | 400 | Malformed JSON or a request the API cannot read | Treat as a bug; log with requestId |
| `verification_failed` | 400 | Email code wrong, expired or out of attempts; `reason` is `invalid`, `expired` or `too_many_attempts` | Show `detail`; for expired/too_many_attempts offer "Send a new code" |
| `unauthenticated` | 401 | No valid session for this school | Go to this school's login page |
| `invalid_credentials` | 401 | Login failed. Same answer for unknown email, wrong password or not a member here | "Email or password is incorrect" + reset link; never guess which |
| `forbidden` | 403 | Signed in, but the role does not allow it (e.g. admin doing an owner action) | Hide the action; show "ask the owner" |
| `csrf_rejected` | 403 | Non-GET request without a matching Origin | Bug in the caller; never shown to users |
| `bot_check_failed` | 403 | Turnstile check failed at signup | Reset the widget and let them try again |
| `not_found` | 404 | No such endpoint or record (or not visible to this school) | Show not found |
| `school_not_found` | 404 | No school at this address | Show the "no school here" page with a link to brillianda.com |
| `school_unavailable` | 404 | School exists but is suspended or archived | Show the "school unavailable" page |
| `method_not_allowed` | 405 | Known path, wrong method; `Allow` header and `allow` list say which work | Bug in the caller |
| `conflict` | 409 | Clashes with current state (already a member, signup already finished) | Show `detail` |
| `subdomain_unavailable` | 409 | Chosen address taken, reserved or invalid; `reason` + `suggestions` | Show the reason and the suggestions as tap-to-pick chips |
| `signup_incomplete` | 409 | A signup step was skipped; `nextStep` names it | Go to that step |
| `link_invalid` | 410 | Emailed link or token expired, used, revoked, or from another school | "This link has expired" + a way to ask for a new one |
| `payload_too_large` | 413 | Body over 256 KB | Split the request or upload as a file |
| `unsupported_media_type` | 415 | Body not sent as JSON | Bug in the caller |
| `validation_failed` | 422 | Input failed validation; `errors[]` lists each field | Show each message on its field |
| `rate_limited` | 429 | Too many requests; `Retry-After` and `retryAfterSec` say how long | Disable the button and count down |
| `internal` | 500 | Unexpected server error (details are logged, never returned) | "Something went wrong" + requestId; retry later |
| `service_unavailable` | 503 | Database or dependency down; `/ready` reports it | Retry with backoff |

Codes are permanent: a code is never renamed or reused. New situations get new codes.

## Response headers

| Header | On | Meaning |
|---|---|---|
| `X-Request-Id` | Every response | Correlates with server logs; same as `requestId` in errors |
| `Server-Timing: app;dur=2.8` | Every response | Milliseconds the API spent, excluding the network |
| `RateLimit-Policy: "api:ip";q=300;w=60` | Rate-limited routes | The quota: q requests per w seconds |
| `RateLimit: "api:ip";r=297;t=41` | Rate-limited routes | r requests left, window resets in t seconds |
| `Retry-After: 41` | `429` | Seconds to wait |
| `Allow: GET, HEAD` | `405` | Methods this path supports |
| `Cache-Control: no-store` | Default | Nothing is cached unless a route says so (`/v1/school`: `public, max-age=60`) |
| `Set-Cookie: __Host-bd_session=...` | Login, renewal, logout | HttpOnly, Secure, SameSite=Lax, no Domain |
| `Content-Security-Policy`, `Strict-Transport-Security`, `X-Frame-Options`, `Referrer-Policy` | Every response | Security baseline |

Several rate rules on one request add entries to the same `RateLimit` / `RateLimit-Policy` list.

## Compatibility

- **Additive changes ship any time:** new endpoints, new optional request fields, new response fields,
  new error codes. Clients must ignore fields they do not know.
- **Breaking changes go to `/v2`:** removing or renaming a field, changing a type or meaning,
  making an optional field required. `/v1` keeps working until every client has moved.
- Deprecated endpoints announce it with `Deprecation` and `Sunset` headers (RFC 9745, RFC 8594) at least
  one school term before removal.
- **Planned:** `Idempotency-Key` on create endpoints where a retry must not double-create (signup,
  imports, payments).

## Performance budget

The API does as little as possible per request: one database transaction, no compression
(the edge compresses what reaches browsers), no response envelopes, small bodies.

| Measure | Budget | Measured Oct 7, 2026 (2 vCPU, Postgres on the same box) |
|---|---|---|
| Endpoint without the database | p95 under 10 ms | `/health` p50 1.4 ms |
| School read with session (one RLS transaction) | p95 under 50 ms server time | `/v1/me` p50 2.8 ms, p95 4.9 ms (one at a time) |
| List endpoints | p95 under 150 ms, at most 3 queries, always paginated | — |
| Writes | p95 under 300 ms (Argon2 logins excepted: ~50 ms by design) | — |
| Typical response size | under 2 KB | `/v1/me` 254 bytes |

`pnpm --filter @brillianda/api bench` reproduces the measurements. In production, watch
`Server-Timing` in the browser and the p95 per route in logs. The measured numbers exclude network
time: Vercel (London) to Neon (London) adds about 1 ms per database round trip, and `/v1/me`
makes four (begin, set school, read, commit). Folding the first two into one is the next
optimisation if p95 needs it.
