/**
 * Signing in on a school's own address, and getting back in.
 *
 *   POST /v1/auth/login                     email + password
 *   POST /v1/auth/handover                  the 60-second token from signup
 *   POST /v1/auth/magic-link (+ /confirm)   sign in from an emailed link
 *   POST /v1/auth/password-reset (+ /confirm)
 *   POST /v1/auth/find-school               (brillianda.com) email me links to my schools
 *   GET  /v1/me/schools                     every school this person can sign in to
 *
 * Enumeration safety: login answers the same for "no such email", "wrong password" and "not a
 * member here"; the email-sending endpoints always answer 202 and do their work after responding.
 */
import { consumeLinkToken, hashPassword, issueLinkToken, needsRehash, verifyPassword } from "@brillianda/auth";
import { auditLog, eq, listUserSchools, revokeUserSessions, schoolMembers, users, withSchool, type Tx } from "@brillianda/db";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import {
  AcceptedSchema,
  EmailSchema,
  inBackground,
  meBody,
  MeSchema,
  PasswordSchema,
  requireApex,
  startSession,
  TokenSchema,
} from "../auth-helpers.js";
import type { AppEnv } from "../context.js";
import { emails } from "../emails.js";
import { ApiError, problemContent } from "../lib/errors.js";
import { RATE_RULES } from "../lib/rate-limit.js";
import type { ResolvedSchool } from "../lib/school-directory.js";
import { schoolUrl } from "../lib/urls.js";
import { enforceRateLimit, requireSchool, schoolRoute } from "../school-route.js";

export const authRoutes = new OpenAPIHono<AppEnv>();

const json = <T extends z.ZodTypeAny>(schema: T) => ({ content: { "application/json": { schema } }, required: true });
const meResponse = { description: "Signed in; the session cookie is set", content: { "application/json": { schema: MeSchema } } };
const accepted = { description: "Accepted. The same answer whether or not the email has an account", content: { "application/json": { schema: AcceptedSchema } } };
const ip = (c: Context<AppEnv>) => c.get("clientIp") ?? "unknown";

interface ActiveMember {
  user: { id: string; email: string; fullName: string; emailVerifiedAt: Date | null; passwordHash: string | null };
  membership: { id: string; role: "owner" | "admin" };
}

/** The user, if they are active AND an active member of this school. Runs inside withSchool. */
async function activeMember(tx: Tx, userId: string): Promise<ActiveMember | null> {
  const [row] = await tx
    .select({
      user: { id: users.id, email: users.email, fullName: users.fullName, emailVerifiedAt: users.emailVerifiedAt, passwordHash: users.passwordHash, status: users.status },
      membership: { id: schoolMembers.id, role: schoolMembers.role, status: schoolMembers.status },
    })
    .from(schoolMembers)
    .innerJoin(users, eq(users.id, schoolMembers.userId))
    .where(eq(schoolMembers.userId, userId))
    .limit(1);
  if (!row || row.user.status !== "active" || row.membership.status !== "active") return null;
  return { user: row.user, membership: { id: row.membership.id, role: row.membership.role } };
}

async function userIdByEmail(c: Context<AppEnv>, email: string): Promise<{ id: string; passwordHash: string | null } | undefined> {
  const [u] = await c.get("deps").db.select({ id: users.id, passwordHash: users.passwordHash }).from(users).where(eq(users.email, email)).limit(1);
  return u;
}

/** Shared by magic link, password reset and handover: a link token only works at the school that issued it. */
async function redeemForThisSchool(
  c: Context<AppEnv>,
  school: ResolvedSchool,
  purpose: "magic_link" | "password_reset" | "handover",
  token: string,
) {
  await enforceRateLimit(c, RATE_RULES.tokenRedeemPerIp, ip(c));
  const { db, secret } = c.get("deps");
  const link = await consumeLinkToken(db, secret, purpose, token);
  if (!link || link.payload.schoolId !== school.id || !link.userId) {
    throw new ApiError("link_invalid", "This link has expired or was already used. Ask for a new one.");
  }
  return link as typeof link & { userId: string };
}

