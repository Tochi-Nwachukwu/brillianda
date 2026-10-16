import { auditLog, classArms, eq, withSchool } from "@brillianda/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { browser, schoolHost, signUpAndLand, type Client } from "./flows.js";
import { createHarness, type Harness } from "./helpers.js";

let h: Harness;
let owner: Client;
let birchId: string;
let palm: Client;

beforeAll(async () => {
  h = await createHarness();
  ({ school: owner, schoolId: birchId } = await signUpAndLand(h, { schoolName: "Birch College", subdomain: "birch", email: "owner@birch.test", password: "birch-owner-pw" }));
  ({ school: palm } = await signUpAndLand(h, { schoolName: "Palm College", subdomain: "palm", email: "owner@palm.test", password: "palm-owner-pw" }));
});
afterAll(async () => {
  await h?.t.close();
});

type Structure = {
  levels: { id: string; key: string | null; name: string; short: string; section: string; position: number; archived: boolean }[];
  armNames: { id: string; name: string; code: string }[];
  arms: { id: string; levelId: string; armNameId: string; department: string | null; archived: boolean; studentCount: number }[];
  levelsOffered: string[];
};

const JSS_TO_SS: { key: string; name: string; short: string; section: string }[] = [
  ...[1, 2, 3].map((n) => ({ key: `jss${n}`, name: `JSS ${n}`, short: `JSS${n}`, section: "junior" })),
  ...[1, 2, 3].map((n) => ({ key: `ss${n}`, name: `SS ${n}`, short: `SS${n}`, section: "senior" })),
];
const FLOWERS = [
  { name: "Anthurium", code: "ANT" },
  { name: "Begonia", code: "BEG" },
  { name: "Calla Lily", code: "CAL" },
];
const setup = { levels: JSS_TO_SS, arms: FLOWERS, armsByLevel: JSS_TO_SS.map(() => [0, 1, 2]) };

const send = (who: Client, method: string, path: string, body?: unknown) => who.send(method, path, body);
const structure = async (who: Client = owner) => (await (await who.get("/v1/classes")).json()) as Structure;
const level = (s: Structure, name: string) => s.levels.find((l) => l.name === name)!;
const armName = (s: Structure, name: string) => s.armNames.find((a) => a.name === name)!;
const armsOf = (s: Structure, levelName: string) =>
  s.arms.filter((a) => a.levelId === level(s, levelName).id).map((a) => s.armNames.find((n) => n.id === a.armNameId)!.name).sort();
const latest = async () => {
  const rows = await withSchool(h.db, birchId, (tx) => tx.select({ summary: auditLog.summary, at: auditLog.createdAt }).from(auditLog));
  return rows.filter((r) => r.summary).sort((a, b) => +b.at - +a.at)[0]!.summary;
};

describe("quick setup (the plan's Phase 2 gate)", () => {
  it("starts empty, with the levels ticked at signup", async () => {
    const s = await structure();
    expect(s).toEqual({ levels: [], armNames: [], arms: [], levelsOffered: ["secondary"] });
  });

  it("checks the setup with the frontend's rules", async () => {
    const res = await send(owner, "POST", "/v1/classes/setup", {
      levels: [JSS_TO_SS[0], { ...JSS_TO_SS[1], name: "jss 1" }],
      arms: [FLOWERS[0], { name: "anthurium", code: "ant" }],
      armsByLevel: [[0], [5]],
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { errors: { pointer: string }[] };
    expect(body.errors.map((e) => e.pointer).sort()).toEqual(["#/arms/1/code", "#/arms/1/name", "#/armsByLevel/1", "#/levels/1/name"]);
  });

  it("JSS 1 to SS 3 with three flower-named arms makes 18 classes", async () => {
    const res = await send(owner, "POST", "/v1/classes/setup", setup);
    expect(res.status).toBe(201);
    const s = (await res.json()) as Structure;
    expect(s.levels.map((l) => [l.position, l.name, l.short, l.section, l.key])).toEqual(JSS_TO_SS.map((l, i) => [i, l.name, l.short, l.section, l.key]));
    expect(s.armNames.map((a) => [a.name, a.code])).toEqual(FLOWERS.map((a) => [a.name, a.code]));
    expect(s.arms).toHaveLength(18);
    expect(s.arms.every((a) => a.studentCount === 0 && !a.archived && a.department === null)).toBe(true);
    expect(await latest()).toBe("Set up 18 classes, JSS 1 to SS 3");

    const progress = (await (await owner.get("/v1/setup")).json()) as { items: { id: string; done: boolean }[] };
    expect(progress.items.filter((i) => i.done).map((i) => i.id)).toEqual(["classes", "arms"]);
    expect(await (await owner.get("/v1/home")).json()).toMatchObject({ classes: 18, arms: 3 });
  });

  it("only once", async () => {
    const res = await send(owner, "POST", "/v1/classes/setup", setup);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { detail: string }).detail).toBe("Your classes are already set up. Change them here instead.");
  });

  it("keeps each school's classes to itself", async () => {
    expect(await structure(palm)).toMatchObject({ levels: [], arms: [] });
    const birch = await structure();
    // Palm can't touch Birch's records by id
    expect((await send(palm, "PATCH", `/v1/class-levels/${birch.levels[0]!.id}`, { name: "Hacked" })).status).toBe(404);
    expect((await send(palm, "DELETE", `/v1/arms/${birch.arms[0]!.id}`)).status).toBe(404);
    expect((await send(palm, "PATCH", `/v1/arm-names/${birch.armNames[0]!.id}`, { name: "X", code: "X" })).status).toBe(404);
    expect((await browser(h, schoolHost("birch")).get("/v1/classes")).status).toBe(401);
  });
});

