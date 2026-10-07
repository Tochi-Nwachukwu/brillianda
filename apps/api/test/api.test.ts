import { auditLog, eq, schools, sessions, withSchool } from "@brillianda/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { RATE_RULES } from "../src/lib/rate-limit.js";
import { schoolRoute } from "../src/school-route.js";
import { addMember, createHarness, PROXY_SECRET, seedSchoolWithMember, signIn, type Harness } from "./helpers.js";

let h: Harness;
let alpha: Awaited<ReturnType<typeof seedSchoolWithMember>>;
let bravo: Awaited<ReturnType<typeof seedSchoolWithMember>>;

const ALPHA = "alpha.brillianda.test";
const BRAVO = "bravo.brillianda.test";
const cookie = (token: string) => ({ cookie: `bd_session=${token}` });

beforeAll(async () => {
  h = await createHarness();
  alpha = await seedSchoolWithMember(h, "alpha");
  bravo = await seedSchoolWithMember(h, "bravo");
  await seedSchoolWithMember(h, "frozen", { status: "suspended" });

  // Test-only routes that exercise schoolRoute() edge cases.
  h.app.post("/v1/__test/owner-only", async (c) =>
    c.json(await schoolRoute(c, { roles: ["owner"] }, async () => ({ ok: true }))),
  );
  h.app.post("/v1/__test/audit-then-fail", async (c) =>
    c.json(
      await schoolRoute(c, {}, async ({ audit }) => {
        audit({ action: "test.should_not_persist", entity: "test" });
        throw new Error("boom");
      }),
    ),
  );
  h.app.post("/v1/__test/audit-ok", async (c) =>
    c.json(
      await schoolRoute(c, {}, async ({ audit, school }) => {
        audit({ action: "test.persisted", entity: "school", entityId: school.id, changes: { a: 1 } });
        return { ok: true };
      }),
    ),
  );
  h.app.post("/v1/__test/limited", async (c) =>
    c.json(await schoolRoute(c, { userRateLimit: { name: "test", limit: 2, windowSec: 60 } }, async () => ({ ok: true }))),
  );
});

afterAll(async () => {
  await h?.t.close();
});

describe("system", () => {
  it("is alive and ready", async () => {
    expect((await h.app.request("/health")).status).toBe(200);
    expect(await (await h.app.request("/ready")).json()).toEqual({ ok: true });
  });

  it("publishes an OpenAPI document", async () => {
    const doc = (await (await h.app.request("/openapi.json")).json()) as { paths: Record<string, unknown> };
    expect(Object.keys(doc.paths)).toEqual(expect.arrayContaining(["/v1/school", "/v1/me", "/v1/auth/logout"]));
  });

  it("sends security headers and no-store by default", async () => {
    const res = await h.app.request("/health");
    expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(res.headers.get("strict-transport-security")).toContain("max-age=");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-request-id")).toBeTruthy();
  });

  it("returns the standard error shape for unknown paths", async () => {
    const res = await h.app.request("/nope");
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("not_found");
  });
});

