/**
 * Staging only: read the emails the API sent, for testers the email provider can't reach yet.
 * Exists only when MAIL_OUTBOX_KEY is set (the API refuses to start in production with it), and
 * answers 404 without that key. Works on any address.
 *
 *   GET /v1/dev/outbox?to=&limit=        JSON, key in the x-brillianda-outbox-key header
 *   GET /dev/outbox?key=&to=             a page to open in a browser: codes big, links clickable
 */
import { timingSafeEqual } from "node:crypto";
import { desc, emailOutbox, eq } from "@brillianda/db";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { AppEnv } from "../context.js";
import { ApiError, problemContent } from "../lib/errors.js";

export const devRoutes = new OpenAPIHono<AppEnv>();

const sameKey = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
const codeOf = (subject: string, text: string) => /\b(\d{6})\b/.exec(subject)?.[1] ?? /\b(\d{6})\b/.exec(text)?.[1] ?? null;
const linksOf = (text: string) => [...new Set(text.match(/https?:\/\/[^\s)>\]]+/g) ?? [])];

/**
 * The browser page. Plain HTML, no script; refreshes itself every 10 seconds so a code shows up
 * while the tester waits. The key travels in the address, which is acceptable for a staging-only
 * test inbox (it is a different secret from everything else).
 */
devRoutes.get("/dev/outbox", async (c) => {
  const key = c.get("deps").config.outboxKey;
  const sent = c.req.query("key") ?? "";
  if (!key || !sameKey(sent, key)) throw new ApiError("not_found", "There is no outbox here.");
  const to = (c.req.query("to") ?? "").trim().toLowerCase();
  const rows = await c
    .get("deps")
    .db.select()
    .from(emailOutbox)
    .where(to ? eq(emailOutbox.to, to) : undefined)
    .orderBy(desc(emailOutbox.createdAt))
    .limit(20);
  const when = new Intl.DateTimeFormat("en-GB", { timeZone: "Africa/Lagos", dateStyle: "medium", timeStyle: "medium" });
  const cards = rows
    .map((r) => {
      const code = codeOf(r.subject, r.text);
      const links = linksOf(r.text)
        .map((l) => `<a href="${escapeHtml(l)}" target="_blank" rel="noopener">${escapeHtml(l.replace(/token=[^&]+/, "token=…"))}</a>`)
        .join("");
      return `<article>
  <p class="meta">${escapeHtml(when.format(r.createdAt))} · to <b>${escapeHtml(r.to)}</b> · ${escapeHtml(r.tag)}${r.delivered ? " · also delivered" : ""}</p>
  <h2>${escapeHtml(r.subject)}</h2>
  ${code ? `<p class="code">${code}</p>` : ""}
  ${links ? `<p class="links">${links}</p>` : ""}
</article>`;
    })
    .join("\n");
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="10"><title>Staging outbox</title><style>
body{font:16px/1.5 system-ui,sans-serif;margin:0;padding:16px;background:#f6f6f4;color:#1b1b1b}
main{max-width:720px;margin:0 auto}form{display:flex;gap:8px;margin:12px 0 20px}
input{flex:1;font:inherit;padding:10px;border:1px solid #bbb;border-radius:8px}button{font:inherit;padding:10px 16px;border-radius:8px;border:0;background:#1b1b1b;color:#fff}
article{background:#fff;border-radius:12px;padding:14px 16px;margin:0 0 12px;box-shadow:0 1px 2px #0001}
h1{font-size:20px;margin:0}h2{font-size:16px;margin:4px 0}.meta{color:#555;font-size:13px;margin:0}
.code{font:700 34px/1.2 ui-monospace,monospace;letter-spacing:6px;margin:8px 0}.links a{display:block;word-break:break-all;margin:4px 0;color:#0b57d0}
.empty{color:#555}</style></head><body><main>
<h1>Staging outbox</h1><p class="meta">Every email the staging API sent in the last 7 days, newest first. Refreshes every 10 seconds.</p>
<form method="get" action="/dev/outbox"><input type="hidden" name="key" value="${escapeHtml(sent)}">
<input type="email" name="to" placeholder="Filter by email address" value="${escapeHtml(to)}"><button>Show</button></form>
${cards || `<p class="empty">No emails${to ? ` to ${escapeHtml(to)}` : ""} yet.</p>`}
</main></body></html>`;
  return c.html(html, 200, { "cache-control": "no-store", "referrer-policy": "no-referrer" });
});

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
          code: codeOf(r.subject, r.text),
          links: linksOf(r.text),
          text: r.text,
        })),
      },
      200,
    );
  },
);
