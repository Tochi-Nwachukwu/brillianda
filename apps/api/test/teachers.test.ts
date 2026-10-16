import { auditLog, eq, withSchool } from "@brillianda/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { browser, schoolHost, signUpAndLand, tokenFrom, waitForMail, type Client } from "./flows.js";
import { createHarness, type Harness } from "./helpers.js";

// Wednesday 14 October 2026, mid-morning in Lagos: a school day in the first term.
const TODAY = "2026-10-14";

let h: Harness;
let owner: Client;
let other: Client;
let oakId: string;
let gold: string;
let blue: string;
let maths: string;
let english: string;
const pupils: Record<string, string> = {};

async function json<T>(res: Response | Promise<Response>, status = 200): Promise<T> {
  const r = await res;
  expect(r.status, await r.clone().text()).toBe(status);
  return (await r.json()) as T;
}

/** Invites someone as a teacher (or admin) and accepts on a fresh browser, signed in. */
async function join(by: Client, email: string, fullName: string, role: "teacher" | "admin" = "teacher") {
  const res = await by.post("/v1/invitations", { email, fullName, role });
  expect(res.status, await res.clone().text()).toBe(201);
  const token = tokenFrom((await waitForMail(h, email, "invitation")).text)!;
  const person = browser(h, schoolHost("oak"));
  const me = await json<{ user: { id: string }; membership: { role: string } }>(person.post("/v1/invitations/accept", { token, password: `${fullName}-password` }));
  expect(me.membership.role).toBe(role);
  return { client: person, userId: me.user.id };
}

let ada: { client: Client; userId: string };
let admin: { client: Client; userId: string };

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ["Date"], now: new Date(`${TODAY}T09:30:00Z`) });
  h = await createHarness();
  ({ school: owner, schoolId: oakId } = await signUpAndLand(h, { schoolName: "Oak College", subdomain: "oak", email: "owner@oak.test", password: "oak-owner-pw", fullName: "Kemi Oak" }));
  ({ school: other } = await signUpAndLand(h, { schoolName: "Pine College", subdomain: "pine", email: "owner@pine.test", password: "pine-owner-pw" }));
  await json(owner.send("PUT", "/v1/session", { startYear: 2026, terms: [{ name: "First Term", startsOn: "2026-09-14", endsOn: "2026-12-18" }, { name: "Second Term", startsOn: "2027-01-11", endsOn: "2027-04-09" }] }));
  await json(owner.send("POST", "/v1/classes/setup", { levels: [{ key: "jss1", name: "JSS 1", short: "JSS1", section: "junior" }], arms: [{ name: "Gold", code: "GOL" }, { name: "Blue", code: "BLU" }], armsByLevel: [[0, 1]] }), 201);
  const { arms } = await json<{ arms: { id: string; label: string }[] }>(owner.get("/v1/students"));
  gold = arms.find((a) => a.label === "JSS 1 Gold")!.id;
  blue = arms.find((a) => a.label === "JSS 1 Blue")!.id;
  await owner.send("POST", "/v1/subjects", { catalogueIds: [], custom: [{ name: "Mathematics", code: "MTH" }, { name: "English", code: "ENG" }] });
  const { subjects } = await json<{ subjects: { id: string; name: string }[] }>(owner.get("/v1/subjects"));
  maths = subjects.find((s) => s.name === "Mathematics")!.id;
  english = subjects.find((s) => s.name === "English")!.id;
  for (const [first, last, arm] of [["Zara", "Bello", gold], ["Ade", "Okafor", gold], ["Chidi", "Bello", gold], ["Musa", "Eze", blue]] as const) {
    const s = await json<{ id: string }>(
      owner.send("POST", "/v1/students", { firstName: first, lastName: last, gender: "male", armId: arm, guardianName: `Parent ${last}`, guardianPhone: `0803${String(Object.keys(pupils).length).padStart(7, "0")}` }),
      201,
    );
    pupils[first] = s.id;
  }
  ada = await join(owner, "ada@oak.test", "Ada Teacher");
  admin = await join(owner, "admin@oak.test", "Bayo Admin", "admin");
});
afterAll(async () => {
  vi.useRealTimers();
  await h?.t.close();
});

