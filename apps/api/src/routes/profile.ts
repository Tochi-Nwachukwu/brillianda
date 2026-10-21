/**
 * My profile (C14), in every dashboard: anyone signed in to a school, whatever their role, changes
 * only their own name, photo and password. Email and phone stay with the school's records.
 *
 *   GET    /v1/me                 (routes/session.ts) gains photo and phone
 *   PATCH  /v1/me                 { fullName }: first and last name, each 1 to 60 characters
 *   PUT    /v1/me/photo           { photo }: a data URL (PNG, JPEG or WebP)
 *   DELETE /v1/me/photo
 *   GET    /v1/me/photo?v=        the picture, for <img src>
 *   POST   /v1/me/password        { current, password }; signs out the person's other devices
 *
 * Rules: the front end's packages/core/src/profile.ts.
 */
import { createHash } from "node:crypto";
import { hashPassword, verifyPassword } from "@brillianda/auth";
import { eq, guardians, parentLinks, revokeUserSessions, userPhotos, users, type Tx } from "@brillianda/db";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { AppEnv } from "../context.js";
import { PasswordSchema } from "../auth-helpers.js";
import { ApiError, problemContent } from "../lib/errors.js";
import { imageInfo } from "../lib/image.js";
import { RATE_RULES } from "../lib/rate-limit.js";
import { ANY_MEMBER, schoolRoute, type Role } from "../school-route.js";

export const profileRoutes = new OpenAPIHono<AppEnv>();

const MAX_PHOTO_BYTES = 150_000;
const MAX_PHOTO_PX = 1024;
const errors = {
  401: problemContent("Not signed in to this school"),
  404: problemContent("No active school here"),
} as const;
const field = (pointer: string, detail: string) => new ApiError("validation_failed", detail, { extensions: { errors: [{ pointer, detail, code: "invalid" }] } });

/** The photo's address for <img src>, through the front end's /api rewrite, versioned for caching. */
const photoUrl = (sha256: string) => `/api/v1/me/photo?v=${sha256.slice(0, 16)}`;

/**
 * What GET /v1/me adds: the photo's address and a phone. A parent's phone is the one on their
 * family's record (the school keeps it); everyone else's is on their account.
 */
export async function meExtras(tx: Tx, userId: string, role: Role): Promise<{ photo: string | null; phone: string | null }> {
  const [photo] = await tx.select({ sha256: userPhotos.sha256 }).from(userPhotos).where(eq(userPhotos.userId, userId)).limit(1);
  let phone: string | null = null;
  if (role === "parent") {
    const [g] = await tx
      .select({ phone: guardians.phone })
      .from(parentLinks)
      .innerJoin(guardians, eq(guardians.id, parentLinks.guardianId))
      .where(eq(parentLinks.userId, userId))
      .limit(1);
    phone = g?.phone ?? null;
  } else {
    const [u] = await tx.select({ phone: users.phone }).from(users).where(eq(users.id, userId)).limit(1);
    phone = u?.phone ?? null;
  }
  return { photo: photo ? photoUrl(photo.sha256) : null, phone };
}

// ——— Name ———

const NamePart = z.string().min(1).max(60);
const ProfileSchema = z
  .object({
    fullName: z
      .string()
      .transform((v) => v.trim().replace(/\s+/g, " "))
      .pipe(z.string().min(1, "Enter your first and last name").max(121, "Use at most 60 characters for each name"))
      .openapi({ description: "First and last name joined with a space (the last word is the last name)", example: "Ada Obi" }),
  })
  .superRefine((v, ctx) => {
    // The two boxes: everything before the last space is the first name, the last word the last name.
    const cut = v.fullName.lastIndexOf(" ");
    const first = cut < 0 ? v.fullName : v.fullName.slice(0, cut);
    const last = cut < 0 ? "" : v.fullName.slice(cut + 1);
    if (!NamePart.safeParse(last).success) ctx.addIssue({ code: "custom", path: ["fullName"], message: last ? "Use at most 60 characters for your last name" : "Enter your last name" });
    else if (!NamePart.safeParse(first).success) ctx.addIssue({ code: "custom", path: ["fullName"], message: "Use at most 60 characters for your first name" });
  })
  .openapi("ProfileName");

profileRoutes.openapi(
  createRoute({
    method: "patch",
    path: "/v1/me",
    tags: ["profile"],
    summary: "Save my name (every role; my own profile only)",
    request: { body: { content: { "application/json": { schema: ProfileSchema } }, required: true } },
    responses: { 204: { description: "Saved" }, 422: problemContent("Name needs fixing"), ...errors },
  }),
  async (c) => {
    const { fullName } = c.req.valid("json");
    await schoolRoute(c, { roles: ANY_MEMBER, userRateLimit: RATE_RULES.profilePerUser }, async ({ tx, auth, audit }) => {
      await tx.update(users).set({ fullName, updatedAt: new Date() }).where(eq(users.id, auth.user.id));
      if (fullName !== auth.user.fullName) audit({ action: "profile.name_changed", entity: "user", entityId: auth.user.id, changes: { from: auth.user.fullName, to: fullName } });
    });
    return c.body(null, 204);
  },
);

// ——— Photo ———

