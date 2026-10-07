/**
 * Self-serve signup on brillianda.com (plan: "Creating a school").
 *
 *   GET  /v1/signup/subdomain-check   is an address free? why not? suggestions
 *   GET  /v1/signup                   resume: where is my draft?
 *   POST /v1/signup/school            step 1: school details (creates the draft + cookie)
 *   POST /v1/signup/owner             step 2: owner account (bot check, sends the 6-digit code)
 *   POST /v1/signup/resend-code       step 3: another code (60 s cooldown)
 *   POST /v1/signup/verify-email      step 3: the code
 *   POST /v1/signup/complete          step 4: the address → one transaction creates everything,
 *                                     returns a 60-second handover link to the new address
 *
 * The draft lives in a host-only cookie on the apex; only its HMAC is in the database.
 */
import {
  codeResendWaitMs,
  generateToken,
  hashPassword,
  issueCode,
  issueLinkToken,
  verifyCode,
  verifyPassword,
} from "@brillianda/auth";
import {
  NIGERIAN_STATES,
  normaliseNigerianPhone,
  SCHOOL_LEVELS,
  suggestSubdomains,
  validateSubdomain,
} from "@brillianda/core";
import {
  and,
  auditLog,
  eq,
  gt,
  inArray,
  schoolMembers,
  schools,
  scopeToSchool,
  signupDrafts,
  users,
} from "@brillianda/db";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { EmailSchema, PasswordSchema, requireApex } from "../auth-helpers.js";
import type { AppEnv } from "../context.js";
import { emails } from "../emails.js";
import { ApiError, problemContent } from "../lib/errors.js";
import { RATE_RULES } from "../lib/rate-limit.js";
import { maskEmail, schoolUrl } from "../lib/urls.js";
import { enforceRateLimit } from "../school-route.js";

export const signupRoutes = new OpenAPIHono<AppEnv>();

const DRAFT_COOKIE = "bd_signup";
const DRAFT_TTL_MS = 7 * 86_400_000;

type Draft = typeof signupDrafts.$inferSelect;

// ── Schemas ─────────────────────────────────────────────────────────────────

const PhoneSchema = z
  .string()
  .trim()
  .max(32)
  .transform((v, ctx) => {
    const e164 = normaliseNigerianPhone(v);
    if (!e164) {
      ctx.addIssue({ code: "custom", message: "Enter a Nigerian phone number, e.g. 0803 000 0001" });
      return z.NEVER;
    }
    return e164;
  });

const SchoolStepSchema = z
  .object({
    name: z.string().trim().min(2, "Enter the school's name").max(120, "Use at most 120 characters"),
    levelsOffered: z
      .array(z.enum(SCHOOL_LEVELS, { message: "Choose nursery, primary or secondary" }))
      .min(1, "Choose at least one level")
      .transform((v) => [...new Set(v)]),
    state: z.enum(NIGERIAN_STATES, { message: "Choose the state the school is in" }),
    phone: PhoneSchema,
  })
  .openapi("SignupSchoolStep");

const OwnerStepSchema = z
  .object({
    fullName: z.string().trim().min(2, "Enter your full name").max(120, "Use at most 120 characters"),
    email: EmailSchema,
    password: PasswordSchema,
    phone: PhoneSchema.optional(),
    turnstileToken: z.string().max(4096).optional().openapi({ description: "Cloudflare Turnstile response from the widget" }),
  })
  .openapi("SignupOwnerStep");

const VerifyStepSchema = z
  .object({ code: z.string().trim().regex(/^\d{6}$/, "Enter the 6-digit code from the email") })
  .openapi("SignupVerifyStep");

const CompleteStepSchema = z
  .object({
    subdomain: z.string().trim().toLowerCase().max(63),
    existingPassword: z
      .string()
      .max(128)
      .optional()
      .openapi({ description: "Only when the draft says existingAccount: the password of that Brillianda account" }),
  })
  .openapi("SignupCompleteStep");