// ── Login ───────────────────────────────────────────────────────────────────

authRoutes.openapi(
  createRoute({
    method: "post",
    path: "/v1/auth/login",
    tags: ["auth"],
    summary: "Sign in with email and password on this school's address",
    request: { body: json(z.object({ email: EmailSchema, password: z.string().max(1024) }).openapi("LoginRequest")) },
    responses: {
      200: meResponse,
      401: problemContent("Email or password is incorrect (also when not a member of this school)"),
      404: problemContent("No active school here"),
      429: problemContent("Too many attempts"),
    },
  }),
  async (c) => {
    const school = await requireSchool(c);
    const { email, password } = c.req.valid("json");
    await enforceRateLimit(c, RATE_RULES.loginPerIp, ip(c));
    await enforceRateLimit(c, RATE_RULES.loginPerEmail, email);
    const { db } = c.get("deps");

    const candidate = await userIdByEmail(c, email);
    // Always run the full Argon2 check so timing does not reveal whether the email exists.
    const passwordOk = await verifyPassword(candidate?.passwordHash, password);

    const me = await withSchool(db, school.id, async (tx) => {
      const member = candidate ? await activeMember(tx, candidate.id) : null;
      if (!passwordOk || !member) {
        if (member) {
          await tx.insert(auditLog).values({
            schoolId: school.id,
            actorUserId: member.user.id,
            action: "auth.login_failed",
            entity: "user",
            entityId: member.user.id,
            ip: c.get("clientIp"),
            userAgent: c.get("userAgent"),
          });
        }
        return null;
      }
      await startSession(c, tx, school, member.user.id, "password");
      const updates: Partial<typeof users.$inferInsert> = { lastLoginAt: new Date() };
      if (needsRehash(member.user.passwordHash!)) updates.passwordHash = await hashPassword(password);
      await tx.update(users).set(updates).where(eq(users.id, member.user.id));
      return meBody(member.user, member.membership, school);
    });
    if (!me) throw new ApiError("invalid_credentials", "Check the email and password, or reset your password.");
    return c.json(me, 200);
  },
);

// ── Handover (signup → school address) ──────────────────────────────────────

authRoutes.openapi(
  createRoute({
    method: "post",
    path: "/v1/auth/handover",
    tags: ["auth", "signup"],
    summary: "Exchange the 60-second signup handover token for a session on the new school's address",
    request: { body: json(z.object({ token: TokenSchema }).openapi("HandoverRequest")) },
    responses: { 200: meResponse, 404: problemContent("No active school here"), 410: problemContent("Expired or used") },
  }),
  async (c) => {
    const school = await requireSchool(c);
    const link = await redeemForThisSchool(c, school, "handover", c.req.valid("json").token);
    const me = await withSchool(c.get("deps").db, school.id, async (tx) => {
      const member = await activeMember(tx, link.userId);
      if (!member) return null;
      await startSession(c, tx, school, member.user.id, "handover");
      return meBody(member.user, member.membership, school);
    });
    if (!me) throw new ApiError("link_invalid", "This link is no longer valid. Sign in instead.");
    return c.json(me, 200);
  },
);

// ── Magic link ──────────────────────────────────────────────────────────────

