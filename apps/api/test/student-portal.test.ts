import { and, eq, invitations, isNull, withSchool } from "@brillianda/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { browser, schoolHost, signUpAndLand, tokenFrom, waitForMail, type Client } from "./flows.js";
import { createHarness, type Harness } from "./helpers.js";

const TODAY = "2026-10-14"; // a Wednesday

let h: Harness;
let owner: Client;
let other: Client;
let teacher: Client;
let student: Client;
let schoolId: string;
let gold: string;
let maths: string;
const kid: Record<string, string> = {};

async function json<T>(res: Response | Promise<Response>, status = 200): Promise<T> {
  const r = await res;
  expect(r.status, await r.clone().text()).toBe(status);
  return (await r.json()) as T;
}
const problem = async (res: Response | Promise<Response>, status: number) => {
  const r = await res;
  expect(r.status, await r.clone().text()).toBe(status);
  return (await r.json()) as { detail: string; errors?: { pointer: string }[] };
};
type Accounts = { students: { id: string; fullName: string; armLabel: string; access: string; email: string | null }[]; arms: { label: string }[] };
const accessOf = async (id: string) => (await json<Accounts>(owner.get("/v1/student-accounts"))).students.find((s) => s.id === id)!;

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ["Date"], now: new Date(`${TODAY}T09:30:00Z`) });
  h = await createHarness();
  ({ school: owner, schoolId } = await signUpAndLand(h, { schoolName: "Ebony College", subdomain: "ebony", email: "owner@ebony.test", password: "ebony-owner-pw", fullName: "Sade Ebony" }));
  ({ school: other } = await signUpAndLand(h, { schoolName: "Ivory College", subdomain: "ivory", email: "owner@ivory.test", password: "ivory-owner-pw" }));
  await json(owner.send("PUT", "/v1/session", { startYear: 2026, terms: [{ name: "First Term", startsOn: "2026-09-14", endsOn: "2026-12-18" }, { name: "Second Term", startsOn: "2027-01-11", endsOn: "2027-07-16" }] }));
  await json(owner.send("POST", "/v1/classes/setup", { levels: [{ key: "jss1", name: "JSS 1", short: "JSS1", section: "junior" }], arms: [{ name: "Gold", code: "GOL" }], armsByLevel: [[0]] }), 201);
  gold = (await json<{ arms: { id: string }[] }>(owner.get("/v1/students"))).arms[0]!.id;
  const levelId = (await json<{ levels: { id: string }[] }>(owner.get("/v1/classes"))).levels[0]!.id;
  await owner.send("POST", "/v1/subjects", { catalogueIds: [], custom: [{ name: "Mathematics", code: "MTH" }] });
  maths = (await json<{ subjects: { id: string }[] }>(owner.get("/v1/subjects"))).subjects[0]!.id;
  await owner.send("PUT", `/v1/subjects/${maths}/levels/${levelId}`, { kind: "compulsory" });
  for (const [first, last, phone] of [["Ada", "Obi", "08030000001"], ["Bayo", "Cole", "08030000002"]] as const) {
    kid[first] = (await json<{ id: string }>(owner.send("POST", "/v1/students", { firstName: first, lastName: last, gender: "female", armId: gold, guardianName: `Parent ${last}`, guardianPhone: phone }), 201)).id;
  }
  await json(owner.post("/v1/invitations", { email: "tunde@ebony.test", fullName: "Tunde Teach", role: "teacher" }), 201);
  teacher = browser(h, schoolHost("ebony"));
  const t = await json<{ user: { id: string } }>(teacher.post("/v1/invitations/accept", { token: tokenFrom((await waitForMail(h, "tunde@ebony.test", "invitation")).text)!, password: "teacher-password" }));
  expect((await owner.send("PUT", `/v1/arms/${gold}/form-teacher`, { userId: t.user.id })).status).toBe(204);
  expect((await owner.send("PUT", `/v1/teachers/${t.user.id}/subject-classes`, [{ armId: gold, subjectId: maths }])).status).toBe(204);
  await json(owner.send("PUT", "/v1/timetable/periods", { periods: [{ id: "p1", label: "Period 1", start: "08:00", end: "08:40", kind: "lesson" }, { id: "p2", label: "Period 2", start: "08:40", end: "09:20", kind: "lesson" }] }));
  expect((await owner.send("PUT", `/v1/timetable/${gold}/3/p2`, { subjectId: maths })).status).toBe(204);
  expect((await owner.send("PUT", `/v1/timetable/${gold}/1/p1`, { subjectId: maths })).status).toBe(204);
  await owner.send("PUT", `/v1/book-lists/2026/${levelId}`, { items: [{ category: "textbook", name: "New General Mathematics 1", detail: "", quantity: 1, price: 4500 }] });
  await owner.send("PUT", `/v1/book-lists/2026/${levelId}/shared`, { shared: true });
});
afterAll(async () => {
  vi.useRealTimers();
  await h?.t.close();
});