const DraftSchema = z
  .object({
    step: z.enum(["school", "owner", "verify_email", "address", "completed"]),
    school: z
      .object({ name: z.string(), levelsOffered: z.array(z.string()), state: z.string().nullable(), phone: z.string().nullable() })
      .nullable(),
    owner: z.object({ fullName: z.string(), email: z.string(), phone: z.string().nullable() }).nullable(),
    emailVerified: z.boolean(),
    existingAccount: z.boolean().openapi({ description: "The verified email already has a Brillianda account; step 4 needs its password" }),
    codeSentTo: z.string().nullable().openapi({ description: "Masked email the last code went to" }),
    resendAvailableInSec: z.number().int(),
    suggestedSubdomains: z.array(z.string()),
    expiresAt: z.string(),
  })
  .openapi("SignupDraft");

const SubdomainCheckSchema = z
  .object({
    subdomain: z.string(),
    available: z.boolean(),
    reason: z.enum(["taken", "reserved", "invalid", "too_short", "too_long"]).nullable(),
    suggestions: z.array(z.string()),
  })
  .openapi("SubdomainCheck");

const CompletedSchema = z
  .object({
    school: z.object({ id: z.string().uuid(), name: z.string(), subdomain: z.string(), url: z.string().url() }),
    handoverUrl: z.string().url().openapi({ description: "Open within 60 seconds; the school's address exchanges it for a session" }),
  })
  .openapi("SignupCompleted");

const apexErrors = {
  404: problemContent("Only on the main site"),
  429: problemContent("Too many attempts"),
} as const;

// ── Draft helpers ───────────────────────────────────────────────────────────

const draftHash = (c: Context<AppEnv>, token: string) => c.get("deps").secret.hash("signup", token);

function readDraftToken(c: Context<AppEnv>): string | undefined {
  const { secureCookies } = c.get("deps").config;
  return secureCookies ? getCookie(c, DRAFT_COOKIE, "host") : getCookie(c, DRAFT_COOKIE);
}

function writeDraftCookie(c: Context<AppEnv>, token: string, expires: Date): void {
  const { secureCookies } = c.get("deps").config;
  setCookie(c, DRAFT_COOKIE, token, {
    path: "/",
    httpOnly: true,
    secure: secureCookies,
    sameSite: "Lax",
    expires,
    ...(secureCookies ? { prefix: "host" as const } : {}),
  });
}

async function loadDraft(c: Context<AppEnv>): Promise<Draft | null> {
  const token = readDraftToken(c);
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const [draft] = await c
    .get("deps")
    .db.select()
    .from(signupDrafts)
    .where(and(eq(signupDrafts.tokenHash, draftHash(c, token)), gt(signupDrafts.expiresAt, new Date())))
    .limit(1);
  return draft ?? null;
}

async function requireDraft(c: Context<AppEnv>): Promise<Draft> {
  const draft = await loadDraft(c);
  if (!draft) throw new ApiError("signup_incomplete", "Start with the school details.", { extensions: { nextStep: "school" } });
  if (draft.status === "completed") throw new ApiError("conflict", "This signup is already finished. Open your school's address to sign in.");
  return draft;
}

function stepOf(d: Draft): z.infer<typeof DraftSchema>["step"] {
  if (d.status === "completed") return "completed";
  if (!d.schoolName) return "school";
  if (!d.ownerEmail || !d.ownerPasswordHash) return "owner";
  if (!d.emailVerifiedAt) return "verify_email";
  return "address";
}

const STEP_ORDER = ["school", "owner", "verify_email", "address", "completed"] as const;

function requireStep(d: Draft, atLeast: (typeof STEP_ORDER)[number]): void {
  const current = stepOf(d);
  if (STEP_ORDER.indexOf(current) < STEP_ORDER.indexOf(atLeast)) {
    throw new ApiError("signup_incomplete", `Finish the "${current}" step first.`, { extensions: { nextStep: current } });
  }
}

