import { auditLog, eq, sessions, withSchool } from "@brillianda/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { browser, schoolHost, signUpAndLand, type Client } from "./flows.js";
import { addMember, createHarness, signIn, type Harness } from "./helpers.js";

let h: Harness;
let owner: Client;
let oakId: string;
let pineId: string;
let admin: { id: string; email: string };
let adminCookie: string;

beforeAll(async () => {
  h = await createHarness();
  ({ school: owner, schoolId: oakId } = await signUpAndLand(h, { schoolName: "Oak School", subdomain: "oak", email: "owner@oak.test", password: "oak-owner-pw", fullName: "Ada Obi" }));
  ({ schoolId: pineId } = await signUpAndLand(h, { schoolName: "Pine School", subdomain: "pine", email: "owner@pine.test", password: "pine-owner-pw" }));
  admin = await addMember(h, oakId, "bisi@oak.test", "admin");
  adminCookie = await signIn(h, oakId, admin.id);
});
afterAll(async () => {
  await h?.t.close();
});

const asAdmin = () => browser(h, schoolHost("oak"), new Map([["bd_session", adminCookie]]));

describe("members", () => {
  it("lists the owner first, then admins, for owners and admins alike", async () => {
    for (const who of [owner, asAdmin()]) {
      const res = await who.get("/v1/members");
      expect(res.status).toBe(200);
      const { data } = (await res.json()) as { data: { email: string; role: string; fullName: string; joinedAt: string }[] };
      expect(data.map((m) => [m.email, m.role])).toEqual([
        ["owner@oak.test", "owner"],
        ["bisi@oak.test", "admin"],
      ]);
      expect(data[0]!.fullName).toBe("Ada Obi");
      expect(data[0]!.joinedAt).toMatch(/Z$/);
    }
  });

  it("never shows another school's people", async () => {
    const pineOwner = browser(h, schoolHost("pine"));
    await pineOwner.post("/v1/auth/login", { email: "owner@pine.test", password: "pine-owner-pw" });
    const { data } = (await (await pineOwner.get("/v1/members")).json()) as { data: { email: string }[] };
    expect(data.map((m) => m.email)).toEqual(["owner@pine.test"]);
    // ...and can't remove Oak's admin from Pine's address
    expect((await pineOwner.del(`/v1/members/${admin.id}`)).status).toBe(404);
  });

  it("needs a session", async () => {
    expect((await browser(h, schoolHost("oak")).get("/v1/members")).status).toBe(401);
  });

  it("an admin can't remove anyone, and nobody can remove the owner", async () => {
    expect((await asAdmin().del(`/v1/members/${admin.id}`)).status).toBe(403);
    const { data } = (await (await owner.get("/v1/members")).json()) as { data: { userId: string; role: string }[] };
    const ownerId = data.find((m) => m.role === "owner")!.userId;
    const res = await owner.del(`/v1/members/${ownerId}`);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { detail: string }).detail).toMatch(/owner can't be removed/);
  });

  it("the owner removes an admin: gone from the list, signed out here at once, recorded", async () => {
    expect((await asAdmin().get("/v1/me")).status).toBe(200);
    expect((await owner.del(`/v1/members/${admin.id}`)).status).toBe(204);
    expect((await owner.del(`/v1/members/${admin.id}`)).status).toBe(404);

    const { data } = (await (await owner.get("/v1/members")).json()) as { data: { email: string }[] };
    expect(data.map((m) => m.email)).toEqual(["owner@oak.test"]);
    expect((await asAdmin().get("/v1/me")).status).toBe(401);
    const left = await withSchool(h.db, oakId, (tx) => tx.select().from(sessions).where(eq(sessions.userId, admin.id)));
    expect(left).toEqual([]);

    const [entry] = await withSchool(h.db, oakId, (tx) => tx.select().from(auditLog).where(eq(auditLog.action, "member.removed")));
    expect(entry).toMatchObject({ entity: "user", entityId: admin.id, changes: { email: "bisi@oak.test", role: "admin" } });
    // Pine's records are untouched
    expect(await withSchool(h.db, pineId, (tx) => tx.select().from(auditLog).where(eq(auditLog.action, "member.removed")))).toEqual([]);
  });
});
