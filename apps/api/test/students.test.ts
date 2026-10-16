import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { browser, schoolHost, signUpAndLand, type Client } from "./flows.js";
import { createHarness, type Harness } from "./helpers.js";

let h: Harness;
let owner: Client;
let other: Client;
let arms: { id: string; label: string; chip: string }[];

beforeAll(async () => {
  h = await createHarness();
  ({ school: owner } = await signUpAndLand(h, { schoolName: "Sunrise Academy", subdomain: "sunrise", email: "owner@sunrise.test", password: "sunrise-owner-pw", fullName: "Funke Ade" }));
  ({ school: other } = await signUpAndLand(h, { schoolName: "Moonlight Academy", subdomain: "moonlight", email: "owner@moon.test", password: "moon-owner-pw" }));
  await owner.send("PUT", "/v1/session", {
    startYear: 2026,
    terms: [
      { name: "First Term", startsOn: "2026-09-14", endsOn: "2026-12-18" },
      { name: "Second Term", startsOn: "2027-01-11", endsOn: "2027-04-09" },
    ],
  });
  const res = await owner.send("POST", "/v1/classes/setup", {
    levels: [
      { key: "jss1", name: "JSS 1", short: "JSS1", section: "junior" },
      { key: "jss2", name: "JSS 2", short: "JSS2", section: "junior" },
    ],
    arms: [
      { name: "Gold", code: "GOL" },
      { name: "Blue", code: "BLU" },
    ],
    armsByLevel: [[0, 1], [0]],
  });
  expect(res.status).toBe(201);
  ({ arms } = (await (await owner.get("/v1/students")).json()) as { arms: typeof arms });
});
afterAll(async () => {
  await h?.t.close();
});

const arm = (label: string) => arms.find((a) => a.label === label)!.id;
const base = (over: Record<string, unknown> = {}) => ({
  firstName: "Chiamaka",
  lastName: "Okafor",
  otherNames: "Adaeze",
  gender: "FEMALE",
  armId: arm("JSS 1 Gold"),
  dateOfBirth: "2014-03-02",
  admissionNo: "",
  admissionDate: "2026-09-14",
  address: "",
  stateOfOrigin: "Anambra",
  guardianId: "",
  guardianName: "Mrs Ngozi Okafor",
  guardianPhone: "0803 000 0001",
  guardianEmail: "ngozi@example.com",
  ...over,
});

type Row = { id: string; fullName: string; admissionNo: string; gender: string; status: string; armId: string; guardianName: string | null; guardianPhone: string | null };
const list = async (who: Client = owner) => (await (await who.get("/v1/students")).json()) as { students: Row[]; nextAdmissionNo: string; arms: typeof arms };
const add = async (over: Record<string, unknown> = {}) => owner.send("POST", "/v1/students", base(over));

describe("admission numbers", () => {
  it("default to the school's initials, the session year and a counter", async () => {
    const res = await owner.get("/v1/admission-numbers");
    expect(await res.json()).toEqual({ pattern: "SA/{YEAR}/{NUMBER}", digits: 4, next: 1, preview: "SA/2026/0001" });
    expect((await list()).nextAdmissionNo).toBe("SA/2026/0001");
  });

  it("refuse a pattern without {NUMBER}", async () => {
    const res = await owner.send("PUT", "/v1/admission-numbers", { pattern: "SUN/{YEAR}", digits: 4 });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { errors: { detail: string }[] }).errors[0]!.detail).toMatch(/Include \{NUMBER\}/);
  });
});

