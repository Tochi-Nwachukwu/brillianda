import { OpenAPIHono } from "@hono/zod-openapi";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import { secureHeaders } from "hono/secure-headers";
import type { AppDeps, AppEnv } from "./context.js";
import { ApiError, type ErrorCode, type FieldError, problemResponse, toPointer } from "./lib/errors.js";
import { csrf } from "./middleware/csrf.js";
import { buildAllowLookup, requireJsonBody, serverTiming } from "./middleware/http.js";
import { requestContext } from "./middleware/request-context.js";
import { schoolRoutes } from "./routes/school.js";
import { sessionRoutes } from "./routes/session.js";
import { systemRoutes } from "./routes/system.js";

const HTTP_EXCEPTION_CODES: Partial<Record<number, ErrorCode>> = {
  400: "bad_request",
  401: "unauthenticated",
  403: "forbidden",
  404: "not_found",
  405: "method_not_allowed",
  409: "conflict",
  413: "payload_too_large",
  415: "unsupported_media_type",
  429: "rate_limited",
  503: "service_unavailable",
};

export function createApp(deps: AppDeps) {
  const app = new OpenAPIHono<AppEnv>({
    // Every Zod validation failure leaves as one validation_failed problem listing each field.
    defaultHook: (result, c) => {
      if (!result.success) {
        const inBody = result.target === "json" || result.target === "form";
        const errors: FieldError[] = result.error.issues.map((i) => ({
          ...(inBody ? { pointer: toPointer(i.path) } : { parameter: i.path.map(String).join(".") }),
          detail: i.message,
          code: i.code,
        }));
        return problemResponse(c, "validation_failed", `${errors.length} field(s) need fixing.`, { extensions: { errors } });
      }
    },
  });

  app.use("*", serverTiming());
  app.use("*", requestContext(deps));
  app.use(
    "*",
    secureHeaders({
      contentSecurityPolicy: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] },
      strictTransportSecurity: deps.config.protocol === "https" ? "max-age=63072000; includeSubDomains; preload" : false,
      xFrameOptions: "DENY",
      referrerPolicy: "strict-origin-when-cross-origin",
      crossOriginResourcePolicy: "same-origin",
    }),
  );
  // No compression here: the frontend's edge compresses what reaches browsers, and API↔edge
  // traffic stays inside one region. Compressing twice only burns CPU.
  app.use("*", async (c, next) => {
    await next();
    if (!c.res.headers.has("Cache-Control")) c.res.headers.set("Cache-Control", "no-store");
  });
  // Uploads get their own route-level limits later; JSON bodies never need more than this.
  app.use(
    "/v1/*",
    bodyLimit({
      maxSize: 256 * 1024,
      onError: () => {
        throw new ApiError("payload_too_large", "Request bodies are limited to 256 KB.");
      },
    }),
  );
  app.use("/v1/*", requireJsonBody());
  app.use("/v1/*", csrf());

  app.route("/", systemRoutes);
  app.route("/", schoolRoutes);
  app.route("/", sessionRoutes);

  app.doc31("/openapi.json", {
    openapi: "3.1.0",
    info: {
      title: "Brillianda API",
      version: "0.1.0",
      description:
        "Multi-tenant school registry API. The school is resolved from the request host; call it through the frontend's /api rewrite. " +
        "Errors are RFC 9457 problem details (application/problem+json); see docs/api-conventions.md.",
    },
  });

  const allowedMethods = buildAllowLookup(app);

  app.notFound((c) => {
    const allow = allowedMethods(c.req.path);
    if (allow.length) {
      return problemResponse(c, "method_not_allowed", `${c.req.method} is not supported here.`, {
        extensions: { allow },
        headers: { Allow: allow.join(", ") },
      });
    }
    return problemResponse(c, "not_found", "No endpoint at this path.");
  });

  app.onError((err, c) => {
    if (err instanceof ApiError) {
      return problemResponse(c, err.code, err.detail, err.options);
    }
    // Hono's own request errors (malformed JSON, bad content type in a validator) are client
    // errors, not 500s. Map them onto the catalog.
    if (err instanceof HTTPException) {
      const code = HTTP_EXCEPTION_CODES[err.status] ?? (err.status < 500 ? "bad_request" : "internal");
      return problemResponse(c, code, err.status < 500 ? err.message : undefined);
    }
    deps.logger.error("unhandled error", { err, requestId: c.get("requestId"), path: c.req.path, method: c.req.method });
    return problemResponse(c, "internal", "Quote the requestId if you report this.");
  });

  return app;
}

export type App = ReturnType<typeof createApp>;
