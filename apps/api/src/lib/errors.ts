import { z } from "@hono/zod-openapi";
import type { ContentfulStatusCode } from "hono/utils/http-status";

/** Stable, machine-readable codes the frontend switches on. Messages are for humans. */
export type ErrorCode =
  | "bad_request"
  | "payload_too_large"
  | "validation_failed"
  | "unauthenticated"
  | "forbidden"
  | "csrf_rejected"
  | "school_not_found"
  | "school_unavailable"
  | "not_found"
  | "conflict"
  | "rate_limited"
  | "internal";

export class ApiError extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
    readonly headers?: Record<string, string>,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export const errors = {
  unauthenticated: () => new ApiError(401, "unauthenticated", "Please sign in."),
  forbidden: () => new ApiError(403, "forbidden", "You do not have access to this."),
  schoolNotFound: () => new ApiError(404, "school_not_found", "There is no school at this address."),
  schoolUnavailable: () => new ApiError(404, "school_unavailable", "This school is not available right now."),
  rateLimited: (retryAfterSec: number) =>
    new ApiError(429, "rate_limited", "Too many attempts. Please wait and try again.", { retryAfterSec }, {
      "Retry-After": String(retryAfterSec),
    }),
};

export const ErrorSchema = z
  .object({
    error: z.object({
      code: z.string().openapi({ example: "unauthenticated" }),
      message: z.string(),
      requestId: z.string().optional(),
      details: z.unknown().optional(),
    }),
  })
  .openapi("Error");

export type ErrorBody = z.infer<typeof ErrorSchema>;