describe("the teacher role", () => {
  it("signs in and sees who they are, but every owner and admin screen refuses them", async () => {
    expect(await json<{ membership: { role: string } }>(ada.client.get("/v1/me"))).toMatchObject({ membership: { role: "teacher" } });
    for (const path of ["/v1/students", "/v1/teachers", "/v1/home", "/v1/members", "/v1/classes", "/v1/subjects", "/v1/changes", "/v1/registers/today", "/v1/invitations"]) {
      expect((await ada.client.get(path)).status, path).toBe(403);
    }
    expect((await ada.client.send("PUT", `/v1/arms/${gold}/form-teacher`, { userId: ada.userId })).status).toBe(403);
    expect((await ada.client.post("/v1/invitations", { email: "x@oak.test", role: "teacher" })).status).toBe(403);
  });

  it("isn't listed among the admins, and can't be removed from there", async () => {
    const { data } = await json<{ data: { email: string }[] }>(owner.get("/v1/members"));
    expect(data.map((m) => m.email)).toEqual(["owner@oak.test", "admin@oak.test"]);
    expect((await owner.del(`/v1/members/${ada.userId}`)).status).toBe(404);
  });

  it("can be invited by an admin, who still can't invite admins or replace the owner's admin invite", async () => {
    expect((await admin.client.post("/v1/invitations", { email: "bola@oak.test", fullName: "Bola Teacher", role: "teacher" })).status).toBe(201);
    expect((await admin.client.post("/v1/invitations", { email: "new-admin@oak.test", role: "admin" })).status).toBe(403);
    expect((await owner.post("/v1/invitations", { email: "pending@oak.test", role: "admin" })).status).toBe(201);
    expect((await admin.client.post("/v1/invitations", { email: "pending@oak.test", role: "teacher" })).status).toBe(409);
    // The owner's list of invitations is for admins; teacher invites live on the Teachers page.
    const { data } = await json<{ data: { email: string }[] }>(owner.get("/v1/invitations"));
    expect(data.map((i) => i.email)).toEqual(["pending@oak.test"]);
    const mail = await waitForMail(h, "bola@oak.test", "invitation");
    expect(mail.text).toContain("as a teacher");
  });
});

describe("the Teachers page", () => {
  it("lists teachers and open invites, every class and the subjects", async () => {
    const page = await json<{ teachers: { id: string; fullName: string; status: string; invitedAt?: number; formArms: unknown[] }[]; arms: { id: string; label: string; formTeacherId: string | null }[]; subjects: { name: string }[] }>(owner.get("/v1/teachers"));
    expect(page.teachers.map((t) => [t.fullName, t.status])).toEqual([
      ["Ada Teacher", "active"],
      ["Bola Teacher", "invited"],
    ]);
    expect(page.teachers[1]!.invitedAt).toEqual(expect.any(Number));
    expect(page.arms).toEqual([
      { id: gold, label: "JSS 1 Gold", formTeacherId: null },
      { id: blue, label: "JSS 1 Blue", formTeacherId: null },
    ]);
    expect(page.subjects.map((s) => s.name)).toEqual(["Mathematics", "English"]);
  });

  it("sets a form teacher, and refuses someone who isn't a teacher", async () => {
    expect((await owner.send("PUT", `/v1/arms/${gold}/form-teacher`, { userId: ada.userId })).status).toBe(204);
    const bad = await owner.send("PUT", `/v1/arms/${blue}/form-teacher`, { userId: admin.userId });
    expect(bad.status).toBe(422);
    expect(((await bad.json()) as { errors: { pointer: string }[] }).errors[0]!.pointer).toBe("#/userId");
    const page = await json<{ teachers: { fullName: string; formArms: { label: string }[] }[]; arms: { formTeacherId: string | null }[] }>(owner.get("/v1/teachers"));
    expect(page.teachers[0]!.formArms).toEqual([{ armId: gold, label: "JSS 1 Gold" }]);
    expect(page.arms[0]!.formTeacherId).toBe(ada.userId);
  });

  it("sets subject classes as a whole list; a class taken by another teacher moves to them", async () => {
    expect((await admin.client.send("PUT", `/v1/teachers/${ada.userId}/subject-classes`, [{ armId: gold, subjectId: maths }, { armId: blue, subjectId: maths }, { armId: gold, subjectId: maths }])).status).toBe(204);
    const bola = await joinInvited("bola@oak.test", "Bola Teacher");
    expect((await owner.send("PUT", `/v1/teachers/${bola.userId}/subject-classes`, [{ armId: gold, subjectId: maths }])).status).toBe(204);
    const page = await json<{ teachers: { fullName: string; subjectClasses: { label: string }[] }[] }>(owner.get("/v1/teachers"));
    expect(page.teachers.find((t) => t.fullName === "Ada Teacher")!.subjectClasses.map((s) => s.label)).toEqual(["Mathematics, JSS 1 Blue"]);
    expect(page.teachers.find((t) => t.fullName === "Bola Teacher")!.subjectClasses.map((s) => s.label)).toEqual(["Mathematics, JSS 1 Gold"]);
    expect((await owner.send("PUT", `/v1/teachers/${ada.userId}/subject-classes`, [{ armId: crypto.randomUUID(), subjectId: maths }])).status).toBe(409);
    expect((await owner.send("PUT", `/v1/teachers/${admin.userId}/subject-classes`, [])).status).toBe(404);
  });
});

