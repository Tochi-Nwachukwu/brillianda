import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { browser, schoolHost, signUpAndLand, tokenFrom, waitForMail, type Client } from "./flows.js";
import { createHarness, type Harness } from "./helpers.js";

const TODAY = "2026-10-14";

let h: Harness;
let owner: Client;
let other: Client;
let parent: Client;
const level: Record<string, string> = {};

async function json<T>(res: Response | Promise<Response>, status = 200): Promise<T> {
  const r = await res;
  expect(r.status, await r.clone().text()).toBe(status);
  return (await r.json()) as T;
}
const problem = async (res: Response | Promise<Response>, status: number) => {
  const r = await res;
  expect(r.status).toBe(status);
  return (await r.json()) as { detail: string; errors?: { pointer: string }[] };
};

type Item = { id: string; category: string; name: string; detail: string; quantity: number; price: number | null };
type List = { levelId: string; levelName: string; startYear: number; session: string; items: Item[]; shared: boolean; updated: { by: string; at: number } | null };
type Page = { startYear: number; session: string; sessions: { startYear: number; name: string; label: string }[]; lists: List[] };

const maths = { category: "textbook", name: "New General Mathematics 2", detail: "Macmillan, 5th edition", quantity: 1, price: 4500 };
const notes = { category: "stationery", name: "Exercise books", detail: "", quantity: 12, price: 300 };

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ["Date"], now: new Date(`${TODAY}T09:30:00Z`) });
  h = await createHarness();
  ({ school: owner } = await signUpAndLand(h, { schoolName: "Iroko Hall", subdomain: "irokohall", email: "owner@irokohall.test", password: "irokohall-owner-pw", fullName: "Bisi Iroko" }));
  ({ school: other } = await signUpAndLand(h, { schoolName: "Palm Hall", subdomain: "palmhall", email: "owner@palmhall.test", password: "palmhall-owner-pw" }));
  await json(owner.send("PUT", "/v1/session", { startYear: 2026, terms: [{ name: "First Term", startsOn: "2026-09-14", endsOn: "2026-12-18" }, { name: "Second Term", startsOn: "2027-01-11", endsOn: "2027-07-16" }] }));
  await json(
    owner.send("POST", "/v1/classes/setup", {
      levels: [
        { key: "jss1", name: "JSS 1", short: "JSS1", section: "junior" },
        { key: "jss2", name: "JSS 2", short: "JSS2", section: "junior" },
      ],
      arms: [{ name: "Gold", code: "GOL" }],
      armsByLevel: [[0], [0]],
    }),
    201,
  );
  for (const l of (await json<{ levels: { id: string; name: string }[] }>(owner.get("/v1/classes"))).levels) level[l.name] = l.id;
  const { arms } = await json<{ arms: { id: string; label: string }[] }>(owner.get("/v1/students"));
  await json(owner.send("POST", "/v1/students", { firstName: "Ada", lastName: "Obi", gender: "female", armId: arms.find((a) => a.label === "JSS 1")!.id, guardianName: "Ngozi Obi", guardianPhone: "08030000001", guardianEmail: "ngozi@obi.test" }), 201);
  const { guardians } = await json<{ guardians: { id: string }[] }>(owner.get("/v1/parents"));
  expect((await owner.post(`/v1/guardians/${guardians[0]!.id}/invite`)).status).toBe(201);
  const token = tokenFrom((await waitForMail(h, "ngozi@obi.test", "invitation")).text)!;
  parent = browser(h, schoolHost("irokohall"));
  await json(parent.post("/v1/invitations/accept", { token, password: "parent-password" }));
});
afterAll(async () => {
  vi.useRealTimers();
  await h?.t.close();
});

