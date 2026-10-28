import { z } from "zod";

const bool = z
  .enum(["true", "false", "1", "0", ""])
  .optional()
  .transform((v) => v === "true" || v === "1");

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  /**
   * Which rules apply. Separate from NODE_ENV because hosts (Vercel) always set NODE_ENV=production.
   *   development  laptop
   *   staging      a hosted test environment: console email allowed (codes appear in the host's logs),
   *                ?school= addressing, Turnstile and Upstash optional, /docs test page on
   *   production   real schools: every safety requirement enforced
   */
  APP_ENV: z.enum(["development", "staging", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(4000),
  DATABASE_URL: z.string().url(),
  DATABASE_POOL_MAX: z.coerce.number().int().positive().default(10),
  ROOT_DOMAIN: z.string().min(1),
  PUBLIC_PROTOCOL: z.enum(["http", "https"]).default("https"),
  AUTH_SECRET: z.string().min(40, "AUTH_SECRET must be at least 32 random bytes, base64"),
  PROXY_SHARED_SECRET: z.string().min(16),
  ALLOW_SCHOOL_QUERY_PARAM: bool,
  /** Port browsers use for the frontend (local: 3000). Leave unset in production. */
  PUBLIC_PORT: z.coerce.number().int().positive().optional().or(z.literal("").transform(() => undefined)),
  /** console = print emails to the terminal / host logs. resend = send for real (needs RESEND_API_KEY). */
  MAIL_PROVIDER: z.enum(["console", "resend"]).default("console"),
  MAIL_FROM: z.string().default("Brillianda <no-reply@brillianda.com>"),
  RESEND_API_KEY: z.string().optional().or(z.literal("").transform(() => undefined)),
  /** The API's own hostnames, comma-separated (e.g. api.staging.brillianda.com). On Vercel its own names are added automatically. */
  API_HOSTNAMES: z.string().optional(),
  /** Staging: the frontend's address, e.g. https://brillianda-web.vercel.app. Email links go to <it>/s/<school>/…. */
  FRONTEND_URL: z
    .string()
    .url()
    .transform((v) => v.replace(/\/+$/, ""))
    .optional()
    .or(z.literal("").transform(() => undefined)),
  /** console = print texts to the terminal / host logs. termii = send for real (needs TERMII_API_KEY, TERMII_SENDER_ID, TERMII_BASE_URL). */
  SMS_PROVIDER: z.enum(["console", "termii"]).default("console"),
  TERMII_API_KEY: z.string().optional().or(z.literal("").transform(() => undefined)),
  /** The approved sender ID (3 to 11 letters or digits), e.g. Brillianda. */
  TERMII_SENDER_ID: z.string().regex(/^[A-Za-z0-9 ]{3,11}$/, "TERMII_SENDER_ID is 3 to 11 letters or digits").optional().or(z.literal("").transform(() => undefined)),
  /** Each Termii account has its own base URL, on its dashboard. */
  TERMII_BASE_URL: z.string().url().optional().or(z.literal("").transform(() => undefined)),
  /** dnd reaches numbers on Do-Not-Disturb (must be activated on the account); generic doesn't. */
  TERMII_CHANNEL: z.enum(["dnd", "generic"]).default("dnd"),
  /**
   * Drafting questions with AI (B7). off until the under-18 terms question (the front end's
   * docs/ai-integration.md, Step 0) is settled; gemini needs GEMINI_API_KEY (a paid-tier key).
   */
  AI_PROVIDER: z.enum(["off", "gemini"]).default("off"),
  GEMINI_API_KEY: z.string().optional().or(z.literal("").transform(() => undefined)),
  AI_MODEL: z.string().min(1).default("gemini-3.8-flash"),
  /** Generations per school per month. */
  AI_MONTHLY_LIMIT: z.coerce.number().int().min(0).default(300),
  /** Production only: set to true once Google (or the provider) has confirmed in writing that our use is allowed. */
  AI_TERMS_CLEARED: bool,
  /** Vercel Cron sends it as "Authorization: Bearer <CRON_SECRET>" to the daily jobs. Unset: no jobs run. */
  CRON_SECRET: z.string().min(16, "CRON_SECRET must be at least 16 characters").optional().or(z.literal("").transform(() => undefined)),
  /** Staging: every email is also kept in an outbox readable with this key (GET /v1/dev/outbox). */
  MAIL_OUTBOX_KEY: z.string().min(24, "MAIL_OUTBOX_KEY must be at least 24 characters").optional().or(z.literal("").transform(() => undefined)),
  /** Where trial requests from the marketing site are emailed. Unset: stored only. */
  TRIAL_NOTIFY_EMAIL: z.string().email().optional().or(z.literal("").transform(() => undefined)),
  TURNSTILE_SECRET_KEY: z.string().optional().or(z.literal("").transform(() => undefined)),
  UPSTASH_REDIS_REST_URL: z.string().url().optional().or(z.literal("").transform(() => undefined)),
  UPSTASH_REDIS_REST_TOKEN: z.string().optional().or(z.literal("").transform(() => undefined)),
});

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  // On Vercel, default the root domain to the project's own address (e.g. brillianda-api.vercel.app),
  // which Vercel exposes as a system environment variable.
  const withDefaults = { ...source, ROOT_DOMAIN: source.ROOT_DOMAIN || source.VERCEL_PROJECT_PRODUCTION_URL };
  const parsed = EnvSchema.safeParse(withDefaults);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid environment:\n${lines}`);
  }
  const env = parsed.data;
  if (env.MAIL_PROVIDER === "resend" && !env.RESEND_API_KEY) {
    throw new Error("MAIL_PROVIDER=resend needs RESEND_API_KEY");
  }
  if (env.SMS_PROVIDER === "termii" && !(env.TERMII_API_KEY && env.TERMII_SENDER_ID && env.TERMII_BASE_URL)) {
    throw new Error("SMS_PROVIDER=termii needs TERMII_API_KEY, TERMII_SENDER_ID and TERMII_BASE_URL");
  }
  if (env.AI_PROVIDER === "gemini" && !env.GEMINI_API_KEY) throw new Error("AI_PROVIDER=gemini needs GEMINI_API_KEY");
  if (env.APP_ENV === "production") {
    if (env.AI_PROVIDER !== "off" && !env.AI_TERMS_CLEARED) {
      throw new Error("AI_PROVIDER is on in production without AI_TERMS_CLEARED=true: confirm the provider allows a service used by under-18s first");
    }
    if (env.MAIL_OUTBOX_KEY) throw new Error("MAIL_OUTBOX_KEY is for staging only: production must never keep a readable copy of emails");
    if (env.FRONTEND_URL) throw new Error("FRONTEND_URL is for staging only: production links use each school's own subdomain");
    if (/@resend\.dev>?\s*$/i.test(env.MAIL_FROM)) {
      throw new Error("MAIL_FROM is Resend's test sender, which only reaches the account owner; use your verified domain in production");
    }
    if (env.PUBLIC_PROTOCOL !== "https") throw new Error("PUBLIC_PROTOCOL must be https in production");
    if (env.ALLOW_SCHOOL_QUERY_PARAM) throw new Error("ALLOW_SCHOOL_QUERY_PARAM must be off in production");
    if (env.NODE_ENV !== "production") throw new Error("APP_ENV=production needs NODE_ENV=production");
    if (!env.UPSTASH_REDIS_REST_URL) throw new Error("Upstash is required in production (rate limits must be shared)");
    if (!env.TURNSTILE_SECRET_KEY) throw new Error("TURNSTILE_SECRET_KEY is required in production (signup bot check)");
    if (env.MAIL_PROVIDER === "console") throw new Error("A real MAIL_PROVIDER is required in production; console mail reaches nobody");
    if (env.SMS_PROVIDER === "console") throw new Error("A real SMS_PROVIDER is required in production; console texts reach nobody");
    if (!env.CRON_SECRET) throw new Error("CRON_SECRET is required in production (the daily birthday texts)");
  }
  if (env.APP_ENV === "staging" && env.PUBLIC_PROTOCOL !== "https") {
    throw new Error("PUBLIC_PROTOCOL must be https on a hosted staging environment");
  }
  return env;
}