async function joinInvited(email: string, fullName: string) {
  const token = tokenFrom((await waitForMail(h, email, "invitation")).text)!;
  const person = browser(h, schoolHost("oak"));
  const me = await json<{ user: { id: string } }>(person.post("/v1/invitations/accept", { token, password: "bola-password" }));
  expect((await json<{ user: { fullName: string } }>(person.get("/v1/me"))).user.fullName).toBe(fullName);
  return { client: person, userId: me.user.id };
}

type Register = {
  date: string;
  problem: string | null;
  taken: { by: string; at: number; updatedBy?: string; updatedAt?: number } | null;
  students: { id: string; fullName: string; mark: string | null; note: string }[];
  days: { date: string; taken: boolean }[];
};

describe("the register", () => {
  it("opens on the latest school day for the form teacher, students by surname", async () => {
    const reg = await json<Register>(ada.client.get(`/v1/arms/${gold}/register`));
    expect(reg).toMatchObject({ date: TODAY, problem: null, taken: null });
    expect(reg.students.map((s) => [s.fullName, s.mark])).toEqual([
      ["Chidi Bello", null],
      ["Zara Bello", null],
      ["Ade Okafor", null],
    ]);
    expect(reg.days[0]).toEqual({ date: TODAY, taken: false });
    expect(reg.days.at(-1)).toEqual({ date: "2026-09-14", taken: false });
    expect(reg.days).toHaveLength(23);
  });

  it("is closed to a teacher who isn't the class's form teacher", async () => {
    expect((await ada.client.get(`/v1/arms/${blue}/register`)).status).toBe(403);
    expect((await ada.client.send("PUT", `/v1/arms/${blue}/register`, { date: TODAY, marks: [{ studentId: pupils.Musa, mark: "present" }] })).status).toBe(403);
  });

  it("explains days that can't be marked", async () => {
    expect((await json<Register>(ada.client.get(`/v1/arms/${gold}/register?date=2026-10-10`))).problem).toMatch(/weekend/);
    const all = (mark = "present") => [pupils.Zara, pupils.Ade, pupils.Chidi].map((studentId) => ({ studentId, mark }));
    for (const [date, why] of [["2026-10-10", /weekend/], ["2026-10-15", /hasn’t come/], ["2026-08-03", /isn’t in a term/]] as const) {
      const res = await ada.client.send("PUT", `/v1/arms/${gold}/register`, { date, marks: all() });
      expect(res.status).toBe(422);
      const body = (await res.json()) as { errors: { pointer: string; detail: string }[] };
      expect(body.errors[0]).toMatchObject({ pointer: "#/date" });
      expect(body.errors[0]!.detail).toMatch(why);
    }
    expect((await ada.client.get(`/v1/arms/${gold}/register?date=2026-02-30`)).status).toBe(422);
  });

  it("needs every student marked once, and only the class's students", async () => {
    const missing = await ada.client.send("PUT", `/v1/arms/${gold}/register`, { date: TODAY, marks: [{ studentId: pupils.Zara, mark: "present" }] });
    expect(missing.status).toBe(422);
    const twice = await ada.client.send("PUT", `/v1/arms/${gold}/register`, {
      date: TODAY,
      marks: [pupils.Zara, pupils.Zara, pupils.Ade].map((studentId) => ({ studentId, mark: "present" })),
    });
    expect(twice.status).toBe(422);
    const stranger = await ada.client.send("PUT", `/v1/arms/${gold}/register`, {
      date: TODAY,
      marks: [pupils.Zara, pupils.Ade, pupils.Chidi, pupils.Musa].map((studentId) => ({ studentId, mark: "present" })),
    });
    expect(stranger.status).toBe(409);
    expect((await ada.client.send("PUT", `/v1/arms/${gold}/register`, { date: TODAY, marks: [{ studentId: pupils.Zara, mark: "sick" }] })).status).toBe(422);
  });

  it("saves, counting late as present, and records who took and who changed it", async () => {
    const saved = await json<{ present: number; absent: number }>(
      ada.client.send("PUT", `/v1/arms/${gold}/register`, {
        date: TODAY,
        marks: [
          { studentId: pupils.Zara, mark: "present" },
          { studentId: pupils.Ade, mark: "late", note: "  Bus broke down  " },
          { studentId: pupils.Chidi, mark: "absent" },
        ],
      }),
    );
    expect(saved).toEqual({ present: 2, absent: 1 });
    let reg = await json<Register>(ada.client.get(`/v1/arms/${gold}/register`));
    expect(reg.taken).toMatchObject({ by: "Ada Teacher" });
    expect(reg.taken!.updatedBy).toBeUndefined();
    expect(reg.students.find((s) => s.id === pupils.Ade)).toMatchObject({ mark: "late", note: "Bus broke down" });
    expect(reg.days[0]).toEqual({ date: TODAY, taken: true });

    // An admin fixes it; an earlier day this term can be taken too.
    await json(owner.send("PUT", `/v1/arms/${gold}/register`, { date: TODAY, marks: [pupils.Zara, pupils.Ade, pupils.Chidi].map((studentId) => ({ studentId, mark: "present" })) }));
    reg = await json<Register>(owner.get(`/v1/arms/${gold}/register?date=${TODAY}`));
    expect(reg.taken).toMatchObject({ by: "Ada Teacher", updatedBy: "Kemi Oak" });
    expect(reg.students.every((s) => s.mark === "present" && s.note === "")).toBe(true);
    await json(ada.client.send("PUT", `/v1/arms/${gold}/register`, { date: "2026-10-13", marks: [pupils.Zara, pupils.Ade, pupils.Chidi].map((studentId) => ({ studentId, mark: "present" })) }));

    const history = await withSchool(h.db, oakId, (tx) => tx.select({ summary: auditLog.summary }).from(auditLog).where(eq(auditLog.entity, "register")));
    expect(history.map((r) => r.summary)).toEqual([
      `Took the register for JSS 1 Gold on ${TODAY}`,
      `Changed the register for JSS 1 Gold on ${TODAY}`,
      "Took the register for JSS 1 Gold on 2026-10-13",
    ]);
  });

  it("shows on Home which classes are still missing today", async () => {
    expect(await json(owner.get("/v1/registers/today"))).toEqual({ date: TODAY, taken: 1, total: 2, missing: [{ armId: blue, label: "JSS 1 Blue" }] });
  });
});

