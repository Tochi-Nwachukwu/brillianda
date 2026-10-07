import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";

export interface RateRule {
  /** Namespaces the counter, e.g. "login:ip". */
  name: string;
  limit: number;
  windowSec: number;
}

export interface RateResult {
  success: boolean;
  remaining: number;
  /** Epoch ms when the window resets. */
  resetAt: number;
}

export interface RateLimiter {
  limit(rule: RateRule, key: string): Promise<RateResult>;
}

/**
 * The rules in one place. Tune here, not at call sites.
 * Auth endpoints get both a per-IP and a per-identifier rule so neither a botnet on one account
 * nor one IP across many accounts gets far.
 */
export const RATE_RULES = {
  apiPerIp: { name: "api:ip", limit: 300, windowSec: 60 },
  subdomainCheckPerIp: { name: "subdomain-check:ip", limit: 30, windowSec: 60 },
  signupPerIp: { name: "signup:ip", limit: 10, windowSec: 3600 },
  loginPerIp: { name: "login:ip", limit: 20, windowSec: 300 },
  loginPerEmail: { name: "login:email", limit: 10, windowSec: 900 },
  codeSendPerEmail: { name: "code-send:email", limit: 5, windowSec: 3600 },
  signupStepPerIp: { name: "signup-step:ip", limit: 60, windowSec: 600 },
  signupCompletePerIp: { name: "signup-complete:ip", limit: 10, windowSec: 3600 },
  findSchoolPerIp: { name: "find-school:ip", limit: 5, windowSec: 3600 },
  findSchoolPerEmail: { name: "find-school:email", limit: 3, windowSec: 3600 },
  emailLinkPerIp: { name: "email-link:ip", limit: 10, windowSec: 3600 },
  emailLinkPerEmail: { name: "email-link:email", limit: 3, windowSec: 3600 },
  tokenRedeemPerIp: { name: "token-redeem:ip", limit: 30, windowSec: 600 },
  invitePerUser: { name: "invite:user", limit: 50, windowSec: 86_400 },
} as const satisfies Record<string, RateRule>;

/** Single-process fallback for local development and tests. Not shared across instances. */
export class MemoryRateLimiter implements RateLimiter {
  readonly #windows = new Map<string, { count: number; resetAt: number }>();

  async limit(rule: RateRule, key: string): Promise<RateResult> {
    const now = Date.now();
    const id = `${rule.name}:${key}`;
    let w = this.#windows.get(id);
    if (!w || w.resetAt <= now) {
      w = { count: 0, resetAt: now + rule.windowSec * 1000 };
      this.#windows.set(id, w);
    }
    w.count += 1;
    if (this.#windows.size > 50_000) this.#sweep(now);
    return { success: w.count <= rule.limit, remaining: Math.max(0, rule.limit - w.count), resetAt: w.resetAt };
  }

  #sweep(now: number) {
    for (const [k, w] of this.#windows) if (w.resetAt <= now) this.#windows.delete(k);
  }
}

/** Shared limits across every API instance (required in production). */
export class UpstashRateLimiter implements RateLimiter {
  readonly #redis: Redis;
  readonly #limiters = new Map<string, Ratelimit>();

  constructor(url: string, token: string) {
    this.#redis = new Redis({ url, token });
  }

  async limit(rule: RateRule, key: string): Promise<RateResult> {
    let limiter = this.#limiters.get(rule.name);
    if (!limiter) {
      limiter = new Ratelimit({
        redis: this.#redis,
        limiter: Ratelimit.slidingWindow(rule.limit, `${rule.windowSec} s`),
        prefix: `bd:rl:${rule.name}`,
        analytics: false,
      });
      this.#limiters.set(rule.name, limiter);
    }
    const r = await limiter.limit(key);
    return { success: r.success, remaining: r.remaining, resetAt: r.reset };
  }
}
