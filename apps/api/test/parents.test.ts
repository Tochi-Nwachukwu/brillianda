import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { browser, schoolHost, signUpAndLand, tokenFrom, waitForMail, type Client } from "./flows.js";
import { createHarness, type Harness } from "./helpers.js";

// Wednesday 14 October 2026: a school day in the first term.
const TODAY = "2026-10-14";

let h: Harness;
let owner: Client;
let other: Client;
let teacher: Client;
let gold: string;
let blue: string;
const kids: Record<string, string> = {};
const families: Record<string, string> = {};

async function json<T>(res: Response | Promise<Response>, status = 200): Promise<T> {
  const r = await res;
  expect(r.status, await r.clone().text()).toBe(status);
  return (await r.json()) as T;
}

async function accept(email: string, password = "parent-password") {
  const token = tokenFrom((await waitForMail(h, email, "invitation")).text)!;
  const person = browser(h, schoolHost("elm"));
  const lookup = await json<{ role: string; fullName: string | null; existingAccount: boolean }>(person.get(`/v1/invitations/lookup?token=${token}`));
  const me = await json<{ membership: { role: string }; user: { id: string } }>(person.post("/v1/invitations/accept", { token, password }));
  return { client: person, lookup, me, token };
}

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ["Date"], now: new Date(`${TODAY}T09:30:00Z`) });
  h = await createHarness();
  ({ school: owner } = await signUpAndLand(h, { schoolName: "Elm Academy", subdomain: "elm", email: "owner@elm.test", password: "elm-owner-pw", fullName: "Tola Elm" }));
  ({ school: other } = await signUpAndLand(h, { schoolName: "Ash Academy", subdomain: "ash", email: "owner@ash.test", password: "ash-owner-pw" }));
  await json(owner.send("PUT", "/v1/session", { startYear: 2026, terms: [{ name: "First Term", startsOn: "2026-09-14", endsOn: "2026-12-18" }, { name: "Second Term", startsOn: "2027-01-11", endsOn: "2027-04-09" }] }));
  await json(owner.send("POST", "/v1/classes/setup", { levels: [{ key: "jss1", name: "JSS 1", short: "JSS1", section: "junior" }], arms: [{ name: "Gold", code: "GOL" }, { name: "Blue", code: "BLU" }], armsByLevel: [[0, 1]] }), 201);
  const { arms } = await json<{ arms: { id: string; label: string }[] }>(owner.get("/v1/students"));
  gold = arms.find((a) => a.label === "JSS 1 Gold")!.id;
  blue = arms.find((a) => a.label === "JSS 1 Blue")!.id;
  const add = async (first: string, last: string, armId: string, guardian: Record<string, string>) =>
    (await json<{ id: string }>(owner.send("POST", "/v1/students", { firstName: first, lastName: last, gender: "female", armId, ...guardian }), 201)).id;
  kids.Ada = await add("Ada", "Okafor", gold, { guardianName: "Ngozi Okafor", guardianPhone: "08030000001", guardianEmail: "ngozi@family.test" });
  const { guardian } = await json<{ guardian: { id: string } }>(owner.get("/v1/guardians?phone=08030000001"));
  families.Okafor = guardian.id;
  kids.Ben = await add("Ben", "Okafor", blue, { guardianId: guardian.id });
  kids.Kemi = await add("Kemi", "Eze", gold, { guardianName: "Uche Eze", guardianPhone: "08030000002", guardianEmail: "uche@family.test" });
  kids.Lara = await add("Lara", "Bello", gold, { guardianName: "Sade Bello", guardianPhone: "08030000003" });
  const page = await json<{ guardians: { id: string; name: string }[] }>(owner.get("/v1/parents"));
  for (const g of page.guardians) families[g.name.split(" ")[1]!] = g.id;

  // A form teacher takes two registers for JSS 1 Gold.
  await json(owner.post("/v1/invitations", { email: "form@elm.test", fullName: "Femi Form", role: "teacher" }), 201);
  const token = tokenFrom((await waitForMail(h, "form@elm.test", "invitation")).text)!;
  teacher = browser(h, schoolHost("elm"));
  const t = await json<{ user: { id: string } }>(teacher.post("/v1/invitations/accept", { token, password: "teacher-password" }));
  expect((await owner.send("PUT", `/v1/arms/${gold}/form-teacher`, { userId: t.user.id })).status).toBe(204);
  const marks = (late: string) => [kids.Ada, kids.Kemi, kids.Lara].map((studentId) => ({ studentId, mark: studentId === late ? "late" : "present", note: "Private note" }));
  await json(teacher.send("PUT", `/v1/arms/${gold}/register`, { date: "2026-10-13", marks: marks("") }));
  await json(teacher.send("PUT", `/v1/arms/${gold}/register`, { date: TODAY, marks: marks(kids.Ada!) }));
});
afterAll(async () => {
  vi.useRealTimers();
  await h?.t.close();
});