describe("what a teacher sees", () => {
  it("their home: form classes with today's register, and subject classes", async () => {
    expect(await json(ada.client.get("/v1/me/teaching"))).toEqual({
      fullName: "Ada Teacher",
      today: TODAY,
      formArms: [{ armId: gold, label: "JSS 1 Gold", students: 3, takenToday: true, takenThisTerm: 2, daysThisTerm: 23 }],
      subjects: [{ armId: blue, subjectId: maths, label: "JSS 1 Blue", subjectName: "Mathematics", students: 1 }],
    });
  });

  it("a subject class they teach, but not one they don't", async () => {
    expect(await json(ada.client.get(`/v1/arms/${blue}/subjects/${maths}/students`))).toEqual({
      armLabel: "JSS 1 Blue",
      subjectName: "Mathematics",
      students: [{ id: pupils.Musa, fullName: "Musa Eze", admissionNo: expect.any(String) }],
    });
    expect((await ada.client.get(`/v1/arms/${gold}/subjects/${english}/students`)).status).toBe(403);
    expect((await owner.get(`/v1/arms/${gold}/subjects/${english}/students`)).status).toBe(200);
  });

  it("nothing at a weekend", async () => {
    vi.setSystemTime(new Date("2026-10-17T09:00:00Z"));
    try {
      const home = await json<{ today: string | null }>(ada.client.get("/v1/me/teaching"));
      expect(home.today).toBeNull();
      expect((await json<{ date: string | null }>(owner.get("/v1/registers/today"))).date).toBeNull();
      expect((await json<Register>(ada.client.get(`/v1/arms/${gold}/register`))).date).toBe("2026-10-16");
    } finally {
      vi.setSystemTime(new Date(`${TODAY}T09:30:00Z`));
    }
  });
});

