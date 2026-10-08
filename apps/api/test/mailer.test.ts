/**
 * The Resend adapter, against a fake fetch (no network, no real key).
 */
import { describe, expect, it } from "vitest";
import { loadEnv } from "../src/env.js";
import { silentLogger } from "../src/lib/logger.js";
import { MailDeliveryError, ResendMailer, type EmailMessage } from "../src/lib/mailer.js";

const message: EmailMessage = { to: "ada@example.com", subject: "Your code", text: "123456", html: "<p>123456</p>", tag: "signup_code" };

function fakeFetch(...responses: (Response | Error)[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (!next) throw new Error("unexpected extra call");
    if (next instanceof Error) throw next;
    return next;
  };
  return { fn, calls };
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("ResendMailer", () => {
  it("posts the message with the key as a bearer token", async () => {
    const f = fakeFetch(json(200, { id: "email_1" }));
    await new ResendMailer("re_test", "Brillianda <onboarding@resend.dev>", silentLogger, f.fn, 0).send(message);

    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.url).toBe("https://api.resend.com/emails");
    expect((f.calls[0]!.init.headers as Record<string, string>).authorization).toBe("Bearer re_test");
    expect(JSON.parse(f.calls[0]!.init.body as string)).toEqual({
      from: "Brillianda <onboarding@resend.dev>",
      to: ["ada@example.com"],
      subject: "Your code",
      text: "123456",
      html: "<p>123456</p>",
      tags: [{ name: "category", value: "signup_code" }],
    });
  });

  it("retries once on 429 or 5xx, then succeeds", async () => {
    const f = fakeFetch(json(503, { message: "busy" }), json(200, { id: "email_2" }));
    await new ResendMailer("re_test", "x@y.z", silentLogger, f.fn, 0).send(message);
    expect(f.calls).toHaveLength(2);
  });

  it("retries once on a network failure", async () => {
    const f = fakeFetch(new TypeError("fetch failed"), json(200, { id: "email_3" }));
    await new ResendMailer("re_test", "x@y.z", silentLogger, f.fn, 0).send(message);
    expect(f.calls).toHaveLength(2);
  });

  it("does not retry a refusal, and reports Resend's reason without the key", async () => {
    const f = fakeFetch(json(403, { name: "validation_error", message: "You can only send testing emails to your own email address" }));
    const err = await new ResendMailer("re_secret_key", "x@y.z", silentLogger, f.fn, 0).send(message).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MailDeliveryError);
    expect((err as MailDeliveryError).status).toBe(403);
    expect((err as Error).message).toContain("own email address");
    expect((err as Error).message).not.toContain("re_secret_key");
    expect(f.calls).toHaveLength(1);
  });

  it("gives up after the second failure", async () => {
    const f = fakeFetch(json(500, {}), json(500, {}));
    await expect(new ResendMailer("re_test", "x@y.z", silentLogger, f.fn, 0).send(message)).rejects.toBeInstanceOf(MailDeliveryError);
  });

  it("keeps tag values to the characters Resend accepts", async () => {
    const f = fakeFetch(json(200, {}));
    await new ResendMailer("re_test", "x@y.z", silentLogger, f.fn, 0).send({ ...message, tag: "login link!" });
    expect(JSON.parse(f.calls[0]!.init.body as string).tags).toEqual([{ name: "category", value: "login_link_" }]);
  });
});

describe("mail settings", () => {
  const base = { DATABASE_URL: "postgres://x@y/z", ROOT_DOMAIN: "brillianda.com", AUTH_SECRET: "a".repeat(44), PROXY_SHARED_SECRET: "b".repeat(20) };

  it("resend needs a key", () => {
    expect(() => loadEnv({ ...base, MAIL_PROVIDER: "resend" })).toThrow(/RESEND_API_KEY/);
    expect(() => loadEnv({ ...base, MAIL_PROVIDER: "resend", RESEND_API_KEY: "re_x" })).not.toThrow();
  });

  it("staging may use Resend's test sender; production may not", () => {
    const resend = { ...base, MAIL_PROVIDER: "resend", RESEND_API_KEY: "re_x", MAIL_FROM: "Brillianda <onboarding@resend.dev>" };
    expect(() => loadEnv({ ...resend, APP_ENV: "staging", PUBLIC_PROTOCOL: "https" })).not.toThrow();
    expect(() =>
      loadEnv({ ...resend, APP_ENV: "production", NODE_ENV: "production", UPSTASH_REDIS_REST_URL: "https://u.io", TURNSTILE_SECRET_KEY: "t" }),
    ).toThrow(/test sender/);
  });
});
