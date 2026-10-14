import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { browser, schoolHost, signUpAndLand, type Client } from "./flows.js";
import { addMember, createHarness, signIn, type Harness } from "./helpers.js";

let h: Harness;
let owner: Client;
let admin: Client;
let olaId: string;

beforeAll(async () => {
  h = await createHarness();
  const { school, schoolId } = await signUpAndLand(h, { schoolName: "Baobab School", subdomain: "baobab", email: "owner@baobab.test", password: "baobab-owner-pw", fullName: "=1+1 Owner" });
  owner = school;
  const a = await addMember(h, schoolId, "kemi@baobab.test", "admin");
  admin = browser(h, schoolHost("baobab"), new Map([["bd_session", await signIn(h, schoolId, a.id)]]));
  await signUpAndLand(h, { schoolName: "Neem School", subdomain: "neem", email: "owner@neem.test", password: "neem-owner-pw" });

  await owner.send("POST", "/v1/classes/setup", { levels: [{ key: "jss1", name: "JSS 1", short: "JSS1", section: "junior" }], arms: [{ name: "A", code: "A" }], armsByLevel: [[0]] });
  const { arms } = (await (await owner.get("/v1/students")).json()) as { arms: { id: string }[] };
  const student = (first: string, last: string) => ({ firstName: first, lastName: last, gender: "female", armId: arms[0]!.id });
  let res = await admin.send("POST", "/v1/students", student("Ọlá", "Adéyẹmí"));
  olaId = ((await res.json()) as { id: string }).id;
  res = await owner.send("POST", "/v1/students", student("Bisi", "Coker"));
  await admin.send("POST", "/v1/students/status", { studentIds: [olaId], status: "suspended" });
});
afterAll(async () => {
  await h?.t.close();
});

type Log = { entries: { who: string; what: string; at: string; student: { id: string; name: string } | null }[]; total: number; people: string[]; student: { name: string } | null };
const changes = async (query = "", who: Client = owner) => (await (await who.get(`/v1/changes${query}`)).json()) as Log;

describe("change history", () => {
  it("lists every change newest first, with the student it was about, and who appears", async () => {
    const log = await changes();
    expect(log.entries.map((e) => e.what)).toEqual([
      "Marked Ọlá Adéyẹmí as suspended",
      "Added Bisi Coker",
      "Added Ọlá Adéyẹmí",
      "Set up 1 class, JSS 1 to JSS 1",
      "Created the school",
    ]);
    expect(log.entries[0]!.student).toEqual({ id: olaId, name: "Ọlá Adéyẹmí" });
    expect(log.entries[3]!.student).toBeNull();
    expect(log.total).toBe(5);
    expect(log.people).toEqual(["=1+1 Owner", "kemi@baobab.test"]);
  });

  it("filters by person, by student, and by words without accents", async () => {
    expect((await changes("?who=kemi%40baobab.test")).entries.map((e) => e.what)).toEqual(["Marked Ọlá Adéyẹmí as suspended", "Added Ọlá Adéyẹmí"]);
    const forOla = await changes(`?studentId=${olaId}`);
    expect(forOla.total).toBe(2);
    expect(forOla.student).toEqual({ id: olaId, name: "Ọlá Adéyẹmí" });
    expect((await changes("?search=ola%20adeyemi")).total).toBe(2);
    expect((await changes("?search=suspended%20ola")).total).toBe(1);
    expect((await changes("?search=100%25")).total).toBe(0);
  });

  it("filters by Lagos days and limits, keeping the total", async () => {
    const today = new Date(Date.now() + 3_600_000).toISOString().slice(0, 10);
    expect((await changes(`?from=${today}&to=${today}`)).total).toBe(5);
    expect((await changes("?to=2020-01-01")).total).toBe(0);
    const limited = await changes("?limit=2");
    expect(limited.entries).toHaveLength(2);
    expect(limited.total).toBe(5);
    expect((await owner.get("/v1/changes?from=yesterday")).status).toBe(422);
  });

  it("exports the same filters as formula-safe CSV", async () => {
    const res = await owner.get("/v1/changes/export?who=%3D1%2B1%20Owner");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(res.headers.get("content-disposition")).toMatch(/^attachment; filename="baobab-changes-\d{4}-\d{2}-\d{2}\.csv"$/);
    const lines = (await res.text()).trim().split("\r\n");
    expect(lines[0]).toBe("When (Lagos time),Who,What,Student");
    expect(lines).toHaveLength(4);
    expect(lines[1]).toContain(",'=1+1 Owner,Added Bisi Coker,Bisi Coker");
  });

  it("keeps each school's history to itself and needs a session", async () => {
    const neem = browser(h, schoolHost("neem"));
    await neem.post("/v1/auth/login", { email: "owner@neem.test", password: "neem-owner-pw" });
    const log = await changes("", neem);
    expect(log.entries.map((e) => e.what)).toEqual(["Created the school"]);
    expect((await changes(`?studentId=${olaId}`, neem)).total).toBe(0);
    expect((await browser(h, schoolHost("baobab")).get("/v1/changes")).status).toBe(401);
  });
});