describe("editing classes", () => {
  it("renames a class, refusing a name already used", async () => {
    const s = await structure();
    const jss1 = level(s, "JSS 1");
    let res = await send(owner, "PATCH", `/v1/class-levels/${jss1.id}`, { name: "jss 2", short: "J2" });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { errors: { pointer: string }[] }).errors[0]!.pointer).toBe("#/name");
    res = await send(owner, "PATCH", `/v1/class-levels/${jss1.id}`, { name: "Year 7", short: "Y7" });
    expect(res.status).toBe(204);
    expect(level(await structure(), "Year 7")).toMatchObject({ short: "Y7", key: "jss1" });
    expect(await latest()).toBe("Renamed JSS 1 to Year 7");
  });

  it("adds a class at the end of its section, with the first arm", async () => {
    let res = await send(owner, "POST", "/v1/class-levels", { name: "Pre-JSS", short: "PJ", section: "primary" });
    expect(res.status).toBe(201);
    res = await send(owner, "POST", "/v1/class-levels", { name: "JSS 4", short: "JSS4", section: "junior" });
    expect(res.status).toBe(201);
    const s = await structure();
    expect(s.levels.map((l) => l.name)).toEqual(["Pre-JSS", "Year 7", "JSS 2", "JSS 3", "JSS 4", "SS 1", "SS 2", "SS 3"]);
    expect(s.levels.map((l) => l.position)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(armsOf(s, "JSS 4")).toEqual(["Anthurium"]);
    expect(await latest()).toBe("Added JSS 4 to junior secondary");
  });

  it("archives and brings back a class, and removes an empty one", async () => {
    const s = await structure();
    const jss4 = level(s, "JSS 4");
    expect((await send(owner, "PATCH", `/v1/class-levels/${jss4.id}`, { archived: true })).status).toBe(204);
    expect(level(await structure(), "JSS 4").archived).toBe(true);
    expect(((await (await owner.get("/v1/home")).json()) as { classes: number }).classes).toBe(19); // 18 + Pre-JSS
    expect((await send(owner, "PATCH", `/v1/class-levels/${jss4.id}`, { archived: false })).status).toBe(204);
    expect(await latest()).toBe("Brought back JSS 4");

    expect((await send(owner, "DELETE", `/v1/class-levels/${jss4.id}`)).status).toBe(204);
    expect((await send(owner, "DELETE", `/v1/class-levels/${jss4.id}`)).status).toBe(404);
    expect((await structure()).levels.some((l) => l.name === "JSS 4")).toBe(false);
  });
});

