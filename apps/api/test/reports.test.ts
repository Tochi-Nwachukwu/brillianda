import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { browser, schoolHost, signUpAndLand, tokenFrom, waitForMail, type Client } from "./flows.js";
import { createHarness, type Harness } from "./helpers.js";

// Wednesday 14 October 2026: the first term is open for results.
const TODAY = "2026-10-14";

let h: Harness;
let owner: Client;
let other: Client;
let teacher: Client;
let parent: Client;
let gold: string;
let blue: string;
let maths: string;
let french: string;
const kids: Record<string, string> = {};

async function json<T>(res: Response | Promise<Response>, status = 200): Promise<T> {
  const r = await res;
  expect(r.status, await r.clone().text()).toBe(status);
  return (await r.json()) as T;
}
const sheet = (arm: string, subject: string) => `/v1/arms/${arm}/subjects/${subject}/sheet`;
async function fill(arm: string, subject: string, studentId: string, ca1: string, ca2: string, exam: string) {
  for (const [componentId, raw] of [["ca1", ca1], ["ca2", ca2], ["exam", exam]]) await json(owner.send("PUT", `${sheet(arm, subject)}/scores`, { studentId, componentId, raw }));
}
async function join(email: string, password: string) {
  const token = tokenFrom((await waitForMail(h, email, "invitation")).text)!;
  const who = browser(h, schoolHost("acacia"));
  const me = await json<{ user: { id: string } }>(who.post("/v1/invitations/accept", { token, password }));
  return { client: who, userId: me.user.id };
}

type Broadsheet = {
  subjects: { name: string; status: string }[];
  rows: { fullName: string; cells: Record<string, unknown>; average: number | null; position: number | null }[];
  allComplete: boolean;
  published: { by: string } | null;
  canPublish: boolean;
};

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ["Date"], now: new Date(`${TODAY}T09:30:00Z`) });
  h = await createHarness();
  ({ school: owner } = await signUpAndLand(h, { schoolName: "Acacia College", subdomain: "acacia", email: "owner@acacia.test", password: "acacia-owner-pw", fullName: "Ngozi Acacia" }));
  ({ school: other } = await signUpAndLand(h, { schoolName: "Palm College", subdomain: "palm", email: "owner@palm.test", password: "palm-owner-pw" }));
  await json(owner.send("PUT", "/v1/session", { startYear: 2026, terms: [{ name: "First Term", startsOn: "2026-09-14", endsOn: "2026-12-18" }, { name: "Second Term", startsOn: "2027-01-11", endsOn: "2027-04-09" }] }));
  await json(owner.send("POST", "/v1/classes/setup", { levels: [{ key: "jss1", name: "JSS 1", short: "JSS1", section: "junior" }], arms: [{ name: "Gold", code: "GOL" }, { name: "Blue", code: "BLU" }], armsByLevel: [[0, 1]] }), 201);
  const { arms } = await json<{ arms: { id: string; label: string }[] }>(owner.get("/v1/students"));
  gold = arms.find((a) => a.label === "JSS 1 Gold")!.id;
  blue = arms.find((a) => a.label === "JSS 1 Blue")!.id;
  const { levels } = await json<{ levels: { id: string }[] }>(owner.get("/v1/classes"));
  await owner.send("POST", "/v1/subjects", { catalogueIds: [], custom: [{ name: "Mathematics", code: "MTH" }, { name: "French", code: "FRE" }] });
  const { subjects } = await json<{ subjects: { id: string; name: string }[] }>(owner.get("/v1/subjects"));
  maths = subjects.find((s) => s.name === "Mathematics")!.id;
  french = subjects.find((s) => s.name === "French")!.id;
  await owner.send("PUT", `/v1/subjects/${maths}/levels/${levels[0]!.id}`, { kind: "compulsory" });
  await owner.send("PUT", `/v1/subjects/${french}/levels/${levels[0]!.id}`, { kind: "elective" });
  for (const [first, last, arm, email] of [["Ada", "Bello", gold, "mum@bello.test"], ["Ben", "Okafor", gold, ""], ["Chi", "Eze", gold, ""], ["Dayo", "Ade", blue, ""]] as const) {
    kids[first] = (
      await json<{ id: string }>(
        owner.send("POST", "/v1/students", { firstName: first, lastName: last, gender: "female", armId: arm, guardianName: `Parent ${last}`, guardianPhone: `0803${String(Object.keys(kids).length).padStart(7, "0")}`, ...(email ? { guardianEmail: email } : {}) }),
        201,
      )
    ).id;
  }
  await json(owner.post("/v1/invitations", { email: "form@acacia.test", fullName: "Femi Form", role: "teacher" }), 201);
  const t = await join("form@acacia.test", "teacher-password");
  teacher = t.client;
  expect((await owner.send("PUT", `/v1/arms/${gold}/form-teacher`, { userId: t.userId })).status).toBe(204);

  const { guardian } = await json<{ guardian: { id: string } }>(owner.get(`/v1/students/${kids.Ada}`));
  await json(owner.post(`/v1/guardians/${guardian.id}/invite`), 201);
  parent = (await join("mum@bello.test", "parent-password")).client;

  await fill(gold, maths, kids.Ada!, "15", "18", "42"); // 75 A
  await fill(gold, maths, kids.Ben!, "10", "10", "30"); // 50 C
  await fill(gold, maths, kids.Chi!, "12", "12", "36"); // 60 B
  expect((await owner.send("PUT", `${sheet(gold, french)}/excluded`, { studentId: kids.Ada, excluded: true })).status).toBe(204);
  await fill(gold, french, kids.Ben!, "20", "20", "40"); // 80 A
  await fill(gold, french, kids.Chi!, "10", "10", "30"); // 50 C
});
afterAll(async () => {
  vi.useRealTimers();
  await h?.t.close();
});

