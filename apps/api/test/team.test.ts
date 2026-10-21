import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addTeamMember, disableTeamMember } from "../src/team-admin.js";
import { APEX, browser, schoolHost, signUpAndLand, type Client } from "./flows.js";
import { createHarness, type Harness } from "./helpers.js";

let h: Harness;
let console_: Client;
let teak: Client;
let password: string;

async function json<T>(res: Response | Promise<Response>, status = 200): Promise<T> {
  const r = await res;
  expect(r.status, await r.clone().text()).toBe(status);
  return (await r.json()) as T;
}

type School = { subdomain: string; name: string; status: string; owner: { fullName: string; email: string } | null; students: number; classes: number; setupDone: number; setupTotal: number; createdAt: number };

beforeAll(async () => {
  h = await createHarness();
  ({ school: teak } = await signUpAndLand(h, { schoolName: "Teak College", subdomain: "teak", email: "owner@teak.test", password: "teak-owner-pw", fullName: "Ola Teak" }));
  await signUpAndLand(h, { schoolName: "Baobab School", subdomain: "baobab", email: "owner@baobab.test", password: "baobab-owner-pw", fullName: "Ife Baobab" });
  await json(teak.send("POST", "/v1/classes/setup", { levels: [{ key: "jss1", name: "JSS 1", short: "JSS1", section: "junior" }], arms: [{ name: "Gold", code: "GOL" }, { name: "Blue", code: "BLU" }], armsByLevel: [[0, 1]] }), 201);
  const { arms } = await json<{ arms: { id: string }[] }>(teak.get("/v1/students"));
  for (const [i, first] of ["Ada", "Bayo", "Chi"].entries()) {
    await json(teak.send("POST", "/v1/students", { firstName: first, lastName: "Teak", gender: "female", armId: arms[0]!.id, guardianName: "Parent", guardianPhone: `0803000000${i}` }), 201);
  }
  await browser(h, APEX).post("/v1/trial-requests", { schoolName: "Lekki Grammar", contactName: "Mrs Bello", role: "Proprietor", email: "bello@lekki.test", phone: "0802 345 6789", studentCount: "400", state: "Lagos", interests: ["results"], message: "Hello", website: "" });
  ({ password } = await addTeamMember(h.db, { email: "Ada@Brillianda.test", fullName: "Ada  Okoro" }));
  console_ = browser(h, APEX);
});
afterAll(async () => {
  await h?.t.close();
});

describe("team sign-in", () => {
  it("is on the main site only, with team accounts only", async () => {
    // A school's owner can't sign in here, and the console isn't reachable on a school's address.
    expect((await browser(h, APEX).post("/v1/team/login", { email: "owner@teak.test", password: "teak-owner-pw" })).status).toBe(401);
    expect((await browser(h, schoolHost("teak")).post("/v1/team/login", { email: "ada@brillianda.test", password })).status).toBe(404);
    expect((await browser(h, APEX).post("/v1/team/login", { email: "ada@brillianda.test", password: "wrong-password" })).status).toBe(401);
    expect((await console_.get("/v1/team/me")).status).toBe(401);

    expect(await json(console_.post("/v1/team/login", { email: "ADA@brillianda.test", password }))).toMatchObject({ fullName: "Ada Okoro", email: "ada@brillianda.test" });
    expect(await json(console_.get("/v1/team/me"))).toMatchObject({ fullName: "Ada Okoro" });
  });

  it("a school session doesn't open the console, and a team session doesn't open a school", async () => {
    for (const path of ["/v1/team/me", "/v1/team/overview", "/v1/team/schools"]) expect((await teak.get(path)).status, path).toBe(404);
    const onSchool = browser(h, schoolHost("teak"), console_.cookies);
    expect((await onSchool.get("/v1/me")).status).toBe(401);
    expect((await onSchool.get("/v1/team/me")).status).toBe(404);
  });
});

