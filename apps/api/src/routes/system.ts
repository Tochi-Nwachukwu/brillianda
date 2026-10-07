import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { sql } from "@brillianda/db";
import type { AppEnv } from "../context.js";

export const systemRoutes = new OpenAPIHono<AppEnv>();

systemRoutes.openapi(
  createRoute({
    method: "get",
    path: "/health",
    tags: ["system"],
    summary: "Liveness: the process is up",
    responses: { 200: { description: "OK", content: { "application/json": { schema: z.object({ ok: z.literal(true) }) } } } },
  }),
  (c) => c.json({ ok: true as const }, 200),
);

systemRoutes.openapi(
  createRoute({
    method: "get",
    path: "/ready",
    tags: ["system"],
    summary: "Readiness: the database answers",
    responses: {
      200: { description: "Ready", content: { "application/json": { schema: z.object({ ok: z.literal(true) }) } } },
      503: { description: "Not ready", content: { "application/json": { schema: z.object({ ok: z.literal(false) }) } } },
    },
  }),
  async (c) => {
    try {
      await c.get("deps").db.execute(sql`select 1`);
      return c.json({ ok: true as const }, 200);
    } catch {
      return c.json({ ok: false as const }, 503);
    }
  },
);