type ParentsPage = { guardians: { id: string; name: string; email: string | null; children: { fullName: string; armLabel: string }[]; access: string }[] };

describe("the Parents page", () => {
  it("lists guardians with children here, by name, none of them using the app yet", async () => {
    const page = await json<ParentsPage>(owner.get("/v1/parents"));
    expect(page.guardians.map((g) => [g.name, g.email, g.children.map((k) => `${k.fullName} (${k.armLabel})`), g.access])).toEqual([
      ["Ngozi Okafor", "ngozi@family.test", ["Ada Okafor (JSS 1 Gold)", "Ben Okafor (JSS 1 Blue)"], "none"],
      ["Sade Bello", null, ["Lara Bello (JSS 1 Gold)"], "none"],
      ["Uche Eze", "uche@family.test", ["Kemi Eze (JSS 1 Gold)"], "none"],
    ]);
  });

  it("is for owners and admins only", async () => {
    expect((await teacher.get("/v1/parents")).status).toBe(403);
    expect((await teacher.post(`/v1/guardians/${families.Okafor}/invite`)).status).toBe(403);
  });

  it("needs an email on the guardian's record", async () => {
    const res = await owner.post(`/v1/guardians/${families.Bello}/invite`);
    expect(res.status).toBe(422);
    expect(((await res.json()) as { detail: string }).detail).toMatch(/no email on file/);
  });

  it("invites a guardian; the student page shows it", async () => {
    expect(await json(owner.post(`/v1/guardians/${families.Okafor}/invite`), 201)).toEqual({ access: "invited", resent: false });
    const mail = await waitForMail(h, "ngozi@family.test", "invitation");
    expect(mail.text).toContain("Hello Ngozi,");
    expect(mail.text).toContain("parent app");
    const student = await json<{ guardian: { parentAccess: string } }>(owner.get(`/v1/students/${kids.Ada}`));
    expect(student.guardian.parentAccess).toBe("invited");
    // Inviting again sends a fresh link.
    h.mail.clear();
    expect(await json(owner.post(`/v1/guardians/${families.Okafor}/invite`), 201)).toEqual({ access: "invited", resent: true });
  });

  it("can't be done through the general invitation endpoint", async () => {
    expect((await owner.post("/v1/invitations", { email: "x@family.test", role: "parent" })).status).toBe(422);
  });
});

