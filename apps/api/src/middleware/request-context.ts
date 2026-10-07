import { normaliseHost, resolveHost, validateSubdomain, type HostTarget } from "@brillianda/core";
import { getConnInfo } from "@hono/node-server/conninfo";
import { createMiddleware } from "hono/factory";
import { randomUUID, timingSafeEqual } from "node:crypto";
import type { AppDeps, AppEnv } from "../context.js";

export const PROXY_SECRET_HEADER = "x-brillianda-proxy-secret";

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/**
 * Works out which host the browser used, and therefore which school this request is for.
 *
 * The frontend's /api rewrite forwards to this API and sets x-forwarded-host plus the shared
 * proxy secret. Forwarded headers are believed ONLY when the secret matches; otherwise the
 * plain Host header is used. No other header, body field or cookie can choose the school.
 */
export const requestContext = (deps: AppDeps) =>
  createMiddleware<AppEnv>(async (c, next) => {
    c.set("deps", deps);
    const incomingId = c.req.header("x-request-id");
    const requestId = incomingId && /^[A-Za-z0-9-]{8,64}$/.test(incomingId) ? incomingId : randomUUID();
    c.set("requestId", requestId);
    c.header("x-request-id", requestId);

    const presented = c.req.header(PROXY_SECRET_HEADER);
    const trusted = presented !== undefined && safeEqual(presented, deps.config.proxySecret);

    const rawHost = (trusted ? c.req.header("x-forwarded-host") : undefined) ?? c.req.header("host") ?? "";
    const host = rawHost.split(",")[0]!.trim().toLowerCase();
    c.set("host", host);

    let target: HostTarget = resolveHost(host, deps.config.rootDomain);
    // Preview deployments only: there are no school subdomains, so ?school= picks one.
    const queryParam = c.req.query("school");
    if (deps.config.allowSchoolQueryParam && queryParam && validateSubdomain(queryParam).ok) {
      target = { kind: "school", subdomain: validateSubdomain(queryParam).subdomain };
    }
    c.set("target", target);

    let clientIp: string | null = null;
    if (trusted) {
      clientIp = c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || null;
    } else {
      try {
        clientIp = getConnInfo(c).remote.address ?? null;
      } catch {
        clientIp = null; // not running under @hono/node-server (tests)
      }
    }
    c.set("clientIp", clientIp);
    c.set("userAgent", c.req.header("user-agent")?.slice(0, 512) ?? null);

    await next();
  });

/** For logging only. */
export function describeHost(host: string): string {
  return normaliseHost(host) || "(none)";
}
