# Integrating sign-up and sign-in (frontend guide)

For the Brillianda frontend (Next.js, `brillanda.vercel.app`). Everything here is live on the
**staging API**, `https://api-rouge-nine-18.vercel.app`. The full contract is
`/openapi.json` there; this guide explains how the pieces fit.

---

## 1. The model in one paragraph

Auth is **ours, cookie-based and per school**. There are no tokens for you to store. When someone
signs in on a school's address, the API sets an HttpOnly session cookie for **that address only**.
A Greenfield session means nothing at Surebloom. Your app never reads the cookie; it only carries
it between the browser and the API. Who someone is comes from `GET /v1/me`.

| Where | What happens there |
|---|---|
| **Main site** (`brillianda.com`; staging: your app's root) | Signup (4 steps), "Find my school" |
| **A school's address** (`greenfield.brillianda.com`; staging: `/s/greenfield/…`) | Sign in, magic link, password reset, invitations, everything after |

Signup happens on the main site but the school lives on its own address, and cookies can't cross
addresses. So signup ends with a **handover**: a 60-second, single-use link that creates the
session on the school's address.

---

## 2. How your app calls the API

Browsers never call the API directly. Every call goes through your server (`proxy.ts` for
`/api/*`, or your Server Actions / route handlers), which adds:

| Header | Value |
|---|---|
| `x-forwarded-host` | The school's address, e.g. `greenfield.brillianda.com`. **Staging:** `<school>.api-rouge-nine-18.vercel.app` for `/s/<school>/…` pages; `api-rouge-nine-18.vercel.app` for main-site calls (signup, find my school) |
| `x-forwarded-proto` | `https` |
| `x-forwarded-for` | The browser's IP (rate limits are per IP) |
| `x-brillianda-proxy-secret` | The shared secret (`API_PROXY_SECRET`, sent privately) |
| `origin` | On every POST/PUT/PATCH/DELETE: `https://<the same host as x-forwarded-host>`. Check the browser's real `Origin` is your own app first, then set this |
| `cookie` | The browser's cookies, passed through unchanged |
| `content-type` | `application/json` (the logo upload is the one multipart call) |

And on the way back: **copy every `set-cookie` from the API's response to the browser.** That's
how sessions start, renew (they slide) and end. If you call from a Server Action, read the
`set-cookie` headers off the API response and set them with `cookies().set(...)` with the same
attributes.

Strip all of those headers from anything the browser sends before adding your own.

**Cookies the API sets** (all HttpOnly, Secure, SameSite=Lax, Path=/):

| Cookie | Where | Lifetime |
|---|---|---|
| `__Host-bd_session` | A school's address | 30 days, extended on use; never more than 90 days |
| `__Host-bd_signup` | Main site | 7 days (the signup draft, so a closed tab resumes) |

On staging every school shares your one address, so a browser holds one session at a time:
signing in to a second school replaces the first. Real subdomains fix this.

---

## 3. Errors

Every error is a problem document (`application/problem+json`):

```json
{
  "status": 422,
  "code": "validation_failed",
  "title": "Some fields need fixing",
  "detail": "2 field(s) need fixing.",
  "errors": [{ "pointer": "#/password", "detail": "Use at least 8 characters", "code": "too_small" }],
  "requestId": "…"
}
```

Show `detail` to the person; put each `errors[].detail` under its field. The field key is the
pointer without `#/`, with `/` as `.` (`#/terms/1/startsOn` → `terms.1.startsOn`).

The codes you'll meet in auth:

| `code` | Status | What to do |
|---|---|---|
| `validation_failed` | 422 | Field messages under the fields |
| `invalid_credentials` | 401 | "Check the email and password, or reset your password." The same answer for a wrong password, an unknown email, or someone from another school, on purpose |
| `unauthenticated` | 401 | Not signed in here: go to this school's sign-in page |
| `forbidden` | 403 | Signed in, but the role can't do this |
| `verification_failed` | 400 | Wrong signup code; `detail` says how many tries are left or to send a new one |
| `link_invalid` | 410 | The emailed link expired or was used: offer to send a new one |
| `signup_incomplete` | 409 | An earlier signup step is missing; `nextStep` says which |
| `subdomain_unavailable` | 409 | Taken or reserved; `suggestions` has alternatives |
| `school_not_found` / `school_unavailable` | 404 | No school at this address, or it's paused: your not-found / paused page |
| `bot_check_failed` | 403 | Turnstile failed (not enforced on staging yet) |
| `rate_limited` | 429 | `Retry-After` header and `retryAfterSec` say when to try again |
| `service_unavailable` | 503 | Email couldn't be sent (shouldn't happen on staging any more) |

