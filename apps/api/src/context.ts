import type { AuthSecret } from "@brillianda/auth";
import type { HostTarget } from "@brillianda/core";
import type { Database } from "@brillianda/db";
import type { BotCheck } from "./lib/bot-check.js";
import type { Logger } from "./lib/logger.js";
import type { Mailer } from "./lib/mailer.js";
import type { RateLimiter } from "./lib/rate-limit.js";
import type { SchoolDirectory } from "./lib/school-directory.js";

export interface AppConfig {
  rootDomain: string;
  protocol: "http" | "https";
  proxySecret: string;
  allowSchoolQueryParam: boolean;
  /** Secure + __Host- cookies. True whenever protocol is https. */
  secureCookies: boolean;
  /** Port the BROWSER uses (frontend), for links in emails. Unset in production (443). */
  publicPort?: number;
}

/** Everything a request handler may use. Built once in server.ts (or per test). */
export interface AppDeps {
  db: Database;
  secret: AuthSecret;
  rateLimiter: RateLimiter;
  schools: SchoolDirectory;
  logger: Logger;
  mailer: Mailer;
  botCheck: BotCheck;
  config: AppConfig;
}

export interface AppEnv {
  Variables: {
    deps: AppDeps;
    requestId: string;
    /** The host the browser actually used (port included), after trusted-proxy resolution. */
    host: string;
    target: HostTarget;
    clientIp: string | null;
    userAgent: string | null;
  };
}
