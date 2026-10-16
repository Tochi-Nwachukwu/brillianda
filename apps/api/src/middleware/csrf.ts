import { createMiddleware } from "hono/factory";
import type { AppEnv } from "../context.js";
import { ApiError } from "../lib/errors.js";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * CSRF defence for cookie-authenticated requests, on top of SameSite=Lax:
 * any state-changing request must carry an Origin (or Referer) equal to the host it was sent to.
 * A form on evil.com, or on another school's subdomain, posting to surebloom.brillianda.com
 * is refused.
 */
export const csrf = () =>
  createMiddleware<AppEnv>(async (c, next) => {
    if (SAFE_METHODS.has(c.req.method)) return next();

    const { protocol } = c.get("deps").config;
    const expected = `${protocol}://${c.get("host")}`;
    const origin = c.req.header("origin") ?? originOf(c.req.header("referer"));

    if (!origin || origin.toLowerCase() !== expected) {
      throw new ApiError("csrf_rejected", "State-changing requests need an Origin header matching this school's address.");
    }
    return next();
  });

function originOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}
