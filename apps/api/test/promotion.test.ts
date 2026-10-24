import { and, enrolments, eq, isNull, students, withSchool } from "@brillianda/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { browser, schoolHost, signUpAndLand, type Client } from "./flows.js";
import { createHarness, type Harness } from "./helpers.js";

const TODAY = "2026-10-14";

let h: Harness;
let owner: Client;
let schoolId: string;
const arm: Record<string, string> = {};
let maths: string;
const kid: Record<string, string> = {};

async function json<T>(res: Response | Promise<Response>, status = 200): Promise<T> {
  const r = await res;
  expect(r.status, await r.clone().text()).toBe(status);
  return (await r.json()) as T;
}
const detail = async (res: Response | Promise<Response>, status: number) => {
  const r = await res;
  expect(r.status).toBe(status);
  return (await r.json()) as { detail: string; errors?: { pointer: string }[] };
};

type Plan = {
  sessionName: string;
  nextSessionName: string;
  passMark: number;
  open: boolean;
  lastTerm: string;
  classes: { label: string; finalClass: boolean; students: { id: string; fullName: string; yearlyAverage: number | null; termsCounted: number; suggested: string; decision: string; reason: string | null; destination: string | null }[] }[];
  counts: Record<string, number>;
  unpublished: { label: string }[];
  firstTerm: { name: string; startsOn: string; endsOn: string };
};
const row = (plan: Plan, id: string) => plan.classes.flatMap((c) => c.students).find((s) => s.id === id)!;

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ["Date"], now: new Date(`${TODAY}T09:30:00Z`) });
  h = await createHarness();
  ({ school: owner, schoolId } = await signUpAndLand(h, { schoolName: "Obeche College", subdomain: "obeche", email: "owner@obeche.test", password: "obeche-owner-pw", fullName: "Uche Obi" }));
  await json(
    owner.send("PUT", "/v1/session", {
      startYear: 2026,
      terms: [
        { name: "First Term", startsOn: "2026-09-14", endsOn: "2026-12-18" },
        { name: "Second Term", startsOn: "2027-01-11", endsOn: "2027-07-16" },
      ],
    }),
  );
  await json(
    owner.send("POST", "/v1/classes/setup", {
      levels: [
        { key: "jss1", name: "JSS 1", short: "JSS1", section: "junior" },
        { key: "jss2", name: "JSS 2", short: "JSS2", section: "junior" },
      ],
      arms: [{ name: "Gold", code: "GOL" }, { name: "Blue", code: "BLU" }],
      armsByLevel: [[0, 1], [0]],
    }),
    201,
  );
  for (const a of (await json<{ arms: { id: string; label: string }[] }>(owner.get("/v1/students"))).arms) arm[a.label] = a.id;
  const { levels } = await json<{ levels: { id: string }[] }>(owner.get("/v1/classes"));
  await owner.send("POST", "/v1/subjects", { catalogueIds: [], custom: [{ name: "Mathematics", code: "MTH" }] });
  maths = (await json<{ subjects: { id: string }[] }>(owner.get("/v1/subjects"))).subjects[0]!.id;
  await owner.send("PUT", `/v1/subjects/${maths}/levels/${levels[0]!.id}`, { kind: "compulsory" });
  for (const [first, last, label, phone] of [
    ["Ada", "Bello", "JSS 1 Gold", "08030000001"],
    ["Bayo", "Cole", "JSS 1 Blue", "08030000002"],
    ["Chidi", "Dike", "JSS 1 Gold", "08030000003"],
    ["Dami", "Eze", "JSS 2", "08030000004"],
  ] as const) {
    kid[first] = (await json<{ id: string }>(owner.send("POST", "/v1/students", { firstName: first, lastName: last, gender: "female", armId: arm[label], guardianName: `Mx ${last}`, guardianPhone: phone }), 201)).id;
  }
  const score = (armId: string, studentId: string, marks: [string, string][]) =>
    Promise.all(marks.map(([componentId, raw]) => json(owner.send("PUT", `/v1/arms/${armId}/subjects/${maths}/sheet/scores`, { studentId, componentId, raw }))));
  await score(arm["JSS 1 Gold"]!, kid.Ada!, [["ca1", "15"], ["ca2", "18"], ["exam", "42"]]);
  await score(arm["JSS 1 Blue"]!, kid.Bayo!, [["ca1", "5"], ["ca2", "5"], ["exam", "20"]]);
});
afterAll(async () => {
  vi.useRealTimers();
  await h?.t.close();
});

