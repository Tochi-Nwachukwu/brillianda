import { eq, unlockRequests, withSchool } from "@brillianda/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { browser, schoolHost, signUpAndLand, tokenFrom, waitForMail, type Client } from "./flows.js";
import { createHarness, type Harness } from "./helpers.js";

const TODAY = "2026-10-14";

let h: Harness;
let owner: Client;
let teacher: Client;
let schoolId: string;
let gold: string;
let maths: string;
let ada: string;

async function json<T>(res: Response | Promise<Response>, status = 200): Promise<T> {
  const r = await res;
  expect(r.status, await r.clone().text()).toBe(status);
  return (await r.json()) as T;
}
const sheet = () => `/v1/arms/${gold}/subjects/${maths}/sheet`;

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ["Date"], now: new Date(`${TODAY}T09:30:00Z`) });
  h = await createHarness();
  ({ school: owner, schoolId } = await signUpAndLand(h, { schoolName: "Iroko Academy", subdomain: "irokoa", email: "owner@irokoa.test", password: "irokoa-owner-pw", fullName: "Tayo Iroko" }));
  await json(
    owner.send("PUT", "/v1/session", {
      startYear: 2026,
      terms: [
        { name: "First Term", startsOn: "2026-09-14", endsOn: "2026-12-18" },
        { name: "Second Term", startsOn: "2027-01-11", endsOn: "2027-04-09" },
      ],
    }),
  );
  await json(owner.send("POST", "/v1/classes/setup", { levels: [{ key: "jss1", name: "JSS 1", short: "JSS1", section: "junior" }], arms: [{ name: "Gold", code: "GOL" }, { name: "Blue", code: "BLU" }], armsByLevel: [[0, 1]] }), 201);
  const { arms } = await json<{ arms: { id: string; label: string }[] }>(owner.get("/v1/students"));
  gold = arms.find((a) => a.label === "JSS 1 Gold")!.id;
  const { levels } = await json<{ levels: { id: string }[] }>(owner.get("/v1/classes"));
  await owner.send("POST", "/v1/subjects", { catalogueIds: [], custom: [{ name: "Mathematics", code: "MTH" }] });
  maths = (await json<{ subjects: { id: string }[] }>(owner.get("/v1/subjects"))).subjects[0]!.id;
  await owner.send("PUT", `/v1/subjects/${maths}/levels/${levels[0]!.id}`, { kind: "compulsory" });
  ada = (await json<{ id: string }>(owner.send("POST", "/v1/students", { firstName: "Ada", lastName: "Bello", gender: "female", armId: gold, guardianName: "Mrs Bello", guardianPhone: "08030000001" }), 201)).id;
  await json(owner.post("/v1/invitations", { email: "t@irokoa.test", fullName: "Tunde Teach", role: "teacher" }), 201);
  const token = tokenFrom((await waitForMail(h, "t@irokoa.test", "invitation")).text)!;
  teacher = browser(h, schoolHost("irokoa"));
  await json(teacher.post("/v1/invitations/accept", { token, password: "teacher-password" }));
});
afterAll(async () => {
  vi.useRealTimers();
  await h?.t.close();
});

type Status = { open: { key: string; name: string; isLast: boolean } | null; following: unknown; waiting: unknown; unpublished: { label: string }[]; closed: { key: string; name: string; session: string; by: string }[] };