async function availableSuggestions(c: Context<AppEnv>, schoolName: string | null | undefined): Promise<string[]> {
  if (!schoolName) return [];
  const candidates = suggestSubdomains(schoolName, 8);
  if (!candidates.length) return [];
  const taken = await c
    .get("deps")
    .db.select({ subdomain: schools.subdomain })
    .from(schools)
    .where(inArray(schools.subdomain, candidates));
  const takenSet = new Set(taken.map((t) => t.subdomain.toLowerCase()));
  return candidates.filter((s) => !takenSet.has(s)).slice(0, 3);
}

async function draftView(c: Context<AppEnv>, d: Draft): Promise<z.infer<typeof DraftSchema>> {
  const wait = d.ownerEmail ? await codeResendWaitMs(c.get("deps").db, "email_verification", d.ownerEmail) : 0;
  return {
    step: stepOf(d),
    school: d.schoolName
      ? { name: d.schoolName, levelsOffered: d.levelsOffered ?? [], state: d.state, phone: d.schoolPhone }
      : null,
    owner: d.ownerEmail ? { fullName: d.ownerFullName ?? "", email: d.ownerEmail, phone: d.ownerPhone } : null,
    emailVerified: d.emailVerifiedAt !== null,
    existingAccount: d.existingUserId !== null,
    codeSentTo: d.ownerEmail && !d.emailVerifiedAt ? maskEmail(d.ownerEmail) : null,
    resendAvailableInSec: Math.ceil(wait / 1000),
    suggestedSubdomains: stepOf(d) === "address" ? await availableSuggestions(c, d.schoolName) : [],
    expiresAt: d.expiresAt.toISOString(),
  };
}

async function sendCode(c: Context<AppEnv>, d: Draft): Promise<void> {
  const { db, secret, mailer } = c.get("deps");
  const email = d.ownerEmail!;
  if ((await codeResendWaitMs(db, "email_verification", email)) > 0) return; // a recent code is still on its way
  await enforceRateLimit(c, RATE_RULES.codeSendPerEmail, email);
  const { code } = await issueCode(db, secret, "email_verification", { identifier: email, payload: { draftId: d.id } });
  await mailer.send(emails.signupCode(email, code));
}

// ── Routes ──────────────────────────────────────────────────────────────────

signupRoutes.openapi(
  createRoute({
    method: "get",
    path: "/v1/signup/subdomain-check",
    tags: ["signup"],
    summary: "Is this school address available? If not, why, and what is",
    request: {
      query: z.object({
        subdomain: z.string().max(63),
        schoolName: z.string().max(120).optional().openapi({ description: "Improves suggestions" }),
      }),
    },
    responses: {
      200: { description: "Result", content: { "application/json": { schema: SubdomainCheckSchema } } },
      ...apexErrors,
    },
  }),
  async (c) => {
    requireApex(c);
    await enforceRateLimit(c, RATE_RULES.subdomainCheckPerIp, c.get("clientIp") ?? "unknown");
    const { subdomain: raw, schoolName } = c.req.valid("query");
    const check = validateSubdomain(raw);
    const suggestionSource = schoolName ?? (await loadDraft(c))?.schoolName ?? raw;
    const suggestions = await availableSuggestions(c, suggestionSource);
    if (!check.ok) {
      const reason = check.problem === "invalid_characters" ? ("invalid" as const) : check.problem;
      return c.json({ subdomain: check.subdomain, available: false, reason, suggestions }, 200);
    }
    const [taken] = await c.get("deps").db.select({ id: schools.id }).from(schools).where(eq(schools.subdomain, check.subdomain)).limit(1);
    return c.json(
      {
        subdomain: check.subdomain,
        available: !taken,
        reason: taken ? ("taken" as const) : null,
        suggestions: suggestions.filter((s) => s !== check.subdomain),
      },
      200,
    );
  },
);