---

## 4. Signup (main site)

Four screens, one draft. The draft lives in the `__Host-bd_signup` cookie; `GET /v1/signup`
resumes it in any tab and tells you which screen to show (`step`).

| Screen | Call | Body | Success |
|---|---|---|---|
| (load) | `GET /v1/signup` | | 200 `SignupDraft`, or 404 if none (show screen 1) |
| 1. School | `POST /v1/signup/school` | `{ name, levelsOffered, state, phone, sessionStart: { month, year } }` | 200, `step: "owner"` |
| 2. Account | `POST /v1/signup/owner` | `{ fullName, email, password, turnstileToken? }` | 200, `step: "verify_email"`; the code is emailed |
| 3. Code | `POST /v1/signup/verify-email` | `{ code }` | 200, `step: "address"` |
| 3. Resend | `POST /v1/signup/resend-code` | (none) | 200; `resendAvailableInSec` drives the timer |
| 4. Address (typing) | `GET /v1/signup/subdomain-check?subdomain=&schoolName=` | | `{ available, reason, suggestions }`; debounce ~300 ms |
| 4. Address | `POST /v1/signup/complete` | `{ subdomain, existingPassword? }` | 201 `{ school, handoverUrl }` |

Then **navigate the browser to `handoverUrl`** (a full page load). On staging it is
`https://brillanda.vercel.app/s/<school>/auth/handover?token=…`.

Notes:

- `levelsOffered`: `NURSERY`, `PRIMARY`, `SECONDARY` in any case; responses are lowercase.
- `existingAccount: true` on the draft means the email already has a Brillianda account (a second
  campus). Screen 4 then asks for **that account's** password and sends it as `existingPassword`.
- `codeSentTo` is the masked email for "we sent a code to ja•••@gmail.com".
- Codes last 10 minutes, 5 tries.

### The handover page — `/s/<school>/auth/handover?token=…`

On load, call `POST /v1/auth/handover` `{ token }` on that school's address.

- 200 `Me`: the session cookie is set. Go to Home (the setup checklist).
- 410 `link_invalid`: the 60 seconds passed or it was used. Say so and link to sign in.

---

## 5. Signing in (school address)

### Who is signed in

`GET /v1/me` → 200 `Me`, or 401. Call it in the school layout (server side) to decide between the
app and the sign-in page.

```json
{
  "user": { "id": "…", "email": "ada@school.ng", "fullName": "Ada Obi", "emailVerified": true },
  "membership": { "role": "owner" },
  "school": { "id": "…", "name": "Greenfield School", "subdomain": "greenfield" }
}
```

`GET /v1/school` (no session needed) gives the name, colour and `logoUrl` for the sign-in page.

### Password

`POST /v1/auth/login` `{ email, password }` → 200 `Me` (session cookie set) or 401
`invalid_credentials`. Limits: 20 tries per IP per 5 minutes, 10 per email per 15 minutes.

### Sign out

`POST /v1/auth/logout` (no body) → 204; clears the cookie. Works even when the session is already
gone.

### Email sign-in link (magic link)