describe("school resolution comes from the host only", () => {
  it("serves the school at its own address", async () => {
    const res = await h.app.request("/v1/school", { headers: { host: ALPHA } });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ subdomain: "alpha", name: "School alpha" });
  });

  it.each([
    ["unknown school", "nobody.brillianda.test", "school_not_found"],
    ["suspended school", "frozen.brillianda.test", "school_unavailable"],
    ["apex", "brillianda.test", "school_not_found"],
    ["reserved name", "api.brillianda.test", "school_not_found"],
    ["foreign domain", "alpha.evil.test", "school_not_found"],
  ])("404s for %s", async (_label, host, code) => {
    const res = await h.app.request("/v1/school", { headers: { host } });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(code);
  });

  it("ignores x-forwarded-host unless the proxy secret is presented", async () => {
    const spoofed = await h.app.request("/v1/school", { headers: { host: ALPHA, "x-forwarded-host": BRAVO } });
    expect(((await spoofed.json()) as { subdomain: string }).subdomain).toBe("alpha");

    const wrongSecret = await h.app.request("/v1/school", {
      headers: { host: ALPHA, "x-forwarded-host": BRAVO, "x-brillianda-proxy-secret": "guess" },
    });
    expect(((await wrongSecret.json()) as { subdomain: string }).subdomain).toBe("alpha");

    const proxied = await h.app.request("/v1/school", {
      headers: { host: "api.internal", "x-forwarded-host": BRAVO, "x-brillianda-proxy-secret": PROXY_SECRET },
    });
    expect(((await proxied.json()) as { subdomain: string }).subdomain).toBe("bravo");
  });

  it("ignores tenant-ish headers and query params", async () => {
    const res = await h.app.request(`/v1/school?school=bravo&school_id=${bravo.school.id}`, {
      headers: { host: ALPHA, "x-tenant": "bravo", "x-school-id": bravo.school.id },
    });
    expect(((await res.json()) as { subdomain: string }).subdomain).toBe("alpha");
  });

  it("accepts ?school= only when the preview flag is on", async () => {
    const preview = createApp({ ...h.deps, config: { ...h.deps.config, allowSchoolQueryParam: true } });
    const res = await preview.request("/v1/school?school=bravo", { headers: { host: "preview-123.vercel.app" } });
    expect(((await res.json()) as { subdomain: string }).subdomain).toBe("bravo");
  });
});

