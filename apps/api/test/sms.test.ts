/**
 * The Termii adapter, against a fake fetch (no network, no real key), and the SMS settings.
 */
import { describe, expect, it } from "vitest";
import { loadEnv } from "../src/env.js";
import { silentLogger } from "../src/lib/logger.js";
import { SmsDeliveryError, TermiiSms } from "../src/lib/sms.js";

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
const opts = { apiKey: "tl_test", senderId: "Brillianda", baseUrl: "https://v3.api.termii.com/", channel: "dnd" as const };

describe("TermiiSms", () => {
  it("posts to the account's base URL, the number without +, plain text when it can", async () => {
    const f = fakeFetch(json(200, { code: "ok", message_id: "9122821270554876574", message_id_str: "9122821270554876574", message: "Successfully Sent", balance: 9, user: "Brillianda" }));
    expect(await new TermiiSms(opts, silentLogger, f.fn).send({ to: "+2348030000001", text: "Happy 12th birthday, Ada!", tag: "birthday" })).toEqual({ ref: "9122821270554876574" });
    expect(f.calls[0]!.url).toBe("https://v3.api.termii.com/api/sms/send");
    expect(JSON.parse(f.calls[0]!.init.body as string)).toEqual({ api_key: "tl_test", to: "2348030000001", from: "Brillianda", sms: "Happy 12th birthday, Ada!", type: "plain", channel: "dnd" });
  });

  it("sends Unicode for letters like ọ and ẹ", async () => {
    const f = fakeFetch(json(200, { code: "ok", message_id: 1 }));
    await new TermiiSms(opts, silentLogger, f.fn).send({ to: "+2348030000001", text: "Ẹ kú ọjọ́ ìbí, Ada!", tag: "birthday" });
    expect(JSON.parse(f.calls[0]!.init.body as string).type).toBe("unicode");
  });

  it("throws on a refusal or no connection, without the key", async () => {
    const refused = fakeFetch(json(400, { message: "Insufficient balance" }));
    const err = await new TermiiSms(opts, silentLogger, refused.fn).send({ to: "+2348030000001", text: "Hi", tag: "birthday" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SmsDeliveryError);
    expect((err as Error).message).toBe("Termii 400: Insufficient balance");
    const down = fakeFetch(new Error("ECONNRESET"));
    await expect(new TermiiSms(opts, silentLogger, down.fn).send({ to: "+2348030000001", text: "Hi", tag: "birthday" })).rejects.toThrow(/unreachable/);
  });
});

describe("SMS settings", () => {
  const base = { DATABASE_URL: "postgres://x@y/z", ROOT_DOMAIN: "brillianda.com", AUTH_SECRET: "a".repeat(44), PROXY_SHARED_SECRET: "b".repeat(20) };
  it("Termii needs its key, sender ID and base URL", () => {
    expect(() => loadEnv({ ...base, SMS_PROVIDER: "termii" })).toThrow(/TERMII_API_KEY/);
    expect(() => loadEnv({ ...base, SMS_PROVIDER: "termii", TERMII_API_KEY: "k", TERMII_SENDER_ID: "Brillianda", TERMII_BASE_URL: "https://v3.api.termii.com" })).not.toThrow();
    expect(() => loadEnv({ ...base, TERMII_SENDER_ID: "Brillianda School" })).toThrow(/3 to 11/);
  });
});
