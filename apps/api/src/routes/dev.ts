/**
 * Staging only: read the emails the API sent, for testers the email provider can't reach yet.
 * Answers 404 unless MAIL_OUTBOX_KEY is set (the API refuses to start in production with it), and
 * only with that key in the x-brillianda-outbox-key header. Works on any address.
 *
 *   GET /v1/dev/outbox?to=&limit=    newest first, with the 6-digit code and links pulled out
 */
import { timingSafeEqual } from "node:crypto";
import { desc, emailOutbox, eq } from "@brillianda/db";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { AppEnv } from "../context.js";
import { ApiError, problemContent } from "../lib/errors.js";

export const devRoutes = new OpenAPIHono<AppEnv>();

const sameKey = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

devRoutes.openapi(
  createRoute({
    method: "get",
    path: "/v1/dev/outbox",
    tags: ["staging"],
    summary: "Staging only: emails the API sent, newest first. Needs the x-brillianda-outbox-key header",
    request: {
      query: z.object({
        to: z.string().trim().toLowerCase().email().optional(),
        limit: z.coerce.number().int().min(1).max(50).default(10),
      }),
      headers: z.object({ "x-brillianda-outbox-key": z.string().max(200).optional() }),
    },
    responses: {
      200: {
        description: "Emails",
        content: {
          "application/json": {
            schema: z
              .object({
                emails: z.array(
                  z.object({
                    id: z.string().uuid(),
                    to: z.string(),
                    tag: z.string(),
                    subject: z.string(),
                    sentAt: z.string(),
                    delivered: z.boolean().nullable().openapi({ description: "Whether the provider accepted it; false means outbox only" }),
                    code: z.string().nullable().openapi({ description: "The 6-digit code, if the email has one" }),
                    links: z.array(z.string()),
                    text: z.string(),
                  }),
                ),
              })
              .openapi("Outbox"),
          },
        },
      },
      404: problemContent("No outbox here"),
    },
  }),
  async (c) => {
    const key = c.get("deps").config.outboxKey;
    const sent = c.req.valid("header")["x-brillianda-outbox-key"] ?? "";
    // Without the outbox, or without the right key, it doesn't exist.
    if (!key || !sameKey(sent, key)) throw new ApiError("not_found", "There is no outbox here.");
    const { to, limit } = c.req.valid("query");
    const rows = await c
      .get("deps")
      .db.select()
      .from(emailOutbox)
      .where(to ? eq(emailOutbox.to, to) : undefined)
      .orderBy(desc(emailOutbox.createdAt))
      .limit(limit);
    return c.json(
      {
        emails: rows.map((r) => ({
          id: r.id,
          to: r.to,
          tag: r.tag,
          subject: r.subject,
          sentAt: r.createdAt.toISOString(),
          delivered: r.delivered,
          code: /\b(\d{6})\b/.exec(r.subject)?.[1] ?? /\b(\d{6})\b/.exec(r.text)?.[1] ?? null,
          links: [...new Set(r.text.match(/https?:\/\/[^\s)>\]]+/g) ?? [])],
          text: r.text,
        })),
      },
      200,
    );
  },
);
