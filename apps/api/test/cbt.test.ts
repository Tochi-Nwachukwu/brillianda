import { and, cbtAttempts, eq, scores, sheetCompletions, withSchool } from "@brillianda/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { testSettingsSchema } from "../src/lib/cbt-rules.js";
import { browser, schoolHost, signUpAndLand, tokenFrom, waitForMail, type Client } from "./flows.js";
import { createHarness, type Harness } from "./helpers.js";

const NOW = "2026-10-14T09:30:00Z";

let h: Harness;
let owner: Client;
let teacher: Client;
let other: Client;
const pupil: Record<string, Client> = {};
let schoolId: string;
let levelId: string;
let maths: string;
let english: string;
const arm: Record<string, string> = {};
const kid: Record<string, string> = {};
let bank: string[] = [];
let testId: string;

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
const at = (iso: string) => vi.setSystemTime(new Date(iso));

const base = { topic: "Fractions", difficulty: "easy" };
const QUESTIONS = [
  { type: "objective", text: "What is 1/2 + 1/4?", options: ["2/6", "3/4", "1/8"], answer: 1, marks: 1, ...base },
  { type: "trueFalse", text: "2/4 equals 1/2.", answer: true, marks: 1, ...base },
  { type: "fillGap", text: "The top number of a fraction is the ____.", answers: ["numerator"], marks: 2, ...base },
  { type: "theory", text: "Explain how to add 1/3 and 1/6.", guide: "Common denominator 6; 2/6 + 1/6 = 3/6 = 1/2", marks: 5, ...base },
];
const settings = (over: object = {}) => ({
  title: "Fractions test",
  instructions: "Answer every question.",
  armIds: [arm["JSS 1 Gold"]],
  questionIds: bank,
  durationMinutes: 30,
  opensAt: "2026-10-14T09:00:00Z",
  closesAt: "2026-10-14T12:00:00Z",
  where: "school",
  shuffle: true,
  showScore: true,
  componentId: "ca1",
  ...over,
});

async function studentAccount(name: string, email: string) {
  await json(owner.post(`/v1/students/${kid[name]}/invite`, { email }), 201);
  const client = browser(h, schoolHost("acaciahigh"));
  await json(client.post("/v1/invitations/accept", { token: tokenFrom((await waitForMail(h, email, "invitation")).text)!, password: "student-password" }));
  pupil[name] = client;
}

