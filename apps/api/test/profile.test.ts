import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { browser, schoolHost, signUpAndLand, tokenFrom, waitForMail, type Client } from "./flows.js";
import { createHarness, type Harness } from "./helpers.js";

let h: Harness;
let owner: Client;
let teacher: Client;

/** A PNG header with the given size: enough for the API to read what it is. */
function png(width: number, height: number, extra = 0): Uint8Array {
  const b = new Uint8Array(33 + extra);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const v = new DataView(b.buffer);
  v.setUint32(16, width);
  v.setUint32(20, height);
  return b;
}
const dataUrl = (bytes: Uint8Array, type = "image/png") => `data:${type};base64,${Buffer.from(bytes).toString("base64")}`;

type Me = { user: { fullName: string }; membership: { role: string }; photo: string | null; phone: string | null };

beforeAll(async () => {
  h = await createHarness();
  ({ school: owner } = await signUpAndLand(h, { schoolName: "Iroko School", subdomain: "iroko", email: "owner@iroko.test", password: "iroko-owner-pw", fullName: "Bisi Iroko" }));
  await owner.post("/v1/invitations", { email: "teach@iroko.test", fullName: "Tunde Teach", role: "teacher" });
  const token = tokenFrom((await waitForMail(h, "teach@iroko.test", "invitation")).text)!;
  teacher = browser(h, schoolHost("iroko"));
  expect((await teacher.post("/v1/invitations/accept", { token, password: "teacher-pw-1" })).status).toBe(200);
});
afterAll(async () => {
  await h?.t.close();
});

describe("my profile", () => {
  it("GET /v1/me shows no photo yet, and the phone on the account", async () => {
    const me = (await (await owner.get("/v1/me")).json()) as Me;
    expect(me).toMatchObject({ photo: null, membership: { role: "owner" } });
    expect(me).toHaveProperty("phone");
  });

  it("saves a name as first and last, for any role", async () => {
    expect((await teacher.send("PATCH", "/v1/me", { fullName: "  Tunde   Adeyemi Teach " })).status).toBe(204);
    expect(((await (await teacher.get("/v1/me")).json()) as Me).user.fullName).toBe("Tunde Adeyemi Teach");
    for (const fullName of ["Tunde", "", `${"A".repeat(61)} Teach`, `Tunde ${"B".repeat(61)}`]) {
      const res = await teacher.send("PATCH", "/v1/me", { fullName });
      expect(res.status, fullName).toBe(422);
      expect(((await res.json()) as { errors: { pointer: string }[] }).errors[0]!.pointer).toBe("#/fullName");
    }
  });

  it("sets, serves and removes a photo, and refuses what isn't a small picture", async () => {
    expect((await owner.send("PUT", "/v1/me/photo", { photo: dataUrl(png(256, 256)) })).status).toBe(204);
    const me = (await (await owner.get("/v1/me")).json()) as Me;
    expect(me.photo).toMatch(/^\/api\/v1\/me\/photo\?v=[0-9a-f]{16}$/);
    const res = await owner.get(me.photo!.replace("/api", ""));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("cache-control")).toBe("private, max-age=31536000, immutable");

    // Only my own: the teacher has none, and another school's session can't read it.
    expect((await teacher.get("/v1/me/photo")).status).toBe(404);
    expect((await browser(h, schoolHost("iroko")).get("/v1/me/photo")).status).toBe(401);

    expect((await owner.send("PUT", "/v1/me/photo", { photo: "data:image/svg+xml;base64,PHN2Zz4=" })).status).toBe(422);
    expect((await owner.send("PUT", "/v1/me/photo", { photo: dataUrl(new Uint8Array([1, 2, 3, 4])) })).status).toBe(422);
    expect((await owner.send("PUT", "/v1/me/photo", { photo: dataUrl(png(2000, 2000)) })).status).toBe(422);
    expect((await owner.send("PUT", "/v1/me/photo", { photo: dataUrl(png(256, 256, 160_000)) })).status).toBe(422);

    expect((await owner.del("/v1/me/photo")).status).toBe(204);
    expect(((await (await owner.get("/v1/me")).json()) as Me).photo).toBeNull();
  });

  it("changes the password with the current one, and signs out other devices", async () => {
    const other = browser(h, schoolHost("iroko"));
    expect((await other.post("/v1/auth/login", { email: "teach@iroko.test", password: "teacher-pw-1" })).status).toBe(200);

    let res = await teacher.post("/v1/me/password", { current: "wrong-password", password: "teacher-pw-2" });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { errors: { pointer: string }[] }).errors[0]!.pointer).toBe("#/current");
    res = await teacher.post("/v1/me/password", { current: "teacher-pw-1", password: "teacher-pw-1" });
    expect(((await res.json()) as { errors: { pointer: string }[] }).errors[0]!.pointer).toBe("#/password");
    expect((await teacher.post("/v1/me/password", { current: "teacher-pw-1", password: "short" })).status).toBe(422);

    expect((await teacher.post("/v1/me/password", { current: "teacher-pw-1", password: "teacher-pw-2" })).status).toBe(204);
    expect((await teacher.get("/v1/me")).status).toBe(200);
    expect((await other.get("/v1/me")).status).toBe(401);
    const fresh = browser(h, schoolHost("iroko"));
    expect((await fresh.post("/v1/auth/login", { email: "teach@iroko.test", password: "teacher-pw-1" })).status).toBe(401);
    expect((await fresh.post("/v1/auth/login", { email: "teach@iroko.test", password: "teacher-pw-2" })).status).toBe(200);
  });

  it("needs a session", async () => {
    const guest = browser(h, schoolHost("iroko"));
    expect((await guest.send("PATCH", "/v1/me", { fullName: "A B" })).status).toBe(401);
    expect((await guest.post("/v1/me/password", { current: "x", password: "long-enough-1" })).status).toBe(401);
  });
});
