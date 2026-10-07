import { AuthSecret } from "@brillianda/auth";
import { createDatabase } from "@brillianda/db";
import type { AppDeps } from "./context.js";
import type { Env } from "./env.js";
import { createLogger, type Logger } from "./lib/logger.js";
import { MemoryRateLimiter, UpstashRateLimiter } from "./lib/rate-limit.js";
import { SchoolDirectory } from "./lib/school-directory.js";

export function buildDeps(env: Env, logger: Logger = createLogger(env.NODE_ENV === "production" ? "info" : "debug")): AppDeps {
  const db = createDatabase(env.DATABASE_URL, {
    max: env.DATABASE_POOL_MAX,
    onIdleError: (err) => logger.warn("idle database connection dropped", { err }),
  });
  const rateLimiter =
    env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN
      ? new UpstashRateLimiter(env.UPSTASH_REDIS_REST_URL, env.UPSTASH_REDIS_REST_TOKEN)
      : new MemoryRateLimiter();
  return {
    db,
    secret: AuthSecret.fromBase64(env.AUTH_SECRET),
    rateLimiter,
    schools: new SchoolDirectory(db),
    logger,
    config: {
      rootDomain: env.ROOT_DOMAIN,
      protocol: env.PUBLIC_PROTOCOL,
      proxySecret: env.PROXY_SHARED_SECRET,
      allowSchoolQueryParam: env.ALLOW_SCHOOL_QUERY_PARAM,
      secureCookies: env.PUBLIC_PROTOCOL === "https",
    },
  };
}