describe("the broadsheet", () => {
  it("shows each student's totals and grades, averages over the subjects they take, and positions", async () => {
    const b = await json<Broadsheet>(teacher.get(`/v1/arms/${gold}/broadsheet`));
    expect(b.subjects.map((s) => [s.name, s.status])).toEqual([["Mathematics", "in-progress"], ["French", "in-progress"]]);
    expect(b.rows.map((r) => [r.fullName, r.cells[maths], r.cells[french], r.average, r.position])).toEqual([
      ["Ada Bello", { total: 75, grade: "A" }, "excluded", 75, 1],
      ["Chi Eze", { total: 60, grade: "B" }, { total: 50, grade: "C" }, 55, 3],
      ["Ben Okafor", { total: 50, grade: "C" }, { total: 80, grade: "A" }, 65, 2],
    ]);
    expect(b).toMatchObject({ allComplete: false, published: null, canPublish: false });
  });

  it("is for owners, admins and the class's form teacher", async () => {
    expect((await teacher.get(`/v1/arms/${blue}/broadsheet`)).status).toBe(403);
    expect((await parent.get(`/v1/arms/${gold}/broadsheet`)).status).toBe(403);
    expect((await json<Broadsheet>(owner.get(`/v1/arms/${gold}/broadsheet`))).canPublish).toBe(true);
  });
});

