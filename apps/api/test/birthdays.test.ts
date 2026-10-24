import { birthdayTexts, eq, guardians, students, withSchool } from "@brillianda/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { runBirthdayTexts } from "../src/routes/birthdays.js";
import { browser, schoolHost, signUpAndLand, tokenFrom, waitForMail, type Client } from "./flows.js";
import { createHarness, type Harness } from "./helpers.js";

const TODAY = "2026-10-14";
const CRON = "cron-secret-0123456789";

let h: Harness;
let owner: Client;
let schoolId: string;
const kid: Record<string, string> = {};

async function json<T>(res: Response | Promise<Response>, status = 200): Promise<T> {
  const r = await res;
  expect(r.status, await r.clone().text()).toBe(status);
  return (await r.json()) as T;
}
const cron = (secret?: string) => h.app.request("/internal/cron/birthdays", { headers: { host: "brillianda.test", ...(secret ? { authorization: `Bearer ${secret}` } : {}) } });

type Row = { studentId: string; fullName: string; armLabel: string; on: string; inDays: number; turns: number; guardianPhone: string | null };
type Page = { settings: { enabled: boolean; message: string }; schoolName: string; today: string; upcoming: Row[]; sent: { fullName: string; to: string | null; text: string; date: string }[] };

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ["Date"], now: new Date(`${TODAY}T09:30:00Z`) });
  h = await createHarness({ cronSecret: CRON });
  ({ school: owner, schoolId } = await signUpAndLand(h, { schoolName: "Mahogany School", subdomain: "mahogany", email: "owner@mahogany.test", password: "mahogany-owner-pw", fullName: "Femi Mahogany" }));
  await json(owner.send("POST", "/v1/classes/setup", { levels: [{ key: "jss1", name: "JSS 1", short: "JSS1", section: "junior" }], arms: [{ name: "Gold", code: "GOL" }], armsByLevel: [[0]] }), 201);
  const { arms } = await json<{ arms: { id: string }[] }>(owner.get("/v1/students"));
  for (const [first, dob, phone, email] of [
    ["Ada", "2014-10-14", "0803 000 0001", "ngozi@family.test"],
    ["Bayo", "2012-02-29", "08030000002", ""],
    ["Chidi", "2015-10-20", "08030000003", ""],
    ["Dami", "2013-10-14", "08030000004", ""],
    ["Efe", "", "08030000005", ""],
  ] as const) {
    kid[first] = (
      await json<{ id: string }>(
        owner.send("POST", "/v1/students", { firstName: first, lastName: "Okoro", gender: "female", dateOfBirth: dob, armId: arms[0]!.id, guardianName: `Parent of ${first}`, guardianPhone: phone, guardianEmail: email }),
        201,
      )
    ).id;
  }
  // Dami's guardian has no phone on file.
  await withSchool(h.db, schoolId, async (tx) => {
    const [g] = await tx.select({ id: guardians.id }).from(guardians).where(eq(guardians.fullName, "Parent of Dami"));
    await tx.update(guardians).set({ phone: null }).where(eq(guardians.id, g!.id));
  });
  // Another school with birthdays off.
  await signUpAndLand(h, { schoolName: "Teak School", subdomain: "teak", email: "owner@teak.test", password: "teak-owner-pw" });
});
afterAll(async () => {
  vi.useRealTimers();
  await h?.t.close();
});