describe("closing a term", () => {
  it("shows the open term, the next one's dates and what isn't published", async () => {
    expect(await json(owner.get("/v1/terms/status"))).toEqual({
      open: { key: "2026-1", name: "First Term", session: "2026/2027", index: 0, isLast: false },
      following: { name: "Second Term", startsOn: "2027-01-11", endsOn: "2027-04-09" },
      waiting: null,
      unpublished: [{ armId: gold, label: "JSS 1 Gold" }],
      closed: [],
    });
    expect((await teacher.get("/v1/terms/status")).status).toBe(403);
  });

  it("is refused while classes are unpublished, unless the admin closes anyway", async () => {
    const res = await owner.post("/v1/terms/close", { closeUnpublished: false });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { detail: string }).detail).toBe("1 class isn’t published yet: JSS 1 Gold. Publish them, or close anyway.");
  });

  it("checks the next term's dates", async () => {
    for (const [body, pointer] of [
      [{ nextStartsOn: "2027-01-20", nextEndsOn: "2027-01-19" }, "#/nextEndsOn"],
      [{ nextStartsOn: "2026-09-01" }, "#/nextStartsOn"],
    ] as const) {
      const res = await owner.post("/v1/terms/close", { closeUnpublished: true, ...body });
      expect(res.status).toBe(422);
      expect(((await res.json()) as { errors: { pointer: string }[] }).errors[0]!.pointer).toBe(pointer);
    }
  });

  it("closes once published: scores lock, results stay, unlock requests end, the next term waits", async () => {
    for (const [componentId, raw] of [["ca1", "15"], ["ca2", "18"], ["exam", "42"]]) await json(owner.send("PUT", `${sheet()}/scores`, { studentId: ada, componentId, raw }));
    expect((await owner.post(`${sheet()}/complete`)).status).toBe(204);
    expect((await owner.post(`${sheet()}/unlock-request`, { reason: "Check the exam score" })).status).toBe(204);
    expect((await owner.send("PUT", `/v1/arms/${gold}/published`, { published: true })).status).toBe(204);

    expect(await json(owner.post("/v1/terms/close", { closeUnpublished: false, nextStartsOn: "2027-01-12" }))).toEqual({ closed: "First Term", next: "Second Term" });
    const s = await json<Status>(owner.get("/v1/terms/status"));
    expect(s).toMatchObject({ open: null, following: null, waiting: { name: "Second Term", startsOn: "2027-01-12" }, unpublished: [] });
    expect(s.closed).toMatchObject([{ key: "2026-1", name: "First Term", session: "2026/2027", by: "Tayo Iroko" }]);

    expect((await owner.send("PUT", `${sheet()}/scores`, { studentId: ada, componentId: "exam", raw: "50" })).status).toBe(404);
    const requests = await withSchool(h.db, schoolId, (tx) => tx.select({ status: unlockRequests.status }).from(unlockRequests).where(eq(unlockRequests.termKey, "2026-1")));
    expect(requests.map((r) => r.status)).toEqual(["declined"]);

    expect(await json(owner.get(`/v1/students/${ada}/report-terms`))).toEqual([{ key: "2026-1", name: "First Term", session: "2026/2027", published: true, open: false }]);
    const card = await json<{ term: { key: string; name: string }; average: number; nextTermBegins: string }>(owner.get(`/v1/students/${ada}/report-card?term=2026-1`));
    expect(card).toMatchObject({ term: { key: "2026-1", name: "First Term" }, average: 75, nextTermBegins: "2027-01-12" });
    const history = await json<{ entries: { what: string }[] }>(owner.get("/v1/changes"));
    expect(history.entries[0]!.what).toBe("Closed First Term 2026/2027");
  });

  it("the next term opens on its start date with fresh sheets; the session's last term waits for promotion", async () => {
    vi.setSystemTime(new Date("2027-01-20T09:00:00Z"));
    try {
      // Three months on, the old session has expired: sign in again.
      const owner = browser(h, schoolHost("irokoa"));
      await json(owner.post("/v1/auth/login", { email: "owner@irokoa.test", password: "irokoa-owner-pw" }));
      const s = await json<Status>(owner.get("/v1/terms/status"));
      expect(s.open).toMatchObject({ key: "2026-2", name: "Second Term", isLast: true });
      const fresh = await json<{ status: string; rows: { scores: Record<string, unknown> }[] }>(owner.get(sheet()));
      expect(fresh).toMatchObject({ status: "not-started", rows: [{ scores: {} }] });
      const res = await owner.post("/v1/terms/close", { closeUnpublished: true });
      expect(res.status).toBe(409);
      expect(((await res.json()) as { detail: string }).detail).toBe("Second Term is the last term of the session. It closes when you complete promotion.");
    } finally {
      vi.setSystemTime(new Date(`${TODAY}T09:30:00Z`));
    }
  });
});