describe("book lists", () => {
  it("open on next session, with every class level and nothing saved yet", async () => {
    const page = await json<Page>(owner.get("/v1/book-lists"));
    expect(page).toMatchObject({
      startYear: 2027,
      session: "2027/2028",
      sessions: [
        { startYear: 2027, name: "2027/2028", label: "Next session" },
        { startYear: 2026, name: "2026/2027", label: "This session" },
      ],
    });
    expect(page.lists.map((l) => [l.levelName, l.items, l.shared, l.updated])).toEqual([
      ["JSS 1", [], false, null],
      ["JSS 2", [], false, null],
    ]);
    expect((await json<Page>(owner.get("/v1/book-lists?session=2026"))).startYear).toBe(2026);
    expect((await parent.get("/v1/book-lists")).status).toBe(403);
  });

  it("checks each item and the list's length", async () => {
    const url = `/v1/book-lists/2027/${level["JSS 2"]}`;
    expect((await problem(owner.send("PUT", url, { items: [maths, { ...notes, name: "B" }] }), 422)).errors![0]!.pointer).toBe("#/items/1/name");
    expect((await problem(owner.send("PUT", url, { items: [{ ...maths, quantity: 0 }] }), 422)).errors![0]!.pointer).toBe("#/items/0/quantity");
    expect((await problem(owner.send("PUT", url, { items: [{ ...maths, price: 12.5 }] }), 422)).errors![0]!.pointer).toBe("#/items/0/price");
    expect((await problem(owner.send("PUT", url, { items: Array.from({ length: 81 }, () => notes) }), 422)).errors![0]!.pointer).toBe("#/items");
  });

  it("replaces a list, keeping the ids it's given", async () => {
    const url = `/v1/book-lists/2027/${level["JSS 2"]}`;
    expect((await owner.send("PUT", url, { items: [maths, { ...notes, price: "300", quantity: "12" }] })).status).toBe(204);
    const [, jss2] = (await json<Page>(owner.get("/v1/book-lists"))).lists;
    expect(jss2!.items.map(({ id: _, ...i }) => i)).toEqual([maths, notes]);
    expect(jss2!.updated).toMatchObject({ by: "Bisi Iroko" });
    const keep = jss2!.items[0]!.id;
    expect((await owner.send("PUT", url, { items: [{ ...jss2!.items[0], price: null }] })).status).toBe(204);
    const again = (await json<Page>(owner.get("/v1/book-lists"))).lists[1]!;
    expect(again.items).toEqual([{ ...maths, id: keep, price: null }]);
    expect((await json<{ entries: { what: string }[] }>(owner.get("/v1/changes"))).entries[0]!.what).toBe("Updated the JSS 2 book list for 2027/2028 (1 item)");
  });

  it("is for this session or the next, and this school's class levels", async () => {
    expect((await problem(owner.send("PUT", `/v1/book-lists/2025/${level["JSS 1"]}`, { items: [maths] }), 409)).detail).toBe("Lists are for this session or the next.");
    expect((await problem(other.send("PUT", `/v1/book-lists/2027/${level["JSS 1"]}`, { items: [maths] }), 404)).detail).toBe("That class isn’t here any more.");
    expect((await other.send("PUT", `/v1/book-lists/2027/${level["JSS 2"]}/shared`, { shared: true })).status).toBe(404);
  });

  it("can't share an empty list; sharing goes in the change history", async () => {
    expect((await problem(owner.send("PUT", `/v1/book-lists/2027/${level["JSS 1"]}/shared`, { shared: true }), 409)).detail).toBe("Add something to the list before sharing it.");
    expect((await owner.send("PUT", `/v1/book-lists/2027/${level["JSS 2"]}/shared`, { shared: true })).status).toBe(204);
    expect((await json<Page>(owner.get("/v1/book-lists"))).lists[1]!.shared).toBe(true);
    expect((await json<{ entries: { what: string }[] }>(owner.get("/v1/changes"))).entries[0]!.what).toBe("Shared the JSS 2 book list for 2027/2028");
  });

  it("shows parents the next class's list for next session, then this session's", async () => {
    await owner.send("PUT", `/v1/book-lists/2026/${level["JSS 1"]}`, { items: [notes] });
    const home = async () => (await json<{ children: { bookLists: { label: string; list: List }[] }[] }>(parent.get("/v1/me/children"))).children[0]!.bookLists;
    // This session's JSS 1 list isn't shared yet.
    expect((await home()).map((b) => b.label)).toEqual(["For next session: JSS 2, 2027/2028"]);
    expect((await owner.send("PUT", `/v1/book-lists/2026/${level["JSS 1"]}/shared`, { shared: true })).status).toBe(204);
    const lists = await home();
    expect(lists.map((b) => b.label)).toEqual(["For next session: JSS 2, 2027/2028", "This session: JSS 1, 2026/2027"]);
    expect(lists[1]!.list.items.map((i) => i.name)).toEqual(["Exercise books"]);
    // Emptying a shared list stops sharing it.
    await owner.send("PUT", `/v1/book-lists/2026/${level["JSS 1"]}`, { items: [] });
    expect((await home()).map((b) => b.label)).toEqual(["For next session: JSS 2, 2027/2028"]);
    expect((await json<Page>(owner.get("/v1/book-lists?session=2026"))).lists[0]!.shared).toBe(false);
  });
});
