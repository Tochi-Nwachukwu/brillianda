import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedTestParent, seedTestSchool, seedTestTeachers } from "../src/seed-school.js";
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

  it("adds a form teacher and a subject teacher to it, who land on their own screens", async () => {
    const r = await seedTestTeachers(h.deps, { subdomain: "fecheck", formTeacherEmail: "form@fecheck.test", subjectTeacherEmail: "subject@fecheck.test" });
    expect(r.formTeacher.formClass).toBe("JSS 1 Gold");
    const form = browser(h, schoolHost("fecheck"));
    expect(await (await form.post("/v1/auth/login", { email: "form@fecheck.test", password: r.formTeacher.password })).json()).toMatchObject({ membership: { role: "teacher" } });
    const home = (await (await form.get("/v1/me/teaching")).json()) as { formArms: { label: string }[]; subjects: { label: string }[] };
    expect(home.formArms.map((a) => a.label)).toEqual(["JSS 1 Gold"]);
    expect(home.subjects).toHaveLength(2);
    const subject = browser(h, schoolHost("fecheck"));
    expect((await subject.post("/v1/auth/login", { email: "subject@fecheck.test", password: r.subjectTeacher.password })).status).toBe(200);
    const theirs = (await (await subject.get("/v1/me/teaching")).json()) as { formArms: unknown[]; subjects: { subjectName: string }[] };
    expect(theirs.formArms).toEqual([]);
    expect(theirs.subjects).toHaveLength(4);
    await expect(seedTestTeachers(h.deps, { subdomain: "nowhere", formTeacherEmail: "a@x.test", subjectTeacherEmail: "b@x.test" })).rejects.toThrow(/no school/);
    // Running it again resets their passwords and keeps their classes; someone else's email is refused.
    const again = await seedTestTeachers(h.deps, { subdomain: "fecheck", formTeacherEmail: "form@fecheck.test", subjectTeacherEmail: "subject@fecheck.test" });
    expect(again.formTeacher.password).not.toBe(r.formTeacher.password);
    expect((await browser(h, schoolHost("fecheck")).post("/v1/auth/login", { email: "form@fecheck.test", password: again.formTeacher.password })).status).toBe(200);
    await expect(seedTestTeachers(h.deps, { subdomain: "fecheck", formTeacherEmail: "owner@fecheck.test", subjectTeacherEmail: "z@x.test" })).rejects.toThrow(/already has a Brillianda account/);
  });

  it("adds a parent who follows the Okafor siblings", async () => {
    const r = await seedTestParent(h.deps, { subdomain: "fecheck", email: "parent@fecheck.test" });
    expect(r.children).toEqual(["Chiamaka Okafor", "Tobi Okafor"]);
    const parent = browser(h, schoolHost("fecheck"));
    expect(await (await parent.post("/v1/auth/login", { email: "parent@fecheck.test", password: r.password })).json()).toMatchObject({ membership: { role: "parent" } });
    const home = (await (await parent.get("/v1/me/children")).json()) as { children: { fullName: string }[] };
    expect(home.children.map((k) => k.fullName).sort()).toEqual(["Chiamaka Okafor", "Tobi Okafor"]);
  });
});
