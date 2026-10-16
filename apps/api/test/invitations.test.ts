import { auditLog, eq, withSchool } from "@brillianda/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { browser, schoolHost, signUpAndLand, tokenFrom, waitForMail, type Client } from "./flows.js";
import { createHarness, type Harness } from "./helpers.js";

let h: Harness;
let owner: Client;
let mapleId: string;

beforeAll(async () => {
  h = await createHarness();
  ({ school: owner, schoolId: mapleId } = await signUpAndLand(h, { schoolName: "Maple School", subdomain: "maple", email: "owner@maple.test", password: "maple-owner-pw", fullName: "Tunde Bello" }));
  await signUpAndLand(h, { schoolName: "Willow School", subdomain: "willow", email: "owner@willow.test", password: "willow-owner-pw" });
});
afterAll(async () => {
  await h?.t.close();
});
beforeEach(() => h.mail.clear());

async function invite(email: string, by: Client = owner) {
  const res = await by.post("/v1/invitations", { email });
  const token = res.status === 201 ? tokenFrom((await waitForMail(h, email.toLowerCase(), "invitation")).text) : undefined;
  return { res, token };
}

describe("invitations", () => {
  it("owner invites a new person, who joins as admin and lands signed in", async () => {
    const { res, token } = await invite("Funmi@Maple.test");
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ email: "funmi@maple.test", role: "admin", invitedBy: "Tunde Bello" });
    const mail = await waitForMail(h, "funmi@maple.test", "invitation");
    expect(mail.subject).toBe("Tunde Bello invited you to Maple School");
    expect(mail.text).toContain("https://maple.brillianda.test/invite?token=");

    const guest = browser(h, schoolHost("maple"));
    expect(await (await guest.get(`/v1/invitations/lookup?token=${token}`)).json()).toMatchObject({
      email: "funmi@maple.test",
      role: "admin",
      school: { name: "Maple School" },
      existingAccount: false,
    });

    let r = await guest.post("/v1/invitations/accept", { token });
    expect(r.status).toBe(422);
    expect(((await r.json()) as { errors: { pointer: string }[] }).errors.map((e) => e.pointer)).toEqual(["#/fullName", "#/password"]);

    r = await guest.post("/v1/invitations/accept", { token, fullName: "Funmi Ade", password: "funmi-password" });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ membership: { role: "admin" }, user: { email: "funmi@maple.test", emailVerified: true } });
    expect((await guest.get("/v1/me")).status).toBe(200);

    // Used once only, and the new admin can sign in with the password later
    expect((await browser(h, schoolHost("maple")).post("/v1/invitations/accept", { token, fullName: "X Y", password: "another-pw" })).status).toBe(410);
    expect((await browser(h, schoolHost("maple")).post("/v1/auth/login", { email: "funmi@maple.test", password: "funmi-password" })).status).toBe(200);

    const joined = await withSchool(h.db, mapleId, (tx) => tx.select().from(auditLog).where(eq(auditLog.action, "member.joined")));
    expect(joined).toHaveLength(1);
  });

  it("carries the invitee's name when the owner gives one, and uses it if they don't retype it", async () => {
    const res = await owner.post("/v1/invitations", { email: "chidi@maple.test", fullName: "  Chidi   Okeke " });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ email: "chidi@maple.test", fullName: "Chidi Okeke" });
    const mail = await waitForMail(h, "chidi@maple.test", "invitation");
    expect(mail.text).toContain("Hello Chidi,");
    const token = tokenFrom(mail.text);

    const list = (await (await owner.get("/v1/invitations")).json()) as { data: { email: string; fullName: string | null }[] };
    expect(list.data.find((i) => i.email === "chidi@maple.test")?.fullName).toBe("Chidi Okeke");

    const guest = browser(h, schoolHost("maple"));
    expect(await (await guest.get(`/v1/invitations/lookup?token=${token}`)).json()).toMatchObject({ fullName: "Chidi Okeke", existingAccount: false });
    const r = await guest.post("/v1/invitations/accept", { token, password: "chidi-password" });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ user: { fullName: "Chidi Okeke" } });

    const summaries = await withSchool(h.db, mapleId, (tx) => tx.select({ s: auditLog.summary }).from(auditLog).where(eq(auditLog.action, "invitation.created")));
    expect(summaries.map((x) => x.s)).toContain("Invited Chidi Okeke (chidi@maple.test) as an admin");
  });

  it("the name is optional, and checked when given", async () => {
    const plain = await owner.post("/v1/invitations", { email: "noname@maple.test" });
    expect(await plain.json()).toMatchObject({ fullName: null });
    expect((await waitForMail(h, "noname@maple.test", "invitation")).text).not.toContain("Hello");
    expect(await (await owner.post("/v1/invitations", { email: "blank@maple.test", fullName: "  " })).json()).toMatchObject({ fullName: null });
    const short = await owner.post("/v1/invitations", { email: "x@maple.test", fullName: "A" });
    expect(short.status).toBe(422);
    expect(((await short.json()) as { errors: { pointer: string }[] }).errors[0]!.pointer).toBe("#/fullName");
    expect((await owner.post("/v1/invitations", { email: "y@maple.test", fullName: "A".repeat(121) })).status).toBe(422);
  });

  it("only the owner manages invitations", async () => {
    const admin = browser(h, schoolHost("maple"));
    await admin.post("/v1/auth/login", { email: "funmi@maple.test", password: "funmi-password" });
    expect((await admin.post("/v1/invitations", { email: "x@maple.test" })).status).toBe(403);
    expect((await admin.get("/v1/invitations")).status).toBe(403);
  });

  it("will not invite someone who is already a member", async () => {
    const { res } = await invite("funmi@maple.test");
    expect(res.status).toBe(409);
  });

  it("lists, revokes, and a revoked link stops working", async () => {
    const { token } = await invite("revoke-me@x.test");
    const list = (await (await owner.get("/v1/invitations")).json()) as { data: { id: string; email: string }[] };
    const inv = list.data.find((i) => i.email === "revoke-me@x.test")!;
    expect((await owner.del(`/v1/invitations/${inv.id}`)).status).toBe(204);
    expect((await owner.del(`/v1/invitations/${inv.id}`)).status).toBe(404);
    expect((await browser(h, schoolHost("maple")).get(`/v1/invitations/lookup?token=${token}`)).status).toBe(410);
  });

  it("a re-invite replaces the old link", async () => {
    const first = await invite("twice@x.test");
    const second = await invite("twice@x.test");
    expect(first.token).not.toBe(second.token);
    const guest = browser(h, schoolHost("maple"));
    expect((await guest.get(`/v1/invitations/lookup?token=${first.token}`)).status).toBe(410);
    expect((await guest.get(`/v1/invitations/lookup?token=${second.token}`)).status).toBe(200);
  });

  it("a link only works at the school that sent it", async () => {
    const { token } = await invite("cross@x.test");
    const elsewhere = browser(h, schoolHost("willow"));
    expect((await elsewhere.get(`/v1/invitations/lookup?token=${token}`)).status).toBe(410);
    expect((await elsewhere.post("/v1/invitations/accept", { token, fullName: "Cross Over", password: "cross-password" })).status).toBe(410);
  });

  it("someone who already has an account just accepts, keeping their password", async () => {
    const { token } = await invite("owner@willow.test");
    const guest = browser(h, schoolHost("maple"));
    expect(await (await guest.get(`/v1/invitations/lookup?token=${token}`)).json()).toMatchObject({ existingAccount: true });
    const res = await guest.post("/v1/invitations/accept", { token });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ membership: { role: "admin" }, school: { subdomain: "maple" } });
    const mine = (await (await guest.get("/v1/me/schools")).json()) as { data: { subdomain: string; role: string }[] };
    expect(Object.fromEntries(mine.data.map((s) => [s.subdomain, s.role]))).toEqual({ maple: "admin", willow: "owner" });
  });

  it("validates the email and the invitation id", async () => {
    expect((await owner.post("/v1/invitations", { email: "not-an-email" })).status).toBe(422);
    expect((await owner.del("/v1/invitations/not-a-uuid")).status).toBe(422);
  });
});
