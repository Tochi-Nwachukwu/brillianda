/**
 * A school's name, colour and logo (plan: "School branding"), on its own address. Changes are
 * owner only; the logo itself is public, because the sign-in page shows it. Follows the frontend's
 * src/data/fake/school.ts and packages/core/src/branding.ts. Logos live in Postgres (decision #6).
 *
 *   PATCH  /v1/school/branding   { name, brandColor }
 *   PUT    /v1/school/logo       multipart/form-data with one file, `logo` (PNG, JPEG or WebP, ≤ 300 KB, ≤ 512 px)
 *   DELETE /v1/school/logo
 *   GET    /v1/school/logo       the image (public)
 */
import { createHash } from "node:crypto";
import { eq, schoolLogos, schools, sql, withSchool, type Tx } from "@brillianda/db";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import type { AppEnv } from "../context.js";
import { ApiError, problemContent } from "../lib/errors.js";
import { imageInfo } from "../lib/image.js";
import type { ResolvedSchool } from "../lib/school-directory.js";
import { requireSchool, schoolRoute } from "../school-route.js";
import { logoUrl, PublicSchoolSchema } from "./school.js";

export const brandingRoutes = new OpenAPIHono<AppEnv>();

const LOGO_MAX_BYTES = 300 * 1024;
const LOGO_MAX_SIDE = 512;
const OWNER_ONLY = { roles: ["owner"] as const };