describe("student accounts", () => {
  it("list active students with their portal access", async () => {
    const page = await json<Accounts>(owner.get("/v1/student-accounts"));
    expect(page.arms.map((a) => a.label)).toEqual(["JSS 1"]);
    expect(page.students.map((s) => [s.fullName, s.armLabel, s.access, s.email])).toEqual([
      ["Ada Obi", "JSS 1", "none", null],
      ["Bayo Cole", "JSS 1", "none", null],
    ]);
    expect((await teacher.get("/v1/student-accounts")).status).toBe(403);
  });

  it("invite with an email nobody at the school uses", async () => {
    expect((await problem(owner.post(`/v1/students/${kid.Ada}/invite`, { email: "tunde@ebony.test" }), 422)).errors![0]!.pointer).toBe("#/email");
    expect((await problem(owner.post(`/v1/students/${kid.Ada}/invite`, { email: "not an email" }), 422)).errors![0]!.pointer).toBe("#/email");
    expect((await other.post(`/v1/students/${kid.Ada}/invite`, { email: "ada@pupils.test" })).status).toBe(404);
    expect((await teacher.post(`/v1/students/${kid.Ada}/invite`, { email: "ada@pupils.test" })).status).toBe(403);
    expect(await json(owner.post(`/v1/students/${kid.Ada}/invite`, { email: "first@pupils.test" }), 201)).toEqual({ access: "invited", email: "first@pupils.test", resent: false });
    // Inviting again with another address replaces the first invitation.
    expect(await json(owner.post(`/v1/students/${kid.Ada}/invite`, { email: "Ada@Pupils.test" }), 201)).toEqual({ access: "invited", email: "ada@pupils.test", resent: true });
    const open = await withSchool(h.db, schoolId, (tx) => tx.select({ email: invitations.email }).from(invitations).where(and(eq(invitations.studentId, kid.Ada!), isNull(invitations.revokedAt))));
    expect(open.map((o) => o.email)).toEqual(["ada@pupils.test"]);
    expect(await accessOf(kid.Ada!)).toMatchObject({ access: "invited", email: "ada@pupils.test" });
    expect((await problem(owner.post(`/v1/students/${kid.Bayo}/invite`, { email: "ada@pupils.test" }), 409)).detail).toBe("ada@pupils.test already has an open invitation to this school.");
    const mail = await waitForMail(h, "ada@pupils.test", "invitation");
    expect(mail.text).toContain("student portal");
    expect((await json<{ entries: { what: string }[] }>(owner.get("/v1/changes"))).entries[0]!.what).toBe("Invited Ada Obi to the student portal");
  });

  it("lets the student join with their own password", async () => {
    const token = tokenFrom((await waitForMail(h, "ada@pupils.test", "invitation")).text)!;
    student = browser(h, schoolHost("ebony"));
    expect(await json(student.get(`/v1/invitations/lookup?token=${token}`))).toMatchObject({ role: "student", fullName: "Ada Obi", existingAccount: false });
    expect(await json(student.post("/v1/invitations/accept", { token, password: "student-password" }))).toMatchObject({ membership: { role: "student" } });
    expect(await accessOf(kid.Ada!)).toMatchObject({ access: "active", email: "ada@pupils.test" });
    expect((await problem(owner.post(`/v1/students/${kid.Ada}/invite`, { email: "again@pupils.test" }), 409)).detail).toBe("Ada already uses the student portal.");
  });

  it("show the student their own home and week", async () => {
    const home = await json<Record<string, unknown>>(student.get("/v1/me/student"));
    expect(home).toMatchObject({
      fullName: "Ada Obi",
      armLabel: "JSS 1",
      formTeacher: "Tunde Teach",
      birthday: null,
      lessonsToday: [{ periodLabel: "Period 2", start: "08:40", end: "09:20", subjectName: "Mathematics" }],
      attendance: { term: "First Term" },
      results: { term: "First Term, 2026/2027", published: false },
      pastTerms: [],
      bookLists: [{ label: "This session: JSS 1, 2026/2027" }],
    });
    expect((home.recent as unknown[]).length).toBeGreaterThan(0);
    const week = await json<{ armLabel: string; periods: unknown[]; lessons: { day: number; periodId: string; subjectName: string; teacherName: string | null }[] }>(student.get("/v1/me/timetable"));
    expect(week.armLabel).toBe("JSS 1");
    expect(week.periods).toHaveLength(2);
    expect(week.lessons.sort((a, b) => a.day - b.day)).toEqual([
      { day: 1, periodId: "p1", subjectName: "Mathematics", teacherName: "Tunde Teach" },
      { day: 3, periodId: "p2", subjectName: "Mathematics", teacherName: "Tunde Teach" },
    ]);
  });

  it("show the report card only once the class is published", async () => {
    expect((await problem(student.get("/v1/me/report-card"), 404)).detail).toBe("There’s no published report card for that term.");
    const sheet = `/v1/arms/${gold}/subjects/${maths}/sheet`;
    for (const id of [kid.Ada!, kid.Bayo!]) for (const [componentId, raw] of [["ca1", "15"], ["ca2", "18"], ["exam", "42"]]) await json(owner.send("PUT", `${sheet}/scores`, { studentId: id, componentId, raw }));
    expect((await owner.post(`${sheet}/complete`)).status).toBe(204);
    expect((await owner.send("PUT", `/v1/arms/${gold}/published`, { published: true })).status).toBe(204);
    const card = await json<{ student: { fullName: string }; published: boolean; average: number }>(student.get("/v1/me/report-card"));
    expect(card).toMatchObject({ published: true, average: 75 });
    expect((await json<{ results: unknown }>(student.get("/v1/me/student"))).results).toMatchObject({ published: true, average: 75 });
  });

  it("refuse students everywhere else", async () => {
    expect(await json(student.get("/v1/me"))).toMatchObject({ membership: { role: "student" } });
    for (const path of ["/v1/students", "/v1/teachers", "/v1/me/children", "/v1/me/teaching", "/v1/timetable", "/v1/results", "/v1/home", "/v1/student-accounts", `/v1/students/${kid.Bayo}`, "/v1/changes", "/v1/parents", "/v1/me/lessons"]) {
      expect((await student.get(path)).status, path).toBe(403);
    }
    expect((await student.post(`/v1/students/${kid.Bayo}/invite`, { email: "x@pupils.test" })).status).toBe(403);
    // And the other roles can't use the student endpoints.
    for (const who of [owner, teacher]) expect((await who.get("/v1/me/student")).status).toBe(403);
  });

  it("end access: the account leaves, the record stays, and it can be invited again", async () => {
    expect((await owner.del(`/v1/students/${kid.Ada}/access`)).status).toBe(204);
    expect((await student.get("/v1/me/student")).status).toBe(401);
    expect(await accessOf(kid.Ada!)).toMatchObject({ access: "none", email: null });
    expect((await json<{ entries: { what: string }[] }>(owner.get("/v1/changes"))).entries[0]!.what).toBe("Ended Ada Obi’s student portal access");
    expect(await json(owner.post(`/v1/students/${kid.Ada}/invite`, { email: "ada@pupils.test" }), 201)).toMatchObject({ access: "invited" });
    const token = tokenFrom((await waitForMail(h, "ada@pupils.test", "invitation")).text)!;
    const back = browser(h, schoolHost("ebony"));
    expect(await json(back.get(`/v1/invitations/lookup?token=${token}`))).toMatchObject({ existingAccount: true });
    await json(back.post("/v1/invitations/accept", { token }));
    expect((await json<{ fullName: string }>(back.get("/v1/me/student"))).fullName).toBe("Ada Obi");
    // Cancelling an open invite.
    expect(await json(owner.post(`/v1/students/${kid.Bayo}/invite`, { email: "bayo@pupils.test" }), 201)).toMatchObject({ access: "invited" });
    expect((await owner.del(`/v1/students/${kid.Bayo}/access`)).status).toBe(204);
    expect(await accessOf(kid.Bayo!)).toMatchObject({ access: "none" });
  });
});
