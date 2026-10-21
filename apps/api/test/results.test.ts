import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { browser, schoolHost, signUpAndLand, tokenFrom, waitForMail, type Client } from "./flows.js";
import { createHarness, type Harness } from "./helpers.js";

// Wednesday 14 October 2026: the first term (from 14 September) is open for results.
const TODAY = "2026-10-14";

let h: Harness;
let owner: Client;
let other: Client;
let teacher: Client;
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
const score = (who: Client, arm: string, subject: string, studentId: string, componentId: string, raw: string) => who.send("PUT", `${sheet(arm, subject)}/scores`, { studentId, componentId, raw });

type Sheet = {
  term: { key: string; name: string; session: string };
  status: string;
  canEdit: boolean;
  isAdmin: boolean;
  kind: string;
  components: { id: string; maxScore: number }[];
  completedBy: { by: string } | null;
  unlockRequest: { by: string; reason: string } | null;
  rows: { studentId: string; fullName: string; excluded: boolean; scores: Record<string, { value: number; isAbsent: boolean }> }[];
};
type Summary = { subjectName: string; armLabel: string; teacher: string | null; status: string; complete: number; of: number; unlockRequest: unknown };

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ["Date"], now: new Date(`${TODAY}T09:30:00Z`) });
  h = await createHarness();
  ({ school: owner } = await signUpAndLand(h, { schoolName: "Mahogany High", subdomain: "mahogany", email: "owner@mahogany.test", password: "mahogany-pw", fullName: "Kola Mahogany" }));
  ({ school: other } = await signUpAndLand(h, { schoolName: "Cedar High", subdomain: "cedar", email: "owner@cedar.test", password: "cedar-owner-pw" }));
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
  expect((await owner.send("PUT", `/v1/subjects/${maths}/levels/${levels[0]!.id}`, { kind: "compulsory" })).status).toBeLessThan(300);
  expect((await owner.send("PUT", `/v1/subjects/${french}/levels/${levels[0]!.id}`, { kind: "elective" })).status).toBeLessThan(300);
  for (const [first, last, arm] of [["Ada", "Bello", gold], ["Ben", "Okafor", gold], ["Chi", "Eze", gold], ["Dayo", "Ade", blue]] as const) {
    kids[first] = (await json<{ id: string }>(owner.send("POST", "/v1/students", { firstName: first, lastName: last, gender: "female", armId: arm, guardianName: `Parent ${last}`, guardianPhone: `0803${String(Object.keys(kids).length).padStart(7, "0")}` }), 201)).id;
  }
  await json(owner.post("/v1/invitations", { email: "maths@mahogany.test", fullName: "Musa Maths", role: "teacher" }), 201);
  const token = tokenFrom((await waitForMail(h, "maths@mahogany.test", "invitation")).text)!;
  teacher = browser(h, schoolHost("mahogany"));
  const t = await json<{ user: { id: string } }>(teacher.post("/v1/invitations/accept", { token, password: "teacher-password" }));
  expect((await owner.send("PUT", `/v1/teachers/${t.user.id}/subject-classes`, [{ armId: gold, subjectId: maths }])).status).toBe(204);
});
afterAll(async () => {
  vi.useRealTimers();
  await h?.t.close();
});

describe("results settings", () => {
  it("start with CA1 20, CA2 20, Exam 60 and A to F", async () => {
    const s = await json<{ components: { id: string; maxScore: number }[]; scale: { grade: string }[]; showPositions: boolean; scoresEntered: boolean }>(owner.get("/v1/results/settings"));
    expect(s.components.map((c) => `${c.id}:${c.maxScore}`)).toEqual(["ca1:20", "ca2:20", "exam:60"]);
    expect(s.scale.map((b) => b.grade)).toEqual(["A", "B", "C", "D", "E", "F"]);
    expect(s).toMatchObject({ showPositions: true, scoresEntered: false });
  });

  it("need parts adding up to 100 and a grade from 0", async () => {
    const base = (await json<Record<string, unknown>>(owner.get("/v1/results/settings"))) as { components: { id: string; name: string; maxScore: number }[]; scale: unknown[]; showPositions: boolean };
    const res = await owner.send("PUT", "/v1/results/settings", { ...base, components: [{ id: "ca", name: "CA", maxScore: 30 }, { id: "exam", name: "Exam", maxScore: 60 }] });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { errors: { detail: string }[] }).errors[0]!.detail).toBe("The parts add up to 90. Make them add up to 100.");
    // Renaming a part and hiding positions is fine.
    expect((await owner.send("PUT", "/v1/results/settings", { ...base, components: base.components.map((c) => (c.id === "exam" ? { ...c, name: "Examination" } : c)), showPositions: false })).status).toBe(204);
    expect((await json<{ showPositions: boolean }>(owner.get("/v1/results/settings"))).showPositions).toBe(false);
  });

  it("are for owners and admins only", async () => {
    expect((await teacher.get("/v1/results/settings")).status).toBe(403);
    expect((await teacher.get("/v1/results")).status).toBe(403);
  });
});

