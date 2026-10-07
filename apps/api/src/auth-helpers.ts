import { createSession, type SessionMembership, type SessionUser } from "@brillianda/auth";
import { auditLog, type Tx } from "@brillianda/db";
import { z } from "@hono/zod-openapi";
import type { Context } from "hono";
import type { AppEnv } from "./context.js";
import { ApiError } from "./lib/errors.js";
import type { ResolvedSchool } from "./lib/school-directory.js";
import { writeSessionCookie } from "./school-route.js";

/** Signup and Find my school live on brillianda.com itself; on a school address they do not exist. */
export function requireApex(c: Context<AppEnv>): void {
  if (c.get("target").kind !== "apex") throw new ApiError("not_found", "This endpoint only exists on the main Brillianda site.");
}

export const EmailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(254)
  .email("Enter a valid email address, like name@school.com");

export const PasswordSchema = z
  .string()
  .min(8, "Use at least 8 characters")
  .max(128, "Use at most 128 characters");

export const TokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/, "This link is not valid. Open it again from the email.");

export const MeSchema = z
  .object({
    user: z.object({
      id: z.string().uuid(),
      email: z.string().email(),
      fullName: z.string(),
      emailVerified: z.boolean(),
    }),
    membership: z.object({ role: z.enum(["owner", "admin"]) }),
    school: z.object({ id: z.string().uuid(), name: z.string(), subdomain: z.string() }),
  })
  .openapi("Me");

export type Me = z.infer<typeof MeSchema>;

export function meBody(user: SessionUser, membership: SessionMembership, school: ResolvedSchool): Me {
  return {
    user: { id: user.id, email: user.email, fullName: user.fullName, emailVerified: user.emailVerifiedAt !== null },
    membership: { role: membership.role },
    school: { id: school.id, name: school.name, subdomain: school.subdomain },
  };
}

/**
 * Starts a session for a member inside an open school transaction, sets the cookie and writes the
 * audit entry. Every way of signing in (password, handover, magic link, reset, invite) ends here.
 */
export async function startSession(
  c: Context<AppEnv>,
  tx: Tx,
  school: ResolvedSchool,
  userId: string,
  method: "password" | "handover" | "magic_link" | "password_reset" | "invitation",
): Promise<void> {
  const { token, sessionId, expiresAt } = await createSession(tx, c.get("deps").secret, {
    schoolId: school.id,
    userId,
    ip: c.get("clientIp"),
    userAgent: c.get("userAgent"),
  });
  await tx.insert(auditLog).values({
    schoolId: school.id,
    actorUserId: userId,
    action: "auth.login",
    entity: "session",
    entityId: sessionId,
    changes: { method },
    ip: c.get("clientIp"),
    userAgent: c.get("userAgent"),
  });
  writeSessionCookie(c, token, expiresAt);
}

/**
 * Runs work after the response is sent. Used where doing it inline would let response timing
 * reveal whether an email has an account (find my school, password reset, magic link).
 * Errors are logged, never surfaced.
 */
export function inBackground(c: Context<AppEnv>, label: string, work: () => Promise<void>): void {
  const { logger } = c.get("deps");
  const requestId = c.get("requestId");
  setImmediate(() => {
    work().catch((err) => logger.error(`background task failed: ${label}`, { err, requestId }));
  });
}

/** The same 202 body whether or not anything was sent, so it reveals nothing. */
export const AcceptedSchema = z.object({ accepted: z.literal(true) }).openapi("Accepted");
