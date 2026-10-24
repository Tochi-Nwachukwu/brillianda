import { AuthSecret } from "@brillianda/auth";
import { createDatabase } from "@brillianda/db";
import type { AppDeps } from "./context.js";
import type { Env } from "./env.js";
import { AllowAllBotCheck, TurnstileBotCheck } from "./lib/bot-check.js";
import { createLogger, type Logger } from "./lib/logger.js";
import { ConsoleMailer, OutboxMailer, ResendMailer, type Mailer } from "./lib/mailer.js";
import { ConsoleSms, OutboxSms, TermiiSms, type Sms } from "./lib/sms.js";
import { MemoryRateLimiter, UpstashRateLimiter } from "./lib/rate-limit.js";
import { SchoolDirectory } from "./lib/school-directory.js";

export function buildDeps(env: Env, logger: Logger = createLogger(env.APP_ENV === "production" ? "info" : "debug")): AppDeps {
  const db = createDatabase(env.DATABASE_URL, {
    max: env.DATABASE_POOL_MAX,
    onIdleError: (err) => logger.warn("idle database connection dropped", { err }),
  });
  const rateLimiter =
    env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN
      ? new UpstashRateLimiter(env.UPSTASH_REDIS_REST_URL, env.UPSTASH_REDIS_REST_TOKEN)
      : new MemoryRateLimiter();
  const provider: Mailer =
    env.MAIL_PROVIDER === "resend" ? new ResendMailer(env.RESEND_API_KEY!, env.MAIL_FROM, logger) : new ConsoleMailer(logger);
  const termii =
    env.SMS_PROVIDER === "termii"
      ? new TermiiSms({ apiKey: env.TERMII_API_KEY!, senderId: env.TERMII_SENDER_ID!, baseUrl: env.TERMII_BASE_URL!, channel: env.TERMII_CHANNEL }, logger)
      : null;
  // Staging keeps every text in the outbox; without Termii, only there.
  const sms: Sms = env.MAIL_OUTBOX_KEY ? new OutboxSms(db, termii, logger) : (termii ?? new ConsoleSms(logger));
  return {
    db,
    secret: AuthSecret.fromBase64(env.AUTH_SECRET),
    rateLimiter,
    schools: new SchoolDirectory(db),
    logger,
    mailer: env.MAIL_OUTBOX_KEY ? new OutboxMailer(db, provider, logger) : provider,
    sms,
    botCheck: env.TURNSTILE_SECRET_KEY ? new TurnstileBotCheck(env.TURNSTILE_SECRET_KEY) : new AllowAllBotCheck(),
    config: {
      appEnv: env.APP_ENV,
      onVercel: process.env.VERCEL === "1",
      rootDomain: env.ROOT_DOMAIN,
      protocol: env.PUBLIC_PROTOCOL,
      proxySecret: env.PROXY_SHARED_SECRET,
      allowSchoolQueryParam: env.ALLOW_SCHOOL_QUERY_PARAM,
      secureCookies: env.PUBLIC_PROTOCOL === "https",
      ...(env.PUBLIC_PORT ? { publicPort: env.PUBLIC_PORT } : {}),
      ...(env.TRIAL_NOTIFY_EMAIL ? { trialNotifyEmail: env.TRIAL_NOTIFY_EMAIL } : {}),
      ...(env.FRONTEND_URL ? { frontendUrl: env.FRONTEND_URL } : {}),
      apiHosts: [
        ...(env.API_HOSTNAMES ?? "").split(","),
        process.env.VERCEL_PROJECT_PRODUCTION_URL ?? "",
        process.env.VERCEL_URL ?? "",
        process.env.VERCEL_BRANCH_URL ?? "",
      ]
        .map((h) => h.trim().toLowerCase())
        .filter(Boolean),
      ...(env.MAIL_OUTBOX_KEY ? { outboxKey: env.MAIL_OUTBOX_KEY } : {}),
      ...(env.CRON_SECRET ? { cronSecret: env.CRON_SECRET } : {}),
    },
  };
}
