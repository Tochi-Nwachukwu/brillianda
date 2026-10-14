import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { browser, schoolHost, signUpAndLand, type Client } from "./flows.js";
import { createHarness, type Harness } from "./helpers.js";

let h: Harness;
let owner: Client;
let other: Client;

beforeAll(async () => {
  h = await createHarness();
  ({ school: owner } = await signUpAndLand(h, { schoolName: "Kola Academy", subdomain: "kola", email: "owner@kola.test", password: "kola-owner-pw", fullName: "Femi Kola" }));
  ({ school: other } = await signUpAndLand(h, { schoolName: "Ube Academy", subdomain: "ube", email: "owner@ube.test", password: "ube-owner-pw" }));
  await owner.send("PUT", "/v1/admission-numbers", { pattern: "KA/{NUMBER}", digits: 4 });
  const res = await owner.send("POST", "/v1/classes/setup", {
    levels: [
      { key: "jss1", name: "JSS 1", short: "JSS1", section: "junior" },
      { key: "ss1", name: "SS 1", short: "SS1", section: "senior" },
    ],
    arms: [
      { name: "A", code: "A" },
      { name: "Gold", code: "GOL" },
    ],
    armsByLevel: [[0, 1], [1]],
  });
  expect(res.status).toBe(201);
  // One student already on file, with a guardian
  const { arms } = (await (await owner.get("/v1/students")).json()) as { arms: { id: string; label: string }[] };
  await owner.send("POST", "/v1/students", {
    firstName: "Adaeze",
    lastName: "Eze",
    gender: "female",
    armId: arms.find((a) => a.label === "SS 1")!.id,
    admissionNo: "OLD/001",
    guardianName: "Mr Eze",
    guardianPhone: "0805 555 0000",
  });
});
afterAll(async () => {
  await h?.t.close();
});

const rows = [
  { fullName: "Chidera Ngozi Okafor", gender: "F", className: "JSS 1A", dateOfBirth: "14/03/2014", guardianName: "Mrs Okafor", guardianPhone: "08030000001" },
  { firstName: "Tobi", lastName: "Okafor", gender: "boy", className: "Jss1", armName: "gold", dateOfBirth: "2013-01-02", guardianName: "Mrs Okafor", guardianPhone: "+2348030000001" },
  { firstName: "Emeka", lastName: "Eze", gender: "M", className: "SSS1", admissionNo: "", guardianName: "Mr Eze", guardianPhone: "08055550000" },
  { firstName: "Adaeze", lastName: "Eze", gender: "F", className: "SS 1", admissionNo: "old/001", address: "12 Allen Avenue" },
  { firstName: "Bad", lastName: "Date", gender: "M", className: "JSS 1", armName: "A", dateOfBirth: "03/14/2014" },
  { firstName: "No", lastName: "Class", gender: "M", className: "JSS 4" },
];

type Checked = { index: number; status: string; problems: { column: string; message: string; blocking: boolean }[]; student?: Record<string, string>; existingId?: string };