describe("students", () => {
  let chiamaka: string;
  let tobi: string;

  it("lists the classes a student can sit in, labelled like the frontend", async () => {
    expect(arms.map((a) => [a.label, a.chip])).toEqual([
      ["JSS 1 Gold", "JSS1 GOL"],
      ["JSS 1 Blue", "JSS1 BLU"],
      ["JSS 2", "JSS2"],
    ]);
  });

  it("adds a student with the next admission number and a new guardian", async () => {
    const res = await add();
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; admissionNo: string; fullName: string };
    expect(body).toMatchObject({ admissionNo: "SA/2026/0001", fullName: "Chiamaka Adaeze Okafor" });
    chiamaka = body.id;
    const { students, nextAdmissionNo } = await list();
    expect(students).toEqual([
      expect.objectContaining({ fullName: "Chiamaka Adaeze Okafor", gender: "female", status: "active", guardianName: "Mrs Ngozi Okafor", guardianPhone: "+2348030000001" }),
    ]);
    expect(nextAdmissionNo).toBe("SA/2026/0002");
  });

  it("finds the guardian by phone so a sibling shares them", async () => {
    const res = await owner.get("/v1/guardians?phone=08030000001");
    const { guardian } = (await res.json()) as { guardian: { id: string; name: string; children: string[] } };
    expect(guardian).toMatchObject({ name: "Mrs Ngozi Okafor", phone: "+2348030000001", children: ["Chiamaka"] });
    expect(await (await owner.get("/v1/guardians?phone=08099999999")).json()).toEqual({ guardian: null });

    const sib = await add({ firstName: "Tobi", otherNames: "", gender: "male", armId: arm("JSS 2"), guardianId: guardian.id, guardianName: "", guardianPhone: "", guardianEmail: "" });
    expect(sib.status).toBe(201);
    tobi = ((await sib.json()) as { id: string }).id;
    const detail = (await (await owner.get(`/v1/students/${chiamaka}`)).json()) as { guardian: { siblings: { fullName: string; armLabel: string }[] } };
    expect(detail.guardian.siblings).toEqual([{ id: tobi, fullName: "Tobi Okafor", armLabel: "JSS 2" }]);
  });

  it("refuses a taken admission number, names it in the field, and checks the frontend's rules", async () => {
    let res = await add({ admissionNo: "sa/2026/0001" });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { errors: { pointer: string }[] }).errors[0]!.pointer).toBe("#/admissionNo");
    res = await add({ firstName: "R2-D2", gender: "other" });
    expect(res.status).toBe(422);
    let pointers = ((await res.json()) as { errors: { pointer: string }[] }).errors.map((e) => e.pointer).sort();
    expect(pointers).toEqual(["#/firstName", "#/gender"]);
    // The cross-field rules run once every field is the right shape (as in the frontend's zod schema)
    res = await add({ dateOfBirth: "2999-01-01", guardianName: "", guardianId: "" });
    pointers = ((await res.json()) as { errors: { pointer: string }[] }).errors.map((e) => e.pointer).sort();
    expect(pointers).toEqual(["#/dateOfBirth", "#/guardianName"]);
    res = await add({ armId: "00000000-0000-7000-8000-000000000000" });
    expect(res.status).toBe(422);
  });

  it("edits a student; moving class adds to the class history", async () => {
    const res = await owner.send("PUT", `/v1/students/${chiamaka}`, base({ armId: arm("JSS 1 Blue"), lastName: "Okafor-Eze", admissionNo: "" }));
    expect(res.status).toBe(204);
    const d = (await (await owner.get(`/v1/students/${chiamaka}`)).json()) as {
      fullName: string;
      admissionNo: string;
      classHistory: { armLabel: string; from: string }[];
      changes: { what: string; who: string }[];
    };
    expect(d.fullName).toBe("Chiamaka Adaeze Okafor-Eze");
    expect(d.admissionNo).toBe("SA/2026/0001");
    expect(d.classHistory.map((x) => x.armLabel)).toEqual(["JSS 1 Gold", "JSS 1 Blue"]);
    expect(d.classHistory[0]!.from).toBe("2026-09-14");
    expect(d.changes.map((x) => x.what)).toEqual(["Updated Chiamaka Adaeze Okafor-Eze’s details", "Moved Chiamaka Adaeze Okafor-Eze to JSS 1 Blue", "Added Chiamaka Adaeze Okafor"]);
    expect(d.changes[0]!.who).toBe("Funke Ade");
  });

  it("editing the guardian's details updates them for every sibling", async () => {
    await owner.send("PUT", `/v1/students/${chiamaka}`, base({ armId: arm("JSS 1 Blue"), lastName: "Okafor-Eze", guardianName: "Dr Ngozi Okafor", guardianPhone: "08030000002" }));
    const rows = (await list()).students;
    expect(rows.find((r) => r.id === tobi)).toMatchObject({ guardianName: "Dr Ngozi Okafor", guardianPhone: "+2348030000002" });
  });

  it("moves several students at once and changes their status", async () => {
    let res = await owner.send("POST", "/v1/students/move", { studentIds: [chiamaka, tobi], armId: arm("JSS 2") });
    expect(await res.json()).toEqual({ moved: 1 }); // Tobi is already there
    res = await owner.send("POST", "/v1/students/status", { studentIds: [chiamaka, tobi], status: "suspended" });
    expect(await res.json()).toEqual({ changed: 2 });
    expect((await list()).students.every((s) => s.status === "suspended" && s.armId === arm("JSS 2"))).toBe(true);
    expect(((await (await owner.get("/v1/home")).json()) as { students: number }).students).toBe(0); // counts active only
    await owner.send("POST", "/v1/students/status", { studentIds: [chiamaka, tobi], status: "active" });
    expect(((await (await owner.get("/v1/home")).json()) as { students: number }).students).toBe(2);
  });

  it("refuses to remove a class arm that has students", async () => {
    const classes = (await (await owner.get("/v1/classes")).json()) as { arms: { id: string; studentCount: number }[]; levels: { id: string; name: string }[] };
    const full = classes.arms.find((a) => a.id === arm("JSS 2"))!;
    expect(full.studentCount).toBe(2);
    const jss2 = classes.levels.find((l) => l.name === "JSS 2")!;
    const res = await owner.send("DELETE", `/v1/class-levels/${jss2.id}`);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { detail: string }).detail).toBe("JSS 2 has 2 students. Move them first, or archive the class instead.");
  });

  it("uses a new admission format for the next student", async () => {
    let res = await owner.send("PUT", "/v1/admission-numbers", { pattern: "SUN-{NUMBER}", digits: 3 });
    expect(await res.json()).toMatchObject({ pattern: "SUN-{NUMBER}", next: 3, preview: "SUN-003" });
    res = await add({ firstName: "Emeka", guardianName: "", guardianPhone: "", guardianEmail: "" });
    expect(((await res.json()) as { admissionNo: string }).admissionNo).toBe("SUN-003");
  });

  it("soft-deletes a student added by mistake, freeing the number", async () => {
    const { students } = await list();
    const emeka = students.find((s) => s.fullName.startsWith("Emeka"))!;
    expect((await owner.send("DELETE", `/v1/students/${emeka.id}`)).status).toBe(204);
    expect((await owner.get(`/v1/students/${emeka.id}`)).status).toBe(404);
    expect((await list()).students.some((s) => s.id === emeka.id)).toBe(false);
    expect((await add({ firstName: "Emeka", admissionNo: "SUN-003", guardianName: "", guardianPhone: "", guardianEmail: "" })).status).toBe(201);
  });

  it("keeps a class that has held students: archive, not delete", async () => {
    // Chiamaka sat in JSS 1 Blue before moving to JSS 2; that history keeps the class
    const res = await owner.send("DELETE", `/v1/arms/${arm("JSS 1 Blue")}`);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { detail: string }).detail).toBe("Students have been in JSS 1 Blue before, so it keeps their history. Archive it instead.");
  });

  it("refuses an unknown guardian id and impossible dates without a server error", async () => {
    let res = await add({ guardianId: "not-a-uuid", guardianName: "" });
    expect(res.status).toBe(422);
    res = await add({ guardianId: "00000000-0000-7000-8000-000000000000", guardianName: "" });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { errors: { pointer: string }[] }).errors[0]!.pointer).toBe("#/guardianId");
    res = await add({ dateOfBirth: "2014-13-45" });
    expect(res.status).toBe(422);
    expect((await owner.get("/v1/changes?from=2026-02-30")).status).toBe(422);
  });

  it("keeps each school's students to itself", async () => {
    expect((await list(other)).students).toEqual([]);
    expect((await other.get(`/v1/students/${chiamaka}`)).status).toBe(404);
    expect(await (await other.get("/v1/guardians?phone=08030000002")).json()).toEqual({ guardian: null });
    expect(await (await other.send("POST", "/v1/students/status", { studentIds: [chiamaka], status: "withdrawn" })).json()).toEqual({ changed: 0 });
    expect((await browser(h, schoolHost("sunrise")).get("/v1/students")).status).toBe(401);
  });
});
