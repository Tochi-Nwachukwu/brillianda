import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { loadEnv } from "../src/env.js";
import { silentLogger } from "../src/lib/logger.js";
import { MailDeliveryError, OutboxMailer, type Mailer } from "../src/lib/mailer.js";
import { schoolUrl } from "../src/lib/urls.js";
import { APEX, schoolHost } from "./flows.js";
import { createHarness, type Harness } from "./helpers.js";

const KEY = "outbox-key-for-tests-0123456789";
const FRONTEND = "https://brillianda-web.vercel.app";

/** Like Resend's test sender: refuses everyone except the account owner. */
const picky: Mailer = {
  async send(m) {
    if (m.to !== "me@owner.test") throw new MailDeliveryError("Resend 403: You can only send testing emails to your own email address", 403);
  },
};

let h: Harness;
let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  h = await createHarness();
  app = createApp({ ...h.deps, mailer: new OutboxMailer(h.db, picky, silentLogger), config: { ...h.deps.config, outboxKey: KEY, frontendUrl: FRONTEND } });
});
afterAll(async () => {
  await h?.t.close();
});

function client(host: string) {
  const cookies = new Map<string, string>();
  return async (method: string, path: string, body?: unknown, extra: Record<string, string> = {}) => {
    const headers: Record<string, string> = { host, ...extra };
    if (cookies.size) headers.cookie = [...cookies].map(([k, v]) => `${k}=${v}`).join("; ");
    if (method !== "GET") headers.origin = `https://${host}`;
    if (body !== undefined) headers["content-type"] = "application/json";
    const res = await app.request(path, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(";");
      const [k, ...v] = pair!.split("=");
      if (v.join("=")) cookies.set(k!, v.join("="));
    }
    return res;
  };
}

type Outbox = { emails: { to: string; tag: string; code: string | null; links: string[]; delivered: boolean | null }[] };
const outbox = async (query = "", key = KEY) => app.request(`/v1/dev/outbox${query}`, { headers: { host: APEX, "x-brillianda-outbox-key": key } });

