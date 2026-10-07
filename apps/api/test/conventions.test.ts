/**
 * The API response conventions (docs/api-conventions.md), enforced.
 */
import { createRoute, z } from "@hono/zod-openapi";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ERROR_CODES, PROBLEMS } from "../src/lib/errors.js";
import { createHarness, seedSchoolWithMember, signIn, type Harness } from "./helpers.js";

let h: Harness;
let token: string;
const HOST = "alpha.brillianda.test";
const ORIGIN = `https://${HOST}`;

beforeAll(async () => {
  h = await createHarness();
  const { school, user } = await seedSchoolWithMember(h, "alpha");
  token = await signIn(h, school.id, user.id);

  // A route with a body schema, to exercise validation errors.
  h.app.openapi(
    createRoute({
      method: "post",
      path: "/v1/__test/students",
      request: {
        body: {
          content: {
            "application/json": {
              schema: z.object({
                firstName: z.string().min(1),
                guardian: z.object({ phone: z.string().regex(/^\+234\d{10}$/) }),
                "a/b": z.string().optional(),
              }),
            },
          },
        },
        query: z.object({ dryRun: z.enum(["true", "false"]).optional() }),
      },
      responses: { 201: { description: "Created" } },
    }),
    (c) => c.json({ ok: true }, 201),
  );
});

afterAll(async () => {
  await h?.t.close();
});

async function problem(res: Response) {
  expect(res.headers.get("content-type")).toBe("application/problem+json");
  return (await res.json()) as Record<string, unknown> & { code: string; status: number; type: string; title: string };
}