authRoutes.openapi(
  createRoute({
    method: "post",
    path: "/v1/auth/magic-link",
    tags: ["auth"],
    summary: "Email a one-time sign-in link for this school (15 minutes)",
    request: { body: json(z.object({ email: EmailSchema }).openapi("EmailRequest")) },
    responses: { 202: accepted, 404: problemContent("No active school here"), 429: problemContent("Too many requests") },
  }),
  async (c) => {
    const school = await requireSchool(c);
    const { email } = c.req.valid("json");
    await enforceRateLimit(c, RATE_RULES.emailLinkPerIp, ip(c));
    await enforceRateLimit(c, RATE_RULES.emailLinkPerEmail, `magic:${email}`);
    const { db, secret, mailer, config } = c.get("deps");
    inBackground(c, "magic link", async () => {
      const user = await userIdByEmail(c, email);
      if (!user) return;
      const member = await withSchool(db, school.id, (tx) => activeMember(tx, user.id));
      if (!member) return;
      const { token } = await issueLinkToken(db, secret, "magic_link", { identifier: email, userId: user.id, payload: { schoolId: school.id } });
      await mailer.send(emails.magicLink(email, school.name, schoolUrl(config, school.subdomain, `/auth/magic?token=${token}`)));
    });
    return c.json({ accepted: true as const }, 202);
  },
);

authRoutes.openapi(
  createRoute({
    method: "post",
    path: "/v1/auth/magic-link/confirm",
    tags: ["auth"],
    summary: "Sign in with the token from a magic link",
    request: { body: json(z.object({ token: TokenSchema }).openapi("TokenRequest")) },
    responses: { 200: meResponse, 404: problemContent("No active school here"), 410: problemContent("Expired or used") },
  }),
  async (c) => {
    const school = await requireSchool(c);
    const link = await redeemForThisSchool(c, school, "magic_link", c.req.valid("json").token);
    const me = await withSchool(c.get("deps").db, school.id, async (tx) => {
      const member = await activeMember(tx, link.userId);
      if (!member) return null;
      // Opening the emailed link proves the address.
      if (!member.user.emailVerifiedAt) {
        await tx.update(users).set({ emailVerifiedAt: new Date() }).where(eq(users.id, member.user.id));
        member.user.emailVerifiedAt = new Date();
      }
      await startSession(c, tx, school, member.user.id, "magic_link");
      await tx.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, member.user.id));
      return meBody(member.user, member.membership, school);
    });
    if (!me) throw new ApiError("link_invalid", "This link is no longer valid. Ask for a new one.");
    return c.json(me, 200);
  },
);

// ── Password reset ──────────────────────────────────────────────────────────

authRoutes.openapi(
  createRoute({
    method: "post",
    path: "/v1/auth/password-reset",
    tags: ["auth"],
    summary: "Email a password reset link for this school (30 minutes)",
    request: { body: json(z.object({ email: EmailSchema }).openapi("EmailRequest")) },
    responses: { 202: accepted, 404: problemContent("No active school here"), 429: problemContent("Too many requests") },
  }),
  async (c) => {
    const school = await requireSchool(c);
    const { email } = c.req.valid("json");
    await enforceRateLimit(c, RATE_RULES.emailLinkPerIp, ip(c));
    await enforceRateLimit(c, RATE_RULES.emailLinkPerEmail, `reset:${email}`);
    const { db, secret, mailer, config } = c.get("deps");
    inBackground(c, "password reset", async () => {
      const user = await userIdByEmail(c, email);
      if (!user) return;
      const member = await withSchool(db, school.id, (tx) => activeMember(tx, user.id));
      if (!member) return;
      const { token } = await issueLinkToken(db, secret, "password_reset", { identifier: email, userId: user.id, payload: { schoolId: school.id } });
      await mailer.send(emails.passwordReset(email, school.name, schoolUrl(config, school.subdomain, `/reset-password?token=${token}`)));
    });
    return c.json({ accepted: true as const }, 202);
  },
);