describe("a parent", () => {
  let parent: Client;

  it("accepts with just a password, named from the record", async () => {
    const { client, lookup, me } = await accept("ngozi@family.test");
    expect(lookup).toMatchObject({ role: "parent", fullName: "Ngozi Okafor", existingAccount: false });
    expect(me.membership.role).toBe("parent");
    parent = client;
    expect((await json<ParentsPage>(owner.get("/v1/parents"))).guardians.find((g) => g.name === "Ngozi Okafor")!.access).toBe("active");
  });

  it("sees their own children: class, form teacher, attendance and the last ten school days, without notes", async () => {
    const home = await json<{
      fullName: string;
      schoolDay: boolean;
      children: { fullName: string; armLabel: string; formTeacher: string | null; attendance: unknown; recent: { date: string; mark: string | null }[]; results: null; pastTerms: unknown[] }[];
    }>(parent.get("/v1/me/children"));
    expect(home.fullName).toBe("Ngozi Okafor");
    expect(home.schoolDay).toBe(true);
    expect(home.children.map((k) => [k.fullName, k.armLabel, k.formTeacher])).toEqual([
      ["Ada Okafor", "JSS 1 Gold", "Femi Form"],
      ["Ben Okafor", "JSS 1 Blue", null],
    ]);
    const ada = home.children[0]!;
    expect(ada.attendance).toEqual({ term: "First Term", days: 2, present: 2, late: 1, absent: 0 });
    expect(ada.recent).toHaveLength(10);
    expect(ada.recent.slice(0, 3)).toEqual([
      { date: TODAY, mark: "late" },
      { date: "2026-10-13", mark: "present" },
      { date: "2026-10-12", mark: null },
    ]);
    expect(JSON.stringify(home)).not.toContain("Private note");
    expect(home.children[1]!.attendance).toEqual({ term: "First Term", days: 0, present: 0, late: 0, absent: 0 });
    expect(ada.results).toBeNull();
  });

  it("is refused by every staff screen", async () => {
    for (const path of ["/v1/students", `/v1/students/${kids.Kemi}`, "/v1/parents", "/v1/teachers", "/v1/me/teaching", `/v1/arms/${gold}/register`, "/v1/home", "/v1/registers/today"]) {
      expect((await parent.get(path)).status, path).toBe(403);
    }
  });

  it("the student page shows attendance and that the guardian uses the app", async () => {
    const student = await json<{ guardian: { parentAccess: string }; attendance: unknown }>(owner.get(`/v1/students/${kids.Ada}`));
    expect(student.guardian.parentAccess).toBe("active");
    expect(student.attendance).toEqual({ term: "First Term", days: 2, present: 2, late: 1, absent: 0 });
    expect((await json<{ guardian: { parentAccess: string } }>(owner.get(`/v1/students/${kids.Lara}`))).guardian.parentAccess).toBe("none");
  });

  it("can't be invited twice", async () => {
    expect((await owner.post(`/v1/guardians/${families.Okafor}/invite`)).status).toBe(409);
  });

  it("loses access when the school ends it; the records stay", async () => {
    expect((await owner.del(`/v1/guardians/${families.Okafor}/access`)).status).toBe(204);
    expect((await parent.get("/v1/me")).status).toBe(401);
    expect((await json<ParentsPage>(owner.get("/v1/parents"))).guardians.find((g) => g.name === "Ngozi Okafor")!.access).toBe("none");
    expect((await json<{ attendance: { days: number } }>(owner.get(`/v1/students/${kids.Ada}`))).attendance.days).toBe(2);
  });
});

describe("inviting everyone", () => {
  it("invites each guardian with an email who isn't invited, and counts those without one", async () => {
    h.mail.clear();
    expect(await json(owner.post("/v1/parents/invite-all"))).toEqual({ invited: 2, withoutEmail: 1, skipped: 0, remaining: 0 });
    await waitForMail(h, "uche@family.test", "invitation");
    await waitForMail(h, "ngozi@family.test", "invitation");
    expect(await json(owner.post("/v1/parents/invite-all"))).toEqual({ invited: 0, withoutEmail: 1, skipped: 0, remaining: 0 });
  });

  it("an open invite can be cancelled, and its link stops working", async () => {
    const token = tokenFrom((await waitForMail(h, "uche@family.test", "invitation")).text)!;
    expect((await owner.del(`/v1/guardians/${families.Eze}/access`)).status).toBe(204);
    expect((await browser(h, schoolHost("elm")).get(`/v1/invitations/lookup?token=${token}`)).status).toBe(410);
  });

  it("a returning parent signs in again with their existing account", async () => {
    const { me, lookup } = await accept("ngozi@family.test", "anything-ignored");
    expect(lookup.existingAccount).toBe(true);
    expect(me.membership.role).toBe("parent");
  });

  it("won't give a staff member's email the parent app", async () => {
    const id = (await json<{ id: string }>(owner.send("POST", "/v1/students", { firstName: "Tobi", lastName: "Form", gender: "male", armId: blue, guardianName: "Femi Form", guardianPhone: "08030000009", guardianEmail: "form@elm.test" }), 201)).id;
    const { guardian } = await json<{ guardian: { id: string } }>(owner.get(`/v1/students/${id}`));
    const res = await owner.post(`/v1/guardians/${guardian.id}/invite`);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { detail: string }).detail).toMatch(/staff/);
    const all = await json<{ skipped: number }>(owner.post("/v1/parents/invite-all"));
    expect(all.skipped).toBe(1);
  });
});

describe("isolation", () => {
  it("another school sees none of these families and can't invite or end them", async () => {
    expect(await json(other.get("/v1/parents"))).toEqual({ guardians: [] });
    expect((await other.post(`/v1/guardians/${families.Okafor}/invite`)).status).toBe(404);
    expect((await other.del(`/v1/guardians/${families.Okafor}/access`)).status).toBe(404);
  });
});