type Taking = { deadline: number | null; now: number; submitted: boolean; questions: { index: number; type: string; text: string; options: { index: number; text: string }[] }[]; responses: Record<string, unknown> };
type Row = { id: string; status: string; window: string; students: number; submitted: number; toMark: number; armLabels: string[]; marks: number; questions: number; sentAt: number | null };

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ["Date"], now: new Date(NOW) });
  h = await createHarness();
  ({ school: owner, schoolId } = await signUpAndLand(h, { schoolName: "Acacia High", subdomain: "acaciahigh", email: "owner@acaciahigh.test", password: "acaciahigh-owner-pw", fullName: "Remi Acacia" }));
  ({ school: other } = await signUpAndLand(h, { schoolName: "Baobab High", subdomain: "baobabhigh", email: "owner@baobabhigh.test", password: "baobabhigh-owner-pw" }));
  await json(owner.send("PUT", "/v1/session", { startYear: 2026, terms: [{ name: "First Term", startsOn: "2026-09-14", endsOn: "2026-12-18" }, { name: "Second Term", startsOn: "2027-01-11", endsOn: "2027-07-16" }] }));
  await json(owner.send("POST", "/v1/classes/setup", { levels: [{ key: "jss1", name: "JSS 1", short: "JSS1", section: "junior" }], arms: [{ name: "Gold", code: "GOL" }, { name: "Blue", code: "BLU" }], armsByLevel: [[0, 1]] }), 201);
  for (const a of (await json<{ arms: { id: string; label: string }[] }>(owner.get("/v1/students"))).arms) arm[a.label] = a.id;
  levelId = (await json<{ levels: { id: string }[] }>(owner.get("/v1/classes"))).levels[0]!.id;
  await owner.send("POST", "/v1/subjects", { catalogueIds: [], custom: [{ name: "Mathematics", code: "MTH" }, { name: "English Studies", code: "ENG" }] });
  for (const s of (await json<{ subjects: { id: string; name: string }[] }>(owner.get("/v1/subjects"))).subjects) {
    if (s.name === "Mathematics") maths = s.id;
    else english = s.id;
    await owner.send("PUT", `/v1/subjects/${s.id}/levels/${levelId}`, { kind: "compulsory" });
  }
  for (const [first, label] of [["Ada", "JSS 1 Gold"], ["Bayo", "JSS 1 Gold"], ["Chidi", "JSS 1 Blue"]] as const) {
    kid[first] = (await json<{ id: string }>(owner.send("POST", "/v1/students", { firstName: first, lastName: "Okoro", gender: "female", armId: arm[label] }), 201)).id;
  }
  await json(owner.post("/v1/invitations", { email: "tunde@acaciahigh.test", fullName: "Tunde Teach", role: "teacher" }), 201);
  teacher = browser(h, schoolHost("acaciahigh"));
  const t = await json<{ user: { id: string } }>(teacher.post("/v1/invitations/accept", { token: tokenFrom((await waitForMail(h, "tunde@acaciahigh.test", "invitation")).text)!, password: "teacher-password" }));
  expect((await owner.send("PUT", `/v1/teachers/${t.user.id}/subject-classes`, [{ armId: arm["JSS 1 Gold"], subjectId: maths }])).status).toBe(204);
  await json(teacher.post("/v1/questions", { subjectId: maths, levelId, source: "teacher", questions: QUESTIONS }));
  await json(owner.post("/v1/questions", { subjectId: english, levelId, source: "teacher", questions: [{ type: "trueFalse", text: "A noun names a thing.", answer: true, marks: 1, ...base }] }));
  bank = (await json<{ questions: { id: string; question: { text: string } }[] }>(teacher.get("/v1/questions"))).questions.sort((x, y) => QUESTIONS.findIndex((q) => q.text === x.question.text) - QUESTIONS.findIndex((q) => q.text === y.question.text)).map((q) => q.id);
  for (const [name, email] of [["Ada", "ada@pupils.test"], ["Bayo", "bayo@pupils.test"], ["Chidi", "chidi@pupils.test"]] as const) await studentAccount(name, email);
});
afterAll(async () => {
  vi.useRealTimers();
  await h?.t.close();
});

describe("test settings", () => {
  it("need a window at least as long as the test", () => {
    const ok = { ...settings(), armIds: [crypto.randomUUID()], questionIds: [crypto.randomUUID()] };
    expect(testSettingsSchema.safeParse(ok).success).toBe(true);
    expect(testSettingsSchema.safeParse({ ...ok, closesAt: "2026-10-14T09:20:00Z" }).error?.issues[0]?.message).toBe("Leave at least the test’s length between opening and closing");
    expect(testSettingsSchema.safeParse({ ...ok, armIds: [] }).success).toBe(false);
  });
});

