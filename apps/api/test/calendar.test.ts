import { academicSessions, asc, terms, withSchool } from "@brillianda/db";
import { defaultTerms } from "@brillianda/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { browser, schoolHost, signUpAndLand, type Client } from "./flows.js";
import { addMember, createHarness, signIn, type Harness } from "./helpers.js";

let h: Harness;
let owner: Client;
let cedarId: string;
let elmId: string;
let elm: Client;

beforeAll(async () => {
  h = await createHarness();
  ({ school: owner, schoolId: cedarId } = await signUpAndLand(h, { schoolName: "Cedar School", subdomain: "cedar", email: "owner@cedar.test", password: "cedar-owner-pw", fullName: "Kemi Adeyemi" }));
  ({ school: elm, schoolId: elmId } = await signUpAndLand(h, { schoolName: "Elm School", subdomain: "elm", email: "owner@elm.test", password: "elm-owner-pw" }));
});
afterAll(async () => {
  await h?.t.close();
});

const put = (who: Client, path: string, body: unknown) => who.send("PUT", path, body);

type Session = { startYear: number; name: string; terms: { name: string; startsOn: string; endsOn: string }[]; confirmed: boolean };
type Progress = { items: { id: string; done: boolean }[]; hidden: boolean };
const done = (p: Progress, id: string) => p.items.find((i) => i.id === id)!.done;

describe("calendar", () => {
  it("starts with signup's suggested session, unconfirmed", async () => {
    const res = await owner.get("/v1/session");
    expect(res.status).toBe(200);
    const s = (await res.json()) as Session;
    expect(s.confirmed).toBe(false);
    expect(s.name).toBe(`${s.startYear}/${s.startYear + 1}`);
    expect(s.terms).toEqual(defaultTerms(s.startYear));

    const p = (await (await owner.get("/v1/setup")).json()) as Progress;
    expect(p.items.map((i) => i.id)).toEqual(["branding", "calendar", "classes", "arms", "subjects", "students", "admins"]);
    expect(p.items.every((i) => !i.done)).toBe(true);
    expect(p.hidden).toBe(false);
  });

  it("checks the terms with the frontend's rules, pointing at each field", async () => {
    const res = await put(owner, "/v1/session", {
      startYear: 2026,
      terms: [
        { name: "First Term", startsOn: "2026-09-14", endsOn: "2026-12-18" },
        { name: "first term", startsOn: "2026-12-01", endsOn: "2026-11-01" },
      ],
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { code: string; errors: { pointer: string; detail: string }[] };
    expect(body.code).toBe("validation_failed");
    expect(body.errors.map((e) => e.pointer).sort()).toEqual(["#/terms/1/endsOn", "#/terms/1/name", "#/terms/1/startsOn"]);
    expect(body.errors.find((e) => e.pointer === "#/terms/1/startsOn")!.detail).toBe("Starts after First Term ends");

    expect((await put(owner, "/v1/session", { startYear: 2026, terms: defaultTerms(2026).slice(0, 1) })).status).toBe(422);
  });

  it("saves two terms, then three again, keeping one session; records each change", async () => {
    const two = defaultTerms(2026, 2, "british");
    let res = await put(owner, "/v1/session", { startYear: 2026, terms: two });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ startYear: 2026, name: "2026/2027", terms: two, confirmed: true });
    expect(await (await owner.get("/v1/session")).json()).toMatchObject({ terms: two, confirmed: true });

    const three = defaultTerms(2026).map((t, i) => (i === 2 ? { ...t, name: "Summer Term" } : t));
    res = await put(owner, "/v1/session", { startYear: 2026, terms: three });
    expect(res.status).toBe(200);

    const rows = await withSchool(h.db, cedarId, async (tx) => ({
      sessions: await tx.select().from(academicSessions),
      terms: await tx.select().from(terms).orderBy(asc(terms.position)),
    }));
    expect(rows.sessions).toHaveLength(1);
    expect(rows.sessions[0]).toMatchObject({ startYear: 2026, startsOn: three[0]!.startsOn, endsOn: three[2]!.endsOn, isCurrent: true });
    expect(rows.sessions[0]!.confirmedAt).not.toBeNull();
    expect(rows.terms.map((t) => t.name)).toEqual(["First Term", "Second Term", "Summer Term"]);

    const p = (await (await owner.get("/v1/setup")).json()) as Progress;
    expect(done(p, "calendar")).toBe(true);

    const home = (await (await owner.get("/v1/home")).json()) as { admins: number; recent: { who: string; what: string; at: string }[] };
    expect(home.admins).toBe(1);
    expect(home.recent.map((r) => r.what)).toEqual(["Changed the 2026/2027 calendar", "Set the 2026/2027 calendar", "Created the school"]);
    expect(home.recent[0]!.who).toBe("Kemi Adeyemi");
    expect(home.recent[0]!.at).toMatch(/Z$/);
  });

  it("moves the session to another year", async () => {
    const res = await put(owner, "/v1/session", { startYear: 2027, terms: defaultTerms(2027) });
    expect(res.status).toBe(200);
    expect(await (await owner.get("/v1/session")).json()).toMatchObject({ startYear: 2027, name: "2027/2028" });
  });

  it("admins can set it too; strangers can't read it", async () => {
    const admin = await addMember(h, cedarId, "tayo@cedar.test", "admin");
    const asAdmin = browser(h, schoolHost("cedar"), new Map([["bd_session", await signIn(h, cedarId, admin.id)]]));
    expect((await put(asAdmin, "/v1/session", { startYear: 2027, terms: defaultTerms(2027, 2) })).status).toBe(200);
    expect((await browser(h, schoolHost("cedar")).get("/v1/session")).status).toBe(401);

    const p = (await (await owner.get("/v1/setup")).json()) as Progress;
    expect(done(p, "admins")).toBe(true);
    expect(((await (await owner.get("/v1/home")).json()) as { admins: number }).admins).toBe(2);
  });

  it("keeps each school's calendar to itself", async () => {
    const s = (await (await elm.get("/v1/session")).json()) as Session;
    expect(s.confirmed).toBe(false);
    const home = (await (await elm.get("/v1/home")).json()) as { recent: { what: string }[] };
    expect(home.recent.map((r) => r.what)).toEqual(["Created the school"]);
    const elmTerms = await withSchool(h.db, elmId, (tx) => tx.select().from(terms));
    expect(elmTerms).toHaveLength(3);
  });

  it("hides and shows the checklist", async () => {
    expect((await put(owner, "/v1/setup/hidden", { hidden: true })).status).toBe(204);
    expect(((await (await owner.get("/v1/setup")).json()) as Progress).hidden).toBe(true);
    expect(((await (await elm.get("/v1/setup")).json()) as Progress).hidden).toBe(false);
    expect((await put(owner, "/v1/setup/hidden", { hidden: false })).status).toBe(204);
    expect(((await (await owner.get("/v1/setup")).json()) as Progress).hidden).toBe(false);
  });
});