describe("import", () => {
  it("serves what the browser needs to match classes and spot duplicates", async () => {
    const setup = (await (await owner.get("/v1/imports/setup")).json()) as { schoolName: string; levels: unknown[]; arms: unknown[]; existing: { admissionNo: string }[]; batches: unknown[]; savedMapping: object };
    expect(setup.schoolName).toBe("Kola Academy");
    expect(setup.levels).toHaveLength(2);
    expect(setup.arms).toHaveLength(3);
    expect(setup.existing.map((e) => e.admissionNo)).toEqual(["OLD/001"]);
    expect(setup.batches).toEqual([]);
    expect(setup.savedMapping).toEqual({});
  });

  it("checks every row with the frontend's rules", async () => {
    const res = await owner.send("POST", "/v1/imports/check", { rows, armId: null });
    expect(res.status).toBe(200);
    const checked = ((await res.json()) as { rows: Checked[] }).rows;
    expect(checked.map((r) => r.status)).toEqual(["ready", "ready", "ready", "duplicate", "fix", "fix"]);
    expect(checked[0]!.student).toMatchObject({ firstName: "Chidera", otherNames: "Ngozi", lastName: "Okafor", gender: "female", armLabel: "JSS 1 A", dateOfBirth: "2014-03-14" });
    expect(checked[1]!.student).toMatchObject({ gender: "male", armLabel: "JSS 1 Gold" });
    expect(checked[2]!.student).toMatchObject({ armLabel: "SS 1", guardianPhone: "+2348055550000" });
    expect(checked[4]!.problems[0]!.message).toBe("Dates are read day first. Did you mean 14/03/2014?");
    expect(checked[5]!.problems[0]!.message).toMatch(/Class JSS 4 not found/);
  });

  it("remembers the column mapping", async () => {
    expect((await owner.send("PUT", "/v1/imports/mapping", { mapping: { "surname": "lastName", "sex": "gender" } })).status).toBe(204);
    expect(((await (await owner.get("/v1/imports/setup")).json()) as { savedMapping: object }).savedMapping).toEqual({ surname: "lastName", sex: "gender" });
    expect((await owner.send("PUT", "/v1/imports/mapping", { mapping: { x: "notAColumn" } })).status).toBe(422);
  });

  let batchId: string;

  it("writes the ready rows under one batch, numbers blanks, shares guardians, and updates a chosen duplicate", async () => {
    const res = await owner.send("POST", "/v1/imports", { rows, armId: null, update: [3], fileName: "jss-list.xlsx" });
    expect(res.status).toBe(201);
    const result = (await res.json()) as { batchId: string; created: number; updated: number; skipped: number; notImported: number; newStudents: { fullName: string; armLabel: string }[] };
    batchId = result.batchId;
    expect(result).toMatchObject({ created: 3, updated: 1, skipped: 0, notImported: 2 });
    expect(result.newStudents.map((s) => [s.fullName, s.armLabel])).toEqual([
      ["Chidera Ngozi Okafor", "JSS 1 A"],
      ["Tobi Okafor", "JSS 1 Gold"],
      ["Emeka Eze", "SS 1"],
    ]);

    const list = (await (await owner.get("/v1/students")).json()) as { students: { id: string; fullName: string; admissionNo: string; guardianName: string | null; guardianPhone: string | null }[] };
    const by = (name: string) => list.students.find((s) => s.fullName === name)!;
    expect([by("Chidera Ngozi Okafor").admissionNo, by("Tobi Okafor").admissionNo, by("Emeka Eze").admissionNo]).toEqual(["KA/0001", "KA/0002", "KA/0003"]);
    // Siblings in the file share one guardian; Emeka joins Adaeze's existing one
    const chidera = (await (await owner.get(`/v1/students/${by("Chidera Ngozi Okafor").id}`)).json()) as { guardian: { id: string; siblings: { fullName: string }[] } };
    expect(chidera.guardian.siblings.map((s) => s.fullName)).toEqual(["Tobi Okafor"]);
    const emeka = (await (await owner.get(`/v1/students/${by("Emeka Eze").id}`)).json()) as { guardian: { name: string; siblings: { fullName: string }[] } };
    expect(emeka.guardian.name).toBe("Mr Eze");
    expect(emeka.guardian.siblings.map((s) => s.fullName)).toEqual(["Adaeze Eze"]);
    // The duplicate was updated, keeping its number
    const adaeze = (await (await owner.get(`/v1/students/${by("Adaeze Eze").id}`)).json()) as { address: string; admissionNo: string; changes: { what: string }[] };
    expect(adaeze).toMatchObject({ address: "12 Allen Avenue", admissionNo: "OLD/001" });
    expect(adaeze.changes[0]!.what).toBe("Updated Adaeze Eze from an import");

    const home = (await (await owner.get("/v1/home")).json()) as { recent: { what: string }[] };
    expect(home.recent[0]!.what).toBe("Imported 3 students from jss-list.xlsx, updated 1");
    const setup = (await (await owner.get("/v1/imports/setup")).json()) as { batches: { id: string; created: number; updated: number; undoable: boolean; by: string }[] };
    expect(setup.batches[0]).toMatchObject({ id: batchId, created: 3, updated: 1, undoable: true, by: "Femi Kola" });
  });

  it("skips duplicates not chosen for update", async () => {
    const res = await owner.send("POST", "/v1/imports", { rows: [rows[3]], armId: null, update: [], fileName: "again.csv" });
    expect(await res.json()).toMatchObject({ created: 0, updated: 0, skipped: 1 });
  });

  it("undoes a batch within 24 hours, once", async () => {
    let res = await owner.send("POST", `/v1/imports/${batchId}/undo`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ removed: 3 });
    const list = (await (await owner.get("/v1/students")).json()) as { students: { fullName: string }[] };
    expect(list.students.map((s) => s.fullName)).toEqual(["Adaeze Eze"]);
    res = await owner.send("POST", `/v1/imports/${batchId}/undo`);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { detail: string }).detail).toBe("That import was already undone.");
  });

  it("refuses to undo once someone has edited a student from the batch", async () => {
    const res = await owner.send("POST", "/v1/imports", { rows: [{ firstName: "Uche", lastName: "Obi", gender: "M", className: "SS 1" }], armId: null, update: [], fileName: "one.csv" });
    const { batchId: id, newStudents } = (await res.json()) as { batchId: string; newStudents: { id: string }[] };
    await new Promise((r) => setTimeout(r, 1100));
    await owner.send("POST", "/v1/students/status", { studentIds: [newStudents[0]!.id], status: "suspended" });
    const undo = await owner.send("POST", `/v1/imports/${id}/undo`);
    expect(undo.status).toBe(409);
    expect(((await undo.json()) as { detail: string }).detail).toMatch(/edited students from this import/);
  });

  it("imports into one class from its page, and takes 2,000 rows in one request", async () => {
    const { arms } = (await (await owner.get("/v1/students")).json()) as { arms: { id: string; label: string }[] };
    const gold = arms.find((a) => a.label === "JSS 1 Gold")!.id;
    const many = Array.from({ length: 2000 }, (_, i) => ({ firstName: `Pupil`, lastName: `Number${"x".repeat(i % 7)}`, otherNames: "", gender: i % 2 ? "M" : "F", admissionNo: `BULK/${i}`, guardianName: `Parent ${i}`, guardianPhone: `0803${String(1_000_000 + i).padStart(7, "0")}` }));
    const body = JSON.stringify({ rows: many, armId: gold, update: [], fileName: "big.csv" });
    expect(body.length).toBeGreaterThan(256 * 1024);
    const started = Date.now();
    const res = await owner.send("POST", "/v1/imports", { rows: many, armId: gold, update: [], fileName: "big.csv" });
    expect(res.status).toBe(201);
    expect(((await res.json()) as { created: number }).created).toBe(2000);
    expect(Date.now() - started).toBeLessThan(20_000);
    const classes = (await (await owner.get("/v1/classes")).json()) as { arms: { id: string; studentCount: number }[] };
    expect(classes.arms.find((a) => a.id === gold)!.studentCount).toBe(2000);
  });

  it("keeps each school's imports to itself", async () => {
    const setup = (await (await other.get("/v1/imports/setup")).json()) as { batches: unknown[]; existing: unknown[] };
    expect(setup.batches).toEqual([]);
    expect(setup.existing).toEqual([]);
    expect((await other.send("POST", `/v1/imports/${batchId}/undo`)).status).toBe(404);
    expect((await browser(h, schoolHost("kola")).get("/v1/imports/setup")).status).toBe(401);
  });
});