describe("setting a test", () => {
  it("offers the classes the teacher teaches the subject in, the bank and the score-sheet parts", async () => {
    const editor = await json<{ pairs: { subjectName: string; arms: { label: string }[] }[]; bank: unknown[]; components: { id: string }[]; test: unknown }>(teacher.get("/v1/tests/editor"));
    expect(editor.pairs).toEqual([expect.objectContaining({ subjectName: "Mathematics", levelName: "JSS 1", arms: [{ id: arm["JSS 1 Gold"], label: "JSS 1 Gold" }] })]);
    expect(editor.bank).toHaveLength(4);
    expect(editor.components.map((c) => c.id)).toEqual(["ca1", "ca2", "exam"]);
    expect(editor.test).toBeNull();
    expect((await pupil.Ada!.get("/v1/tests/editor")).status).toBe(403);
  });

  it("checks the classes, the questions and the settings", async () => {
    const save = (body: object) => teacher.post("/v1/tests", { subjectId: maths, levelId, publish: false, ...body });
    expect((await problem(save({ settings: settings({ armIds: [arm["JSS 1 Blue"]] }) }), 403)).detail).toBe("You can set tests only for the classes you teach this subject in.");
    expect((await problem(save({ subjectId: english, settings: settings() }), 403)).detail).toBe("You can set tests only for the classes you teach this subject in.");
    expect((await problem(save({ settings: settings({ closesAt: "2026-10-14T09:10:00Z" }) }), 422)).errors![0]!.pointer).toBe("#/settings/closesAt");
    expect((await problem(save({ settings: settings({ componentId: "nope" }) }), 422)).errors![0]!.pointer).toBe("#/settings/componentId");
    expect((await problem(save({ settings: settings({ questionIds: [crypto.randomUUID()] }) }), 409)).detail).toBe("A question isn’t in this subject’s bank any more. Reload and choose again.");
  });

  it("saves a draft, changes it, then sets it; a set test doesn't change", async () => {
    testId = (await json<{ id: string }>(teacher.post("/v1/tests", { subjectId: maths, levelId, publish: false, settings: settings({ title: "Draft" }) }))).id;
    const draft = await json<{ test: { title: string; armIds: string[]; questionIds: string[] } }>(teacher.get(`/v1/tests/editor?test=${testId}`));
    expect(draft.test).toMatchObject({ title: "Draft", armIds: [arm["JSS 1 Gold"]], questionIds: bank });
    expect(await json(teacher.send("PUT", `/v1/tests/${testId}`, { subjectId: maths, levelId, publish: true, settings: settings() }))).toEqual({ id: testId });
    expect((await json<{ entries: { what: string }[] }>(owner.get("/v1/changes"))).entries[0]!.what).toBe("Set the test “Fractions test” for JSS 1 Mathematics");
    expect((await problem(teacher.send("PUT", `/v1/tests/${testId}`, { subjectId: maths, levelId, publish: true, settings: settings() }), 409)).detail).toBe("Only drafts can be changed. Students may already be taking this test.");
    const [row] = await json<Row[]>(teacher.get("/v1/tests"));
    expect(row).toMatchObject({ id: testId, status: "published", window: "open", students: 2, submitted: 0, questions: 4, marks: 9, armLabels: ["JSS 1 Gold"], sentAt: null });
    expect((await json<Row[]>(owner.get("/v1/tests"))).map((t) => t.id)).toEqual([testId]);
    expect(await json(other.get("/v1/tests"))).toEqual([]);
  });
});