describe("sessions", () => {
  it("requires a session", async () => {
    const res = await h.app.request("/v1/me", { headers: { host: ALPHA } });
    expect(res.status).toBe(401);
  });

  it("returns the user and their role in this school", async () => {
    const token = await signIn(h, alpha.school.id, alpha.user.id);
    const res = await h.app.request("/v1/me", { headers: { host: ALPHA, ...cookie(token) } });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      user: { email: "owner@alpha.test", emailVerified: false },
      membership: { role: "owner" },
      school: { subdomain: "alpha" },
    });
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("does not accept alpha's session at bravo's address", async () => {
    const token = await signIn(h, alpha.school.id, alpha.user.id);
    const res = await h.app.request("/v1/me", { headers: { host: BRAVO, ...cookie(token) } });
    expect(res.status).toBe(401);
  });

  it("logs out: deletes the session, clears the cookie and writes an audit entry", async () => {
    const token = await signIn(h, alpha.school.id, alpha.user.id);
    const res = await h.app.request("/v1/auth/logout", {
      method: "POST",
      headers: { host: ALPHA, origin: `https://${ALPHA}`, ...cookie(token) },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("set-cookie")).toMatch(/bd_session=;.*Expires=Thu, 01 Jan 1970/);
    expect((await h.app.request("/v1/me", { headers: { host: ALPHA, ...cookie(token) } })).status).toBe(401);
    const logouts = await withSchool(h.db, alpha.school.id, (tx) =>
      tx.select().from(auditLog).where(eq(auditLog.action, "auth.logout")),
    );
    expect(logouts.length).toBeGreaterThanOrEqual(1);
  });

  it("sets a __Host- Secure cookie in https mode", async () => {
    const secure = createApp({ ...h.deps, config: { ...h.deps.config, secureCookies: true } });
    const res = await secure.request("/v1/auth/logout", { method: "POST", headers: { host: ALPHA, origin: `https://${ALPHA}` } });
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toMatch(/^__Host-bd_session=/);
    expect(setCookie).toMatch(/Secure/);
    expect(setCookie).toMatch(/HttpOnly/);
    expect(setCookie).toMatch(/SameSite=Lax/);
    expect(setCookie).not.toMatch(/Domain=/i);
  });
});

describe("CSRF", () => {
  it.each([
    ["no origin", {}],
    ["another site", { origin: "https://evil.test" }],
    ["another school", { origin: `https://${BRAVO}` }],
    ["http downgrade", { origin: `http://${ALPHA}` }],
  ])("rejects a POST with %s", async (_label, extra) => {
    const res = await h.app.request("/v1/auth/logout", { method: "POST", headers: { host: ALPHA, ...extra } });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("csrf_rejected");
  });

  it("accepts a same-origin Referer when Origin is absent", async () => {
    const res = await h.app.request("/v1/auth/logout", {
      method: "POST",
      headers: { host: ALPHA, referer: `https://${ALPHA}/settings` },
    });
    expect(res.status).toBe(204);
  });
});

describe("schoolRoute()", () => {
  const post = (path: string, token: string, host = ALPHA) =>
    h.app.request(path, { method: "POST", headers: { host, origin: `https://${host}`, ...cookie(token) } });

  it("enforces roles", async () => {
    const admin = await addMember(h, alpha.school.id, "admin@alpha.test", "admin");
    const adminToken = await signIn(h, alpha.school.id, admin.id);
    expect((await post("/v1/__test/owner-only", adminToken)).status).toBe(403);
    const ownerToken = await signIn(h, alpha.school.id, alpha.user.id);
    expect((await post("/v1/__test/owner-only", ownerToken)).status).toBe(200);
  });

  it("writes audit entries in the same transaction as the work", async () => {
    const token = await signIn(h, alpha.school.id, alpha.user.id);
    expect((await post("/v1/__test/audit-ok", token)).status).toBe(200);
    const rows = await withSchool(h.db, alpha.school.id, (tx) =>
      tx.select().from(auditLog).where(eq(auditLog.action, "test.persisted")),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actorUserId: alpha.user.id, entityId: alpha.school.id, changes: { a: 1 } });
  });

  it("rolls the audit entry back when the handler fails, and hides the error", async () => {
    const token = await signIn(h, alpha.school.id, alpha.user.id);
    const res = await post("/v1/__test/audit-then-fail", token);
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("internal");
    expect(body.error.message).not.toContain("boom");
    const rows = await withSchool(h.db, alpha.school.id, (tx) =>
      tx.select().from(auditLog).where(eq(auditLog.action, "test.should_not_persist")),
    );
    expect(rows).toHaveLength(0);
  });

  it("rate limits per user with Retry-After", async () => {
    const token = await signIn(h, alpha.school.id, alpha.user.id);
    expect((await post("/v1/__test/limited", token)).status).toBe(200);
    expect((await post("/v1/__test/limited", token)).status).toBe(200);
    const third = await post("/v1/__test/limited", token);
    expect(third.status).toBe(429);
    expect(Number(third.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  it("refuses everything once the school is suspended", async () => {
    const token = await signIn(h, bravo.school.id, bravo.user.id);
    expect((await h.app.request("/v1/me", { headers: { host: BRAVO, ...cookie(token) } })).status).toBe(200);
    await h.db.update(schools).set({ status: "suspended" }).where(eq(schools.id, bravo.school.id));
    const res = await h.app.request("/v1/me", { headers: { host: BRAVO, ...cookie(token) } });
    expect(res.status).toBe(404);
    await h.db.update(schools).set({ status: "active" }).where(eq(schools.id, bravo.school.id));
  });

  it("does not leave sessions behind for a removed member", async () => {
    const temp = await addMember(h, alpha.school.id, "temp@alpha.test", "admin");
    await signIn(h, alpha.school.id, temp.id);
    await withSchool(h.db, alpha.school.id, async (tx) => {
      const { schoolMembers } = await import("@brillianda/db");
      await tx.delete(schoolMembers).where(eq(schoolMembers.userId, temp.id));
    });
    const left = await withSchool(h.db, alpha.school.id, (tx) => tx.select().from(sessions).where(eq(sessions.userId, temp.id)));
    expect(left).toHaveLength(0);
  });

  it("keeps the API-wide per-IP rule defined", () => {
    expect(RATE_RULES.apiPerIp.limit).toBeGreaterThan(0);
  });
});