signupRoutes.openapi(
  createRoute({
    method: "get",
    path: "/v1/signup",
    tags: ["signup"],
    summary: "The signup in progress in this browser, to resume where it stopped",
    responses: {
      200: { description: "Draft", content: { "application/json": { schema: DraftSchema } } },
      404: problemContent("No signup in progress"),
    },
  }),
  async (c) => {
    requireApex(c);
    const draft = await loadDraft(c);
    if (!draft) throw new ApiError("not_found", "No signup in progress in this browser.");
    return c.json(await draftView(c, draft), 200);
  },
);

signupRoutes.openapi(
  createRoute({
    method: "post",
    path: "/v1/signup/school",
    tags: ["signup"],
    summary: "Step 1: school details. Starts a signup, or updates the one in progress",
    request: { body: { content: { "application/json": { schema: SchoolStepSchema } }, required: true } },
    responses: {
      200: { description: "Saved", content: { "application/json": { schema: DraftSchema } } },
      ...apexErrors,
    },
  }),
  async (c) => {
    requireApex(c);
    const ip = c.get("clientIp") ?? "unknown";
    await enforceRateLimit(c, RATE_RULES.signupStepPerIp, ip);
    const input = c.req.valid("json");
    const { db } = c.get("deps");
    const values = { schoolName: input.name, levelsOffered: input.levelsOffered, state: input.state, schoolPhone: input.phone };

    const existing = await loadDraft(c);
    let draft: Draft | undefined;
    if (existing && existing.status === "open") {
      [draft] = await db.update(signupDrafts).set(values).where(eq(signupDrafts.id, existing.id)).returning();
    } else {
      await enforceRateLimit(c, RATE_RULES.signupPerIp, ip);
      const token = generateToken();
      const expiresAt = new Date(Date.now() + DRAFT_TTL_MS);
      [draft] = await db
        .insert(signupDrafts)
        .values({ ...values, tokenHash: draftHash(c, token), expiresAt, ip })
        .returning();
      writeDraftCookie(c, token, expiresAt);
    }
    return c.json(await draftView(c, draft!), 200);
  },
);

signupRoutes.openapi(
  createRoute({
    method: "post",
    path: "/v1/signup/owner",
    tags: ["signup"],
    summary: "Step 2: the owner's account. Sends a 6-digit code to the email",
    request: { body: { content: { "application/json": { schema: OwnerStepSchema } }, required: true } },
    responses: {
      200: { description: "Saved; code sent", content: { "application/json": { schema: DraftSchema } } },
      403: problemContent("Bot check failed"),
      409: problemContent("Earlier step missing"),
      ...apexErrors,
    },
  }),
  async (c) => {
    requireApex(c);
    await enforceRateLimit(c, RATE_RULES.signupStepPerIp, c.get("clientIp") ?? "unknown");
    const draft = await requireDraft(c);
    requireStep(draft, "owner");
    const input = c.req.valid("json");
    const { db, botCheck } = c.get("deps");

    if (!(await botCheck.verify(input.turnstileToken, c.get("clientIp")))) {
      throw new ApiError("bot_check_failed", "Complete the check that you are human, then try again.");
    }

    const emailChanged = draft.ownerEmail?.toLowerCase() !== input.email;
    const [updated] = await db
      .update(signupDrafts)
      .set({
        ownerFullName: input.fullName,
        ownerEmail: input.email,
        ownerPhone: input.phone ?? null,
        ownerPasswordHash: await hashPassword(input.password),
        // A new email must be verified again.
        ...(emailChanged ? { emailVerifiedAt: null, existingUserId: null } : {}),
      })
      .where(eq(signupDrafts.id, draft.id))
      .returning();

    if (!updated!.emailVerifiedAt) await sendCode(c, updated!);
    return c.json(await draftView(c, updated!), 200);
  },
);