describe("remarks and ratings", () => {
  it("ratings are off until the school turns them on", async () => {
    expect(await json(owner.get("/v1/results/ratings"))).toEqual({ enabled: false, traits: [] });
    expect((await teacher.send("PUT", `/v1/arms/${gold}/students/${kids.Ada}/ratings`, { trait: "Neatness", value: 4 })).status).toBe(409);
    expect((await owner.send("PUT", "/v1/results/ratings", { enabled: true, traits: [] })).status).toBe(422);
    expect((await owner.send("PUT", "/v1/results/ratings", { enabled: true, traits: ["Punctuality", "Neatness"] })).status).toBe(204);
    expect((await teacher.get("/v1/results/ratings")).status).toBe(403);
  });

  it("the form teacher writes the class teacher's remark and ratings; admins write the principal's", async () => {
    expect((await teacher.send("PUT", `/v1/arms/${gold}/students/${kids.Ada}/remarks/teacher`, { text: "  A careful, steady term.  " })).status).toBe(204);
    expect((await teacher.send("PUT", `/v1/arms/${gold}/students/${kids.Ada}/remarks/principal`, { text: "Well done." })).status).toBe(403);
    expect((await owner.send("PUT", `/v1/arms/${gold}/students/${kids.Ada}/remarks/principal`, { text: "Well done." })).status).toBe(204);
    expect((await teacher.send("PUT", `/v1/arms/${gold}/students/${kids.Ada}/remarks/teacher`, { text: "x".repeat(301) })).status).toBe(422);
    expect((await teacher.send("PUT", `/v1/arms/${gold}/students/${kids.Ada}/ratings`, { trait: "Neatness", value: 4 })).status).toBe(204);
    expect((await teacher.send("PUT", `/v1/arms/${gold}/students/${kids.Ada}/ratings`, { trait: "Neatness", value: 6 })).status).toBe(422);
    expect((await teacher.send("PUT", `/v1/arms/${gold}/students/${kids.Ada}/ratings`, { trait: "Honesty", value: 3 })).status).toBe(409);
    expect((await teacher.send("PUT", `/v1/arms/${gold}/students/${kids.Dayo}/ratings`, { trait: "Neatness", value: 3 })).status).toBe(409);
    await teacher.send("PUT", `/v1/arms/${gold}/students/${kids.Ben}/remarks/teacher`, { text: "Temporary" });
    expect((await teacher.send("PUT", `/v1/arms/${gold}/students/${kids.Ben}/remarks/teacher`, { text: "" })).status).toBe(204);

    const r = await json<{ ratings: { enabled: boolean; traits: string[] }; canWritePrincipal: boolean; rows: { fullName: string; teacherRemark: string; principalRemark: string; ratings: Record<string, number> }[] }>(teacher.get(`/v1/arms/${gold}/reports`));
    expect(r).toMatchObject({ ratings: { enabled: true, traits: ["Punctuality", "Neatness"] }, canWritePrincipal: false });
    expect(r.rows.find((x) => x.fullName === "Ada Bello")).toMatchObject({ teacherRemark: "A careful, steady term.", principalRemark: "Well done.", ratings: { Neatness: 4 } });
    expect(r.rows.find((x) => x.fullName === "Ben Okafor")!.teacherRemark).toBe("");
  });
});

describe("publishing", () => {
  it("needs every subject complete, is for owners and admins, and goes in the history", async () => {
    let res = await owner.send("PUT", `/v1/arms/${gold}/published`, { published: true });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { detail: string }).detail).toBe("2 subjects aren’t complete yet: Mathematics, French.");
    expect((await owner.post(`${sheet(gold, maths)}/complete`)).status).toBe(204);
    expect((await owner.post(`${sheet(gold, french)}/complete`)).status).toBe(204);
    expect((await teacher.send("PUT", `/v1/arms/${gold}/published`, { published: true })).status).toBe(403);
    expect((await owner.send("PUT", `/v1/arms/${gold}/published`, { published: true })).status).toBe(204);
    expect((await owner.send("PUT", `/v1/arms/${gold}/published`, { published: true })).status).toBe(409);
    const b = await json<Broadsheet>(owner.get(`/v1/arms/${gold}/broadsheet`));
    expect(b).toMatchObject({ allComplete: true, published: { by: "Ngozi Acacia" } });
    res = await owner.get("/v1/changes");
    expect(((await res.json()) as { entries: { what: string }[] }).entries.map((e) => e.what)).toContain("Published First Term results for JSS 1 Gold");
  });
});

type Card = {
  student: { fullName: string; armLabel: string };
  subjects: { name: string; scores: Record<string, { value: number } | null>; total: number | null; grade: string | null; remark: string | null }[];
  average: number | null;
  position: number | null;
  of: number;
  ratings: { trait: string; value: number | null }[];
  teacherRemark: string | null;
  principalRemark: string | null;
  formTeacher: string | null;
  nextTermBegins: string | null;
  published: boolean;
  attendance: unknown;
  term: { key: string };
};

