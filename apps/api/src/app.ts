import { swaggerUI } from "@hono/swagger-ui";
import { OpenAPIHono } from "@hono/zod-openapi";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import { secureHeaders } from "hono/secure-headers";
import type { AppDeps, AppEnv } from "./context.js";
import { MailDeliveryError } from "./lib/mailer.js";
import { ApiError, type ErrorCode, type FieldError, problemResponse, toPointer } from "./lib/errors.js";
import { csrf } from "./middleware/csrf.js";
import { buildAllowLookup, requireJsonBody, serverTiming } from "./middleware/http.js";
import { requestContext } from "./middleware/request-context.js";
import { authRoutes } from "./routes/auth.js";
import { invitationRoutes } from "./routes/invitations.js";
import { memberRoutes } from "./routes/members.js";
import { calendarRoutes } from "./routes/calendar.js";
import { homeRoutes } from "./routes/home.js";
import { classRoutes } from "./routes/classes.js";
import { subjectRoutes } from "./routes/subjects.js";
import { studentRoutes } from "./routes/students.js";
import { changeRoutes } from "./routes/changes.js";
import { importRoutes } from "./routes/imports.js";
import { brandingRoutes } from "./routes/branding.js";
import { trialRoutes } from "./routes/trials.js";
import { teacherRoutes } from "./routes/teachers.js";
import { parentRoutes } from "./routes/parents.js";
import { profileRoutes } from "./routes/profile.js";
import { teamRoutes } from "./routes/team.js";
import { resultsRoutes } from "./routes/results.js";
import { reportRoutes } from "./routes/reports.js";
import { devRoutes } from "./routes/dev.js";
import { schoolRoutes } from "./routes/school.js";
import { sessionRoutes } from "./routes/session.js";
import { signupRoutes } from "./routes/signup.js";
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
  const showDocs = deps.config.appEnv !== "production";
  const strictHeaders = secureHeaders({
    contentSecurityPolicy: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] },
    strictTransportSecurity: deps.config.protocol === "https" ? "max-age=63072000; includeSubDomains; preload" : false,
    xFrameOptions: "DENY",
    referrerPolicy: "strict-origin-when-cross-origin",
    crossOriginResourcePolicy: "same-origin",
  });
  // The /docs test page (never in production) loads Swagger UI from jsDelivr, so it gets its own,
  // looser policy; every API response keeps default-src 'none'.
  const docsHeaders = secureHeaders({
    contentSecurityPolicy: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net"],
      imgSrc: ["'self'", "data:", "https://cdn.jsdelivr.net"],
      connectSrc: ["'self'"],
      frameAncestors: ["'none'"],
    },
    xFrameOptions: "DENY",
  });
  // The staging outbox page needs its own inline styles and nothing else.
  const outboxHeaders = secureHeaders({
    contentSecurityPolicy: { defaultSrc: ["'none'"], styleSrc: ["'unsafe-inline'"], formAction: ["'self'"], frameAncestors: ["'none'"] },
    xFrameOptions: "DENY",
    referrerPolicy: "no-referrer",
  });
  app.use("*", (c, next) => {
    if (showDocs && c.req.path === "/docs") return docsHeaders(c, next);
    if (deps.config.outboxKey && c.req.path === "/dev/outbox") return outboxHeaders(c, next);
    return strictHeaders(c, next);
  });
  // No compression here: the frontend's edge compresses what reaches browsers, and API↔edge
  // traffic stays inside one region. Compressing twice only burns CPU.
  app.use("*", async (c, next) => {
    await next();
    if (!c.res.headers.has("Cache-Control")) c.res.headers.set("Cache-Control", "no-store");
  });
  // JSON bodies never need more than 256 KB, except a whole student list being imported (5,000
  // rows fit in 4 MB; Vercel itself refuses bodies over 4.5 MB).
  const bigBody = bodyLimit({
    maxSize: 4 * 1024 * 1024,
    onError: () => {
      throw new ApiError("payload_too_large", "An import can send at most 4 MB. Split the list into smaller files.");
    },
  });
  const smallBody = bodyLimit({
    maxSize: 256 * 1024,
    onError: () => {
      throw new ApiError("payload_too_large", "Request bodies are limited to 256 KB.");
    },
  });
  const logoBody = bodyLimit({
    maxSize: 400 * 1024,
    onError: () => {
      throw new ApiError("payload_too_large", "A logo can be at most 300 KB.");
    },
  });
  app.use("/v1/*", (c, next) => {
    if (c.req.path === "/v1/imports" || c.req.path === "/v1/imports/check") return bigBody(c, next);
    if (c.req.path === "/v1/school/logo") return logoBody(c, next);
    return smallBody(c, next);
  });
  app.use("/v1/*", requireJsonBody());
  app.use("/v1/*", csrf());

  app.route("/", systemRoutes);
  app.route("/", schoolRoutes);
  app.route("/", sessionRoutes);
  app.route("/", signupRoutes);
  app.route("/", authRoutes);
  app.route("/", invitationRoutes);
  app.route("/", memberRoutes);
  app.route("/", calendarRoutes);
  app.route("/", homeRoutes);
  app.route("/", classRoutes);
  app.route("/", subjectRoutes);
  app.route("/", studentRoutes);
  app.route("/", changeRoutes);
  app.route("/", teacherRoutes);
  app.route("/", parentRoutes);
  app.route("/", profileRoutes);
  app.route("/", teamRoutes);
  app.route("/", resultsRoutes);
  app.route("/", reportRoutes);
  app.route("/", importRoutes);
  app.route("/", brandingRoutes);
  app.route("/", trialRoutes);
  // Staging only: the route doesn't exist at all unless the outbox is switched on.
  if (deps.config.outboxKey) app.route("/", devRoutes);

  app.doc31("/openapi.json", {
    openapi: "3.1.0",
    ...(deps.config.allowSchoolQueryParam
      ? {
          servers: [
            { url: "/", description: "Main site: signup, find my school" },
            { url: "/s/{school}", description: "A school's address (staging)", variables: { school: { default: "surebloom" } } },
          ],
        }
      : {}),
    info: {
      title: "Brillianda API",
      version: "0.1.0",
      description:
        "Multi-tenant school registry API. The school is resolved from the request host; call it through the frontend's /api rewrite. " +
        "Errors are RFC 9457 problem details (application/problem+json); see docs/api-conventions.md.",
    },
  });

  if (showDocs) {
    app.get("/docs", swaggerUI({ url: "/openapi.json", persistAuthorization: true, withCredentials: true }));
  }

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
    // The email provider refused or was down (already logged by the mailer). The request did not
    // complete its purpose, so say so plainly instead of a generic 500.
    if (err instanceof MailDeliveryError) {
      return problemResponse(c, "service_unavailable", "We could not send the email just now. Try again in a minute.", {
        headers: { "retry-after": "60" },
      });
    }
    // A uniqueness or reference rule enforced by Postgres that a handler's own check didn't catch
    // (usually two requests racing). Nothing was written: the transaction rolled back.
    const pg = (err as { cause?: { code?: string; constraint?: string } }).cause;
    if (pg?.code === "23505") {
      deps.logger.warn("unique violation", { constraint: pg.constraint, requestId: c.get("requestId"), path: c.req.path });
      if (pg.constraint === "students_school_admission_idx") {
        return problemResponse(c, "validation_failed", "Another student has this admission number.", {
          extensions: { errors: [{ pointer: "#/admissionNo", detail: "Already used by another student", code: "taken" }] },
        });
      }
      return problemResponse(c, "conflict", "Something with the same name or number was just saved. Reload and try again.");
    }
    if (pg?.code === "23503") {
      deps.logger.warn("reference violation", { constraint: pg.constraint, requestId: c.get("requestId"), path: c.req.path });
      return problemResponse(c, "conflict", "This is still used by other records, so it can’t be removed. Archive it instead.");
    }
    deps.logger.error("unhandled error", { err, requestId: c.get("requestId"), path: c.req.path, method: c.req.method });
    return problemResponse(c, "internal", "Quote the requestId if you report this.");
  });

  return app;
}

export type App = ReturnType<typeof createApp>;