signupRoutes.openapi(
  createRoute({
    method: "post",
    path: "/v1/signup/resend-code",
    tags: ["signup"],
    summary: "Step 3: send a new code (available 60 seconds after the last one)",
    responses: {
      200: { description: "Sent, or still cooling down (see resendAvailableInSec)", content: { "application/json": { schema: DraftSchema } } },
      409: problemContent("Earlier step missing"),
      ...apexErrors,
    },
  }),
  async (c) => {
    requireApex(c);
    await enforceRateLimit(c, RATE_RULES.signupStepPerIp, c.get("clientIp") ?? "unknown");
    const draft = await requireDraft(c);
    requireStep(draft, "verify_email");
    if (!draft.emailVerifiedAt) await sendCode(c, draft);
    return c.json(await draftView(c, draft), 200);
  },
);

signupRoutes.openapi(
  createRoute({
    method: "post",
    path: "/v1/signup/verify-email",
    tags: ["signup"],
    summary: "Step 3: the 6-digit code (5 attempts, expires after 10 minutes)",
    request: { body: { content: { "application/json": { schema: VerifyStepSchema } }, required: true } },
    responses: {
      200: { description: "Email verified", content: { "application/json": { schema: DraftSchema } } },
      400: problemContent("Wrong, expired or exhausted code (see reason)"),
      409: problemContent("Earlier step missing"),
      ...apexErrors,
    },
  }),
  async (c) => {
    requireApex(c);
    await enforceRateLimit(c, RATE_RULES.signupStepPerIp, c.get("clientIp") ?? "unknown");
    const draft = await requireDraft(c);
    requireStep(draft, "verify_email");
    if (draft.emailVerifiedAt) return c.json(await draftView(c, draft), 200);

    const { db, secret } = c.get("deps");
    const result = await verifyCode(db, secret, "email_verification", draft.ownerEmail!, c.req.valid("json").code);
    if (!result.ok || result.payload.draftId !== draft.id) {
      const reason = result.ok ? "invalid" : result.reason;
      const detail = {
        invalid: "That code is not right. Check the latest email.",
        expired: "That code has expired. Send a new one.",
        too_many_attempts: "Too many wrong codes. Send a new one.",
      }[reason];
      throw new ApiError("verification_failed", detail, { extensions: { reason } });
    }

    const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, draft.ownerEmail!)).limit(1);
    const [updated] = await db
      .update(signupDrafts)
      .set({ emailVerifiedAt: new Date(), existingUserId: existing?.id ?? null })
      .where(eq(signupDrafts.id, draft.id))
      .returning();
    return c.json(await draftView(c, updated!), 200);
  },
);

