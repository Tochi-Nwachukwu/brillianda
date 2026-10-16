import { CATALOGUE } from "@brillianda/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { browser, schoolHost, signUpAndLand, type Client } from "./flows.js";
import { createHarness, type Harness } from "./helpers.js";

let h: Harness;
let owner: Client;
let other: Client;

const LEVELS = [
  ...[1, 2, 3].map((n) => ({ key: `jss${n}`, name: `JSS ${n}`, short: `JSS${n}`, section: "junior" })),
  ...[1, 2, 3].map((n) => ({ key: `ss${n}`, name: `SS ${n}`, short: `SS${n}`, section: "senior" })),
];

beforeAll(async () => {
  h = await createHarness();
  ({ school: owner } = await signUpAndLand(h, { schoolName: "Iroko College", subdomain: "iroko", email: "owner@iroko.test", password: "iroko-owner-pw" }));
  ({ school: other } = await signUpAndLand(h, { schoolName: "Obeche College", subdomain: "obeche", email: "owner@obeche.test", password: "obeche-owner-pw" }));
  const res = await owner.send("POST", "/v1/classes/setup", { levels: LEVELS, arms: [{ name: "Gold", code: "GOL" }], armsByLevel: LEVELS.map(() => [0]) });
  expect(res.status).toBe(201);
});
afterAll(async () => {
  await h?.t.close();
});

type Setup = {
  subjects: { id: string; catalogueId: string | null; name: string; code: string; tag: string; catalogueName: string | null }[];
  links: { subjectId: string; levelId: string; kind: string; department: string | null }[];
  levels: { id: string; name: string }[];
  catalogue: { id: string }[];
  bands: string[];
};
const setup = async (who: Client = owner) => (await (await who.get("/v1/subjects")).json()) as Setup;
const subject = (s: Setup, name: string) => s.subjects.find((x) => x.name === name)!;
const linksOf = (s: Setup, name: string) =>
  s.links
    .filter((l) => l.subjectId === subject(s, name).id)
    .map((l) => [s.levels.find((v) => v.id === l.levelId)!.name, l.kind, l.department])
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])));

