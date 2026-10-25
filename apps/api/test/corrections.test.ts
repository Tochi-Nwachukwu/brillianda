import { eq, guardians, students, withSchool } from "@brillianda/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { browser, schoolHost, signUpAndLand, tokenFrom, waitForMail, type Client } from "./flows.js";
import { createHarness, type Harness } from "./helpers.js";

const TODAY = "2026-10-14";

let h: Harness;
let owner: Client;
let other: Client;
let parent: Client;
let schoolId: string;
const kid: Record<string, string> = {};

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

type Row = { id: string; studentName: string; armLabel: string; by: string; changes: { field: string; from: string; to: string }[]; note: string; status: string; decided: { by: string; reason: string | null } | null };
type Child = { fullName: string; details: Record<string, unknown> & { guardian: { name: string; phone: string | null; email: string | null } | null }; corrections: Row[] };
const ask = (body: unknown, studentId = kid.Ada!) => parent.post(`/v1/me/children/${studentId}/corrections`, body);
const home = async () => (await json<{ children: Child[] }>(parent.get("/v1/me/children"))).children[0]!;

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ["Date"], now: new Date(`${TODAY}T09:30:00Z`) });
  h = await createHarness();
  ({ school: owner, schoolId } = await signUpAndLand(h, { schoolName: "Baobab School", subdomain: "baobab", email: "owner@baobab.test", password: "baobab-owner-pw", fullName: "Kunle Baobab" }));
  ({ school: other } = await signUpAndLand(h, { schoolName: "Cedar School", subdomain: "cedarx", email: "owner@cedarx.test", password: "cedarx-owner-pw" }));
  await json(owner.send("POST", "/v1/classes/setup", { levels: [{ key: "jss1", name: "JSS 1", short: "JSS1", section: "junior" }], arms: [{ name: "Gold", code: "GOL" }], armsByLevel: [[0]] }), 201);
  const { arms } = await json<{ arms: { id: string }[] }>(owner.get("/v1/students"));
  kid.Ada = (
    await json<{ id: string }>(
      owner.send("POST", "/v1/students", {
        firstName: "Ada",
        lastName: "Obi",
        gender: "female",
        dateOfBirth: "2014-05-02",
        admissionDate: "2025-09-15",
        stateOfOrigin: "Anambra",
        address: "12 Palm Avenue, Enugu",
        armId: arms[0]!.id,
        guardianName: "Ngozi Obi",
        guardianPhone: "08030000001",
        guardianEmail: "ngozi@obi.test",
      }),
      201,
    )
  ).id;
  kid.Kemi = (await json<{ id: string }>(owner.send("POST", "/v1/students", { firstName: "Kemi", lastName: "Eze", gender: "female", armId: arms[0]!.id, guardianName: "Uche Eze", guardianPhone: "08030000002" }), 201)).id;
  const { guardians: list } = await json<{ guardians: { id: string; name: string }[] }>(owner.get("/v1/parents"));
  expect((await owner.post(`/v1/guardians/${list.find((g) => g.name === "Ngozi Obi")!.id}/invite`)).status).toBe(201);
  const token = tokenFrom((await waitForMail(h, "ngozi@obi.test", "invitation")).text)!;
  parent = browser(h, schoolHost("baobab"));
  await json(parent.post("/v1/invitations/accept", { token, password: "parent-password", fullName: "Ngozi Obi" }));
});
afterAll(async () => {
  vi.useRealTimers();
  await h?.t.close();
});