describe("score entry", () => {
  it("a teacher sees their own sheets", async () => {
    const mine = await json<{ term: { key: string; name: string }; sheets: Summary[] }>(teacher.get("/v1/me/sheets"));
    expect(mine.term).toMatchObject({ key: "2026-1", name: "First Term" });
    expect(mine.sheets.map((s) => [s.armLabel, s.subjectName, s.teacher, s.status, `${s.complete}/${s.of}`])).toEqual([["JSS 1 Gold", "Mathematics", "Musa Maths", "not-started", "0/3"]]);
  });

  it("opens their sheet, and no one else's", async () => {
    const s = await json<Sheet>(teacher.get(sheet(gold, maths)));
    expect(s).toMatchObject({ term: { key: "2026-1", session: "2026/2027" }, status: "not-started", canEdit: true, isAdmin: false, kind: "compulsory" });
    expect(s.rows.map((r) => r.fullName)).toEqual(["Ada Bello", "Chi Eze", "Ben Okafor"]);
    expect((await teacher.get(sheet(blue, maths))).status).toBe(403);
    expect((await teacher.get(sheet(gold, french))).status).toBe(403);
    expect((await owner.get(sheet(blue, maths))).status).toBe(200);
  });

  it("saves scores: numbers up to the part's marks with 2 decimals, ABS, or empty", async () => {
    expect(await json(score(teacher, gold, maths, kids.Ada!, "ca1", "15.5"))).toEqual({ status: "in-progress" });
    for (const [raw, why] of [["25", "Must be 20 or less"], ["abc", "Enter a number, or ABS if absent"], ["1.234", "Enter a number, or ABS if absent"]] as const) {
      const res = await score(teacher, gold, maths, kids.Ada!, "ca2", raw);
      expect(res.status, raw).toBe(422);
      expect(((await res.json()) as { errors: { pointer: string; detail: string }[] }).errors[0]).toMatchObject({ pointer: "#/raw", detail: why });
    }
    await json(score(teacher, gold, maths, kids.Ada!, "ca2", "abs"));
    await json(score(teacher, gold, maths, kids.Ben!, "ca1", "10"));
    expect(await json(score(teacher, gold, maths, kids.Ben!, "ca1", ""))).toEqual({ status: "in-progress" });
    expect((await score(teacher, gold, maths, kids.Dayo!, "ca1", "10")).status).toBe(409);
    expect((await score(teacher, gold, maths, kids.Ada!, "project", "10")).status).toBe(409);

    const s = await json<Sheet>(teacher.get(sheet(gold, maths)));
    expect(s.rows.find((r) => r.studentId === kids.Ada)!.scores).toEqual({ ca1: { value: 15.5, isAbsent: false }, ca2: { value: 0, isAbsent: true } });
    expect(s.rows.find((r) => r.studentId === kids.Ben)!.scores).toEqual({});
  });

  it("the parts can't change once scores are in this term", async () => {
    const base = await json<{ components: { id: string; name: string; maxScore: number }[]; scale: unknown[]; showPositions: boolean; scoresEntered: boolean }>(owner.get("/v1/results/settings"));
    expect(base.scoresEntered).toBe(true);
    const res = await owner.send("PUT", "/v1/results/settings", { components: [{ id: "ca", name: "CA", maxScore: 40 }, { id: "exam", name: "Exam", maxScore: 60 }], scale: base.scale, showPositions: true });
    expect(res.status).toBe(409);
  });

  it("an elective can leave a student out, clearing their scores; a compulsory subject can't", async () => {
    expect((await owner.send("PUT", `${sheet(gold, maths)}/excluded`, { studentId: kids.Ada, excluded: true })).status).toBe(409);
    await json(score(owner, gold, french, kids.Chi!, "ca1", "12"));
    expect((await owner.send("PUT", `${sheet(gold, french)}/excluded`, { studentId: kids.Chi, excluded: true })).status).toBe(204);
    let s = await json<Sheet>(owner.get(sheet(gold, french)));
    expect(s.rows.find((r) => r.studentId === kids.Chi)).toMatchObject({ excluded: true, scores: {} });
    expect((await score(owner, gold, french, kids.Chi!, "ca1", "12")).status).toBe(409);
    expect((await owner.send("PUT", `${sheet(gold, french)}/excluded`, { studentId: kids.Chi, excluded: false })).status).toBe(204);
    s = await json<Sheet>(owner.get(sheet(gold, french)));
    expect(s.rows.find((r) => r.studentId === kids.Chi)!.excluded).toBe(false);
  });

  it("can't be marked complete while scores are empty; then it locks for the teacher", async () => {
    const res = await teacher.post(`${sheet(gold, maths)}/complete`);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { detail: string }).detail).toBe("3 students still have empty scores. Enter them, or ABS for absent.");
    for (const kid of [kids.Ada!, kids.Ben!, kids.Chi!]) for (const part of ["ca1", "ca2", "exam"]) await json(score(teacher, gold, maths, kid, part, part === "exam" ? "45" : "12"));
    expect((await teacher.post(`${sheet(gold, maths)}/complete`)).status).toBe(204);
    const s = await json<Sheet>(teacher.get(sheet(gold, maths)));
    expect(s).toMatchObject({ status: "complete", canEdit: false, completedBy: { by: "Musa Maths" } });
    expect((await score(teacher, gold, maths, kids.Ada!, "exam", "50")).status).toBe(409);
    // Admins can still correct a completed sheet.
    expect(await json(score(owner, gold, maths, kids.Ada!, "exam", "50"))).toEqual({ status: "complete" });
  });

  it("the teacher asks to unlock; an admin declines, then approves; it reopens", async () => {
    expect((await teacher.post(`${sheet(gold, maths)}/unlock-request`, { reason: "typo" })).status).toBe(422);
    expect((await teacher.post(`${sheet(gold, maths)}/unlock-request`, { reason: "Chi's exam was 54, not 45" })).status).toBe(204);
    expect((await teacher.post(`${sheet(gold, maths)}/unlock-request`, { reason: "Again please" })).status).toBe(409);

    const overview = await json<{ arms: { label: string; sheets: number; complete: number; inProgress: number }[]; requests: { by: string; reason: string; subjectName: string; armLabel: string }[] }>(owner.get("/v1/results"));
    expect(overview.arms).toEqual([
      { armId: gold, label: "JSS 1 Gold", sheets: 2, complete: 1, inProgress: 0 },
      { armId: blue, label: "JSS 1 Blue", sheets: 2, complete: 0, inProgress: 0 },
    ]);
    expect(overview.requests).toMatchObject([{ by: "Musa Maths", reason: "Chi's exam was 54, not 45", subjectName: "Mathematics", armLabel: "JSS 1 Gold" }]);
    const armSheets = await json<{ sheets: Summary[] }>(owner.get(`/v1/arms/${gold}/sheets`));
    expect(armSheets.sheets.map((s) => [s.subjectName, s.status, `${s.complete}/${s.of}`, !!s.unlockRequest])).toEqual([
      ["Mathematics", "complete", "3/3", true],
      ["French", "not-started", "0/3", false],
    ]);

    expect((await teacher.post(`${sheet(gold, maths)}/unlock`, { approve: true })).status).toBe(403);
    expect((await owner.post(`${sheet(gold, maths)}/unlock`, { approve: false })).status).toBe(204);
    expect((await owner.post(`${sheet(gold, maths)}/unlock`, { approve: false })).status).toBe(409);
    expect((await json<Sheet>(teacher.get(sheet(gold, maths)))).unlockRequest).toBeNull();
    await teacher.post(`${sheet(gold, maths)}/unlock-request`, { reason: "Chi's exam was 54, not 45" });
    expect((await owner.post(`${sheet(gold, maths)}/unlock`, { approve: true })).status).toBe(204);
    expect(await json(score(teacher, gold, maths, kids.Chi!, "exam", "54"))).toEqual({ status: "in-progress" });

    const history = await json<{ entries: { what: string }[] }>(owner.get("/v1/changes"));
    expect(history.entries.map((e) => e.what)).toEqual(
      expect.arrayContaining([
        "Marked Mathematics complete for JSS 1 Gold",
        "Asked to unlock Mathematics for JSS 1 Gold: Chi's exam was 54, not 45",
        "Declined Musa Maths’s request to unlock Mathematics for JSS 1 Gold",
        "Unlocked Mathematics for JSS 1 Gold",
      ]),
    );
  });
});

describe("before the term starts", () => {
  it("there's no open term: the overview shows the next one, and sheets aren't open", async () => {
    vi.setSystemTime(new Date("2026-09-01T09:00:00Z"));
    try {
      expect(await json(owner.get("/v1/results"))).toEqual({ term: null, next: { name: "First Term", startsOn: "2026-09-14" }, arms: [], requests: [] });
      expect((await owner.get(sheet(gold, maths))).status).toBe(404);
      expect(await json(teacher.get("/v1/me/sheets"))).toEqual({ term: null, sheets: [] });
    } finally {
      vi.setSystemTime(new Date(`${TODAY}T09:30:00Z`));
    }
  });
});

describe("isolation", () => {
  it("another school can't open these sheets", async () => {
    expect((await other.get(sheet(gold, maths))).status).toBe(404);
    expect((await score(other, gold, maths, kids.Ada!, "ca1", "1")).status).toBe(404);
    expect((await other.get(`/v1/arms/${gold}/sheets`)).status).toBe(404);
    expect((await json<{ arms: unknown[] }>(other.get("/v1/results"))).arms).toEqual([]);
  });
});