describe("birthday messages", () => {
  it("are off with the default message until the school turns them on", async () => {
    const page = await json<Page>(owner.get("/v1/birthdays"));
    expect(page).toMatchObject({ settings: { enabled: false }, schoolName: "Mahogany School", today: TODAY, sent: [] });
    expect(page.settings.message).toContain("{name}");
    expect(page.upcoming.map((r) => [r.fullName, r.inDays, r.turns, r.guardianPhone])).toEqual([
      ["Ada Okoro", 0, 12, "+2348030000001"],
      ["Dami Okoro", 0, 13, null],
      ["Chidi Okoro", 6, 11, "+2348030000003"],
    ]);
    expect(await json(owner.get("/v1/birthdays?days=3"))).toMatchObject({ enabled: false, rows: [{ fullName: "Ada Okoro" }, { fullName: "Dami Okoro" }] });
  });

  it("checks the message: {name}, 10 to 300 characters", async () => {
    for (const message of ["Happy birthday from us all!", "Hi {name}", `{name} ${"x".repeat(300)}`]) {
      const res = await owner.send("PUT", "/v1/birthdays/settings", { enabled: true, message });
      expect(res.status).toBe(422);
      expect(((await res.json()) as { errors: { pointer: string }[] }).errors[0]!.pointer).toBe("#/message");
    }
    expect((await owner.send("PUT", "/v1/birthdays/settings", { enabled: true, message: "Happy {age} birthday, {name}! Love from {school}." })).status).toBe(204);
    expect((await json<{ entries: { what: string }[] }>(owner.get("/v1/changes"))).entries[0]!.what).toBe("Turned birthday messages on");
    expect((await browser(h, schoolHost("mahogany")).get("/v1/birthdays")).status).toBe(401);
  });

  it("the daily job needs its secret", async () => {
    expect((await cron()).status).toBe(404);
    expect((await cron("not-the-secret-0000000")).status).toBe(404);
  });

  it("texts each birthday child's guardian once; no phone is logged, not sent", async () => {
    expect(await json(cron(CRON))).toEqual({ day: TODAY, schools: 1, sent: 1, noPhone: 1, failed: 0 });
    expect(h.sms.sent).toEqual([{ to: "+2348030000001", text: "Happy 12th birthday, Ada! Love from Mahogany School.", tag: "birthday" }]);
    // Again the same day: nothing new.
    expect(await json(cron(CRON))).toEqual({ day: TODAY, schools: 1, sent: 0, noPhone: 0, failed: 0 });
    expect(h.sms.sent).toHaveLength(1);
    const page = await json<Page>(owner.get("/v1/birthdays"));
    expect(page.sent.map((s) => [s.fullName, s.to, s.date]).sort()).toEqual([
      ["Ada Okoro", "+2348030000001", TODAY],
      ["Dami Okoro", null, TODAY],
    ]);
  });

  it("celebrates 29 February on 28 February, and records a provider's refusal", async () => {
    h.sms.failing.add("+2348030000002");
    expect(await runBirthdayTexts(h.deps, "2027-02-28")).toMatchObject({ sent: 0, failed: 1 });
    const rows = await withSchool(h.db, schoolId, (tx) => tx.select().from(birthdayTexts).where(eq(birthdayTexts.studentId, kid.Bayo!)));
    expect(rows).toMatchObject([{ day: "2027-02-28", status: "failed", text: "Happy 15th birthday, Bayo! Love from Mahogany School." }]);
    h.sms.failing.clear();
  });

  it("leaves out students who aren't active", async () => {
    await withSchool(h.db, schoolId, (tx) => tx.update(students).set({ status: "withdrawn" }).where(eq(students.id, kid.Chidi!)));
    expect(await runBirthdayTexts(h.deps, "2026-10-20")).toMatchObject({ sent: 0, noPhone: 0 });
  });

  it("shows the parent the school's message on the child's birthday", async () => {
    const page = await json<{ guardians: { id: string; name: string }[] }>(owner.get("/v1/parents"));
    const ngozi = page.guardians.find((g) => g.name === "Parent of Ada")!.id;
    expect((await owner.post(`/v1/guardians/${ngozi}/invite`)).status).toBe(201);
    const token = tokenFrom((await waitForMail(h, "ngozi@family.test", "invitation")).text)!;
    const parent = browser(h, schoolHost("mahogany"));
    await json(parent.post("/v1/invitations/accept", { token, password: "parent-password" }));
    const home = await json<{ children: { fullName: string; birthday: string | null }[] }>(parent.get("/v1/me/children"));
    expect(home.children).toMatchObject([{ fullName: "Ada Okoro", birthday: "Happy 12th birthday, Ada! Love from Mahogany School." }]);
    vi.setSystemTime(new Date("2026-10-15T09:30:00Z"));
    try {
      expect((await json<{ children: { birthday: string | null }[] }>(parent.get("/v1/me/children"))).children[0]!.birthday).toBeNull();
    } finally {
      vi.setSystemTime(new Date(`${TODAY}T09:30:00Z`));
    }
  });
});