describe("the console", () => {
  it("overview: schools, students, trial requests waiting, newest schools and activity", async () => {
    const o = await json<{ schools: { active: number; suspended: number; newThisWeek: number }; students: number; trialsWaiting: number; recentSchools: School[]; activity: { what: string; subdomain?: string }[] }>(console_.get("/v1/team/overview"));
    expect(o.schools).toEqual({ active: 2, suspended: 0, newThisWeek: 2 });
    expect(o.students).toBe(3);
    expect(o.trialsWaiting).toBe(1);
    expect(o.recentSchools.map((s) => s.subdomain)).toEqual(["baobab", "teak"]);
    expect(o.activity.map((a) => a.what)).toEqual(["Baobab School signed up", "Teak College signed up"]);
  });

  it("every school with counts and setup progress, by name, never a student's record", async () => {
    const list = await json<School[]>(console_.get("/v1/team/schools"));
    expect(list.map((s) => [s.name, s.status, s.owner?.email, s.students, s.classes, `${s.setupDone}/${s.setupTotal}`])).toEqual([
      ["Baobab School", "active", "owner@baobab.test", 0, 0, "0/7"],
      ["Teak College", "active", "owner@teak.test", 3, 2, "3/7"],
    ]);
    expect(JSON.stringify(list)).not.toContain("Ada Teak");
  });

  it("a school's summary, logged in that school's history once an hour", async () => {
    const d = await json<{ name: string; admins: number; teachers: number; parents: number; subjects: number; setup: { label: string; done: boolean }[]; statusNote: unknown; levelsOffered: string[] }>(console_.get("/v1/team/schools/teak"));
    expect(d).toMatchObject({ name: "Teak College", admins: 1, teachers: 0, parents: 0, subjects: 0, statusNote: null, levelsOffered: ["secondary"] });
    expect(d.setup.filter((s) => s.done).map((s) => s.label)).toEqual(["Classes", "Arms", "Students"]);
    await json(console_.get("/v1/team/schools/teak"));
    const history = await json<{ entries: { who: string; what: string }[] }>(teak.get("/v1/changes"));
    const views = history.entries.filter((e) => e.what.startsWith("Viewed the school’s summary"));
    expect(views).toEqual([{ ...views[0], who: "Ada Okoro (Brillianda)", what: "Viewed the school’s summary from the Brillianda team console" }]);
    expect((await console_.get("/v1/team/schools/nowhere")).status).toBe(404);
  });

  it("pauses a school with a reason: its people can't sign in, its records stay; then reactivates it", async () => {
    expect((await console_.send("PUT", "/v1/team/schools/teak/status", { status: "suspended", reason: "x" })).status).toBe(422);
    expect((await console_.send("PUT", "/v1/team/schools/teak/status", { status: "suspended", reason: "Unpaid since August" })).status).toBe(204);
    expect((await console_.send("PUT", "/v1/team/schools/teak/status", { status: "suspended", reason: "Again" })).status).toBe(409);

    expect((await teak.get("/v1/me")).status).toBe(404);
    expect((await browser(h, schoolHost("teak")).post("/v1/auth/login", { email: "owner@teak.test", password: "teak-owner-pw" })).status).toBe(404);
    const d = await json<{ status: string; statusNote: { status: string; reason: string; by: string } }>(console_.get("/v1/team/schools/teak"));
    expect(d).toMatchObject({ status: "suspended", statusNote: { status: "suspended", reason: "Unpaid since August", by: "Ada Okoro" } });
    expect((await json<{ schools: { suspended: number } }>(console_.get("/v1/team/overview"))).schools.suspended).toBe(1);

    expect((await console_.send("PUT", "/v1/team/schools/teak/status", { status: "active", reason: "Paid in full" })).status).toBe(204);
    expect((await teak.get("/v1/me")).status).toBe(200);
    const history = await json<{ entries: { who: string; what: string }[] }>(teak.get("/v1/changes"));
    expect(history.entries.map((e) => e.what)).toEqual(expect.arrayContaining(["Paused the school’s account: Unpaid since August", "Reactivated the school’s account: Paid in full"]));
    expect((await json<{ students: number }>(teak.get("/v1/home"))).students).toBe(3);
  });

  it("trial requests: newest first, with a status and the team's note", async () => {
    const [t] = await json<{ id: string; schoolName: string; status: string; note: string | null; studentCount: number }[]>(console_.get("/v1/team/trial-requests"));
    expect(t).toMatchObject({ schoolName: "Lekki Grammar", status: "new", note: null, studentCount: 400 });
    expect((await console_.send("PATCH", `/v1/team/trial-requests/${t!.id}`, { status: "contacted", note: "Called; demo on Friday" })).status).toBe(204);
    expect((await json<{ status: string; note: string }[]>(console_.get("/v1/team/trial-requests")))[0]).toMatchObject({ status: "contacted", note: "Called; demo on Friday" });
    expect((await console_.send("PATCH", `/v1/team/trial-requests/${t!.id}`, { status: "maybe", note: "" })).status).toBe(422);
    expect((await console_.send("PATCH", `/v1/team/trial-requests/${crypto.randomUUID()}`, { status: "new" })).status).toBe(404);

    const o = await json<{ trialsWaiting: number; activity: { who: string; what: string }[] }>(console_.get("/v1/team/overview"));
    expect(o.trialsWaiting).toBe(0);
    expect(o.activity.slice(0, 3).map((a) => a.what)).toEqual([
      "Marked Lekki Grammar’s trial request contacted: Called; demo on Friday",
      "Reactivated Teak College: Paid in full",
      "Paused Teak College: Unpaid since August",
    ]);
  });
});

describe("signing out and disabled accounts", () => {
  it("signs out, and a disabled account loses its sessions", async () => {
    const other = browser(h, APEX);
    await json(other.post("/v1/team/login", { email: "ada@brillianda.test", password }));
    expect((await console_.post("/v1/team/logout")).status).toBe(204);
    expect((await console_.get("/v1/team/me")).status).toBe(401);
    expect((await other.get("/v1/team/me")).status).toBe(200);
    expect(await disableTeamMember(h.db, "ada@brillianda.test")).toBe(true);
    expect((await other.get("/v1/team/me")).status).toBe(401);
    expect((await browser(h, APEX).post("/v1/team/login", { email: "ada@brillianda.test", password })).status).toBe(401);
  });

  it("refuses a second account with the same email", async () => {
    await expect(addTeamMember(h.db, { email: "ada@brillianda.test", fullName: "Someone Else" })).rejects.toThrow(/already has a team account/);
  });
});