describe("report cards", () => {
  it("brings it all together for a student", async () => {
    const card = await json<Card>(owner.get(`/v1/students/${kids.Ada}/report-card`));
    expect(card).toMatchObject({
      term: { key: "2026-1" },
      student: { fullName: "Ada Bello", armLabel: "JSS 1 Gold" },
      average: 75,
      position: 1,
      of: 3,
      ratings: [{ trait: "Punctuality", value: null }, { trait: "Neatness", value: 4 }],
      teacherRemark: "A careful, steady term.",
      principalRemark: "Well done.",
      formTeacher: "Femi Form",
      nextTermBegins: "2027-01-11",
      published: true,
      attendance: { term: "First Term", days: 0, present: 0, late: 0, absent: 0 },
    });
    expect(card.subjects).toEqual([{ name: "Mathematics", scores: { ca1: { value: 15, isAbsent: false }, ca2: { value: 18, isAbsent: false }, exam: { value: 42, isAbsent: false } }, total: 75, grade: "A", remark: "Excellent" }]);
    expect(await json(owner.get(`/v1/students/${kids.Ada}/report-terms`))).toEqual([{ key: "2026-1", name: "First Term", session: "2026/2027", published: true, open: true }]);
    expect((await owner.get(`/v1/students/${kids.Ada}/report-card?term=2025-1`)).status).toBe(404);
  });

  it("the form teacher reads their own class's cards only", async () => {
    expect((await teacher.get(`/v1/students/${kids.Ben}/report-card`)).status).toBe(200);
    expect((await teacher.get(`/v1/students/${kids.Dayo}/report-card`)).status).toBe(403);
    expect((await teacher.get(`/v1/students/${kids.Ben}/report-terms`)).status).toBe(403);
  });
});

describe("parents see results (C4)", () => {
  it("once published: this term's average and position, and the report card", async () => {
    const home = await json<{ children: { fullName: string; results: unknown; pastTerms: unknown[] }[] }>(parent.get("/v1/me/children"));
    expect(home.children).toMatchObject([{ fullName: "Ada Bello", results: { term: "First Term, 2026/2027", published: true, average: 75, position: 1, of: 3 }, pastTerms: [] }]);
    const card = await json<Card>(parent.get(`/v1/me/children/${kids.Ada}/report-card`));
    expect(card).toMatchObject({ average: 75, teacherRemark: "A careful, steady term." });
  });

  it("only their own children, only published terms", async () => {
    expect((await parent.get(`/v1/me/children/${kids.Ben}/report-card`)).status).toBe(404);
    expect((await parent.get(`/v1/me/children/${kids.Ada}/report-card?term=2025-1`)).status).toBe(404);
    expect((await parent.get(`/v1/students/${kids.Ada}/report-card`)).status).toBe(403);
  });

  it("taking results back hides them again", async () => {
    expect((await owner.send("PUT", `/v1/arms/${gold}/published`, { published: false })).status).toBe(204);
    expect((await parent.get(`/v1/me/children/${kids.Ada}/report-card`)).status).toBe(404);
    const home = await json<{ children: { results: unknown }[] }>(parent.get("/v1/me/children"));
    expect(home.children[0]!.results).toEqual({ term: "First Term, 2026/2027", published: false });
    expect((await owner.send("PUT", `/v1/arms/${gold}/published`, { published: false })).status).toBe(409);
  });
});

describe("isolation", () => {
  it("another school can't read this school's broadsheets or cards", async () => {
    expect((await other.get(`/v1/arms/${gold}/broadsheet`)).status).toBe(404);
    expect((await other.get(`/v1/students/${kids.Ada}/report-card`)).status).toBe(404);
    expect((await other.send("PUT", `/v1/arms/${gold}/published`, { published: true })).status).toBe(404);
  });
});
