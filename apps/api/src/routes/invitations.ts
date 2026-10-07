/**
 * Admin invitations (owner only), on the school's own address.
 *
 *   POST   /v1/invitations           invite an email as admin (replaces an open invite for it)
 *   GET    /v1/invitations           open invitations
 *   DELETE /v1/invitations/{id}      revoke
 *   GET    /v1/invitations/lookup    (no session) what does this link invite me to?
 *   POST   /v1/invitations/accept    (no session) accept: creates or links the account, signs in
 *
 * Tokens are looked up inside withSchool, so a link only works at the school that sent it.
 */
import { generateToken, hashPassword } from "@brillianda/auth";
import { and, auditLog, desc, eq, gt, invitations, isNull, schoolMembers, users, withSchool, type Tx } from "@brillianda/db";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import { EmailSchema, meBody, MeSchema, PasswordSchema, startSession, TokenSchema } from "../auth-helpers.js";
import type { AppEnv } from "../context.js";
import { emails } from "../emails.js";
import { ApiError, problemContent } from "../lib/errors.js";
import { RATE_RULES } from "../lib/rate-limit.js";
import { schoolUrl } from "../lib/urls.js";
import { enforceRateLimit, requireSchool, schoolRoute } from "../school-route.js";

export const invitationRoutes = new OpenAPIHono<AppEnv>();

const INVITE_TTL_MS = 7 * 86_400_000;
const json = <T extends z.ZodTypeAny>(schema: T) => ({ content: { "application/json": { schema } }, required: true });
const inviteHash = (c: Context<AppEnv>, token: string) => c.get("deps").secret.hash("invite", token);

const InvitationSchema = z
  .object({
    id: z.string().uuid(),
    email: z.string().email(),
    role: z.enum(["owner", "admin"]),
    invitedBy: z.string().nullable().openapi({ description: "Inviter's name" }),
    createdAt: z.string(),
    expiresAt: z.string(),
  })
  .openapi("Invitation");

const ownerErrors = {
  401: problemContent("Not signed in to this school"),
  403: problemContent("Only the owner can manage invitations"),
  404: problemContent("No active school here"),
} as const;

const openInvite = (now = new Date()) =>
  and(isNull(invitations.acceptedAt), isNull(invitations.revokedAt), gt(invitations.expiresAt, now));

async function findOpenByToken(tx: Tx, c: Context<AppEnv>, token: string) {
  const [row] = await tx
    .select({
      id: invitations.id,
      email: invitations.email,
      role: invitations.role,
      inviterName: users.fullName,
    })
    .from(invitations)
    .leftJoin(users, eq(users.id, invitations.invitedBy))
    .where(and(eq(invitations.tokenHash, inviteHash(c, token)), openInvite()))
    .limit(1);
  return row;
}

invitationRoutes.openapi(
  createRoute({
    method: "post",
    path: "/v1/invitations",
    tags: ["invitations"],
    summary: "Invite someone to help run this school as an admin (owner only)",
    request: { body: json(z.object({ email: EmailSchema, role: z.literal("admin").default("admin") }).openapi("InviteRequest")) },
    responses: {
      201: { description: "Invitation sent", content: { "application/json": { schema: InvitationSchema } } },
      409: problemContent("Already a member"),
      ...ownerErrors,
    },
  }),
  async (c) => {
    const { email, role } = c.req.valid("json");
    const { mailer, config } = c.get("deps");
    const token = generateToken();
    const result = await schoolRoute(c, { roles: ["owner"], userRateLimit: RATE_RULES.invitePerUser }, async ({ tx, school, auth, audit }) => {
      const [member] = await tx
        .select({ id: schoolMembers.id })
        .from(schoolMembers)
        .innerJoin(users, eq(users.id, schoolMembers.userId))
        .where(eq(users.email, email))
        .limit(1);
      if (member) throw new ApiError("conflict", `${email} is already a member of ${school.name}.`);

      // One open invitation per email: a re-invite replaces the old link.
      await tx
        .update(invitations)
        .set({ revokedAt: new Date(), updatedBy: auth.user.id })
        .where(and(eq(invitations.email, email), isNull(invitations.acceptedAt), isNull(invitations.revokedAt)));
      const [inv] = await tx
        .insert(invitations)
        .values({
          schoolId: school.id,
          email,
          role,
          tokenHash: inviteHash(c, token),
          invitedBy: auth.user.id,
          expiresAt: new Date(Date.now() + INVITE_TTL_MS),
          createdBy: auth.user.id,
          updatedBy: auth.user.id,
        })
        .returning();
      audit({ action: "invitation.created", entity: "invitation", entityId: inv!.id, changes: { email, role } });
      return { inv: inv!, school, inviter: auth.user.fullName };
    });
    await mailer.send(
      emails.invitation(email, result.school.name, result.inviter, role, schoolUrl(config, result.school.subdomain, `/invite?token=${token}`)),
    );
    return c.json(
      {
        id: result.inv.id,
        email: result.inv.email,
        role: result.inv.role,
        invitedBy: result.inviter,
        createdAt: result.inv.createdAt.toISOString(),
        expiresAt: result.inv.expiresAt.toISOString(),
      },
      201,
    );
  },
);