describe("taking a test", () => {
  let code: string;

  it("is for the test's classes only, and needs the code in school", async () => {
    expect(await json(pupil.Chidi!.get("/v1/me/tests"))).toEqual([]);
    expect((await pupil.Chidi!.get(`/v1/me/tests/${testId}`)).status).toBe(404);
    expect(await json(pupil.Ada!.get("/v1/me/tests"))).toMatchObject([{ id: testId, title: "Fractions test", subjectName: "Mathematics", window: "open", attempt: "none", score: null, questions: 4 }]);
    expect(await json<Taking>(pupil.Ada!.get(`/v1/me/tests/${testId}`))).toMatchObject({ deadline: null, submitted: false, questions: [] });
    expect((await problem(pupil.Ada!.post(`/v1/me/tests/${testId}/start`, { code: "WRONG1" }), 422)).errors![0]!.pointer).toBe("#/code");
    code = (await json<{ test: { accessCode: string } }>(teacher.get(`/v1/tests/${testId}/results`))).test.accessCode;
    expect(code).toMatch(/^[A-HJ-NP-Z2-9]{6}$/);
    expect((await pupil.Ada!.post(`/v1/me/tests/${testId}/start`, { code: code.toLowerCase() })).status).toBe(204);
    expect((await teacher.get("/v1/me/tests")).status).toBe(403);
  });

  it("gives the questions in the student's order without any answer, on the server's clock", async () => {
    const test = await json<Taking>(pupil.Ada!.get(`/v1/me/tests/${testId}`));
    // The fake clock still ticks in real milliseconds.
    expect(Math.abs(test.deadline! - (Date.parse(NOW) + 30 * 60_000))).toBeLessThan(5_000);
    expect(Math.abs(test.now - Date.now())).toBeLessThan(5_000);
    expect(test.questions.map((q) => q.index).sort()).toEqual([0, 1, 2, 3]);
    const raw = JSON.stringify(test);
    for (const secret of ['"answer"', '"answers"', '"guide"', "numerator", "Common denominator"]) expect(raw).not.toContain(secret);
    const again = await json<Taking>(pupil.Ada!.get(`/v1/me/tests/${testId}`));
    expect({ ...again, now: 0 }).toEqual({ ...test, now: 0 });
  });

  it("saves answers that fit their question, and notes leaving the page", async () => {
    const answer = (index: number, response: unknown) => pupil.Ada!.send("PUT", `/v1/me/tests/${testId}/answers/${index}`, { response });
    expect((await answer(0, { option: 1 })).status).toBe(204);
    expect((await answer(1, { value: true })).status).toBe(204);
    expect((await answer(2, { text: " Numerator " })).status).toBe(204);
    expect((await answer(3, { text: "Use 6 as the denominator: 2/6 + 1/6 = 3/6." })).status).toBe(204);
    expect((await problem(answer(1, { text: "yes" }), 422)).errors![0]!.pointer).toBe("#/response");
    expect((await problem(answer(0, { option: 3 }), 422)).errors![0]!.pointer).toBe("#/response");
    expect((await answer(9, { value: true })).status).toBe(404);
    expect((await pupil.Ada!.post(`/v1/me/tests/${testId}/left`)).status).toBe(204);
    expect(await json(pupil.Ada!.post(`/v1/me/tests/${testId}/submit`))).toEqual({ score: { total: 4, max: 9, complete: false } });
    expect((await problem(answer(0, { option: 0 }), 409)).detail).toBe("You’ve already submitted this test.");
  });

  it("submits what was saved once time is up", async () => {
    expect((await pupil.Bayo!.post(`/v1/me/tests/${testId}/start`, { code })).status).toBe(204);
    expect((await pupil.Bayo!.send("PUT", `/v1/me/tests/${testId}/answers/1`, { response: { value: false } })).status).toBe(204);
    at("2026-10-14T10:00:20Z"); // 30 minutes and 20 seconds in: still inside the grace
    expect((await pupil.Bayo!.send("PUT", `/v1/me/tests/${testId}/answers/0`, { response: { option: 1 } })).status).toBe(204);
    at("2026-10-14T10:01:00Z");
    expect((await problem(pupil.Bayo!.send("PUT", `/v1/me/tests/${testId}/answers/2`, { response: { text: "numerator" } }), 409)).detail).toBe("Time is up. Your answers were submitted.");
    const [a] = await withSchool(h.db, schoolId, (tx) => tx.select().from(cbtAttempts).where(and(eq(cbtAttempts.testId, testId), eq(cbtAttempts.studentId, kid.Bayo!))));
    expect(Math.abs(a!.submittedAt!.getTime() - Date.parse("2026-10-14T10:00:00Z"))).toBeLessThan(5_000);
    expect(await json(pupil.Bayo!.get("/v1/me/tests"))).toMatchObject([{ attempt: "submitted", score: { total: 1, max: 9, complete: true } }]);
  });
});