authRoutes.openapi(
  createRoute({
    method: "post",
    path: "/v1/auth/password-reset/confirm",
    tags: ["auth"],
    summary: "Set a new password with the reset token. Signs out every other device in every school",
    request: { body: json(z.object({ token: TokenSchema, password: PasswordSchema }).openapi("PasswordResetConfirm")) },
    responses: { 200: meResponse, 404: problemContent("No active school here"), 410: problemContent("Expired or used"), 422: problemContent("Password too short or long") },
  }),
  async (c) => {
    const school = await requireSchool(c);
    const { token, password } = c.req.valid("json");
    const link = await redeemForThisSchool(c, school, "password_reset", token);
    const { db, mailer } = c.get("deps");
    const passwordHash = await hashPassword(password);
    // Every existing session, in every school, ends: whoever had the old password is out.
    await revokeUserSessions(db, link.userId);
    const me = await withSchool(db, school.id, async (tx) => {
      const member = await activeMember(tx, link.userId);
      if (!member) return null;
      await tx.update(users).set({ passwordHash, lastLoginAt: new Date(), emailVerifiedAt: member.user.emailVerifiedAt ?? new Date() }).where(eq(users.id, member.user.id));
      await tx.insert(auditLog).values({
        schoolId: school.id,
        actorUserId: member.user.id,
        action: "auth.password_reset",
        entity: "user",
        entityId: member.user.id,
        ip: c.get("clientIp"),
        userAgent: c.get("userAgent"),
      });
      await startSession(c, tx, school, member.user.id, "password_reset");
      return { me: meBody(member.user, member.membership, school), email: member.user.email };
    });
    if (!me) throw new ApiError("link_invalid", "This link is no longer valid. Ask for a new one.");
    await mailer.send(emails.passwordChanged(me.email, school.name)).catch(() => {});
    return c.json(me.me, 200);
  },
);

// ── Find my school (brillianda.com) ─────────────────────────────────────────

authRoutes.openapi(
  createRoute({
    method: "post",
    path: "/v1/auth/find-school",
    tags: ["auth"],
    summary: "Email links to every school this address can sign in to (main site only)",
    request: { body: json(z.object({ email: EmailSchema }).openapi("EmailRequest")) },
    responses: { 202: accepted, 404: problemContent("Only on the main site"), 429: problemContent("Too many requests") },
  }),
  async (c) => {
    requireApex(c);
    const { email } = c.req.valid("json");
    await enforceRateLimit(c, RATE_RULES.findSchoolPerIp, ip(c));
    await enforceRateLimit(c, RATE_RULES.findSchoolPerEmail, email);
    const { db, mailer, config } = c.get("deps");
    inBackground(c, "find my school", async () => {
      const user = await userIdByEmail(c, email);
      if (!user) return;
      const list = await listUserSchools(db, user.id);
      if (!list.length) return;
      await mailer.send(emails.findMySchool(email, list.map((s) => ({ name: s.name, url: schoolUrl(config, s.subdomain) }))));
    });
    return c.json({ accepted: true as const }, 202);
  },
);

// ── My schools ──────────────────────────────────────────────────────────────

const MySchoolsSchema = z
  .object({
    data: z.array(
      z.object({
        id: z.string().uuid(),
        name: z.string(),
        subdomain: z.string(),
        role: z.enum(["owner", "admin"]),
        url: z.string().url(),
        current: z.boolean(),
      }),
    ),
  })
  .openapi("MySchools");

authRoutes.openapi(
  createRoute({
    method: "get",
    path: "/v1/me/schools",
    tags: ["auth"],
    summary: "Every active school the signed-in person belongs to (for the school switcher)",
    responses: {
      200: { description: "Schools", content: { "application/json": { schema: MySchoolsSchema } } },
      401: problemContent("Not signed in to this school"),
      404: problemContent("No active school here"),
    },
  }),
  async (c) => {
    const { config, db } = c.get("deps");
    const data = await schoolRoute(c, {}, async ({ auth, school }) => {
      const list = await listUserSchools(db, auth.user.id);
      return list.map((s) => ({
        id: s.schoolId,
        name: s.name,
        subdomain: s.subdomain,
        role: s.role,
        url: schoolUrl(config, s.subdomain),
        current: s.schoolId === school.id,
      }));
    });
    return c.json({ data }, 200);
  },
);

