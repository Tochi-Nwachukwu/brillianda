import { invalidateSession, validateSession } from "@brillianda/auth";
import { auditLog, withSchool } from "@brillianda/db";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { AppEnv } from "../context.js";
import { problemContent } from "../lib/errors.js";
import { clearSessionCookie, readSessionToken, requireSchool, schoolRoute } from "../school-route.js";

export const sessionRoutes = new OpenAPIHono<AppEnv>();

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

const errorResponses = {
  401: problemContent("Not signed in to this school"),
  404: problemContent("No active school here"),
} as const;

sessionRoutes.openapi(
  createRoute({
    method: "get",
    path: "/v1/me",
    tags: ["auth"],
    summary: "The signed-in user and their role in this school",
    responses: {
      200: { description: "Signed in", content: { "application/json": { schema: MeSchema } } },
      ...errorResponses,
    },
  }),
  async (c) => {
    const me = await schoolRoute(c, {}, async ({ auth, school }) => ({
      user: {
        id: auth.user.id,
        email: auth.user.email,
        fullName: auth.user.fullName,
        emailVerified: auth.user.emailVerifiedAt !== null,
      },
      membership: { role: auth.membership.role },
      school: { id: school.id, name: school.name, subdomain: school.subdomain },
    }));
    c.header("Cache-Control", "no-store");
    return c.json(me, 200);
  },
);

sessionRoutes.openapi(
  createRoute({
    method: "post",
    path: "/v1/auth/logout",
    tags: ["auth"],
    summary: "Sign out of this school on this device",
    description: "Always clears the cookie and returns 204, whether or not the session was still valid.",
    responses: { 204: { description: "Signed out" }, 404: errorResponses[404] },
  }),
  async (c) => {
    const school = await requireSchool(c);
    const token = readSessionToken(c);
    if (token) {
      const { db, secret } = c.get("deps");
      await withSchool(db, school.id, async (tx) => {
        const auth = await validateSession(tx, secret, token);
        if (!auth) return;
        await invalidateSession(tx, auth.session.id);
        await tx.insert(auditLog).values({
          schoolId: school.id,
          actorUserId: auth.user.id,
          action: "auth.logout",
          entity: "session",
          entityId: auth.session.id,
          ip: c.get("clientIp"),
          userAgent: c.get("userAgent"),
        });
      });
    }
    clearSessionCookie(c);
    return c.body(null, 204);
  },
);