1. `POST /v1/auth/magic-link` `{ email }` → always 202 `{ accepted: true }`, whether or not the
   email belongs here (so the page reveals nothing). The link lasts 15 minutes.
2. The email links to `/s/<school>/auth/magic?token=…`. Show a **button** ("Sign in to
   Greenfield"), and only on click call `POST /v1/auth/magic-link/confirm` `{ token }` → 200 `Me`.
   The button matters: email scanners open links automatically and would use up the token.
3. 410 `link_invalid` → "This link has expired. Send a new one."

### Forgot password

1. `POST /v1/auth/password-reset` `{ email }` → always 202. The link lasts 30 minutes.
2. The email links to `/s/<school>/reset-password?token=…`. Ask for the new password, then
   `POST /v1/auth/password-reset/confirm` `{ token, password }` → 200 `Me`, signed in.
3. Every other session of that person, **in every school**, ends. Say so on the success screen.

### Find my school (main site)

`POST /v1/auth/find-school` `{ email }` → always 202. The email lists a link to each school that
email can sign in to (on staging, `https://brillanda.vercel.app/s/<school>`).

### School switcher

`GET /v1/me/schools` → `{ data: [{ id, name, subdomain, role, url, current }] }` for someone
signed in. Each `url` is that school's address; they sign in there separately.

---

## 6. Invitations (school address)

Owner side (owner only):

| Call | Body | Returns |
|---|---|---|
| `POST /v1/invitations` | `{ email }` | 201 `Invitation`; inviting the same email again resends |
| `GET /v1/invitations` | | `{ data: Invitation[] }` (open ones) |
| `DELETE /v1/invitations/{id}` | | 204 |
| `GET /v1/members` / `DELETE /v1/members/{userId}` | | Who has access / remove an admin |

Invitee side — the email links to `/s/<school>/invite?token=…`:

1. `GET /v1/invitations/lookup?token=…` → `{ email, role, school, invitedBy, existingAccount }`,
   or 410 `link_invalid`.
2. If `existingAccount` is **false**: ask for full name and a password, then
   `POST /v1/invitations/accept` `{ token, fullName, password }`.
   If **true**: just a "Join Greenfield" button, then `POST /v1/invitations/accept` `{ token }`.
3. 200 `Me`: joined and signed in. Go to Home.

Invitations last 7 days.

---

## 7. Testing on staging

- **Test school:** `fecheck`, owner and admin logins sent privately.
- **Emails:** Resend only reaches our own address until a domain is verified, so every email is
  also kept for 7 days in the **outbox**. Open in a browser (key sent privately):
  `https://api-rouge-nine-18.vercel.app/dev/outbox?key=<key>&to=<email>`. It shows codes large and
  links clickable, and refreshes every 10 seconds. JSON for scripts:
  `GET /v1/dev/outbox?to=` with header `x-brillianda-outbox-key`.
- **A full signup:** sign up with any email on your app, read the code in the outbox tab, finish,
  and the handover link lands you signed in on `/s/<school>/`.
- **Try it without your app:** `https://api-rouge-nine-18.vercel.app/docs`, or Postman with
  `Origin: https://api-rouge-nine-18.vercel.app` and paths prefixed `/s/<school>` for school calls.

---

## 8. Checklist

- [ ] Proxy strips browser-sent `x-forwarded-*`, `x-brillianda-*` and `origin`, then sets them
- [ ] `set-cookie` from the API reaches the browser on every response (including Server Actions)
- [ ] School layout calls `GET /v1/me` server side; 401 → sign-in page
- [ ] Signup screens follow `step` from the draft, and the last one navigates to `handoverUrl`
- [ ] Handover, magic-link and reset pages exist at the paths above, under `/s/<school>/`
- [ ] Magic-link page waits for a button press before confirming
- [ ] Errors: `detail` for the person, `errors[]` under fields, `Retry-After` on 429
- [ ] Nothing stores a token or password in the browser