describe("staging outbox and links", () => {
  it("lets signup finish even when the provider refuses, and keeps the code readable", async () => {
    const apex = client(APEX);
    expect((await apex("POST", "/v1/signup/school", { name: "Fecheck School", levelsOffered: ["secondary"], state: "Lagos", phone: "08030000001" })).status).toBe(200);
    const res = await apex("POST", "/v1/signup/owner", { fullName: "Tochi Tester", email: "tochi@frontend.test", password: "correct horse battery" });
    expect(res.status).toBe(200);

    const { emails } = (await (await outbox("?to=Tochi@Frontend.test")).json()) as Outbox;
    expect(emails).toHaveLength(1);
    expect(emails[0]).toMatchObject({ to: "tochi@frontend.test", tag: "signup_code", delivered: false });
    expect(emails[0]!.code).toMatch(/^\d{6}$/);

    expect((await apex("POST", "/v1/signup/verify-email", { code: emails[0]!.code })).status).toBe(200);
    const done = await apex("POST", "/v1/signup/complete", { subdomain: "fecheck" });
    expect(done.status).toBe(201);
    const { handoverUrl, school } = (await done.json()) as { handoverUrl: string; school: { url: string } };
    expect(handoverUrl).toMatch(/^https:\/\/brillianda-web\.vercel\.app\/s\/fecheck\/auth\/handover\?token=[A-Za-z0-9_-]{43}$/);
    expect(school.url).toBe(`${FRONTEND}/s/fecheck`);
  });

  it("puts the frontend's page links in emails", async () => {
    const school = client(schoolHost("fecheck"));
    expect((await school("POST", "/v1/auth/login", { email: "tochi@frontend.test", password: "correct horse battery" })).status).toBe(200);
    expect((await school("POST", "/v1/invitations", { email: "me@owner.test" })).status).toBe(201);
    const { emails } = (await (await outbox("?to=me@owner.test")).json()) as Outbox;
    expect(emails[0]).toMatchObject({ tag: "invitation", delivered: true });
    expect(emails[0]!.links).toEqual([expect.stringMatching(/^https:\/\/brillianda-web\.vercel\.app\/s\/fecheck\/invite\?token=/)]);
  });

  it("shows a page a tester can open in a browser: codes big, links clickable, nothing injected", async () => {
    const res = await app.request(`/dev/outbox?key=${KEY}&to=tochi@frontend.test`, { headers: { host: APEX } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^text\/html/);
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
    const html = await res.text();
    expect(html).toMatch(/<p class="code">\d{6}<\/p>/);
    expect(html).toContain('<meta http-equiv="refresh" content="10">');
    expect(html).not.toContain("<script");

    const all = await (await app.request(`/dev/outbox?key=${KEY}`, { headers: { host: APEX } })).text();
    expect(all).toMatch(/href="https:\/\/brillianda-web\.vercel\.app\/s\/fecheck\/invite\?token=[A-Za-z0-9_-]+"/);
    const hostile = await (await app.request(`/dev/outbox?key=${KEY}&to=%22%3E%3Cscript%3Ealert(1)%3C/script%3E`, { headers: { host: APEX } })).text();
    expect(hostile).not.toContain("<script>alert(1)");
    expect((await app.request("/dev/outbox?key=nope", { headers: { host: APEX } })).status).toBe(404);
    expect((await h.app.request(`/dev/outbox?key=${KEY}`, { headers: { host: APEX } })).status).toBe(404);
  });

  it("is invisible without the key, and absent when switched off", async () => {
    expect((await outbox("", "wrong-key-wrong-key-wrong-key-00")).status).toBe(404);
    expect((await app.request("/v1/dev/outbox", { headers: { host: APEX } })).status).toBe(404);
    expect((await h.app.request("/v1/dev/outbox", { headers: { host: APEX, "x-brillianda-outbox-key": KEY } })).status).toBe(404);
    expect(((await (await outbox("?limit=1")).json()) as Outbox).emails).toHaveLength(1);
  });

  it("builds links per setting, and production refuses the staging-only settings", () => {
    const base = h.deps.config;
    expect(schoolUrl({ ...base, frontendUrl: FRONTEND }, "kingsway", "/reset-password?token=x")).toBe(`${FRONTEND}/s/kingsway/reset-password?token=x`);
    expect(schoolUrl(base, "kingsway", "/reset-password?token=x")).toBe("https://kingsway.brillianda.test/reset-password?token=x");
    const env = { DATABASE_URL: "postgres://x@y/z", ROOT_DOMAIN: "brillianda.com", AUTH_SECRET: "a".repeat(44), PROXY_SHARED_SECRET: "b".repeat(20) };
    const prod = { ...env, APP_ENV: "production", NODE_ENV: "production", UPSTASH_REDIS_REST_URL: "https://u.io", TURNSTILE_SECRET_KEY: "t", MAIL_PROVIDER: "resend", RESEND_API_KEY: "re_x" };
    expect(() => loadEnv({ ...prod, MAIL_OUTBOX_KEY: KEY })).toThrow(/staging only/);
    expect(() => loadEnv({ ...prod, FRONTEND_URL: FRONTEND })).toThrow(/staging only/);
    expect(loadEnv({ ...env, APP_ENV: "staging", PUBLIC_PROTOCOL: "https", FRONTEND_URL: `${FRONTEND}/`, MAIL_OUTBOX_KEY: KEY }).FRONTEND_URL).toBe(FRONTEND);
  });
});

describe("the API's own hostnames", () => {
  it("act as the main site, never a school, and other unknown hosts stay unknown", async () => {
    const own = createApp({ ...h.deps, config: { ...h.deps.config, apiHosts: ["api.brillianda.test", "api-x.vercel.app"] } });
    for (const host of ["api.brillianda.test", "API-X.vercel.app"]) {
      const res = await own.request("/v1/signup/subdomain-check?subdomain=newplace", { headers: { host } });
      expect(res.status).toBe(200);
    }
    expect((await own.request("/v1/me", { headers: { host: "api.brillianda.test" } })).status).not.toBe(200);
    const stranger = await own.request("/v1/signup/subdomain-check?subdomain=newplace", { headers: { host: "evil.example.com" } });
    expect(stranger.status).not.toBe(200);
    const before = await h.app.request("/v1/signup/subdomain-check?subdomain=newplace", { headers: { host: "api.brillianda.test" } });
    expect(before.status).not.toBe(200);
  });
});