invitationRoutes.openapi(
  createRoute({
    method: "get",
    path: "/v1/invitations",
    tags: ["invitations"],
    summary: "Open invitations (owner only)",
    responses: {
      200: { description: "Open invitations, newest first", content: { "application/json": { schema: z.object({ data: z.array(InvitationSchema) }) } } },
      ...ownerErrors,
    },
  }),
  async (c) => {
    const data = await schoolRoute(c, { roles: ["owner"] }, async ({ tx }) => {
      const rows = await tx
        .select({ inv: invitations, inviter: users.fullName })
        .from(invitations)
        .leftJoin(users, eq(users.id, invitations.invitedBy))
        .where(openInvite())
        .orderBy(desc(invitations.createdAt))
        .limit(200);
      return rows.map(({ inv, inviter }) => ({
        id: inv.id,
        email: inv.email,
        role: inv.role,
        invitedBy: inviter,
        createdAt: inv.createdAt.toISOString(),
        expiresAt: inv.expiresAt.toISOString(),
      }));
    });
    return c.json({ data }, 200);
  },
);

invitationRoutes.openapi(
  createRoute({
    method: "delete",
    path: "/v1/invitations/{id}",
    tags: ["invitations"],
    summary: "Revoke an open invitation (owner only); its link stops working",
    request: { params: z.object({ id: z.string().uuid("Invalid invitation id") }) },
    responses: { 204: { description: "Revoked" }, ...ownerErrors },
  }),
  async (c) => {
    const { id } = c.req.valid("param");
    await schoolRoute(c, { roles: ["owner"] }, async ({ tx, auth, audit }) => {
      const [inv] = await tx
        .update(invitations)
        .set({ revokedAt: new Date(), updatedBy: auth.user.id })
        .where(and(eq(invitations.id, id), openInvite()))
        .returning({ id: invitations.id, email: invitations.email });
      if (!inv) throw new ApiError("not_found", "No open invitation with that id.");
      audit({ action: "invitation.revoked", entity: "invitation", entityId: inv.id, changes: { email: inv.email } });
    });
    return c.body(null, 204);
  },
);

const LookupSchema = z
  .object({
    email: z.string().email(),
    role: z.enum(["owner", "admin"]),
    school: z.object({ name: z.string(), subdomain: z.string() }),
    invitedBy: z.string().nullable(),
    existingAccount: z.boolean().openapi({ description: "true: just accept. false: also send fullName and password" }),
  })
  .openapi("InvitationLookup");

invitationRoutes.openapi(
  createRoute({
    method: "get",
    path: "/v1/invitations/lookup",
    tags: ["invitations"],
    summary: "What an invitation link is for, so the accept page can ask for the right things",
    request: { query: z.object({ token: TokenSchema }) },
    responses: {
      200: { description: "Open invitation", content: { "application/json": { schema: LookupSchema } } },
      404: problemContent("No active school here"),
      410: problemContent("Expired, used or revoked"),
    },
  }),
  async (c) => {
    const school = await requireSchool(c);
    await enforceRateLimit(c, RATE_RULES.tokenRedeemPerIp, c.get("clientIp") ?? "unknown");
    const { token } = c.req.valid("query");
    const { db } = c.get("deps");
    const inv = await withSchool(db, school.id, (tx) => findOpenByToken(tx, c, token));
    if (!inv) throw new ApiError("link_invalid", "This invitation has expired, was revoked, or was already used. Ask the owner for a new one.");
    const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, inv.email)).limit(1);
    return c.json(
      { email: inv.email, role: inv.role, school: { name: school.name, subdomain: school.subdomain }, invitedBy: inv.inviterName, existingAccount: !!existing },
      200,
    );
  },
);

