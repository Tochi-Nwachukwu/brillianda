/**
 * Every error the API can return, in one place. Responses follow RFC 9457 Problem Details
 * (application/problem+json). docs/api-conventions.md documents each code, and a test fails
 * if a code here is missing from that page.
 *
 * Rules:
 *  - `code` is the stable machine identifier the frontend switches on. Never rename one;
 *    add a new code and retire the old.
 *  - `title` is fixed per code. `detail` explains this occurrence, for humans, and is never parsed.
 *  - Status codes come from the catalog, so the same code always means the same status.
 */
import { z } from "@hono/zod-openapi";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

export const PROBLEM_TYPE_BASE = "https://brillianda.com/problems/";

export const PROBLEMS = {
  bad_request: { status: 400, title: "Bad request" },
  validation_failed: { status: 422, title: "Some fields need fixing" },
  unauthenticated: { status: 401, title: "Sign in required" },
  forbidden: { status: 403, title: "Not allowed" },
  csrf_rejected: { status: 403, title: "Request did not come from this school's site" },
  not_found: { status: 404, title: "Not found" },
  school_not_found: { status: 404, title: "No school at this address" },
  school_unavailable: { status: 404, title: "School unavailable" },
  method_not_allowed: { status: 405, title: "Method not allowed" },
  conflict: { status: 409, title: "Conflict with current state" },
  payload_too_large: { status: 413, title: "Request body too large" },
  unsupported_media_type: { status: 415, title: "Unsupported content type" },
  rate_limited: { status: 429, title: "Too many requests" },
  internal: { status: 500, title: "Something went wrong on our side" },
  service_unavailable: { status: 503, title: "Temporarily unavailable" },
} as const satisfies Record<string, { status: ContentfulStatusCode; title: string }>;

export type ErrorCode = keyof typeof PROBLEMS;
export const ERROR_CODES = Object.keys(PROBLEMS) as [ErrorCode, ...ErrorCode[]];

/** One field-level problem inside a validation_failed response. */
export interface FieldError {
  /** JSON Pointer into the request body (RFC 6901), e.g. "#/guardian/phone". */
  pointer?: string;
  /** Name of the query or path parameter, when the problem is not in the body. */
  parameter?: string;
  detail: string;
  /** Zod issue code, e.g. "too_small", "invalid_format". */
  code: string;
}

export interface ProblemOptions {
  /** Machine-readable extras, e.g. { retryAfterSec } or { errors: FieldError[] }. */
  extensions?: Record<string, unknown>;
  headers?: Record<string, string>;
}

export class ApiError extends Error {
  readonly status: ContentfulStatusCode;

  constructor(
    readonly code: ErrorCode,
    /** For humans: what happened this time and how to fix it. Never include secrets. */
    readonly detail?: string,
    readonly options: ProblemOptions = {},
  ) {
    super(detail ?? PROBLEMS[code].title);
    this.name = "ApiError";
    this.status = PROBLEMS[code].status;
  }
}

/** Shorthands for errors raised in several places. */
export const errors = {
  unauthenticated: () => new ApiError("unauthenticated", "Please sign in."),
  forbidden: () => new ApiError("forbidden", "Your role in this school does not allow this."),
  schoolNotFound: () => new ApiError("school_not_found", "There is no school at this address."),
  schoolUnavailable: () => new ApiError("school_unavailable", "This school is not available right now."),
  rateLimited: (retryAfterSec: number) =>
    new ApiError("rate_limited", `Too many attempts. Try again in ${retryAfterSec} seconds.`, {
      extensions: { retryAfterSec },
      headers: { "Retry-After": String(retryAfterSec) },
    }),
};

/** Writes an RFC 9457 response. The only place error bodies are built. */
export function problemResponse(c: Context, code: ErrorCode, detail?: string, options: ProblemOptions = {}): Response {
  const { status, title } = PROBLEMS[code];
  const body: Record<string, unknown> = {
    type: `${PROBLEM_TYPE_BASE}${code.replaceAll("_", "-")}`,
    title,
    status,
    ...(detail ? { detail } : {}),
    instance: c.req.path,
    code,
    requestId: (c.get("requestId") as string | undefined) ?? "",
    ...options.extensions,
  };
  const headers: Record<string, string> = { "Content-Type": "application/problem+json", ...options.headers };
  return c.body(JSON.stringify(body), status, headers);
}

/** Converts a Zod issue path into a JSON Pointer (RFC 6901). */
export function toPointer(path: readonly PropertyKey[]): string {
  return "#/" + path.map((p) => String(p).replaceAll("~", "~0").replaceAll("/", "~1")).join("/");
}

export const ProblemSchema = z
  .object({
    type: z.string().url().openapi({ example: "https://brillianda.com/problems/unauthenticated" }),
    title: z.string().openapi({ example: "Sign in required" }),
    status: z.number().int().openapi({ example: 401 }),
    detail: z.string().optional().openapi({ example: "Please sign in." }),
    instance: z.string().openapi({ example: "/v1/me" }),
    code: z.enum(ERROR_CODES).openapi({ description: "Stable machine-readable code. Switch on this." }),
    requestId: z.string().openapi({ description: "Quote this when reporting a problem." }),
    errors: z
      .array(
        z.object({
          pointer: z.string().optional(),
          parameter: z.string().optional(),
          detail: z.string(),
          code: z.string(),
        }),
      )
      .optional()
      .openapi({ description: "validation_failed only: one entry per field." }),
    retryAfterSec: z.number().int().optional().openapi({ description: "rate_limited only." }),
    allow: z.array(z.string()).optional().openapi({ description: "method_not_allowed only." }),
  })
  .openapi("Problem");

export type Problem = z.infer<typeof ProblemSchema>;

/** OpenAPI response entry for a problem status, so every route documents its errors the same way. */
export function problemContent(description: string) {
  return { description, content: { "application/problem+json": { schema: ProblemSchema } } } as const;
}
