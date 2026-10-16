/**
 * The people who run a school, on its own address.
 *
 *   GET    /v1/members              owner and admins: the owner and admins (teachers: GET /v1/teachers)
 *   DELETE /v1/members/{userId}     owner only: remove an admin; their sessions here end at once
 *
 * Open invitations are separate (GET /v1/invitations). Removing someone only removes them from
 * this school; their Brillianda account and any other schools are untouched.
 */
import { and, asc, eq, inArray, schoolMembers, sql, users } from "@brillianda/db";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { AppEnv } from "../context.js";
import { ApiError, problemContent } from "../lib/errors.js";
import { schoolRoute } from "../school-route.js";

export const memberRoutes = new OpenAPIHono<AppEnv>();

const MemberSchema = z
  .object({
    userId: z.string().uuid(),
    fullName: z.string(),
    email: z.string().email(),
    role: z.enum(["owner", "admin"]),
    joinedAt: z.string().openapi({ description: "When they gained access to this school (ISO 8601)" }),
  })
  .openapi("Member");

const errors = {
  401: problemContent("Not signed in to this school"),
  404: problemContent("No active school here"),
} as const;

memberRoutes.openapi(
  createRoute({
    method: "get",
    path: "/v1/members",
    tags: ["members"],
    summary: "Everyone who helps run this school: the owner first, then admins by when they joined",
    responses: {
      200: { description: "Members", content: { "application/json": { schema: z.object({ data: z.array(MemberSchema) }) } } },
      ...errors,
    },
  }),
  async (c) => {
    const data = await schoolRoute(c, { roles: ["owner", "admin"] }, async ({ tx }) => {
      const rows = await tx
        .select({
          userId: schoolMembers.userId,
          fullName: users.fullName,
          email: users.email,
          role: schoolMembers.role,
          joinedAt: schoolMembers.createdAt,
        })
        .from(schoolMembers)
        .innerJoin(users, eq(users.id, schoolMembers.userId))
        .where(and(eq(schoolMembers.status, "active"), inArray(schoolMembers.role, ["owner", "admin"])))
        .orderBy(sql`${schoolMembers.role} = 'owner' desc`, asc(schoolMembers.createdAt))
        .limit(500);
      return rows.map((r) => ({ ...r, role: r.role as "owner" | "admin", joinedAt: r.joinedAt.toISOString() }));
    });
    return c.json({ data }, 200);
  },
);

memberRoutes.openapi(
  createRoute({
    method: "delete",
    path: "/v1/members/{userId}",
    tags: ["members"],
    summary: "Remove an admin from this school (owner only). Their sessions here end immediately",
    request: { params: z.object({ userId: z.string().uuid("Invalid user id") }) },
    responses: {
      204: { description: "Removed" },
      403: problemContent("Only the owner can remove admins, and the owner can't be removed"),
      ...errors,
    },
  }),
  async (c) => {
    const { userId } = c.req.valid("param");
    await schoolRoute(c, { roles: ["owner"] }, async ({ tx, audit }) => {
      const [member] = await tx
        .select({ role: schoolMembers.role, email: users.email, fullName: users.fullName })
        .from(schoolMembers)
        .innerJoin(users, eq(users.id, schoolMembers.userId))
        .where(eq(schoolMembers.userId, userId))
        .limit(1);
      if (!member || (member.role !== "owner" && member.role !== "admin")) {
        throw new ApiError("not_found", "That person isn't an admin of this school. Teachers and parents are removed from their own pages.");
      }
      if (member.role === "owner") throw new ApiError("forbidden", "The owner can't be removed. Transfer ownership first.");

      // Their sessions at this school go with the membership (sessions_membership_fk cascades).
      await tx.delete(schoolMembers).where(eq(schoolMembers.userId, userId));
      audit({ action: "member.removed", entity: "user", entityId: userId, changes: { email: member.email, fullName: member.fullName, role: member.role }, summary: `Removed ${member.fullName} as an admin` });
    });
    return c.body(null, 204);
  },
);
