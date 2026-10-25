import { DEFAULT_PERIODS } from "@brillianda/core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { browser, schoolHost, signUpAndLand, tokenFrom, waitForMail, type Client } from "./flows.js";
import { createHarness, type Harness } from "./helpers.js";

const TODAY = "2026-10-14"; // a Wednesday

let h: Harness;
let owner: Client;
let other: Client;
let teacher: Client;
const arm: Record<string, string> = {};
const subject: Record<string, string> = {};
let levelId: string;

async function json<T>(res: Response | Promise<Response>, status = 200): Promise<T> {
  const r = await res;
  expect(r.status, await r.clone().text()).toBe(status);
  return (await r.json()) as T;
}
const problem = async (res: Response | Promise<Response>, status: number) => {
  const r = await res;
  expect(r.status, await r.clone().text()).toBe(status);
  return (await r.json()) as { detail: string; errors?: { pointer: string; detail: string }[] };
};
const lesson = (who: Client, armId: string, day: number, periodId: string, subjectId: string | null) => who.send("PUT", `/v1/timetable/${armId}/${day}/${periodId}`, { subjectId });

async function upload(who: Client, bytes: Uint8Array, name = "timetable.pdf") {
  const form = new FormData();
  form.set("file", new File([bytes], name, { type: "application/pdf" }));
  const host = schoolHost("acacia");
  const headers: Record<string, string> = { host, origin: `https://${host}` };
  if (who.cookies.size) headers.cookie = [...who.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  return h.app.request("/v1/timetable/document", { method: "PUT", headers, body: form });
}

type Page = {
  periods: { id: string; label: string; kind: string }[];
  arms: { id: string; label: string; levelId: string }[];
  subjects: { id: string; name: string; levelIds: string[] }[];
  lessons: { armId: string; day: number; periodId: string; subjectId: string; teacherId: string | null; teacherName: string | null }[];
  clashes: { teacherName: string; day: number; periodId: string; armLabels: string[] }[];
  file: { name: string; size: number; url: string; by: string } | null;
  me: { userId: string; canEdit: boolean };
};

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ["Date"], now: new Date(`${TODAY}T09:30:00Z`) });
  h = await createHarness();
  ({ school: owner } = await signUpAndLand(h, { schoolName: "Acacia School", subdomain: "acacia", email: "owner@acacia.test", password: "acacia-owner-pw", fullName: "Dayo Acacia" }));
  ({ school: other } = await signUpAndLand(h, { schoolName: "Neem School", subdomain: "neem", email: "owner@neem.test", password: "neem-owner-pw" }));
  await json(owner.send("POST", "/v1/classes/setup", { levels: [{ key: "jss1", name: "JSS 1", short: "JSS1", section: "junior" }], arms: [{ name: "Gold", code: "GOL" }, { name: "Blue", code: "BLU" }], armsByLevel: [[0, 1]] }), 201);
  for (const a of (await json<{ arms: { id: string; label: string }[] }>(owner.get("/v1/students"))).arms) arm[a.label] = a.id;
  levelId = (await json<{ levels: { id: string }[] }>(owner.get("/v1/classes"))).levels[0]!.id;
  await owner.send("POST", "/v1/subjects", { catalogueIds: [], custom: [{ name: "Mathematics", code: "MTH" }, { name: "English Studies", code: "ENG" }] });
  for (const s of (await json<{ subjects: { id: string; name: string }[] }>(owner.get("/v1/subjects"))).subjects) {
    subject[s.name] = s.id;
    await owner.send("PUT", `/v1/subjects/${s.id}/levels/${levelId}`, { kind: "compulsory" });
  }
  await json(owner.post("/v1/invitations", { email: "tunde@acacia.test", fullName: "Tunde Teach", role: "teacher" }), 201);
  const token = tokenFrom((await waitForMail(h, "tunde@acacia.test", "invitation")).text)!;
  teacher = browser(h, schoolHost("acacia"));
  const me = await json<{ user: { id: string } }>(teacher.post("/v1/invitations/accept", { token, password: "teacher-password" }));
  expect(
    (
      await owner.send("PUT", `/v1/teachers/${me.user.id}/subject-classes`, [
        { armId: arm["JSS 1 Gold"], subjectId: subject.Mathematics },
        { armId: arm["JSS 1 Blue"], subjectId: subject.Mathematics },
      ])
    ).status,
  ).toBe(204);
});
afterAll(async () => {
  vi.useRealTimers();
  await h?.t.close();
});

