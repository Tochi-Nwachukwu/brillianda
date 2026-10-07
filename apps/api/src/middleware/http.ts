/**
 * HTTP rules every endpoint gets without thinking about them.
 */
import type { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import type { AppEnv } from "../context.js";
import { ApiError } from "../lib/errors.js";

/**
 * Server-Timing: app;dur=<ms>. Lets the frontend and browser devtools see how long the API itself
 * took, separate from the network. Cheap: one clock read on the way in and out.
 */
export const serverTiming = () =>
  createMiddleware<AppEnv>(async (c, next) => {
    const start = performance.now();
    await next();
    c.res.headers.append("Server-Timing", `app;dur=${(performance.now() - start).toFixed(1)}`);
  });

const BODY_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * A request that carries a body must say it is JSON. Without this, a form post or text body would
 * reach the validator as {} and come back as a confusing "validation_failed".
 * Upload routes (multipart) will opt out when they exist.
 */
export const requireJsonBody = () =>
  createMiddleware<AppEnv>(async (c, next) => {
    if (BODY_METHODS.has(c.req.method)) {
      const length = c.req.header("content-length");
      const contentType = c.req.header("content-type");
      // A declared content type is checked even without a length (chunked or unknown); a body with
      // a length but no content type is refused too. A bodyless POST (logout) has neither.
      const hasBody =
        contentType !== undefined || (length !== undefined && length !== "0") || c.req.header("transfer-encoding") !== undefined;
      if (hasBody) {
        const type = (contentType ?? "").split(";")[0]!.trim().toLowerCase();
        if (type !== "application/json") {
          throw new ApiError("unsupported_media_type", "Send the body as JSON with Content-Type: application/json.", {
            headers: { "Accept-Post": "application/json", "Accept-Patch": "application/json" },
          });
        }
      }
    }
    await next();
  });

/**
 * Builds a lookup from the registered routes so an unknown method on a known path answers
 * 405 with an Allow header (RFC 9110 §15.5.6) instead of a misleading 404.
 * Call after every route is registered.
 */
export function buildAllowLookup(app: Hono<AppEnv>): (path: string) => string[] {
  const routes = app.routes
    .filter((r) => r.method !== "ALL")
    .map((r) => ({
      method: r.method.toUpperCase(),
      pattern: new RegExp(
        "^" +
          r.path
            .split("/")
            .map((seg) => (seg.startsWith(":") ? "[^/]+" : seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
            .join("/") +
          "/?$",
      ),
    }));
  return (path) => {
    const methods = new Set(routes.filter((r) => r.pattern.test(path)).map((r) => r.method));
    if (methods.has("GET")) methods.add("HEAD");
    return [...methods].sort();
  };
}
