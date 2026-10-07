import { auditLog, eq, schools, signupDrafts, users, withSchool } from "@brillianda/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { APEX, browser, codeFrom, schoolHost, setCookieValue, signUp, signUpAndLand, tokenFrom, waitForMail } from "./flows.js";
import { createHarness, type Harness } from "./helpers.js";

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h?.t.close();
});
beforeEach(() => h.mail.clear());

const schoolStep = { name: "Surebloom School", levelsOffered: ["secondary", "primary"], state: "Rivers", phone: "0803 000 0001" };

describe("Phase 1 gate: a new school signs up and lands signed in on its own address", () => {
  it("runs the four steps, creates the school in one go, and hands over to the subdomain", async () => {
    const apex = browser(h, APEX);

    // Step 1
    let res = await apex.post("/v1/signup/school", schoolStep);
    expect(res.status).toBe(200);
    expect(setCookieValue(res, "bd_signup")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await res.json()).toMatchObject({ step: "owner", school: { name: "Surebloom School", phone: "+2348030000001" } });

    // Resume in a "new tab": same cookie, same draft
    expect(await (await apex.get("/v1/signup")).json()).toMatchObject({ step: "owner" });

    // Step 2
    res = await apex.post("/v1/signup/owner", { fullName: "Ngozi Okafor", email: "Ngozi@Surebloom.test", password: "correct horse battery" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ step: "verify_email", codeSentTo: "ng•••@surebloom.test", resendAvailableInSec: 60 });
    const mail = await waitForMail(h, "ngozi@surebloom.test", "signup_code");
    const code = codeFrom(mail.text)!;

    // Step 3: a wrong code first
    res = await apex.post("/v1/signup/verify-email", { code: code === "000000" ? "111111" : "000000" });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "verification_failed", reason: "invalid" });
    res = await apex.post("/v1/signup/verify-email", { code });
    expect(await res.json()).toMatchObject({ step: "address", emailVerified: true, existingAccount: false, suggestedSubdomains: expect.arrayContaining(["surebloom"]) });

    // Step 4
    res = await apex.post("/v1/signup/complete", { subdomain: "surebloom" });
    expect(res.status).toBe(201);
    const done = (await res.json()) as { school: { id: string; url: string }; handoverUrl: string };
    expect(done.school.url).toBe("https://surebloom.brillianda.test/");
    expect(res.headers.get("location")).toBe(done.school.url);
    expect(done.handoverUrl).toMatch(/^https:\/\/surebloom\.brillianda\.test\/auth\/handover\?token=/);
    expect(apex.cookies.has("bd_signup")).toBe(false);
    expect((await waitForMail(h, "ngozi@surebloom.test", "welcome")).text).toContain("https://surebloom.brillianda.test/");

    // Handover on the new address → signed in as owner
    const school = browser(h, schoolHost("surebloom"));
    res = await school.post("/v1/auth/handover", { token: tokenFrom(done.handoverUrl) });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ membership: { role: "owner" }, school: { subdomain: "surebloom" }, user: { emailVerified: true } });
    expect((await school.get("/v1/me")).status).toBe(200);

    // The handover token is single-use
    res = await browser(h, schoolHost("surebloom")).post("/v1/auth/handover", { token: tokenFrom(done.handoverUrl) });
    expect(res.status).toBe(410);

    // Written once, atomically: school, owner, audit; draft closed without the password hash
    const [s] = await h.db.select().from(schools).where(eq(schools.subdomain, "surebloom"));
    expect(s).toMatchObject({ name: "Surebloom School", levelsOffered: ["secondary", "primary"], state: "Rivers", phone: "+2348030000001" });
    const created = await withSchool(h.db, s!.id, (tx) => tx.select().from(auditLog).where(eq(auditLog.action, "school.created")));
    expect(created).toHaveLength(1);
    const [draft] = await h.db.select().from(signupDrafts).where(eq(signupDrafts.completedSchoolId, s!.id));
    expect(draft).toMatchObject({ status: "completed", ownerPasswordHash: null });
    const [owner] = await h.db.select().from(users).where(eq(users.email, "ngozi@surebloom.test"));
    expect(owner!.passwordHash).toMatch(/^\$argon2id\$/);
  });
});

