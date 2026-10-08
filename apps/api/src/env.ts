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
  if (env.APP_ENV === "production") {
    if (/@resend\.dev>?\s*$/i.test(env.MAIL_FROM)) {
      throw new Error("MAIL_FROM is Resend's test sender, which only reaches the account owner; use your verified domain in production");
    }
    if (env.PUBLIC_PROTOCOL !== "https") throw new Error("PUBLIC_PROTOCOL must be https in production");
    if (env.ALLOW_SCHOOL_QUERY_PARAM) throw new Error("ALLOW_SCHOOL_QUERY_PARAM must be off in production");
    if (env.NODE_ENV !== "production") throw new Error("APP_ENV=production needs NODE_ENV=production");
    if (!env.UPSTASH_REDIS_REST_URL) throw new Error("Upstash is required in production (rate limits must be shared)");
    if (!env.TURNSTILE_SECRET_KEY) throw new Error("TURNSTILE_SECRET_KEY is required in production (signup bot check)");
    if (env.MAIL_PROVIDER === "console") throw new Error("A real MAIL_PROVIDER is required in production; console mail reaches nobody");
  }
  if (env.APP_ENV === "staging" && env.PUBLIC_PROTOCOL !== "https") {
    throw new Error("PUBLIC_PROTOCOL must be https on a hosted staging environment");
  }
  return env;
}
