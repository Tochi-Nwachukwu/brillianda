/**
 * "Request a trial" from the marketing site (brillianda.com only, no session). Rules are the
 * frontend's validateTrialRequest (packages/core/src/trial.ts). A filled honeypot field (`website`)
 * is answered like any other request and dropped, so bots learn nothing.
 *
 *   POST /v1/trial-requests   → 202 { accepted: true }
 */
import { trialRequests } from "@brillianda/db";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { AcceptedSchema, inBackground, requireApex } from "../auth-helpers.js";
import type { AppEnv } from "../context.js";
import { emails } from "../emails.js";
import { ApiError, problemContent } from "../lib/errors.js";
import { RATE_RULES } from "../lib/rate-limit.js";
import { enforceRateLimit } from "../school-route.js";

export const trialRoutes = new OpenAPIHono<AppEnv>();

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PHONE = /^(?:\+?234|0)\d{10}$/;
const text = (min: number, max: number, message: string) => z.string().trim().min(min, message).max(max, "That’s too long");

const TrialSchema = z
  .object({
    schoolName: text(2, 120, "Tell us the school’s name"),
    contactName: text(2, 120, "Tell us your name"),
    role: text(1, 60, "Choose your role"),
    email: z.string().trim().toLowerCase().min(1, "We need an email to reply to").max(254).regex(EMAIL, "Check this email address"),
    phone: z
      .string()
      .transform((v) => v.replace(/[\s-]/g, ""))
      .pipe(z.string().min(1, "A phone number, in case email fails").regex(PHONE, "Enter a Nigerian number, e.g. 08012345678")),
    studentCount: z.preprocess(
      (v) => (typeof v === "string" ? v.replace(/,/g, "").trim() : v),
      z.coerce.number({ message: "Enter a number, e.g. 420" }).int("Enter a number, e.g. 420").min(1, "Enter a number, e.g. 420").max(999_999, "Enter a number, e.g. 420"),
    ),
    state: z.string().trim().max(60).optional(),
    interests: z.array(z.string().trim().max(60)).max(20).default([]),
    message: z.string().trim().max(1000, "Please keep this under 1,000 characters").optional(),
    website: z.string().max(500).default("").openapi({ description: "Honeypot: leave empty" }),
    turnstileToken: z.string().max(4096).optional(),
  })
  .openapi("TrialRequest");

trialRoutes.openapi(
  createRoute({
    method: "post",
    path: "/v1/trial-requests",
    tags: ["site"],
    summary: "The marketing site's trial form (main site only)",
    request: { body: { content: { "application/json": { schema: TrialSchema } }, required: true } },
    responses: {
      202: { description: "Received", content: { "application/json": { schema: AcceptedSchema } } },
      403: problemContent("Bot check failed"),
      404: problemContent("Only on the main site"),
      422: problemContent("A field needs fixing"),
      429: problemContent("Too many requests"),
    },
  }),
  async (c) => {
    requireApex(c);
    const ip = c.get("clientIp") ?? "unknown";
    await enforceRateLimit(c, RATE_RULES.trialPerIp, ip);
    const input = c.req.valid("json");
    if (input.website) return c.json({ accepted: true as const }, 202);

    const { db, botCheck, mailer, config } = c.get("deps");
    if (!(await botCheck.verify(input.turnstileToken, c.get("clientIp")))) {
      throw new ApiError("bot_check_failed", "Please complete the check and try again.");
    }
    const row = {
      schoolName: input.schoolName,
      contactName: input.contactName,
      role: input.role,
      email: input.email,
      phone: input.phone,
      studentCount: input.studentCount,
      state: input.state || null,
      interests: input.interests,
      message: input.message || null,
      ip: c.get("clientIp"),
    };
    await db.insert(trialRequests).values(row);
    if (config.trialNotifyEmail) {
      const to = config.trialNotifyEmail;
      inBackground(c, "trial request email", () => mailer.send(emails.trialRequested(to, row)));
    }
    return c.json({ accepted: true as const }, 202);
  },
);
