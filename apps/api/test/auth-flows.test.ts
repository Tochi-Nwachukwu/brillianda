import { auditLog, eq, schoolMembers, sessions, withSchool } from "@brillianda/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { APEX, browser, schoolHost, signUpAndLand, tokenFrom, waitForMail } from "./flows.js";
import { createHarness, type Harness } from "./helpers.js";

let h: Harness;
let oakId: string;
let pineId: string;
const OWNER = "chidi@oak.test";
const PASSWORD = "oak-password-1";

beforeAll(async () => {
  h = await createHarness();
  ({ schoolId: oakId } = await signUpAndLand(h, { schoolName: "Oak College", subdomain: "oak", email: OWNER, password: PASSWORD, fullName: "Chidi Obi" }));
  ({ schoolId: pineId } = await signUpAndLand(h, { schoolName: "Pine School", subdomain: "pine", email: "ada@pine.test", password: "pine-password" }));
});
afterAll(async () => {
  await h?.t.close();
});
beforeEach(() => h.mail.clear());

const login = (host: string, email: string, password: string) => browser(h, schoolHost(host)).post("/v1/auth/login", { email, password });

describe("login", () => {
  it("signs in on the school's address and records it", async () => {
    const oak = browser(h, schoolHost("oak"));
    const res = await oak.post("/v1/auth/login", { email: "CHIDI@oak.test", password: PASSWORD });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ user: { email: OWNER, fullName: "Chidi Obi" }, membership: { role: "owner" } });
    expect(oak.cookies.get("bd_session")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect((await oak.get("/v1/me")).status).toBe(200);
    const logins = await withSchool(h.db, oakId, (tx) => tx.select().from(auditLog).where(eq(auditLog.action, "auth.login")));
    expect(logins.some((l) => (l.changes as { method?: string }).method === "password")).toBe(true);
  });

  it("gives the same answer for wrong password, unknown email and not-a-member", async () => {
    const bodies = await Promise.all([
      login("oak", OWNER, "wrong-password"),
      login("oak", "nobody@nowhere.test", PASSWORD),
      login("oak", "ada@pine.test", "pine-password"), // real account, right password, wrong school
    ]);
    const shapes = await Promise.all(bodies.map(async (r) => ({ status: r.status, ...(({ requestId: _r, ...rest }) => rest)((await r.json()) as Record<string, unknown>) })));
    expect(shapes[0]).toMatchObject({ status: 401, code: "invalid_credentials" });
    expect(shapes[1]).toEqual(shapes[0]);
    expect(shapes[2]).toEqual(shapes[0]);
  });

  it("records failed attempts on a real member for the school to see", async () => {
    await login("oak", OWNER, "nope-nope-nope");
    const failed = await withSchool(h.db, oakId, (tx) => tx.select().from(auditLog).where(eq(auditLog.action, "auth.login_failed")));
    expect(failed.length).toBeGreaterThan(0);
    // ...and nothing about it lands in another school
    const leaked = await withSchool(h.db, pineId, (tx) => tx.select().from(auditLog).where(eq(auditLog.action, "auth.login_failed")));
    expect(leaked).toHaveLength(0);
  });

  it("refuses a suspended member", async () => {
    await signUpAndLand(h, { schoolName: "Elm School", subdomain: "elm", email: "suspended@elm.test", password: "elm-password" });
    const elmId = (await (await browser(h, schoolHost("elm")).get("/v1/school")).json()) as { id: string };
    await withSchool(h.db, elmId.id, (tx) => tx.update(schoolMembers).set({ status: "suspended" }));
    expect((await login("elm", "suspended@elm.test", "elm-password")).status).toBe(401);
  });

  it("rate limits guessing on one email", async () => {
    let last: Response | undefined;
    for (let i = 0; i < 12; i++) last = await login("pine", "target@pine.test", `guess-${i}`);
    expect(last!.status).toBe(429);
    expect(Number(last!.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  it("does not exist on the main site", async () => {
    const res = await browser(h, APEX).post("/v1/auth/login", { email: OWNER, password: PASSWORD });
    expect(res.status).toBe(404);
  });
});

describe("magic link", () => {
  it("answers 202 either way, emails only real members, and signs in once", async () => {
    const oak = browser(h, schoolHost("oak"));
    expect((await oak.post("/v1/auth/magic-link", { email: "stranger@x.test" })).status).toBe(202);
    expect((await oak.post("/v1/auth/magic-link", { email: OWNER })).status).toBe(202);
    const mail = await waitForMail(h, OWNER, "login_link");
    expect(mail.text).toContain("https://oak.brillianda.test/auth/magic?token=");
    expect(h.mail.sent.some((m) => m.to === "stranger@x.test")).toBe(false);

    const token = tokenFrom(mail.text)!;
    const fresh = browser(h, schoolHost("oak"));
    expect((await fresh.post("/v1/auth/magic-link/confirm", { token })).status).toBe(200);
    expect((await fresh.get("/v1/me")).status).toBe(200);
    expect((await browser(h, schoolHost("oak")).post("/v1/auth/magic-link/confirm", { token })).status).toBe(410);
  });

  it("does not work at another school", async () => {
    await browser(h, schoolHost("oak")).post("/v1/auth/magic-link", { email: OWNER });
    const token = tokenFrom((await waitForMail(h, OWNER, "login_link")).text)!;
    expect((await browser(h, schoolHost("pine")).post("/v1/auth/magic-link/confirm", { token })).status).toBe(410);
  });
});

describe("password reset", () => {
  it("sets a new password, ends every other session in every school, and tells the owner", async () => {
    const email = "reset@both.test";
    // One person in two schools, signed in at both
    const { school: birch } = await signUpAndLand(h, { schoolName: "Birch", subdomain: "birch", email, password: "old-password" });
    const { school: cedar } = await signUpAndLand(h, { schoolName: "Cedar", subdomain: "cedar", email, password: "ignored-for-existing", existingPassword: "old-password" });
    expect((await birch.get("/v1/me")).status).toBe(200);
    expect((await cedar.get("/v1/me")).status).toBe(200);

    expect((await browser(h, schoolHost("birch")).post("/v1/auth/password-reset", { email })).status).toBe(202);
    const token = tokenFrom((await waitForMail(h, email, "password_reset")).text)!;

    const phone = browser(h, schoolHost("birch"));
    const res = await phone.post("/v1/auth/password-reset/confirm", { token, password: "brand-new-password" });
    expect(res.status).toBe(200);
    expect((await phone.get("/v1/me")).status).toBe(200);

    expect((await birch.get("/v1/me")).status).toBe(401);
    expect((await cedar.get("/v1/me")).status).toBe(401);
    expect((await login("cedar", email, "old-password")).status).toBe(401);
    expect((await login("cedar", email, "brand-new-password")).status).toBe(200);
    await waitForMail(h, email, "password_changed");
    expect((await browser(h, schoolHost("birch")).post("/v1/auth/password-reset/confirm", { token, password: "again-again" })).status).toBe(410);
  });

  it("rejects a weak new password before using up the link", async () => {
    await browser(h, schoolHost("pine")).post("/v1/auth/password-reset", { email: "ada@pine.test" });
    const token = tokenFrom((await waitForMail(h, "ada@pine.test", "password_reset")).text)!;
    const pine = browser(h, schoolHost("pine"));
    expect((await pine.post("/v1/auth/password-reset/confirm", { token, password: "short" })).status).toBe(422);
    expect((await pine.post("/v1/auth/password-reset/confirm", { token, password: "long-enough-now" })).status).toBe(200);
  });
});

describe("find my school", () => {
  it("emails links to every school, from the main site only, revealing nothing", async () => {
    const apex = browser(h, APEX);
    expect((await apex.post("/v1/auth/find-school", { email: "reset@both.test" })).status).toBe(202);
    const mail = await waitForMail(h, "reset@both.test", "find_school");
    expect(mail.text).toContain("https://birch.brillianda.test/");
    expect(mail.text).toContain("https://cedar.brillianda.test/");

    expect((await apex.post("/v1/auth/find-school", { email: "ghost@x.test" })).status).toBe(202);
    expect((await browser(h, schoolHost("oak")).post("/v1/auth/find-school", { email: OWNER })).status).toBe(404);
  });
});

describe("sessions created by these flows", () => {
  it("are scoped to the school that created them", async () => {
    const pine = browser(h, schoolHost("pine"));
    await pine.post("/v1/auth/login", { email: "ada@pine.test", password: "long-enough-now" });
    const stolen = pine.cookies.get("bd_session")!;
    const res = await browser(h, schoolHost("oak"), new Map([["bd_session", stolen]])).get("/v1/me");
    expect(res.status).toBe(401);
    const pineSessions = await withSchool(h.db, pineId, (tx) => tx.select().from(sessions));
    expect(pineSessions.length).toBeGreaterThan(0);
  });
});