describe("removing teachers", () => {
  it("cancels an open teacher invite", async () => {
    await owner.post("/v1/invitations", { email: "late@oak.test", fullName: "Late Teacher", role: "teacher" });
    const page = await json<{ teachers: { id: string; email: string; status: string }[] }>(owner.get("/v1/teachers"));
    const invite = page.teachers.find((t) => t.email === "late@oak.test")!;
    expect(invite.status).toBe("invited");
    expect((await owner.del(`/v1/teachers/${invite.id}`)).status).toBe(204);
    expect((await owner.del(`/v1/teachers/${invite.id}`)).status).toBe(404);
  });

  it("removes a teacher: signed out, classes freed, their name kept on registers", async () => {
    expect((await owner.del(`/v1/teachers/${ada.userId}`)).status).toBe(204);
    expect((await ada.client.get("/v1/me")).status).toBe(401);
    const page = await json<{ teachers: { fullName: string }[]; arms: { formTeacherId: string | null }[] }>(owner.get("/v1/teachers"));
    expect(page.teachers.map((t) => t.fullName)).not.toContain("Ada Teacher");
    expect(page.arms.every((a) => a.formTeacherId === null)).toBe(true);
    expect((await json<Register>(owner.get(`/v1/arms/${gold}/register?date=2026-10-13`))).taken).toMatchObject({ by: "Ada Teacher" });
    expect((await owner.del(`/v1/teachers/${admin.userId}`)).status).toBe(404);
  });
});

describe("isolation", () => {
  it("another school can't see or mark this school's classes", async () => {
    expect((await other.get(`/v1/arms/${gold}/register`)).status).toBe(404);
    expect((await other.send("PUT", `/v1/arms/${gold}/register`, { date: TODAY, marks: [{ studentId: pupils.Zara, mark: "present" }] })).status).toBe(404);
    expect((await other.send("PUT", `/v1/arms/${gold}/form-teacher`, { userId: null })).status).toBe(404);
    expect((await other.get(`/v1/arms/${gold}/subjects/${maths}/students`)).status).toBe(404);
    expect((await other.send("PUT", `/v1/teachers/${admin.userId}/subject-classes`, [])).status).toBe(404);
    const page = await json<{ teachers: unknown[]; arms: unknown[] }>(other.get("/v1/teachers"));
    expect(page).toMatchObject({ teachers: [], arms: [] });
  });
});
