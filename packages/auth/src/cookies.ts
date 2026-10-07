/**
 * Session cookie policy. Framework-agnostic: the API applies it.
 *
 * In production the cookie is `__Host-` prefixed. Browsers only accept that prefix with
 * Secure, Path=/ and NO Domain attribute, so the cookie is pinned to exactly one school's host
 * (surebloom.brillianda.com) and is never sent to another school or to the apex.
 * Locally (http://surebloom.localhost) the prefix is dropped because it requires Secure.
 */
export const SESSION_COOKIE = "bd_session";

export function sessionCookieAttributes(secure: boolean, expires: Date) {
  return {
    path: "/",
    httpOnly: true,
    secure,
    sameSite: "Lax" as const,
    expires,
    ...(secure ? { prefix: "host" as const } : {}),
  };
}