describe("problem details (RFC 9457)", () => {
  it("every error has type, title, status, instance, code and requestId, and status matches the HTTP status", async () => {
    const res = await h.app.request("/v1/me", { headers: { host: HOST } });
    expect(res.status).toBe(401);
    const body = await problem(res);
    expect(body).toMatchObject({
      type: "https://brillianda.com/problems/unauthenticated",
      title: "Sign in required",
      status: 401,
      instance: "/v1/me",
      code: "unauthenticated",
    });
    expect(body.requestId).toBe(res.headers.get("x-request-id"));
  });

  it("the catalog never maps one code to two statuses, and every status is an error status", () => {
    for (const code of ERROR_CODES) {
      expect(PROBLEMS[code].status).toBeGreaterThanOrEqual(400);
      expect(PROBLEMS[code].title.length).toBeGreaterThan(0);
    }
  });

  it("validation errors list every field with a JSON Pointer", async () => {
    const res = await h.app.request("/v1/__test/students", {
      method: "POST",
      headers: { host: HOST, origin: ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({ firstName: "", guardian: { phone: "0803" } }),
    });
    expect(res.status).toBe(422);
    const body = await problem(res);
    expect(body.code).toBe("validation_failed");
    const errors = body.errors as { pointer?: string; parameter?: string; code: string }[];
    expect(errors.map((e) => e.pointer ?? `?${e.parameter}`).sort()).toEqual(["#/firstName", "#/guardian/phone"]);
  });

  it("query parameter errors name the parameter", async () => {
    const res = await h.app.request("/v1/__test/students?dryRun=maybe", {
      method: "POST",
      headers: { host: HOST, origin: ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({ firstName: "Ada", guardian: { phone: "+2348030000001" } }),
    });
    const body = await problem(res);
    expect(body.errors).toEqual([expect.objectContaining({ parameter: "dryRun" })]);
  });

  it("escapes / and ~ in pointers (RFC 6901)", async () => {
    const res = await h.app.request("/v1/__test/students", {
      method: "POST",
      headers: { host: HOST, origin: ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({ firstName: "Ada", guardian: { phone: "+2348030000001" }, "a/b": 5 }),
    });
    const body = await problem(res);
    expect((body.errors as { pointer: string }[])[0]!.pointer).toBe("#/a~1b");
  });

  it("valid input passes through", async () => {
    const res = await h.app.request("/v1/__test/students", {
      method: "POST",
      headers: { host: HOST, origin: ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({ firstName: "Ada", guardian: { phone: "+2348030000001" } }),
    });
    expect(res.status).toBe(201);
  });
});

describe("HTTP rules", () => {
  it("405 with Allow for a known path and wrong method", async () => {
    const res = await h.app.request("/v1/me", { method: "DELETE", headers: { host: HOST, origin: ORIGIN } });
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET, HEAD");
    const body = await problem(res);
    expect(body.allow).toEqual(["GET", "HEAD"]);
  });

  it("404 only for paths that do not exist", async () => {
    const res = await h.app.request("/v1/nothing-here", { headers: { host: HOST } });
    expect(res.status).toBe(404);
    expect((await problem(res)).code).toBe("not_found");
  });

  it("415 for a body that is not JSON", async () => {
    const res = await h.app.request("/v1/__test/students", {
      method: "POST",
      headers: { host: HOST, origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" },
      body: "firstName=Ada",
    });
    expect(res.status).toBe(415);
    expect((await problem(res)).code).toBe("unsupported_media_type");
  });

  it("413 for an oversized body", async () => {
    const res = await h.app.request("/v1/__test/students", {
      method: "POST",
      headers: { host: HOST, origin: ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({ firstName: "x".repeat(300 * 1024), guardian: { phone: "+2348030000001" } }),
    });
    expect(res.status).toBe(413);
    expect((await problem(res)).code).toBe("payload_too_large");
  });

  it("reports rate limits with the IETF RateLimit and RateLimit-Policy headers", async () => {
    const res = await h.app.request("/v1/me", { headers: { host: HOST, cookie: `bd_session=${token}` } });
    expect(res.status).toBe(200);
    expect(res.headers.get("ratelimit-policy")).toMatch(/^"api:ip";q=\d+;w=\d+$/);
    expect(res.headers.get("ratelimit")).toMatch(/^"api:ip";r=\d+;t=\d+$/);
  });

  it("sends Server-Timing and a request id on every response", async () => {
    const res = await h.app.request("/health");
    expect(res.headers.get("server-timing")).toMatch(/^app;dur=\d+(\.\d)?$/);
    expect(res.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("keeps a sane incoming x-request-id so logs line up across services", async () => {
    const res = await h.app.request("/health", { headers: { "x-request-id": "frontend-abc12345" } });
    expect(res.headers.get("x-request-id")).toBe("frontend-abc12345");
  });

  it("400 bad_request (not 500) for malformed JSON", async () => {
    const res = await h.app.request("/v1/__test/students", {
      method: "POST",
      headers: { host: HOST, origin: ORIGIN, "content-type": "application/json" },
      body: '{"firstName": "Ada",',
    });
    expect(res.status).toBe(400);
    expect((await problem(res)).code).toBe("bad_request");
  });

  it("a bodyless POST (like logout) is not mistaken for a non-JSON body", async () => {
    const res = await h.app.request("/v1/auth/logout", { method: "POST", headers: { host: HOST, origin: ORIGIN } });
    expect(res.status).toBe(204);
  });

  it("serializes timestamps as ISO 8601 UTC and ids as UUID strings", async () => {
    const res = await h.app.request("/v1/me", { headers: { host: HOST, cookie: `bd_session=${token}` } });
    const body = (await res.json()) as { user: { id: string } };
    expect(body.user.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(JSON.stringify(new Date(Date.UTC(2026, 9, 7, 19, 0)))).toBe('"2026-10-07T19:00:00.000Z"');
  });
});

describe("the contract", () => {
  it("documents every error code in docs/api-conventions.md", () => {
    const doc = readFileSync(new URL("../../../docs/api-conventions.md", import.meta.url), "utf8");
    const missing = ERROR_CODES.filter((code) => !doc.includes(`\`${code}\``));
    expect(missing).toEqual([]);
  });

  it("publishes problem responses as application/problem+json with the code enum", async () => {
    const doc = (await (await h.app.request("/openapi.json")).json()) as {
      components: { schemas: { Problem: { properties: { code: { enum: string[] } } } } };
      paths: Record<string, Record<string, { responses: Record<string, { content?: Record<string, unknown> }> }>>;
    };
    expect(doc.components.schemas.Problem.properties.code.enum.sort()).toEqual([...ERROR_CODES].sort());
    expect(Object.keys(doc.paths["/v1/me"]!.get!.responses["401"]!.content!)).toEqual(["application/problem+json"]);
  });
});
