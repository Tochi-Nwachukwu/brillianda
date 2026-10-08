/**
 * The outermost layer, shared by the Node server (server.ts) and Vercel (index.ts).
 *
 * In staging (ALLOW_SCHOOL_QUERY_PARAM=true, a host without wildcard subdomains such as *.vercel.app)
 * a school can also be addressed as /s/<subdomain>/v1/..., which is rewritten to
 * /v1/...?school=<subdomain> before the app sees it. That lets the /docs test page reach any school.
 * In production the flag is off and this layer only forwards.
 */
import { validateSubdomain } from "@brillianda/core";
import { Hono } from "hono";
import { createApp } from "./app.js";
import type { AppDeps } from "./context.js";

const SCHOOL_PREFIX = /^\/s\/([a-z0-9-]{3,30})(\/.*)?$/;

export function createServer(deps: AppDeps) {
  const app = createApp(deps);
  const server = new Hono();

  server.all("*", (c) => {
    const req = c.req.raw;
    if (deps.config.allowSchoolQueryParam) {
      const url = new URL(c.req.url);
      const m = SCHOOL_PREFIX.exec(url.pathname);
      if (m && validateSubdomain(m[1]!).ok) {
        url.pathname = m[2] ?? "/";
        url.searchParams.set("school", m[1]!);
        return app.fetch(new Request(url, req));
      }
    }
    return app.fetch(req);
  });

  return server;
}