invitationRoutes.openapi(
  createRoute({
    method: "post",
    path: "/v1/invitations/accept",
    tags: ["invitations"],
    summary: "Accept an invitation and sign in. New people also send their name and a password",
    request: {
      body: json(
        z
          .object({ token: TokenSchema, fullName: z.string().trim().min(2, "Enter your full name").max(120).optional(), password: PasswordSchema.optional() })
          .openapi("AcceptInvitation"),
      ),
    },
    responses: {
      200: { description: "Joined and signed in", content: { "application/json": { schema: MeSchema } } },
      404: problemContent("No active school here"),
      410: problemContent("Expired, used or revoked"),
      422: problemContent("New account needs fullName and password"),
    },
  }),
  async (c) => {
    const school = await requireSchool(c);
    await enforceRateLimit(c, RATE_RULES.tokenRedeemPerIp, c.get("clientIp") ?? "unknown");
    const { token, fullName, password } = c.req.valid("json");
    const { db } = c.get("deps");
    const passwordHash = password ? await hashPassword(password) : undefined;

    const me = await withSchool(db, school.id, async (tx) => {
      const inv = await findOpenByToken(tx, c, token);
      if (!inv) throw new ApiError("link_invalid", "This invitation has expired, was revoked, or was already used. Ask the owner for a new one.");

      let [user] = await tx
        .select({ id: users.id, email: users.email, fullName: users.fullName, emailVerifiedAt: users.emailVerifiedAt, status: users.status })
        .from(users)
        .where(eq(users.email, inv.email))
        .limit(1);
      if (user && user.status !== "active") throw new ApiError("forbidden", "This account is disabled.");
      if (!user) {
        const missing = [
          ...(fullName ? [] : [{ pointer: "#/fullName", detail: "Enter your full name", code: "required" }]),
          ...(passwordHash ? [] : [{ pointer: "#/password", detail: "Choose a password of at least 8 characters", code: "required" }]),
        ];
        if (missing.length) throw new ApiError("validation_failed", "New accounts need a name and a password.", { extensions: { errors: missing } });
        [user] = await tx
          .insert(users)
          .values({ email: inv.email, fullName: fullName!, passwordHash: passwordHash!, emailVerifiedAt: new Date() })
          .returning({ id: users.id, email: users.email, fullName: users.fullName, emailVerifiedAt: users.emailVerifiedAt, status: users.status });
      } else if (!user.emailVerifiedAt) {
        await tx.update(users).set({ emailVerifiedAt: new Date() }).where(eq(users.id, user.id));
        user.emailVerifiedAt = new Date();
      }

      const [member] = await tx
        .insert(schoolMembers)
        .values({ schoolId: school.id, userId: user!.id, role: inv.role, createdBy: user!.id, updatedBy: user!.id })
        .onConflictDoNothing({ target: [schoolMembers.schoolId, schoolMembers.userId] })
        .returning({ id: schoolMembers.id, role: schoolMembers.role });
      const membership =
        member ??
        (await tx.select({ id: schoolMembers.id, role: schoolMembers.role }).from(schoolMembers).where(eq(schoolMembers.userId, user!.id)).limit(1))[0]!;

      const accepted = await tx
        .update(invitations)
        .set({ acceptedAt: new Date(), acceptedUserId: user!.id, updatedBy: user!.id })
        .where(and(eq(invitations.id, inv.id), isNull(invitations.acceptedAt), isNull(invitations.revokedAt)))
        .returning({ id: invitations.id });
      if (!accepted.length) throw new ApiError("link_invalid", "This invitation was just used or revoked.");

      await tx.insert(auditLog).values({
        schoolId: school.id,
        actorUserId: user!.id,
        action: "member.joined",
        entity: "school_member",
        entityId: membership.id,
        changes: { email: inv.email, role: membership.role, invitationId: inv.id },
        ip: c.get("clientIp"),
        userAgent: c.get("userAgent"),
      });
      await startSession(c, tx, school, user!.id, "invitation");
      return meBody({ id: user!.id, email: user!.email, fullName: user!.fullName, emailVerifiedAt: user!.emailVerifiedAt }, membership, school);
    });
    return c.json(me, 200);
  },
);