describe("signup rules", () => {
  it("lives only on the main site", async () => {
    const res = await browser(h, schoolHost("anything")).post("/v1/signup/school", schoolStep);
    expect(res.status).toBe(404);
  });

  it("enforces the step order and says what is next", async () => {
    const apex = browser(h, APEX);
    let res = await apex.post("/v1/signup/owner", { fullName: "A B", email: "x@y.test", password: "password123" });
    expect(await res.json()).toMatchObject({ status: 409, code: "signup_incomplete", nextStep: "school" });
    await apex.post("/v1/signup/school", schoolStep);
    res = await apex.post("/v1/signup/complete", { subdomain: "nope-yet" });
    expect(await res.json()).toMatchObject({ code: "signup_incomplete", nextStep: "owner" });
  });

  it("validates fields with human messages and pointers", async () => {
    const res = await browser(h, APEX).post("/v1/signup/school", { name: "S", levelsOffered: [], state: "Atlantis", phone: "12345" });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { errors: { pointer: string; detail: string }[] };
    expect(body.errors.map((e) => e.pointer).sort()).toEqual(["#/levelsOffered", "#/name", "#/phone", "#/state"]);
    expect(body.errors.find((e) => e.pointer === "#/phone")!.detail).toBe("Enter a Nigerian phone number, e.g. 0803 000 0001");
  });

  it("re-verifies when the email changes", async () => {
    const apex = browser(h, APEX);
    await apex.post("/v1/signup/school", schoolStep);
    await apex.post("/v1/signup/owner", { fullName: "A B", email: "first@x.test", password: "password123" });
    await apex.post("/v1/signup/verify-email", { code: codeFrom((await waitForMail(h, "first@x.test", "signup_code")).text) });
    const res = await apex.post("/v1/signup/owner", { fullName: "A B", email: "second@x.test", password: "password123" });
    expect(await res.json()).toMatchObject({ step: "verify_email", emailVerified: false });
    await waitForMail(h, "second@x.test", "signup_code");
  });

  it("refuses when the bot check fails", async () => {
    const strict = createApp({ ...h.deps, botCheck: { verify: async () => false } });
    const send = (path: string, body: unknown, cookie?: string) =>
      strict.request(path, { method: "POST", headers: { host: APEX, origin: `https://${APEX}`, "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
    const r1 = await send("/v1/signup/school", schoolStep);
    const cookie = `bd_signup=${setCookieValue(r1, "bd_signup")}`;
    const r2 = await send("/v1/signup/owner", { fullName: "A B", email: "bot@x.test", password: "password123", turnstileToken: "fake" }, cookie);
    expect(r2.status).toBe(403);
    expect(((await r2.json()) as { code: string }).code).toBe("bot_check_failed");
    expect(h.mail.sent.filter((m) => m.to === "bot@x.test")).toHaveLength(0);
  });
});

describe("addresses", () => {
  it("explains why an address is unavailable and suggests free ones", async () => {
    await signUp(h, { schoolName: "Greenfield Academy", subdomain: "greenfield", email: "o@greenfield.test", password: "password123" });
    const check = async (subdomain: string) =>
      (await browser(h, APEX).get(`/v1/signup/subdomain-check?subdomain=${subdomain}&schoolName=Greenfield%20Academy`)).json();
    expect(await check("greenfield")).toMatchObject({ available: false, reason: "taken" });
    expect(((await check("greenfield")) as { suggestions: string[] }).suggestions).not.toContain("greenfield");
    expect(await check("admin")).toMatchObject({ available: false, reason: "reserved" });
    expect(await check("a--b")).toMatchObject({ available: false, reason: "invalid" });
    expect(await check("greenfield-ph")).toMatchObject({ available: true, reason: null });
  });

  it("lets exactly one of two racing signups take an address", async () => {
    const prepare = async (email: string) => {
      const apex = browser(h, APEX);
      await apex.post("/v1/signup/school", { ...schoolStep, name: "Race School" });
      await apex.post("/v1/signup/owner", { fullName: "A B", email, password: "password123" });
      await apex.post("/v1/signup/verify-email", { code: codeFrom((await waitForMail(h, email, "signup_code")).text) });
      return apex;
    };
    const [a, b] = await Promise.all([prepare("racer1@x.test"), prepare("racer2@x.test")]);
    const results = await Promise.all([a.post("/v1/signup/complete", { subdomain: "raceway" }), b.post("/v1/signup/complete", { subdomain: "raceway" })]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    const loser = results.find((r) => r.status === 409)!;
    expect(await loser.json()).toMatchObject({ code: "subdomain_unavailable", reason: "taken" });
    expect(await h.db.select().from(schools).where(eq(schools.subdomain, "raceway"))).toHaveLength(1);
  });
});

describe("a proprietor with a second campus", () => {
  it("reuses the existing account after proving its password, and sees both schools", async () => {
    await signUpAndLand(h, { schoolName: "Hilltop Main", subdomain: "hilltop", email: "prop@hilltop.test", password: "first-password" });

    const apex = browser(h, APEX);
    await apex.post("/v1/signup/school", { ...schoolStep, name: "Hilltop Annex" });
    await apex.post("/v1/signup/owner", { fullName: "Prop", email: "prop@hilltop.test", password: "whatever-new" });
    let res = await apex.post("/v1/signup/verify-email", { code: codeFrom((await waitForMail(h, "prop@hilltop.test", "signup_code")).text) });
    expect(await res.json()).toMatchObject({ existingAccount: true });

    res = await apex.post("/v1/signup/complete", { subdomain: "hilltop-annex" });
    expect(await res.json()).toMatchObject({ status: 401, code: "invalid_credentials" });
    res = await apex.post("/v1/signup/complete", { subdomain: "hilltop-annex", existingPassword: "first-password" });
    expect(res.status).toBe(201);

    const annex = browser(h, schoolHost("hilltop-annex"));
    await annex.post("/v1/auth/handover", { token: tokenFrom(((await res.json()) as { handoverUrl: string }).handoverUrl) });
    const mine = (await (await annex.get("/v1/me/schools")).json()) as { data: { subdomain: string; current: boolean }[] };
    expect(Object.fromEntries(mine.data.map((s) => [s.subdomain, s.current]))).toEqual({ hilltop: false, "hilltop-annex": true });

    // Still one user row, with the ORIGINAL password
    expect(await h.db.select().from(users).where(eq(users.email, "prop@hilltop.test"))).toHaveLength(1);
    const login = await browser(h, schoolHost("hilltop-annex")).post("/v1/auth/login", { email: "prop@hilltop.test", password: "first-password" });
    expect(login.status).toBe(200);
  });

  it("a handover token only works on the school it was made for", async () => {
    const { handoverToken } = await signUp(h, { schoolName: "Lone School", subdomain: "lone", email: "o@lone.test", password: "password123" });
    const res = await browser(h, schoolHost("hilltop")).post("/v1/auth/handover", { token: handoverToken });
    expect(res.status).toBe(410);
  });
});