describe("the timetable", () => {
  it("starts empty, with the classes and subjects to fill it", async () => {
    const page = await json<Page>(owner.get("/v1/timetable"));
    expect(page).toMatchObject({ periods: [], lessons: [], clashes: [], file: null, me: { canEdit: true } });
    expect(page.arms.map((a) => a.label)).toEqual(["JSS 1 Gold", "JSS 1 Blue"]);
    expect(page.subjects.map((s) => [s.name, s.levelIds])).toEqual([
      ["English Studies", [levelId]],
      ["Mathematics", [levelId]],
    ]);
  });

  it("checks the bell schedule: in order, no overlaps, at least one lesson, up to 16", async () => {
    const overlap = DEFAULT_PERIODS.map((p) => (p.id === "p2" ? { ...p, start: "08:30" } : p));
    expect((await problem(owner.send("PUT", "/v1/timetable/periods", { periods: overlap }), 422)).errors![0]).toMatchObject({ pointer: "#/periods/1/start", detail: "Starts after Period 1 ends" });
    const backwards = DEFAULT_PERIODS.map((p) => (p.id === "p1" ? { ...p, end: "07:50" } : p));
    expect((await problem(owner.send("PUT", "/v1/timetable/periods", { periods: backwards }), 422)).errors![0]).toMatchObject({ pointer: "#/periods/0/end", detail: "Ends after it starts" });
    expect((await owner.send("PUT", "/v1/timetable/periods", { periods: DEFAULT_PERIODS.filter((p) => p.kind === "break") })).status).toBe(422);
    expect((await owner.send("PUT", "/v1/timetable/periods", { periods: Array.from({ length: 17 }, (_, i) => ({ id: `x${i}`, label: `P${i}`, start: "08:00", end: "08:10", kind: "lesson" })) })).status).toBe(422);
    expect(await json(owner.send("PUT", "/v1/timetable/periods", { periods: DEFAULT_PERIODS }))).toEqual({ removed: 0 });
    expect((await json<{ entries: { what: string }[] }>(owner.get("/v1/changes"))).entries[0]!.what).toBe("Changed the bell schedule");
  });

  it("sets lessons, flags a teacher in two classes at once, and keeps breaks free", async () => {
    expect((await lesson(owner, arm["JSS 1 Gold"]!, 1, "p1", subject.Mathematics!)).status).toBe(204);
    expect((await lesson(owner, arm["JSS 1 Blue"]!, 1, "p1", subject.Mathematics!)).status).toBe(204);
    expect((await lesson(owner, arm["JSS 1 Gold"]!, 3, "p2", subject["English Studies"]!)).status).toBe(204);
    expect((await problem(lesson(owner, arm["JSS 1 Gold"]!, 1, "b1", subject.Mathematics!), 409)).detail).toBe("No lessons in a break.");
    expect((await problem(lesson(owner, arm["JSS 1 Gold"]!, 1, "p99", subject.Mathematics!), 404)).detail).toBe("That period isn’t in the bell schedule any more.");
    expect((await lesson(owner, arm["JSS 1 Gold"]!, 6, "p1", subject.Mathematics!)).status).toBe(422);
    expect((await lesson(owner, arm["JSS 1 Gold"]!, 1, "p1", crypto.randomUUID())).status).toBe(404);

    const page = await json<Page>(owner.get("/v1/timetable"));
    expect(page.lessons).toHaveLength(3);
    expect(page.lessons.find((l) => l.periodId === "p2")).toMatchObject({ teacherId: null, teacherName: null });
    expect(page.lessons.find((l) => l.armId === arm["JSS 1 Gold"] && l.periodId === "p1")).toMatchObject({ teacherName: "Tunde Teach" });
    expect(page.clashes).toEqual([{ teacherName: "Tunde Teach", day: 1, periodId: "p1", armLabels: ["JSS 1 Gold", "JSS 1 Blue"] }]);
    expect((await json<{ entries: { what: string }[] }>(owner.get("/v1/changes"))).entries[0]!.what).toBe("Set JSS 1 Gold’s Wednesday Period 2 to English Studies");

    expect((await lesson(owner, arm["JSS 1 Blue"]!, 1, "p1", null)).status).toBe(204);
    expect((await json<Page>(owner.get("/v1/timetable"))).clashes).toEqual([]);
  });

  it("is read by teachers, with their own day", async () => {
    const page = await json<Page>(teacher.get("/v1/timetable"));
    expect(page.me.canEdit).toBe(false);
    expect(page.lessons).toHaveLength(2);
    expect((await lesson(teacher, arm["JSS 1 Gold"]!, 2, "p1", subject.Mathematics!)).status).toBe(403);
    const monday = await json<{ period: { id: string; label: string }; armLabel: string; subjectName: string }[]>(teacher.get("/v1/me/lessons?day=1"));
    expect(monday).toEqual([{ period: expect.objectContaining({ id: "p1", label: "Period 1" }), armLabel: "JSS 1 Gold", subjectName: "Mathematics" }]);
    // Today is a Wednesday: English isn't theirs.
    expect(await json(teacher.get("/v1/me/lessons"))).toEqual([]);
  });

  it("replaces whole classes' weeks from an upload", async () => {
    const week = { armId: arm["JSS 1 Gold"], lessons: [{ day: 2, periodId: "p1", subjectId: subject.Mathematics }, { day: 2, periodId: "p4", subjectId: subject["English Studies"] }] };
    expect((await problem(owner.send("PUT", "/v1/timetable/classes", { fileName: "t.xlsx", classes: [{ ...week, lessons: [...week.lessons, week.lessons[0]] }] }), 422)).errors![0]!.pointer).toBe("#/classes/0/lessons/2");
    expect((await problem(owner.send("PUT", "/v1/timetable/classes", { fileName: "t.xlsx", classes: [{ ...week, lessons: [{ day: 2, periodId: "b2", subjectId: subject.Mathematics }] }] }), 409)).detail).toBe("No lessons in a break.");
    expect(await json(owner.send("PUT", "/v1/timetable/classes", { fileName: "Timetable 2026.xlsx", classes: [week] }))).toEqual({ classes: 1, lessons: 2 });
    const page = await json<Page>(owner.get("/v1/timetable"));
    expect(page.lessons.filter((l) => l.armId === arm["JSS 1 Gold"]).map((l) => [l.day, l.periodId]).sort()).toEqual([[2, "p1"], [2, "p4"]]);
    expect((await json<{ entries: { what: string }[] }>(owner.get("/v1/changes"))).entries[0]!.what).toBe("Uploaded the timetable for 1 class from Timetable 2026.xlsx");
  });

  it("drops lessons when their period goes or becomes a break", async () => {
    const periods = DEFAULT_PERIODS.filter((p) => p.id !== "p4").map((p) => (p.id === "p1" ? { ...p, kind: "break" } : p));
    expect(await json(owner.send("PUT", "/v1/timetable/periods", { periods }))).toEqual({ removed: 2 });
    expect((await json<Page>(owner.get("/v1/timetable"))).lessons).toEqual([]);
  });

  it("keeps one PDF up to 2 MB, for staff to open", async () => {
    const pdf = new TextEncoder().encode("%PDF-1.7\n% a tiny test file\n%%EOF\n");
    expect((await problem(upload(owner, new TextEncoder().encode("not a pdf"), "notes.pdf"), 422)).detail).toBe("Upload a PDF.");
    expect((await upload(owner, new Uint8Array(2 * 1024 * 1024 + 10).fill(37))).status).toBe(413);
    expect((await upload(teacher, pdf)).status).toBe(403);
    expect((await upload(owner, pdf, "Timetable — First Term.pdf")).status).toBe(204);
    const { file } = await json<Page>(owner.get("/v1/timetable"));
    expect(file).toMatchObject({ name: "Timetable — First Term.pdf", size: pdf.length, by: "Dayo Acacia" });
    expect(file!.url).toMatch(/^\/api\/v1\/timetable\/document\?v=[0-9a-f]{16}$/);
    const res = await teacher.get("/v1/timetable/document");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(pdf);
    expect((await other.get("/v1/timetable/document")).status).toBe(404);
    expect((await owner.del("/v1/timetable/document")).status).toBe(204);
    expect((await json<Page>(owner.get("/v1/timetable"))).file).toBeNull();
  });

  it("belongs to one school", async () => {
    expect((await json<Page>(other.get("/v1/timetable"))).arms).toEqual([]);
    await other.send("PUT", "/v1/timetable/periods", { periods: DEFAULT_PERIODS });
    expect((await problem(lesson(other, arm["JSS 1 Gold"]!, 1, "p2", subject.Mathematics!), 404)).detail).toBe("That class isn’t here any more.");
  });
});
