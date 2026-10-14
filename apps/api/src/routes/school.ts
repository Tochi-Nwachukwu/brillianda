import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { AppEnv } from "../context.js";
import { problemContent } from "../lib/errors.js";
import { requireSchool } from "../school-route.js";

export const schoolRoutes = new OpenAPIHono<AppEnv>();

/** Where browsers fetch a school's logo: through the school's own address, versioned by its hash. */
export const logoUrl = (logoKey: string | null) => (logoKey ? `/api/v1/school/logo?v=${logoKey.slice(0, 16)}` : null);

export const PublicSchoolSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string(),
    subdomain: z.string(),
    brandColor: z.string().nullable(),
    logoUrl: z.string().nullable().openapi({ description: "Relative to the school's own address, e.g. /api/v1/school/logo?v=…; null without a logo" }),
  })
  .openapi("PublicSchool");

/**
 * The school's public identity for this host: what the login page, header and web manifest need.
 * No session required. 404 for unknown or suspended schools, which the frontend shows as a clear page.
 */
schoolRoutes.openapi(
  createRoute({
    method: "get",
    path: "/v1/school",
    tags: ["school"],
    summary: "Public branding for the school at this address",
    responses: {
      200: { description: "The school", content: { "application/json": { schema: PublicSchoolSchema } } },
      404: problemContent("No active school here"),
    },
  }),
  async (c) => {
    const school = await requireSchool(c);
    c.header("Cache-Control", "public, max-age=60");
    return c.json(
      {
        id: school.id,
        name: school.name,
        subdomain: school.subdomain,
        brandColor: school.brandColor,
        logoUrl: logoUrl(school.logoKey),
      },
      200,
    );
  },
);
