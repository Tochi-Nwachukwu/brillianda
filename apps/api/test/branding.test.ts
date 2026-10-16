import { trialRequests } from "@brillianda/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { imageInfo } from "../src/lib/image.js";
import { APEX, browser, schoolHost, signUpAndLand, type Client } from "./flows.js";
import { addMember, createHarness, signIn, type Harness } from "./helpers.js";

let h: Harness;
let owner: Client;
let admin: Client;

beforeAll(async () => {
  h = await createHarness();
  const { school, schoolId } = await signUpAndLand(h, { schoolName: "Mahogany School", subdomain: "mahogany", email: "owner@mahogany.test", password: "mahogany-owner-pw" });
  owner = school;
  const a = await addMember(h, schoolId, "tola@mahogany.test", "admin");
  admin = browser(h, schoolHost("mahogany"), new Map([["bd_session", await signIn(h, schoolId, a.id)]]));
});
afterAll(async () => {
  await h?.t.close();
});

/** A PNG header with the given size: enough for the API to read what it is. */
function png(width: number, height: number, extra = 0): Uint8Array {
  const b = new Uint8Array(33 + extra);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const v = new DataView(b.buffer);
  v.setUint32(16, width);
  v.setUint32(20, height);
  return b;
}

async function upload(who: Client, bytes: Uint8Array, type = "image/png") {
  const form = new FormData();
  form.set("logo", new File([bytes], "logo.png", { type }));
  const headers: Record<string, string> = { host: schoolHost("mahogany"), origin: `https://${schoolHost("mahogany")}` };
  if (who.cookies.size) headers.cookie = [...who.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  return h.app.request("/v1/school/logo", { method: "PUT", headers, body: form });
}

describe("reading images", () => {
  it("knows PNG, JPEG and WebP by their bytes, and nothing else", () => {
    expect(imageInfo(png(300, 120))).toEqual({ type: "image/png", width: 300, height: 120 });
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 17, 8, 0, 200, 1, 44, 3]);
    expect(imageInfo(jpeg)).toEqual({ type: "image/jpeg", width: 300, height: 200 });
    const webp = new Uint8Array(30);
    webp.set([...new TextEncoder().encode("RIFF"), 0, 0, 0, 0, ...new TextEncoder().encode("WEBPVP8X")]);
    webp.set([255, 1, 0, 99, 0, 0], 24);
    expect(imageInfo(webp)).toEqual({ type: "image/webp", width: 512, height: 100 });
    expect(imageInfo(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'))).toBeNull();
  });
});

describe("branding", () => {
  it("lets the owner change the name and colour, normalising the colour", async () => {
    const res = await owner.send("PATCH", "/v1/school/branding", { name: "Mahogany International School", brandColor: "1e6b45" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ name: "Mahogany International School", brandColor: "#1E6B45", logoUrl: null });
    expect(await (await owner.get("/v1/school")).json()).toMatchObject({ name: "Mahogany International School", brandColor: "#1E6B45" });
    const progress = (await (await owner.get("/v1/setup")).json()) as { items: { id: string; done: boolean }[] };
    expect(progress.items.find((i) => i.id === "branding")!.done).toBe(true);
    const home = (await (await owner.get("/v1/home")).json()) as { recent: { what: string }[] };
    expect(home.recent[0]!.what).toBe("Changed the school’s name to Mahogany International School and colour to #1E6B45");
  });

  it("is owner only, and checks the colour", async () => {
    expect((await admin.send("PATCH", "/v1/school/branding", { name: "Hijack", brandColor: "#000000" })).status).toBe(403);
    expect((await upload(admin, png(10, 10))).status).toBe(403);
    const res = await owner.send("PATCH", "/v1/school/branding", { name: "Mahogany", brandColor: "green" });
    expect(res.status).toBe(422);
  });

  it("uploads a logo, serves it publicly with a versioned URL, and replaces it", async () => {
    let res = await upload(owner, png(400, 200));
    expect(res.status).toBe(200);
    const { logoUrl } = (await res.json()) as { logoUrl: string };
    expect(logoUrl).toMatch(/^\/api\/v1\/school\/logo\?v=[0-9a-f]{16}$/);
    expect(((await (await owner.get("/v1/school")).json()) as { logoUrl: string }).logoUrl).toBe(logoUrl);

    const visitor = browser(h, schoolHost("mahogany"));
    const image = await visitor.get(logoUrl.replace("/api", ""));
    expect(image.status).toBe(200);
    expect(image.headers.get("content-type")).toBe("image/png");
    expect(image.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(new Uint8Array(await image.arrayBuffer())).toEqual(png(400, 200));
    const unversioned = await visitor.get("/v1/school/logo?v=");
    expect(unversioned.headers.get("cache-control")).toBe("public, max-age=300");
    const etag = image.headers.get("etag")!;
    const again = await h.app.request("/v1/school/logo", { headers: { host: schoolHost("mahogany"), "if-none-match": etag } });
    expect(again.status).toBe(304);

    res = await upload(owner, png(512, 512));
    const next = ((await res.json()) as { logoUrl: string }).logoUrl;
    expect(next).not.toBe(logoUrl);
    const changes = (await (await owner.get("/v1/changes")).json()) as { entries: { what: string }[] };
    expect(changes.entries.slice(0, 2).map((e) => e.what)).toEqual(["Replaced the logo", "Uploaded a logo"]);
  });

  it("refuses SVG, oversized and too-large images", async () => {
    let res = await upload(owner, new TextEncoder().encode("<svg></svg>"), "image/svg+xml");
    expect(res.status).toBe(422);
    expect(((await res.json()) as { detail: string }).detail).toMatch(/SVG logos aren’t accepted/);
    res = await upload(owner, png(1024, 300));
    expect(res.status).toBe(422);
    expect(((await res.json()) as { detail: string }).detail).toBe("A logo can be at most 512 by 512 pixels. This one is 1024 by 300.");
    res = await upload(owner, png(100, 100, 350 * 1024));
    expect(res.status).toBe(413);
    // A JSON body is still refused on every other route
    const json = await owner.send("PATCH", "/v1/school/branding", { name: "x".repeat(300_000), brandColor: "#000" });
    expect(json.status).toBe(413);
  });

  it("removes the logo", async () => {
    const res = await owner.send("DELETE", "/v1/school/logo");
    expect(await res.json()).toMatchObject({ logoUrl: null });
    expect((await browser(h, schoolHost("mahogany")).get("/v1/school/logo")).status).toBe(404);
  });
});

describe("trial requests", () => {
  const form = {
    schoolName: "Lekki Grammar School",
    contactName: "Mrs Bello",
    role: "Proprietor",
    email: "Bello@Lekki.test",
    phone: "0802 345 6789",
    studentCount: "1,250",
    state: "Lagos",
    interests: ["results", "fees"],
    message: "We want to start in January.",
    website: "",
  };

  it("stores a request from the main site", async () => {
    const res = await browser(h, APEX).post("/v1/trial-requests", form);
    expect(res.status).toBe(202);
    const rows = await h.db.select().from(trialRequests);
    expect(rows).toEqual([expect.objectContaining({ schoolName: "Lekki Grammar School", email: "bello@lekki.test", phone: "08023456789", studentCount: 1250, status: "new" })]);
  });

  it("answers a filled honeypot the same way, and stores nothing", async () => {
    const res = await browser(h, APEX).post("/v1/trial-requests", { ...form, schoolName: "Spam School", website: "https://spam.test" });
    expect(res.status).toBe(202);
    expect((await h.db.select().from(trialRequests)).map((r) => r.schoolName)).toEqual(["Lekki Grammar School"]);
  });

  it("checks the frontend's rules, and lives only on the main site", async () => {
    const res = await browser(h, APEX).post("/v1/trial-requests", { ...form, email: "nope", phone: "123", studentCount: "lots" });
    expect(res.status).toBe(422);
    const pointers = ((await res.json()) as { errors: { pointer: string }[] }).errors.map((e) => e.pointer).sort();
    expect(pointers).toEqual(["#/email", "#/phone", "#/studentCount"]);
    expect((await browser(h, schoolHost("mahogany")).post("/v1/trial-requests", form)).status).toBe(404);
  });
});