describe("corrections", () => {
  it("show the parent what the school has on record", async () => {
    const child = await home();
    expect(child.details).toEqual({
      firstName: "Ada",
      otherNames: "",
      lastName: "Obi",
      dateOfBirth: "2014-05-02",
      gender: "female",
      admissionDate: "2025-09-15",
      stateOfOrigin: "Anambra",
      address: "12 Palm Avenue, Enugu",
      guardian: { name: "Ngozi Obi", phone: "+2348030000001", email: "ngozi@obi.test" },
    });
    expect(child.corrections).toEqual([]);
  });

  it("check each value with the student form's rules, and drop what's unchanged", async () => {
    const pointer = async (body: unknown) => (await problem(ask(body), 422)).errors![0]!;
    expect(await pointer({ changes: [{ field: "dateOfBirth", value: "2030-01-01" }] })).toMatchObject({ pointer: "#/changes/0/value", detail: "A birth date can’t be in the future" });
    expect(await pointer({ changes: [{ field: "firstName", value: "Adaeze" }, { field: "firstName", value: "Ada" }] })).toMatchObject({ pointer: "#/changes/1/field" });
    expect(await pointer({ changes: [{ field: "guardianPhone", value: "12345" }] })).toMatchObject({ detail: "Enter a Nigerian number, e.g. 0803 000 0001" });
    expect(await pointer({ changes: [{ field: "stateOfOrigin", value: "Atlantis" }] })).toMatchObject({ detail: "Choose a state" });
    expect(await pointer({ changes: [{ field: "address", value: "x" }] })).toMatchObject({ detail: "Enter the address" });
    expect(await pointer({ changes: [{ field: "firstName", value: "Ada" }, { field: "guardianPhone", value: "0803 000 0001" }] })).toMatchObject({ pointer: "#/changes", detail: "That’s what the record already says." });
    expect(await pointer({ changes: [], note: "" })).toMatchObject({ pointer: "#/changes" });
  });

  it("are for the parent's own children only", async () => {
    expect((await problem(ask({ changes: [{ field: "firstName", value: "Kemisola" }] }, kid.Kemi), 404)).detail).toBe("You can ask about your own children only.");
    expect((await owner.post(`/v1/me/children/${kid.Ada}/corrections`, { changes: [{ field: "firstName", value: "Adaeze" }] })).status).toBe(403);
  });

  it("reach the school with what the record said and what it should say", async () => {
    const body = { changes: [{ field: "firstName", value: " Adaeze " }, { field: "otherNames", value: "" }, { field: "dateOfBirth", value: "2014-05-03" }, { field: "guardianPhone", value: "0809 111 2222" }], note: "Her name was misspelt" };
    await json(ask(body), 201);
    expect(await json(owner.get("/v1/corrections/count"))).toEqual({ open: 1 });
    const page = await json<{ open: Row[]; answered: Row[] }>(owner.get("/v1/corrections"));
    expect(page.answered).toEqual([]);
    expect(page.open).toMatchObject([
      {
        studentName: "Ada Obi",
        armLabel: "JSS 1",
        by: "Ngozi Obi",
        note: "Her name was misspelt",
        status: "open",
        decided: null,
        changes: [
          { field: "firstName", from: "Ada", to: "Adaeze" },
          { field: "dateOfBirth", from: "2014-05-02", to: "2014-05-03" },
          { field: "guardianPhone", from: "+2348030000001", to: "+2348091112222" },
        ],
      },
    ]);
    expect((await home()).corrections.map((c) => c.status)).toEqual(["open"]);
    expect(await json(other.get("/v1/corrections/count"))).toEqual({ open: 0 });
    expect((await other.post(`/v1/corrections/${page.open[0]!.id}/resolve`, { approve: true })).status).toBe(404);
  });

  it("change the record in one go when approved, once", async () => {
    const [request] = (await json<{ open: Row[] }>(owner.get("/v1/corrections"))).open;
    expect((await owner.post(`/v1/corrections/${request!.id}/resolve`, { approve: true })).status).toBe(204);
    const [s] = await withSchool(h.db, schoolId, (tx) => tx.select().from(students).where(eq(students.id, kid.Ada!)));
    expect(s).toMatchObject({ firstName: "Adaeze", dateOfBirth: "2014-05-03" });
    const [g] = await withSchool(h.db, schoolId, (tx) => tx.select().from(guardians).where(eq(guardians.fullName, "Ngozi Obi")));
    expect(g!.phone).toBe("+2348091112222");
    const history = await json<{ entries: { what: string }[] }>(owner.get("/v1/changes"));
    expect(history.entries[0]!.what).toBe("Corrected Adaeze Obi’s first name, date of birth, guardian’s phone number, as Ngozi Obi asked");
    expect((await problem(owner.post(`/v1/corrections/${request!.id}/resolve`, { approve: false, reason: "Too late" }), 409)).detail).toBe("This request has already been answered.");
    expect(await json(owner.get("/v1/corrections/count"))).toEqual({ open: 0 });
    expect((await home()).details).toMatchObject({ firstName: "Adaeze", guardian: { phone: "+2348091112222" } });
  });

  it("need a reason to decline, which the parent sees", async () => {
    await json(ask({ changes: [{ field: "guardianEmail", value: "NGOZI.OBI@Example.com" }] }), 201);
    const [request] = (await json<{ open: Row[] }>(owner.get("/v1/corrections"))).open;
    expect(request!.changes).toEqual([{ field: "guardianEmail", from: "ngozi@obi.test", to: "ngozi.obi@example.com" }]);
    expect((await problem(owner.post(`/v1/corrections/${request!.id}/resolve`, { approve: false, reason: " " }), 422)).errors![0]!.pointer).toBe("#/reason");
    expect((await owner.post(`/v1/corrections/${request!.id}/resolve`, { approve: false, reason: "Please confirm it at the office" })).status).toBe(204);
    const latest = (await home()).corrections;
    expect(latest.map((c) => c.status)).toEqual(["declined", "approved"]);
    expect(latest[0]!.decided).toMatchObject({ by: "Kunle Baobab", reason: "Please confirm it at the office" });
    expect((await json<{ answered: Row[] }>(owner.get("/v1/corrections"))).answered).toHaveLength(2);
    expect((await json<{ entries: { what: string }[] }>(owner.get("/v1/changes"))).entries[0]!.what).toBe("Declined Ngozi Obi’s correction to Adaeze Obi’s details");
  });
});
