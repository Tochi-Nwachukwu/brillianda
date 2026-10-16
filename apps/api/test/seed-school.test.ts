import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedTestSchool } from "../src/seed-school.js";
import { browser, schoolHost } from "./flows.js";
import { createHarness, type Harness } from "./helpers.js";

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h?.t.close();
});

describe("test school for the frontend team", () => {
  it("creates a school both people can sign in to, with classes, subjects and 20 students", async () => {
    const result = await seedTestSchool(h.deps, { subdomain: "fecheck", name: "FE Check School", ownerEmail: "owner@fecheck.test", adminEmail: "admin@fecheck.test" });
    expect(result.owner.password).toMatch(/^[A-Za-z0-9_-]{16}$/);

    const admin = browser(h, schoolHost("fecheck"));
    expect((await admin.post("/v1/auth/login", { email: "admin@fecheck.test", password: result.admin.password })).status).toBe(200);
    const owner = browser(h, schoolHost("fecheck"));
    const me = await owner.post("/v1/auth/login", { email: "owner@fecheck.test", password: result.owner.password });
    expect(await me.json()).toMatchObject({ membership: { role: "owner" } });

    const home = (await (await owner.get("/v1/home")).json()) as { students: number; classes: number; arms: number; subjects: number; admins: number };
    expect(home).toMatchObject({ students: 20, classes: 12, arms: 2, admins: 2 });
    expect(home.subjects).toBeGreaterThan(20);
    const setup = (await (await owner.get("/v1/setup")).json()) as { items: { id: string; done: boolean }[] };
    expect(setup.items.filter((i) => i.done).map((i) => i.id)).toEqual(["calendar", "classes", "arms", "subjects", "students", "admins"]);

    // The two Okafors share one guardian
    const { students } = (await (await owner.get("/v1/students")).json()) as { students: { id: string; fullName: string }[] };
    const chiamaka = students.find((s) => s.fullName === "Chiamaka Okafor")!;
    const detail = (await (await owner.get(`/v1/students/${chiamaka.id}`)).json()) as { guardian: { siblings: { fullName: string }[] } };
    expect(detail.guardian.siblings.map((s) => s.fullName)).toEqual(["Tobi Okafor"]);
  });

  it("refuses to touch a school or an account that already exists", async () => {
    await expect(seedTestSchool(h.deps, { subdomain: "fecheck", name: "x", ownerEmail: "a@x.test", adminEmail: "b@x.test" })).rejects.toThrow(/already exists/);
    await expect(seedTestSchool(h.deps, { subdomain: "fecheck2", name: "x", ownerEmail: "owner@fecheck.test", adminEmail: "b@x.test" })).rejects.toThrow(/already has a Brillianda account/);
  });
});