describe("subjects", () => {
  it("serves the whole catalogue and the bands the school runs", async () => {
    const s = await setup();
    expect(s.catalogue).toHaveLength(CATALOGUE.length);
    expect(s.bands.sort()).toEqual(["junior", "senior"]);
    expect(s.subjects).toEqual([]);
  });

  it("adds catalogue subjects with their default classes, and the school's own with none", async () => {
    const res = await owner.send("POST", "/v1/subjects", {
      catalogueIds: ["mathematics", "biology", "english-language", "crs", "french"],
      custom: [{ name: "Verbal Reasoning", code: "vr" }],
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ added: 6 });

    const s = await setup();
    expect(subject(s, "Verbal Reasoning")).toMatchObject({ code: "VR", tag: "custom", catalogueId: null });
    expect(subject(s, "Biology")).toMatchObject({ tag: "nerdc2025", catalogueId: "biology" });
    expect(linksOf(s, "Mathematics")).toEqual([
      ["JSS 1", "compulsory", null],
      ["JSS 2", "compulsory", null],
      ["JSS 3", "compulsory", null],
    ]);
    expect(linksOf(s, "Biology")).toEqual([
      ["SS 1", "elective", "science"],
      ["SS 2", "elective", "science"],
      ["SS 3", "elective", "science"],
    ]);
    expect(linksOf(s, "Christian Religious Studies").map((l) => [l[0], l[1], l[2]])).toEqual([
      ["JSS 1", "elective", null],
      ["JSS 2", "elective", null],
      ["JSS 3", "elective", null],
      ["SS 1", "elective", "arts"],
      ["SS 2", "elective", "arts"],
      ["SS 3", "elective", "arts"],
    ]);
    expect(linksOf(s, "Verbal Reasoning")).toEqual([]);

    const progress = (await (await owner.get("/v1/setup")).json()) as { items: { id: string; done: boolean }[] };
    expect(progress.items.find((i) => i.id === "subjects")!.done).toBe(true);
    expect(await (await owner.get("/v1/home")).json()).toMatchObject({ subjects: 6, recent: expect.arrayContaining([expect.objectContaining({ what: "Added 6 subjects" })]) });
  });

  it("skips catalogue subjects already added, and refuses taken codes and names", async () => {
    let res = await owner.send("POST", "/v1/subjects", { catalogueIds: ["mathematics", "physics"], custom: [] });
    expect(await res.json()).toEqual({ added: 1 });
    res = await owner.send("POST", "/v1/subjects", { catalogueIds: [], custom: [{ name: "Maths Club", code: "MTH" }] });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { detail: string }).detail).toBe("Another of your subjects already uses the code MTH. Rename it first.");
    res = await owner.send("POST", "/v1/subjects", { catalogueIds: ["no-such-subject"], custom: [] });
    expect(res.status).toBe(422);
    res = await owner.send("POST", "/v1/subjects", { catalogueIds: [], custom: [] });
    expect(res.status).toBe(422);
  });

  it("refuses a catalogue subject whose name a custom subject already has", async () => {
    await owner.send("POST", "/v1/subjects", { catalogueIds: [], custom: [{ name: "Chemistry", code: "CHX" }] });
    const res = await owner.send("POST", "/v1/subjects", { catalogueIds: ["chemistry"], custom: [] });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { detail: string }).detail).toBe("You already have a subject called Chemistry. Rename it first.");
    const s = await setup();
    await owner.send("DELETE", `/v1/subjects/${subject(s, "Chemistry").id}`);
  });

  it("renames a subject but keeps it linked to the catalogue", async () => {
    const s = await setup();
    const english = subject(s, "English Language");
    let res = await owner.send("PATCH", `/v1/subjects/${english.id}`, { name: "Biology", code: "ENL" });
    expect(res.status).toBe(422);
    res = await owner.send("PATCH", `/v1/subjects/${english.id}`, { name: "English", code: "ENG" });
    expect(res.status).toBe(204);
    expect(subject(await setup(), "English")).toMatchObject({ catalogueId: "english-language", catalogueName: "English Language", code: "ENG" });
  });

  it("ticks, changes and unticks a subject for one class", async () => {
    const s = await setup();
    const vr = subject(s, "Verbal Reasoning");
    const jss1 = s.levels.find((l) => l.name === "JSS 1")!;
    expect((await owner.send("PUT", `/v1/subjects/${vr.id}/levels/${jss1.id}`, { kind: "elective" })).status).toBe(204);
    expect(linksOf(await setup(), "Verbal Reasoning")).toEqual([["JSS 1", "elective", null]]);
    expect((await owner.send("PUT", `/v1/subjects/${vr.id}/levels/${jss1.id}`, { kind: "compulsory" })).status).toBe(204);
    expect(linksOf(await setup(), "Verbal Reasoning")).toEqual([["JSS 1", "compulsory", null]]);
    expect((await owner.send("PUT", `/v1/subjects/${vr.id}/levels/${jss1.id}`, { kind: null })).status).toBe(204);
    expect(linksOf(await setup(), "Verbal Reasoning")).toEqual([]);

    // A catalogue subject ticked on a senior class picks up its department
    const physics = subject(s, "Physics");
    const ss1 = s.levels.find((l) => l.name === "SS 1")!;
    await owner.send("PUT", `/v1/subjects/${physics.id}/levels/${ss1.id}`, { kind: null });
    await owner.send("PUT", `/v1/subjects/${physics.id}/levels/${ss1.id}`, { kind: "elective" });
    expect(linksOf(await setup(), "Physics")[0]).toEqual(["SS 1", "elective", "science"]);
  });

  it("moves a subject's senior electives to another department", async () => {
    const s = await setup();
    const french = subject(s, "French");
    expect((await owner.send("PUT", `/v1/subjects/${french.id}/department`, { department: "commercial" })).status).toBe(204);
    const links = linksOf(await setup(), "French");
    expect(links.filter((l) => String(l[0]).startsWith("SS")).every((l) => l[2] === "commercial")).toBe(true);
    expect(links.filter((l) => String(l[0]).startsWith("JSS")).every((l) => l[2] === null)).toBe(true);
  });

  it("removes a subject with its links", async () => {
    const s = await setup();
    const french = subject(s, "French");
    expect((await owner.send("DELETE", `/v1/subjects/${french.id}`)).status).toBe(204);
    const after = await setup();
    expect(after.subjects.some((x) => x.name === "French")).toBe(false);
    expect(after.links.some((l) => l.subjectId === french.id)).toBe(false);
    expect((await owner.send("DELETE", `/v1/subjects/${french.id}`)).status).toBe(404);
  });

  it("keeps each school's subjects to itself", async () => {
    const s = await setup();
    expect((await setup(other)).subjects).toEqual([]);
    expect((await other.send("PATCH", `/v1/subjects/${s.subjects[0]!.id}`, { name: "X", code: "X" })).status).toBe(404);
    expect((await other.send("DELETE", `/v1/subjects/${s.subjects[0]!.id}`)).status).toBe(404);
    expect((await browser(h, schoolHost("iroko")).get("/v1/subjects")).status).toBe(401);
  });
});