describe("editing arms", () => {
  it("adds an existing arm or a new school-wide one to a single class", async () => {
    const s = await structure();
    const ss1 = level(s, "SS 1");
    let res = await send(owner, "POST", `/v1/class-levels/${ss1.id}/arms`, { name: "Daisy", code: "dai" });
    expect(res.status).toBe(201);
    res = await send(owner, "POST", `/v1/class-levels/${ss1.id}/arms`, { armNameId: armName(s, "Begonia").id });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { detail: string }).detail).toBe("SS 1 already has Begonia.");
    res = await send(owner, "POST", `/v1/class-levels/${ss1.id}/arms`, { name: "daisy", code: "DZ" });
    expect(res.status).toBe(422);

    const after = await structure();
    expect(armsOf(after, "SS 1")).toEqual(["Anthurium", "Begonia", "Calla Lily", "Daisy"]);
    expect(armName(after, "Daisy").code).toBe("DAI");
    expect(await latest()).toBe("Added SS 1 Daisy");
  });

  it("renames an arm in every class, refusing a code already used", async () => {
    const s = await structure();
    const daisy = armName(s, "Daisy");
    expect((await send(owner, "PATCH", `/v1/arm-names/${daisy.id}`, { name: "Dahlia", code: "ant" })).status).toBe(422);
    expect((await send(owner, "PATCH", `/v1/arm-names/${daisy.id}`, { name: "Dahlia", code: "dah" })).status).toBe(204);
    expect(armsOf(await structure(), "SS 1")).toContain("Dahlia");
    expect(await latest()).toBe("Renamed the Daisy arm to Dahlia in every class");
  });

  it("sets departments on senior classes only, and archives one class's arm", async () => {
    const s = await structure();
    const ss1Ant = s.arms.find((a) => a.levelId === level(s, "SS 1").id && a.armNameId === armName(s, "Anthurium").id)!;
    const jss2Ant = s.arms.find((a) => a.levelId === level(s, "JSS 2").id && a.armNameId === armName(s, "Anthurium").id)!;
    expect((await send(owner, "PATCH", `/v1/arms/${ss1Ant.id}`, { department: "science" })).status).toBe(204);
    expect(await latest()).toBe("Set SS 1 Anthurium to Science");
    const res = await send(owner, "PATCH", `/v1/arms/${jss2Ant.id}`, { department: "arts" });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { detail: string }).detail).toBe("Departments are for senior classes.");

    expect((await send(owner, "PATCH", `/v1/arms/${jss2Ant.id}`, { archived: true })).status).toBe(204);
    const after = await structure();
    expect(after.arms.find((a) => a.id === ss1Ant.id)!.department).toBe("science");
    expect(after.arms.find((a) => a.id === jss2Ant.id)!.archived).toBe(true);
    expect(await latest()).toBe("Archived JSS 2 Anthurium");
  });

  it("removes one class's arm, but never its last", async () => {
    const s = await structure();
    const preJss = s.arms.find((a) => a.levelId === level(s, "Pre-JSS").id)!;
    const res = await send(owner, "DELETE", `/v1/arms/${preJss.id}`);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { detail: string }).detail).toBe("Every class needs at least one arm. Remove Pre-JSS instead.");

    const ss1Dahlia = s.arms.find((a) => a.levelId === level(s, "SS 1").id && a.armNameId === armName(s, "Dahlia").id)!;
    expect((await send(owner, "DELETE", `/v1/arms/${ss1Dahlia.id}`)).status).toBe(204);
    expect(armsOf(await structure(), "SS 1")).toEqual(["Anthurium", "Begonia", "Calla Lily"]);
  });
});

