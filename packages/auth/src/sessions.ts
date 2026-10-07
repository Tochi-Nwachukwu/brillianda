/**
 * Database sessions, scoped to one school.
 *
 * Every function here takes a `Tx` from withSchool(): the sessions table is under row-level
 * security, so a token from school A is simply not found when presented to school B.
 * The cookie carries a random token; Postgres stores only its HMAC.
 */
import { and, eq, schoolMembers, sessions, users, type Tx } from "@brillianda/db";
import { AUTH_LIMITS } from "./config.js";
import { type AuthSecret, generateToken, looksLikeToken } from "./crypto.js";

export interface SessionUser {
  id: string;
  email: string;
  fullName: string;
  emailVerifiedAt: Date | null;
}

export interface SessionMembership {
  id: string;
  role: "owner" | "admin";
}

export interface ValidSession {
  session: { id: string; schoolId: string; userId: string; expiresAt: Date; createdAt: Date };
  /** True when this call pushed the expiry forward; the caller should re-send the cookie. */
  renewed: boolean;
  user: SessionUser;
  membership: SessionMembership;
}

export interface CreateSessionInput {
  schoolId: string;
  userId: string;
  ip?: string | null;
  userAgent?: string | null;
  now?: Date;
}

const hashSessionToken = (secret: AuthSecret, token: string) => secret.hash("session", token);

export async function createSession(
  tx: Tx,
  secret: AuthSecret,
  input: CreateSessionInput,
): Promise<{ token: string; sessionId: string; expiresAt: Date }> {
  const now = input.now ?? new Date();
  const token = generateToken();
  const absoluteExpiresAt = new Date(now.getTime() + AUTH_LIMITS.sessionAbsoluteMs);
  const expiresAt = new Date(Math.min(now.getTime() + AUTH_LIMITS.sessionIdleMs, absoluteExpiresAt.getTime()));

  const [row] = await tx
    .insert(sessions)
    .values({
      schoolId: input.schoolId,
      userId: input.userId,
      tokenHash: hashSessionToken(secret, token),
      createdAt: now,
      lastSeenAt: now,
      expiresAt,
      absoluteExpiresAt,
      ip: input.ip ?? null,
      userAgent: input.userAgent?.slice(0, 512) ?? null,
    })
    .returning({ id: sessions.id });

  return { token, sessionId: row!.id, expiresAt };
}

/**
 * Returns the session, user and membership, or null. Deletes expired sessions it finds.
 * A session is only valid while the user is active AND still an active member of this school.
 */
export async function validateSession(
  tx: Tx,
  secret: AuthSecret,
  token: string | null | undefined,
  now: Date = new Date(),
): Promise<ValidSession | null> {
  if (!looksLikeToken(token)) return null;

  const [row] = await tx
    .select({
      session: {
        id: sessions.id,
        schoolId: sessions.schoolId,
        userId: sessions.userId,
        expiresAt: sessions.expiresAt,
        absoluteExpiresAt: sessions.absoluteExpiresAt,
        createdAt: sessions.createdAt,
      },
      user: {
        id: users.id,
        email: users.email,
        fullName: users.fullName,
        emailVerifiedAt: users.emailVerifiedAt,
        status: users.status,
      },
      membership: { id: schoolMembers.id, role: schoolMembers.role, status: schoolMembers.status },
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .innerJoin(
      schoolMembers,
      and(eq(schoolMembers.schoolId, sessions.schoolId), eq(schoolMembers.userId, sessions.userId)),
    )
    .where(eq(sessions.tokenHash, hashSessionToken(secret, token)))
    .limit(1);

  if (!row) return null;

  const expired = row.session.expiresAt <= now || row.session.absoluteExpiresAt <= now;
  if (expired) {
    await tx.delete(sessions).where(eq(sessions.id, row.session.id));
    return null;
  }
  if (row.user.status !== "active" || row.membership.status !== "active") return null;

  let expiresAt = row.session.expiresAt;
  let renewed = false;
  if (expiresAt.getTime() - now.getTime() < AUTH_LIMITS.sessionRenewWhenRemainingMs) {
    expiresAt = new Date(Math.min(now.getTime() + AUTH_LIMITS.sessionIdleMs, row.session.absoluteExpiresAt.getTime()));
    await tx.update(sessions).set({ expiresAt, lastSeenAt: now }).where(eq(sessions.id, row.session.id));
    renewed = true;
  }

  return {
    session: {
      id: row.session.id,
      schoolId: row.session.schoolId,
      userId: row.session.userId,
      expiresAt,
      createdAt: row.session.createdAt,
    },
    renewed,
    user: {
      id: row.user.id,
      email: row.user.email,
      fullName: row.user.fullName,
      emailVerifiedAt: row.user.emailVerifiedAt,
    },
    membership: { id: row.membership.id, role: row.membership.role },
  };
}

export async function invalidateSession(tx: Tx, sessionId: string): Promise<void> {
  await tx.delete(sessions).where(eq(sessions.id, sessionId));
}

/** Signs the user out of this school on every device. For all schools use revokeUserSessions(). */
export async function invalidateUserSessionsInSchool(tx: Tx, userId: string): Promise<void> {
  await tx.delete(sessions).where(eq(sessions.userId, userId));
}