describe("marking and sending scores", () => {
  it("shows each student's answers and how each question went", async () => {
    const r = await json<{ rows: { fullName: string; state: string; score: { total: number; toMark: number } | null; leftPage: number; attemptId: string | null }[]; stats: { answered: number; right: number | null }[] }>(teacher.get(`/v1/tests/${testId}/results`));
    expect(r.rows.map((x) => [x.fullName, x.state, x.score?.total ?? null, x.score?.toMark ?? null, x.leftPage])).toEqual([
      ["Ada Okoro", "submitted", 4, 1, 1],
      ["Bayo Okoro", "submitted", 1, 0, 0],
    ]);
    expect(r.stats).toEqual([
      { answered: 2, right: 2 },
      { answered: 2, right: 1 },
      { answered: 1, right: 1 },
      { answered: 1, right: null },
    ]);
    expect((await json<Row[]>(teacher.get("/v1/tests")))[0]).toMatchObject({ submitted: 2, toMark: 1 });
  });

  it("marks theory answers by hand, in halves, up to the question's marks", async () => {
    const r = await json<{ rows: { fullName: string; attemptId: string }[] }>(teacher.get(`/v1/tests/${testId}/results`));
    const ada = r.rows.find((x) => x.fullName === "Ada Okoro")!.attemptId;
    const mark = (index: number, marks: number) => teacher.send("PUT", `/v1/tests/${testId}/attempts/${ada}/marks/${index}`, { marks });
    expect((await problem(mark(3, 6), 422)).errors![0]!.pointer).toBe("#/marks");
    expect((await problem(mark(0, 1), 409)).detail).toBe("Only theory answers are marked by hand.");
    expect((await mark(3, 3.4)).status).toBe(204);
    expect(await json(pupil.Ada!.get("/v1/me/tests"))).toMatchObject([{ score: { total: 7.5, max: 9, complete: true } }]);
  });

  it("sends fully marked scores into this term's sheet, scaled to the part, and leaves completed sheets alone", async () => {
    expect(await json(teacher.post(`/v1/tests/${testId}/send-scores`))).toEqual({ sent: 2, skipped: 0, lockedClasses: [] });
    const cells = await withSchool(h.db, schoolId, (tx) => tx.select({ studentId: scores.studentId, value: scores.value, componentId: scores.componentId, termKey: scores.termKey }).from(scores));
    expect(cells.sort((x, y) => x.value - y.value)).toEqual([
      { studentId: kid.Bayo, value: 2.22, componentId: "ca1", termKey: "2026-1" },
      { studentId: kid.Ada, value: 16.67, componentId: "ca1", termKey: "2026-1" },
    ]);
    expect((await json<{ entries: { what: string }[] }>(owner.get("/v1/changes"))).entries[0]!.what).toBe("Sent 2 scores from “Fractions test” to CA1");
    await withSchool(h.db, schoolId, (tx) => tx.insert(sheetCompletions).values({ schoolId, termKey: "2026-1", classArmId: arm["JSS 1 Gold"]!, schoolSubjectId: maths }));
    expect(await json(teacher.post(`/v1/tests/${testId}/send-scores`))).toEqual({ sent: 0, skipped: 0, lockedClasses: ["JSS 1 Gold"] });
  });

  it("keeps a test once students have started it; drafts go", async () => {
    expect((await problem(teacher.del(`/v1/tests/${testId}`), 409)).detail).toBe("Students have started this test, so it stays. You can stop sending its scores.");
    const draft = (await json<{ id: string }>(teacher.post("/v1/tests", { subjectId: maths, levelId, publish: false, settings: settings({ title: "Spare" }) }))).id;
    expect((await pupil.Ada!.get(`/v1/me/tests/${draft}`)).status).toBe(404);
    expect((await teacher.del(`/v1/tests/${draft}`)).status).toBe(204);
    expect((await other.del(`/v1/tests/${testId}`)).status).toBe(404);
  });
});