describe("Edit arms: every arm at once", () => {
  const layoutFrom = (s: Structure, names: { key: string; name: string; code: string }[], armsFor: (levelName: string) => string[]) => ({
    names,
    levels: s.levels.filter((l) => !l.archived).map((l) => ({ levelId: l.id, arms: armsFor(l.name) })),
  });

  it("refuses a stale screen without changing anything", async () => {
    const s = await structure();
    const res = await send(owner, "PUT", "/v1/arms/layout", {
      names: s.armNames.map((a) => ({ key: a.id, name: a.name, code: a.code })),
      levels: s.levels.slice(1).map((l) => ({ levelId: l.id, arms: [s.armNames[0]!.id] })),
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { detail: string }).detail).toMatch(/classes changed while you were editing/);
    expect(await structure()).toEqual(s);
  });

  it("renames, swaps codes, adds an arm everywhere, drops one, and brings back an archived arm, in one save", async () => {
    const s = await structure();
    const ant = armName(s, "Anthurium");
    const beg = armName(s, "Begonia");
    const cal = armName(s, "Calla Lily");
    const dah = armName(s, "Dahlia");
    const names = [
      { key: ant.id, name: "Anthurium", code: "BEG" }, // swap codes with Begonia
      { key: beg.id, name: "Bluebell", code: "ANT" },
      { key: cal.id, name: "Calla Lily", code: "CAL" },
      { key: "new-1", name: "Dahlia", code: "DAH" }, // reuses the name of the arm being dropped
    ];
    const res = await send(
      owner,
      "PUT",
      "/v1/arms/layout",
      layoutFrom(s, names, (l) => (l === "Pre-JSS" ? [ant.id] : [ant.id, beg.id, cal.id, "new-1"])),
    );
    expect(res.status).toBe(200);
    const { summary } = (await res.json()) as { summary: string };
    expect(summary).toBe("new arm Dahlia; renamed Begonia to Bluebell; deleted Dahlia; 7 classes added");
    expect(await latest()).toBe(`Edited the arms: ${summary}`);

    const after = await structure();
    expect(after.armNames.map((a) => [a.name, a.code])).toEqual([
      ["Anthurium", "BEG"],
      ["Bluebell", "ANT"],
      ["Calla Lily", "CAL"],
      ["Dahlia", "DAH"],
    ]);
    expect(after.armNames.find((a) => a.name === "Dahlia")!.id).not.toBe(dah.id);
    expect(armsOf(after, "JSS 2")).toEqual(["Anthurium", "Bluebell", "Calla Lily", "Dahlia"]);
    expect(after.arms.find((a) => a.levelId === level(after, "JSS 2").id && a.armNameId === ant.id)!.archived).toBe(false);
    expect(armsOf(after, "Pre-JSS")).toEqual(["Anthurium"]);
    // SS 1 Anthurium kept its department through the save
    expect(after.arms.find((a) => a.levelId === level(after, "SS 1").id && a.armNameId === ant.id)!.department).toBe("science");
  });

  it("takes arms out of classes, and reports no changes when nothing changed", async () => {
    const s = await structure();
    const names = s.armNames.map((a) => ({ key: a.id, name: a.name, code: a.code }));
    const first = s.armNames[0]!.id;
    let res = await send(owner, "PUT", "/v1/arms/layout", layoutFrom(s, names, (l) => (l === "SS 3" ? [first] : s.arms.filter((a) => a.levelId === level(s, l).id).map((a) => a.armNameId))));
    expect(((await res.json()) as { summary: string }).summary).toBe("3 classes removed");
    const after = await structure();
    expect(armsOf(after, "SS 3")).toEqual(["Anthurium"]);

    res = await send(owner, "PUT", "/v1/arms/layout", layoutFrom(after, after.armNames.map((a) => ({ key: a.id, name: a.name, code: a.code })), (l) => after.arms.filter((a) => a.levelId === level(after, l).id).map((a) => a.armNameId)));
    expect(((await res.json()) as { summary: string }).summary).toBe("no changes");
  });

  it("checks the layout's own rules", async () => {
    const s = await structure();
    const res = await send(owner, "PUT", "/v1/arms/layout", {
      names: [
        { key: s.armNames[0]!.id, name: "Same", code: "S1" },
        { key: s.armNames[1]!.id, name: "same", code: "s1" },
      ],
      levels: s.levels.map((l) => ({ levelId: l.id, arms: [] })),
    });
    expect(res.status).toBe(422);
    const pointers = ((await res.json()) as { errors: { pointer: string }[] }).errors.map((e) => e.pointer);
    expect(pointers).toEqual(expect.arrayContaining(["#/names/1/name", "#/names/1/code", "#/levels/0/arms"]));
  });

  it("counts classes in the database the same way Home does", async () => {
    const rows = await withSchool(h.db, birchId, (tx) => tx.select().from(classArms).where(eq(classArms.schoolId, birchId)));
    const home = (await (await owner.get("/v1/home")).json()) as { classes: number };
    expect(home.classes).toBe(rows.filter((r) => !r.archivedAt).length);
  });
});
