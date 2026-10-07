/**
 * schoolRoute(): the single path every school-scoped handler goes through.
 *
 *   1. school   resolved from the host (never from input); unknown/suspended → 404
 *   2. limit    per-IP rate limit (and optionally per-user, once known)
 *   3. tx       withSchool(): one transaction, app.school_id set transaction-locally
 *   4. session  cookie → session under RLS; must belong to THIS school → else 401
 *   5. role     membership role checked → else 403
 *   6. run      the handler, with the transaction
 *   7. audit    queued audit entries written in the same transaction (rolled back with it)
 *
 * Input validation happens before this, in the route's Zod schema.
 * The brillianda-actions skill documents how to write a handler with it.
 */
import { SESSION_COOKIE, sessionCookieAttributes, validateSession, type ValidSession } from "@brillianda/auth";
import { auditLog, withSchool, type Tx } from "@brillianda/db";
import type { Context } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import type { AppEnv } from "./context.js";
import { errors } from "./lib/errors.js";
import { RATE_RULES, type RateRule } from "./lib/rate-limit.js";
import type { ResolvedSchool } from "./lib/school-directory.js";

export type Role = "owner" | "admin";

export interface AuditEntry {
  action: string;
  entity: string;
  entityId?: string | null;
  changes?: Record<string, unknown>;
}

export interface SchoolContext {
  tx: Tx;
  school: ResolvedSchool;
  auth: ValidSession;
  /** Queue an audit entry; it is written in this transaction after the handler succeeds. */
  audit(entry: AuditEntry): void;
}

export interface SchoolRouteOptions {
  roles?: readonly Role[];
  /** Extra rule keyed by the signed-in user (e.g. for expensive actions). */
  userRateLimit?: RateRule;
}

/** Resolves the school for this request's host, or throws the right 404. */
export async function requireSchool(c: Context<AppEnv>): Promise<ResolvedSchool> {
  const target = c.get("target");
  if (target.kind !== "school") throw errors.schoolNotFound();
  const school = await c.get("deps").schools.bySubdomain(target.subdomain);
  if (!school) throw errors.schoolNotFound();
  if (school.status !== "active") throw errors.schoolUnavailable();
  return school;
}

/**
 * Applies a rate-limit rule and reports it with the IETF RateLimit headers
 * (draft-ietf-httpapi-ratelimit-headers-11): RateLimit-Policy describes the quota,
 * RateLimit what is left. Several rules on one request each add an entry to both lists.
 */
export async function enforceRateLimit(c: Context<AppEnv>, rule: RateRule, key: string): Promise<void> {
  const result = await c.get("deps").rateLimiter.limit(rule, key);
  const resetSec = Math.max(1, Math.ceil((result.resetAt - Date.now()) / 1000));
  c.header("RateLimit-Policy", `"${rule.name}";q=${rule.limit};w=${rule.windowSec}`, { append: true });
  c.header("RateLimit", `"${rule.name}";r=${result.remaining};t=${resetSec}`, { append: true });
  if (!result.success) throw errors.rateLimited(resetSec);
}

export function readSessionToken(c: Context<AppEnv>): string | undefined {
  const { secureCookies } = c.get("deps").config;
  return secureCookies ? getCookie(c, SESSION_COOKIE, "host") : getCookie(c, SESSION_COOKIE);
}

export function writeSessionCookie(c: Context<AppEnv>, token: string, expires: Date): void {
  const { secureCookies } = c.get("deps").config;
  setCookie(c, SESSION_COOKIE, token, sessionCookieAttributes(secureCookies, expires));
}

export function clearSessionCookie(c: Context<AppEnv>): void {
  writeSessionCookie(c, "", new Date(0));
}

export async function schoolRoute<T>(
  c: Context<AppEnv>,
  options: SchoolRouteOptions,
  run: (ctx: SchoolContext) => Promise<T>,
): Promise<T> {
  const deps = c.get("deps");
  const school = await requireSchool(c);
  await enforceRateLimit(c, RATE_RULES.apiPerIp, c.get("clientIp") ?? "unknown");

  const token = readSessionToken(c);
  if (!token) throw errors.unauthenticated();

  const { result, auth } = await withSchool(deps.db, school.id, async (tx) => {
    const auth = await validateSession(tx, deps.secret, token);
    if (!auth) throw errors.unauthenticated();

    const roles = options.roles ?? ["owner", "admin"];
    if (!roles.includes(auth.membership.role)) throw errors.forbidden();
    if (options.userRateLimit) await enforceRateLimit(c, options.userRateLimit, auth.user.id);

    const queued: AuditEntry[] = [];
    const result = await run({ tx, school, auth, audit: (e) => queued.push(e) });

    if (queued.length) {
      await tx.insert(auditLog).values(
        queued.map((e) => ({
          schoolId: school.id,
          actorUserId: auth.user.id,
          action: e.action,
          entity: e.entity,
          entityId: e.entityId ?? null,
          changes: e.changes ?? {},
          ip: c.get("clientIp"),
          userAgent: c.get("userAgent"),
        })),
      );
    }
    return { result, auth };
  });

  if (auth.renewed) writeSessionCookie(c, token, auth.session.expiresAt);
  return result;
}