const PhotoSchema = z
  .object({
    photo: z
      .string()
      .max(200_000, "That picture is too big")
      .regex(/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/, "That isn’t a picture")
      .openapi({ description: "A data URL; the browser shrinks it to a 256×256 JPEG first" }),
  })
  .openapi("ProfilePhoto");

profileRoutes.openapi(
  createRoute({
    method: "put",
    path: "/v1/me/photo",
    tags: ["profile"],
    summary: "Set my photo",
    request: { body: { content: { "application/json": { schema: PhotoSchema } }, required: true } },
    responses: { 204: { description: "Saved" }, 422: problemContent("Not a picture, or too big"), ...errors },
  }),
  async (c) => {
    const { photo } = c.req.valid("json");
    const bytes = Buffer.from(photo.slice(photo.indexOf(",") + 1), "base64");
    const info = imageInfo(bytes);
    if (!info) throw field("#/photo", "That isn’t a picture we can use. Choose a PNG, JPEG or WebP.");
    if (bytes.length > MAX_PHOTO_BYTES) throw field("#/photo", "That picture is too big.");
    if (info.width > MAX_PHOTO_PX || info.height > MAX_PHOTO_PX) throw field("#/photo", `Use a picture at most ${MAX_PHOTO_PX} pixels across.`);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    await schoolRoute(c, { roles: ANY_MEMBER, userRateLimit: RATE_RULES.profilePerUser }, async ({ tx, auth }) => {
      await tx
        .insert(userPhotos)
        .values({ userId: auth.user.id, contentType: info.type, bytes, sha256 })
        .onConflictDoUpdate({ target: userPhotos.userId, set: { contentType: info.type, bytes, sha256, updatedAt: new Date() } });
    });
    return c.body(null, 204);
  },
);

profileRoutes.openapi(
  createRoute({
    method: "delete",
    path: "/v1/me/photo",
    tags: ["profile"],
    summary: "Remove my photo",
    responses: { 204: { description: "Removed" }, ...errors },
  }),
  async (c) => {
    await schoolRoute(c, { roles: ANY_MEMBER }, async ({ tx, auth }) => {
      await tx.delete(userPhotos).where(eq(userPhotos.userId, auth.user.id));
    });
    return c.body(null, 204);
  },
);

profileRoutes.openapi(
  createRoute({
    method: "get",
    path: "/v1/me/photo",
    tags: ["profile"],
    summary: "My photo, for <img src>. With ?v= matching the current version it is cached privately for a year",
    request: { query: z.object({ v: z.string().max(64).optional() }) },
    responses: {
      200: { description: "The image", content: { "image/png": { schema: z.string() }, "image/jpeg": { schema: z.string() }, "image/webp": { schema: z.string() } } },
      ...errors,
    },
  }),
  async (c) => {
    const { v } = c.req.valid("query");
    const photo = await schoolRoute(c, { roles: ANY_MEMBER }, async ({ tx, auth }) => {
      const [p] = await tx.select().from(userPhotos).where(eq(userPhotos.userId, auth.user.id)).limit(1);
      return p;
    });
    if (!photo) throw new ApiError("not_found", "You have no photo yet.");
    const etag = `"${photo.sha256}"`;
    const headers = {
      "content-type": photo.contentType,
      etag,
      // Private: it's this person's own picture, behind their session.
      "cache-control": v === photo.sha256.slice(0, 16) ? "private, max-age=31536000, immutable" : "private, max-age=60",
      "x-content-type-options": "nosniff",
    };
    if (c.req.header("if-none-match") === etag) return c.body(null, 304, headers);
    return c.body(new Uint8Array(photo.bytes), 200, headers);
  },
);

// ——— Password ———

const ChangePasswordSchema = z
  .object({
    current: z.string().min(1, "Enter your current password").max(1024),
    password: PasswordSchema.pipe(z.string().max(128, "Use at most 128 characters")),
  })
  .openapi("ChangePassword");

profileRoutes.openapi(
  createRoute({
    method: "post",
    path: "/v1/me/password",
    tags: ["profile"],
    summary: "Change my password. Needs the current one; signs me out on my other devices, in every school",
    request: { body: { content: { "application/json": { schema: ChangePasswordSchema } }, required: true } },
    responses: { 204: { description: "Changed" }, 422: problemContent("#/current wrong, or #/password the same as now"), 429: problemContent("Too many tries"), ...errors },
  }),
  async (c) => {
    const { current, password } = c.req.valid("json");
    const { db } = c.get("deps");
    const who = await schoolRoute(c, { roles: ANY_MEMBER, userRateLimit: RATE_RULES.passwordChangePerUser }, async ({ tx, auth, audit }) => {
      const [u] = await tx.select({ hash: users.passwordHash }).from(users).where(eq(users.id, auth.user.id)).limit(1);
      if (!(await verifyPassword(u?.hash ?? null, current))) throw field("#/current", "That isn’t your current password.");
      if (current === password) throw field("#/password", "Choose a password you haven’t used here.");
      await tx.update(users).set({ passwordHash: await hashPassword(password), updatedAt: new Date() }).where(eq(users.id, auth.user.id));
      audit({ action: "profile.password_changed", entity: "user", entityId: auth.user.id });
      return { userId: auth.user.id, sessionId: auth.session.id };
    });
    // Like a reset: every other session of this person, in every school, ends.
    await revokeUserSessions(db, who.userId, who.sessionId);
    return c.body(null, 204);
  },
);