signupRoutes.openapi(
  createRoute({
    method: "post",
    path: "/v1/signup/complete",
    tags: ["signup"],
    summary: "Step 4: choose the address. Creates the school and its owner in one transaction",
    request: { body: { content: { "application/json": { schema: CompleteStepSchema } }, required: true } },
    responses: {
      201: { description: "School created", content: { "application/json": { schema: CompletedSchema } } },
      401: problemContent("Existing account password wrong"),
      409: problemContent("Address unavailable, or earlier step missing"),
      ...apexErrors,
    },
  }),
  async (c) => {
    requireApex(c);
    await enforceRateLimit(c, RATE_RULES.signupCompletePerIp, c.get("clientIp") ?? "unknown");
    const draft = await requireDraft(c);
    requireStep(draft, "address");
    const { subdomain: raw, existingPassword } = c.req.valid("json");
    const { db, secret, mailer, config, schools: directory } = c.get("deps");

    const unavailable = async (reason: string, detail: string): Promise<never> => {
      throw new ApiError("subdomain_unavailable", detail, {
        extensions: { reason, suggestions: await availableSuggestions(c, draft.schoolName) },
      });
    };

    const check = validateSubdomain(raw);
    if (!check.ok) {
      await unavailable(
        check.problem === "reserved" ? "reserved" : "invalid",
        check.problem === "reserved"
          ? "That address is reserved."
          : "Use 3 to 30 lowercase letters, digits or single hyphens, starting with a letter.",
      );
    }
    const subdomain = check.subdomain;

    // Second campus: the email already has an account. Prove it is theirs with that password.
    let existingUser: { id: string; passwordHash: string | null; status: string } | undefined;
    if (draft.existingUserId) {
      [existingUser] = await db
        .select({ id: users.id, passwordHash: users.passwordHash, status: users.status })
        .from(users)
        .where(eq(users.id, draft.existingUserId))
        .limit(1);
      const ok = await verifyPassword(existingUser?.passwordHash, existingPassword ?? "");
      if (!ok || existingUser?.status !== "active") {
        throw new ApiError("invalid_credentials", "This email already has a Brillianda account. Enter that account's password.");
      }
    }

    let created: { schoolId: string; userId: string; handover: string };
    try {
      created = await db.transaction(async (tx) => {
        let userId = existingUser?.id;
        if (!userId) {
          const [user] = await tx
            .insert(users)
            .values({
              email: draft.ownerEmail!,
              fullName: draft.ownerFullName!,
              phone: draft.ownerPhone,
              passwordHash: draft.ownerPasswordHash!,
              emailVerifiedAt: draft.emailVerifiedAt,
            })
            .returning({ id: users.id });
          userId = user!.id;
        }

        const [school] = await tx
          .insert(schools)
          .values({
            name: draft.schoolName!,
            subdomain,
            ownerUserId: userId,
            levelsOffered: draft.levelsOffered ?? [],
            state: draft.state,
            phone: draft.schoolPhone,
            settings: {
              termsPerSession: 3,
              admissionNumberFormat: { prefix: null, includeYear: true, digits: 4 },
            },
          })
          .returning({ id: schools.id });

        await scopeToSchool(tx, school!.id);
        await tx.insert(schoolMembers).values({ schoolId: school!.id, userId, role: "owner", createdBy: userId, updatedBy: userId });
        await tx.insert(auditLog).values({
          schoolId: school!.id,
          actorUserId: userId,
          action: "school.created",
          entity: "school",
          entityId: school!.id,
          changes: { name: draft.schoolName, subdomain, levelsOffered: draft.levelsOffered, state: draft.state, via: "signup" },
          ip: c.get("clientIp"),
          userAgent: c.get("userAgent"),
        });

        await tx
          .update(signupDrafts)
          .set({ status: "completed", completedSchoolId: school!.id, ownerPasswordHash: null })
          .where(eq(signupDrafts.id, draft.id));

        const { token } = await issueLinkToken(tx, secret, "handover", {
          identifier: draft.ownerEmail!,
          userId,
          payload: { schoolId: school!.id },
        });
        return { schoolId: school!.id, userId, handover: token };
      });
    } catch (err) {
      // Two people raced for the same address: the unique index decides, the loser gets alternatives.
      const cause = (err as { cause?: { code?: string; constraint?: string } }).cause;
      if (cause?.code === "23505" && cause.constraint === "schools_subdomain_unique") {
        await unavailable("taken", "Someone just took that address. Pick another.");
      }
      throw err;
    }

    directory.invalidate(subdomain);
    const url = schoolUrl(config, subdomain);
    await mailer.send(emails.welcome(draft.ownerEmail!, draft.schoolName!, url)).catch((err) =>
      c.get("deps").logger.error("welcome email failed", { err }),
    );
    writeDraftCookie(c, "", new Date(0));
    c.header("Location", url);
    return c.json(
      {
        school: { id: created.schoolId, name: draft.schoolName!, subdomain, url },
        handoverUrl: schoolUrl(config, subdomain, `/auth/handover?token=${created.handover}`),
      },
      201,
    );
  },
);