describe("promotion", () => {
  it("suggests from the yearly average: the final class graduates, no results moves up", async () => {
    const plan = await json<Plan>(owner.get("/v1/promotion"));
    expect(plan).toMatchObject({ sessionName: "2026/2027", nextSessionName: "2027/2028", passMark: 40, open: false, lastTerm: "Second Term", unpublished: [], counts: { promote: 2, repeat: 1, graduate: 1 } });
    expect(plan.firstTerm.startsOn.startsWith("2027-09")).toBe(true);
    expect(plan.classes.map((c) => [c.label, c.finalClass])).toEqual([["JSS 1 Gold", false], ["JSS 1 Blue", false], ["JSS 2", true]]);
    expect(row(plan, kid.Ada!)).toMatchObject({ fullName: "Ada Bello", yearlyAverage: 75, termsCounted: 1, suggested: "promote", decision: "promote", destination: "JSS 2" });
    expect(row(plan, kid.Bayo!)).toMatchObject({ yearlyAverage: 30, suggested: "repeat", destination: "JSS 1 Blue" });
    expect(row(plan, kid.Chidi!)).toMatchObject({ yearlyAverage: null, termsCounted: 0, suggested: "promote" });
    expect(row(plan, kid.Dami!)).toMatchObject({ suggested: "graduate", destination: null });
  });

  it("can't be completed before the session's last term", async () => {
    expect((await detail(owner.post("/v1/promotion/complete", { closeUnpublished: true }), 409)).detail).toBe("Promotion opens in the session’s last term.");
  });

  it("takes a changed decision with a reason; choosing the suggestion clears it", async () => {
    expect((await owner.send("PUT", `/v1/promotion/students/${kid.Bayo}`, { decision: "promote", reason: "Strong in class work" })).status).toBe(204);
    expect(row(await json<Plan>(owner.get("/v1/promotion")), kid.Bayo!)).toMatchObject({ suggested: "repeat", decision: "promote", reason: "Strong in class work", destination: "JSS 2" });
    expect((await owner.send("PUT", `/v1/promotion/students/${kid.Bayo}`, { decision: "repeat", reason: "ignored" })).status).toBe(204);
    expect(row(await json<Plan>(owner.get("/v1/promotion")), kid.Bayo!)).toMatchObject({ decision: "repeat", reason: null });
    expect((await detail(owner.send("PUT", `/v1/promotion/students/${kid.Bayo}`, { decision: "graduate", reason: "x".repeat(201) }), 422)).errors![0]!.pointer).toBe("#/reason");
  });

  it("moves suggestions with the pass mark", async () => {
    expect((await owner.send("PUT", "/v1/promotion/pass-mark", { passMark: 25 })).status).toBe(204);
    expect(row(await json<Plan>(owner.get("/v1/promotion")), kid.Bayo!)).toMatchObject({ suggested: "promote" });
    expect((await owner.send("PUT", "/v1/promotion/pass-mark", { passMark: 101 })).status).toBe(422);
    expect((await owner.send("PUT", "/v1/promotion/pass-mark", { passMark: 40 })).status).toBe(204);
    const history = await json<{ entries: { what: string }[] }>(owner.get("/v1/changes"));
    expect(history.entries[0]!.what).toBe("Set the promotion pass mark to 40");
  });

  it("is for owners and admins, and only for this school's students", async () => {
    const { school: other } = await signUpAndLand(h, { schoolName: "Other School", subdomain: "otherpromo", email: "owner@otherpromo.test", password: "other-owner-pw", fullName: "Other Owner" });
    expect((await detail(other.send("PUT", `/v1/promotion/students/${kid.Ada}`, { decision: "repeat", reason: null }), 404)).detail).toBe("That student isn’t in a class this session.");
    expect((await json<Plan>(other.get("/v1/promotion"))).classes).toEqual([]);
    expect((await browser(h, schoolHost("obeche")).get("/v1/promotion")).status).toBe(401);
  });

  it("completes in the last term: closes it, moves everyone, starts the next session", async () => {
    expect((await owner.post("/v1/terms/close", { closeUnpublished: true })).status).toBe(200);
    vi.setSystemTime(new Date("2027-07-01T09:00:00Z"));
    const owner2 = browser(h, schoolHost("obeche"));
    await json(owner2.post("/v1/auth/login", { email: "owner@obeche.test", password: "obeche-owner-pw" }));

    const plan = await json<Plan>(owner2.get("/v1/promotion"));
    expect(plan).toMatchObject({ open: true, unpublished: [{ label: "JSS 1 Gold" }, { label: "JSS 1 Blue" }] });
    // A second term's score: Ada's yearly average counts both terms.
    for (const [componentId, raw] of [["ca1", "10"], ["ca2", "10"], ["exam", "35"]]) await json(owner2.send("PUT", `/v1/arms/${arm["JSS 1 Gold"]}/subjects/${maths}/sheet/scores`, { studentId: kid.Ada, componentId, raw }));
    expect(row(await json<Plan>(owner2.get("/v1/promotion")), kid.Ada!)).toMatchObject({ yearlyAverage: 65, termsCounted: 2 });

    expect((await detail(owner2.post("/v1/promotion/complete", { closeUnpublished: false }), 409)).detail).toBe("2 classes aren’t published yet: JSS 1 Gold, JSS 1 Blue. Publish them, or complete anyway.");
    for (const [body, pointer] of [
      [{ startsOn: "2027-09-20", endsOn: "2027-09-19" }, "#/endsOn"],
      [{ startsOn: "2026-12-01", endsOn: "2027-12-01" }, "#/startsOn"],
      [{ startsOn: "2027-09-13", endsOn: "2028-06-01" }, "#/endsOn"],
    ] as const) {
      expect((await detail(owner2.post("/v1/promotion/complete", { closeUnpublished: true, ...body }), 422)).errors![0]!.pointer).toBe(pointer);
    }

    expect(await json(owner2.post("/v1/promotion/complete", { closeUnpublished: true, startsOn: "2027-09-13", endsOn: "2027-12-17" }))).toEqual({ promoted: 2, repeating: 1, graduated: 1, session: "2027/2028" });

    const session = await json<{ startYear: number; terms: { name: string; startsOn: string; endsOn: string }[]; confirmed: boolean }>(owner2.get("/v1/session"));
    expect(session).toMatchObject({ startYear: 2027, confirmed: true });
    expect(session.terms.map((t) => t.name)).toEqual(["First Term", "Second Term"]);
    expect(session.terms[0]).toMatchObject({ startsOn: "2027-09-13", endsOn: "2027-12-17" });

    const rows = await withSchool(h.db, schoolId, (tx) => tx.select({ id: students.id, armId: students.classArmId, status: students.status }).from(students));
    const of = (id: string) => rows.find((r) => r.id === id)!;
    expect(of(kid.Ada!)).toMatchObject({ armId: arm["JSS 2"], status: "active" });
    expect(of(kid.Chidi!)).toMatchObject({ armId: arm["JSS 2"], status: "active" });
    expect(of(kid.Bayo!)).toMatchObject({ armId: arm["JSS 1 Blue"], status: "active" });
    expect(of(kid.Dami!)).toMatchObject({ status: "graduated" });
    const current = await withSchool(h.db, schoolId, (tx) => tx.select({ armId: enrolments.classArmId, startedOn: enrolments.startedOn }).from(enrolments).where(and(eq(enrolments.studentId, kid.Ada!), isNull(enrolments.endedOn))));
    expect(current).toEqual([{ armId: arm["JSS 2"], startedOn: "2027-09-13" }]);

    const status = await json<{ open: unknown; waiting: { name: string; startsOn: string } | null; closed: { key: string }[] }>(owner2.get("/v1/terms/status"));
    expect(status).toMatchObject({ open: null, waiting: { name: "First Term", startsOn: "2027-09-13" } });
    expect(status.closed.map((c) => c.key)).toEqual(["2026-2", "2026-1"]);
    // Past report cards keep their terms.
    expect((await json<{ key: string }[]>(owner2.get(`/v1/students/${kid.Ada}/report-terms`))).map((t) => t.key)).toEqual(["2026-2", "2026-1"]);

    const next = await json<Plan>(owner2.get("/v1/promotion"));
    expect(next).toMatchObject({ sessionName: "2027/2028", open: false });
    expect(row(next, kid.Bayo!)).toMatchObject({ yearlyAverage: null, decision: "promote" });
    const history = await json<{ entries: { what: string }[] }>(owner2.get("/v1/changes"));
    expect(history.entries[0]!.what).toBe("Completed promotion: 2 moved up, 1 repeating, 1 graduated. 2027/2028 begins 2027-09-13");
    vi.setSystemTime(new Date(`${TODAY}T09:30:00Z`));
  });
});
