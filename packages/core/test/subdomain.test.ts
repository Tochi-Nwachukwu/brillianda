import { describe, expect, it } from "vitest";
import { suggestSubdomains, validateSubdomain } from "../src/subdomain.js";
import { resolveHost } from "../src/host.js";
import { isUuid } from "../src/uuid.js";

describe("validateSubdomain", () => {
  it.each(["surebloom", "sure-bloom", "abc", "a1b2c3", "a".repeat(30), "  SureBloom  "])("accepts %j", (s) => {
    expect(validateSubdomain(s).ok).toBe(true);
  });

  it.each([
    ["ab", "too_short"],
    ["a".repeat(31), "too_long"],
    ["1school", "invalid_characters"],
    ["-school", "invalid_characters"],
    ["school-", "invalid_characters"],
    ["sure--bloom", "invalid_characters"],
    ["sure_bloom", "invalid_characters"],
    ["surebloom.com", "invalid_characters"],
    ["ọlá", "invalid_characters"],
    ["admin", "reserved"],
    ["WAEC", "reserved"],
    ["jamb", "reserved"],
  ])("rejects %j as %s", (s, problem) => {
    const r = validateSubdomain(s);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problem).toBe(problem);
  });
});

describe("suggestSubdomains", () => {
  it("follows the plan's example order", () => {
    expect(suggestSubdomains("Surebloom School").slice(0, 3)).toEqual([
      "surebloom",
      "surebloomschool",
      "surebloom-school",
    ]);
  });

  it("strips accents and punctuation", () => {
    expect(suggestSubdomains("Ọlá & Sons' Academy")[0]).toBe("ola");
  });

  it("never suggests invalid or reserved names", () => {
    for (const s of suggestSubdomains("Admin")) expect(validateSubdomain(s).ok).toBe(true);
    expect(suggestSubdomains("123")).toEqual([]);
  });
});

describe("resolveHost", () => {
  const root = "brillianda.com";
  it("maps apex and www to the marketing site", () => {
    expect(resolveHost("brillianda.com", root)).toEqual({ kind: "apex" });
    expect(resolveHost("WWW.Brillianda.com:443", root)).toEqual({ kind: "apex" });
  });
  it("maps a single label to a school", () => {
    expect(resolveHost("surebloom.brillianda.com", root)).toEqual({ kind: "school", subdomain: "surebloom" });
    expect(resolveHost("SureBloom.brillianda.com.", root)).toEqual({ kind: "school", subdomain: "surebloom" });
  });
  it("rejects nested, foreign, reserved and malformed hosts", () => {
    expect(resolveHost("a.b.brillianda.com", root).kind).toBe("unknown");
    expect(resolveHost("evilbrillianda.com", root).kind).toBe("unknown");
    expect(resolveHost("surebloom.brillianda.com.evil.io", root).kind).toBe("unknown");
    expect(resolveHost("api.brillianda.com", root).kind).toBe("unknown");
    expect(resolveHost("[::1]:3000", root).kind).toBe("unknown");
    expect(resolveHost("", root).kind).toBe("unknown");
    expect(resolveHost(undefined, root).kind).toBe("unknown");
  });
  it("works for local development on *.localhost", () => {
    expect(resolveHost("surebloom.localhost:3000", "localhost")).toEqual({ kind: "school", subdomain: "surebloom" });
    expect(resolveHost("localhost:3000", "localhost")).toEqual({ kind: "apex" });
  });
});

describe("isUuid", () => {
  it("accepts v4 and v7, rejects junk", () => {
    expect(isUuid("0199b4a3-7c2e-7a6f-9d1e-3b5c8f2a1e40")).toBe(true);
    expect(isUuid("f47ac10b-58cc-4372-a567-0e02b2c3d479")).toBe(true);
    expect(isUuid("not-a-uuid")).toBe(false);
    expect(isUuid("' or 1=1 --")).toBe(false);
  });
});
