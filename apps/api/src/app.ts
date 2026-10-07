import { OpenAPIHono } from "@hono/zod-openapi";
import { bodyLimit } from "hono/body-limit";
import { secureHeaders } from "hono/secure-headers";
import type { AppDeps, AppEnv } from "./context.js";
import { ApiError, type ErrorBody } from "./lib/errors.js";
import { csrf } from "./middleware/csrf.js";
import { requestContext } from "./middleware/request-context.js";
import { schoolRoutes } from "./routes/school.js";
import { sessionRoutes } from "./routes/session.js";
import { systemRoutes } from "./routes/system.js";

export function createApp(deps: AppDeps) {
  const app = new OpenAPIHono<AppEnv>({
    // Every Zod validation failure leaves in the same error shape as everything else.
    defaultHook: (result, c) => {
      if (!result.success) {
        const body: ErrorBody = {
          error: {
            code: "validation_failed",
            message: "Some fields need fixing.",
            requestId: c.get("requestId"),
            details: result.error.issues.map((i) => ({ path: i.path.join("."), message: i.message, code: i.code })),
          },
        };
        return c.json(body, 422);
      }
    },
  });

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
        throw new ApiError(413, "payload_too_large", "Request body too large.");
      },
    }),
  );
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
        "Multi-tenant school registry API. The school is resolved from the request host; call it through the frontend's /api rewrite.",
    },
  });

  app.notFound((c) => c.json<ErrorBody>({ error: { code: "not_found", message: "Not found.", requestId: c.get("requestId") } }, 404));

  app.onError((err, c) => {
    const requestId = c.get("requestId");
    if (err instanceof ApiError) {
      for (const [k, v] of Object.entries(err.headers ?? {})) c.header(k, v);
      return c.json<ErrorBody>(
        { error: { code: err.code, message: err.message, requestId, ...(err.details === undefined ? {} : { details: err.details }) } },
        err.status,
      );
    }
    deps.logger.error("unhandled error", { err, requestId, path: c.req.path, method: c.req.method });
    return c.json<ErrorBody>({ error: { code: "internal", message: "Something went wrong on our side.", requestId } }, 500);
  });

  return app;
}

export type App = ReturnType<typeof createApp>;