/** "#1e6b45", "1E6B45" and "#16a" all become "#1E6B45" / "#1166AA" (the frontend's normaliseHex). */
function normaliseHex(input: string): string | null {
  const raw = input.trim().replace(/^#/, "");
  const full = /^[0-9a-f]{3}$/i.test(raw) ? [...raw].map((ch) => ch + ch).join("") : raw;
  return /^[0-9a-f]{6}$/i.test(full) ? `#${full.toUpperCase()}` : null;
}

const BrandingSchema = z
  .object({
    name: z.string().trim().min(2, "Enter the school’s name").max(120, "Use at most 120 characters"),
    brandColor: z
      .string()
      .trim()
      .refine((v) => normaliseHex(v) !== null, "Enter a colour like #1E6B45, or pick one above")
      .transform((v) => normaliseHex(v)!),
  })
  .openapi("Branding");

const errors = {
  401: problemContent("Not signed in to this school"),
  403: problemContent("Only the school owner can change the school’s name, colour and logo"),
  404: problemContent("No active school here"),
} as const;
const ok = { description: "The school as everyone now sees it", content: { "application/json": { schema: PublicSchoolSchema } } };

async function publicSchool(tx: Tx, id: string) {
  const [s] = await tx.select().from(schools).where(eq(schools.id, id));
  return { id: s!.id, name: s!.name, subdomain: s!.subdomain, brandColor: s!.brandColor, logoUrl: logoUrl(s!.logoKey) };
}

async function markBrandingSaved(tx: Tx, school: ResolvedSchool, set: Partial<typeof schools.$inferInsert> = {}) {
  await tx
    .update(schools)
    .set({ ...set, settings: sql`${schools.settings} || '{"brandingSaved": true}'::jsonb` })
    .where(eq(schools.id, school.id));
}

brandingRoutes.openapi(
  createRoute({
    method: "patch",
    path: "/v1/school/branding",
    tags: ["school"],
    summary: "Change the school's name and brand colour (owner only)",
    request: { body: { content: { "application/json": { schema: BrandingSchema } }, required: true } },
    responses: { 200: ok, 422: problemContent("A field needs fixing"), ...errors },
  }),
  async (c) => {
    const input = c.req.valid("json");
    const data = await schoolRoute(c, OWNER_ONLY, async ({ tx, school, audit }) => {
      const [before] = await tx.select({ name: schools.name, brandColor: schools.brandColor }).from(schools).where(eq(schools.id, school.id));
      await markBrandingSaved(tx, school, { name: input.name, brandColor: input.brandColor });
      const changed = [input.name !== before!.name && `name to ${input.name}`, input.brandColor !== before!.brandColor && `colour to ${input.brandColor}`].filter(Boolean);
      if (changed.length) {
        audit({ action: "school.branding_changed", entity: "school", entityId: school.id, changes: input, summary: `Changed the school’s ${changed.join(" and ")}` });
      }
      return publicSchool(tx, school.id);
    });
    c.get("deps").schools.invalidate(data.subdomain);
    return c.json(data, 200);
  },
);

brandingRoutes.openapi(
  createRoute({
    method: "put",
    path: "/v1/school/logo",
    tags: ["school"],
    summary: "Upload the logo (owner only): multipart/form-data, one file named `logo`, PNG, JPEG or WebP, at most 300 KB and 512 px",
    request: {
      body: {
        content: { "multipart/form-data": { schema: z.object({ logo: z.any().optional().openapi({ type: "string", format: "binary" }) }) } },
        required: true,
      },
    },
    responses: { 200: ok, 413: problemContent("Larger than 300 KB"), 422: problemContent("Not a usable image"), ...errors },
  }),
  async (c) => {
    const data = await schoolRoute(c, OWNER_ONLY, async ({ tx, school, auth, audit }) => {
      const bytes = await readLogo(c);
      const info = imageInfo(bytes);
      if (!info) throw logoError("Upload a PNG, JPG or WebP image. SVG logos aren’t accepted.");
      if (bytes.length > LOGO_MAX_BYTES) throw new ApiError("payload_too_large", "A logo can be at most 300 KB.");
      if (info.width > LOGO_MAX_SIDE || info.height > LOGO_MAX_SIDE || info.width < 1 || info.height < 1) {
        throw logoError(`A logo can be at most ${LOGO_MAX_SIDE} by ${LOGO_MAX_SIDE} pixels. This one is ${info.width} by ${info.height}.`);
      }
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const [had] = await tx.select({ id: schoolLogos.id }).from(schoolLogos).limit(1);
      const values = { contentType: info.type, bytes: Buffer.from(bytes), sha256, width: info.width, height: info.height, updatedBy: auth.user.id };
      if (had) await tx.update(schoolLogos).set(values).where(eq(schoolLogos.id, had.id));
      else await tx.insert(schoolLogos).values({ schoolId: school.id, ...values, createdBy: auth.user.id });
      await markBrandingSaved(tx, school, { logoKey: sha256 });
      audit({ action: had ? "school.logo_replaced" : "school.logo_uploaded", entity: "school", entityId: school.id, changes: { sha256, type: info.type, width: info.width, height: info.height }, summary: had ? "Replaced the logo" : "Uploaded a logo" });
      return publicSchool(tx, school.id);
    });
    c.get("deps").schools.invalidate(data.subdomain);
    return c.json(data, 200);
  },
);

function logoError(detail: string) {
  return new ApiError("validation_failed", detail, { extensions: { errors: [{ pointer: "#/logo", detail, code: "invalid_image" }] } });
}

/** The `logo` field, as parsed by the route's multipart validator (Hono's parseBody). */
async function readLogo(c: Context<AppEnv>): Promise<Uint8Array> {
  const form = (c.req.valid as (target: "form") => Record<string, unknown>)("form");
  const file = form.logo;
  if (!(file instanceof File)) throw logoError("Send the logo as multipart/form-data, in a field named logo.");
  return new Uint8Array(await file.arrayBuffer());
}

brandingRoutes.openapi(
  createRoute({
    method: "delete",
    path: "/v1/school/logo",
    tags: ["school"],
    summary: "Remove the logo (owner only)",
    responses: { 200: ok, ...errors },
  }),
  async (c) => {
    const data = await schoolRoute(c, OWNER_ONLY, async ({ tx, school, audit }) => {
      const removed = await tx.delete(schoolLogos).returning({ id: schoolLogos.id });
      await tx.update(schools).set({ logoKey: null }).where(eq(schools.id, school.id));
      if (removed.length) audit({ action: "school.logo_removed", entity: "school", entityId: school.id, summary: "Removed the logo" });
      return publicSchool(tx, school.id);
    });
    c.get("deps").schools.invalidate(data.subdomain);
    return c.json(data, 200);
  },
);

brandingRoutes.openapi(
  createRoute({
    method: "get",
    path: "/v1/school/logo",
    tags: ["school"],
    summary: "The school's logo (public). With ?v= matching the current version it is cached for a year",
    request: { query: z.object({ v: z.string().max(64).optional() }) },
    responses: {
      200: { description: "The image", content: { "image/png": { schema: z.string() }, "image/jpeg": { schema: z.string() }, "image/webp": { schema: z.string() } } },
      404: problemContent("No logo, or no active school here"),
    },
  }),
  async (c) => {
    const school = await requireSchool(c);
    const { v } = c.req.valid("query");
    const [logo] = await withSchool(c.get("deps").db, school.id, (tx) => tx.select().from(schoolLogos).limit(1));
    if (!logo) throw new ApiError("not_found", "This school has no logo.");
    const etag = `"${logo.sha256}"`;
    const versioned = v === logo.sha256.slice(0, 16);
    const headers = {
      "content-type": logo.contentType,
      etag,
      "cache-control": versioned ? "public, max-age=31536000, immutable" : "public, max-age=300",
      "x-content-type-options": "nosniff",
    };
    if (c.req.header("if-none-match") === etag) return c.body(null, 304, headers);
    return c.body(new Uint8Array(logo.bytes), 200, headers);
  },
);
