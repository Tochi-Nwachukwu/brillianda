import { schoolMembers, schools, users, withSchool, type Database } from "@brillianda/db";
import { createTestDatabase, type TestDatabase } from "@brillianda/db/testing";
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  AUTH_LIMITS,
  AuthSecret,
  codeResendWaitMs,
  consumeLinkToken,
  createSession,
  generateToken,
  hashPassword,
  invalidateSession,
  issueCode,
  issueLinkToken,
  needsRehash,
  validateSession,
  verifyCode,
  verifyPassword,
} from "../src/index.js";

const secret = AuthSecret.fromBase64(randomBytes(32).toString("base64"));
let t: TestDatabase;
let db: Database;
let schoolA: string;
let schoolB: string;
let userId: string;

beforeAll(async () => {
  t = await createTestDatabase();
  db = t.db;
  const [u] = await db.insert(users).values({ email: "ngozi@surebloom.test", fullName: "Ngozi Okafor" }).returning();
  userId = u!.id;
  const [a] = await db.insert(schools).values({ name: "Surebloom", subdomain: "surebloom", ownerUserId: userId }).returning();
  const [b] = await db.insert(schools).values({ name: "Other", subdomain: "otherschool", ownerUserId: userId }).returning();
  schoolA = a!.id;
  schoolB = b!.id;
  await withSchool(db, schoolA, (tx) => tx.insert(schoolMembers).values({ schoolId: schoolA, userId, role: "owner" }));
  await withSchool(db, schoolB, (tx) => tx.insert(schoolMembers).values({ schoolId: schoolB, userId, role: "owner" }));
});

afterAll(async () => {
  await t?.close();
});

describe("AuthSecret", () => {
  it("refuses short or missing secrets", () => {
    expect(() => AuthSecret.fromBase64(undefined)).toThrow();
    expect(() => AuthSecret.fromBase64(Buffer.alloc(16).toString("base64"))).toThrow(/32 bytes/);
  });
});

describe("passwords", () => {
  it("hashes with argon2id and verifies", async () => {
    const h = await hashPassword("correct horse battery");
    expect(h).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(await verifyPassword(h, "correct horse battery")).toBe(true);
    expect(await verifyPassword(h, "wrong horse battery")).toBe(false);
    expect(needsRehash(h)).toBe(false);
  });

  it("treats unknown users as a failed login after doing the same work", async () => {
    expect(await verifyPassword(null, "anything at all")).toBe(false);
  });

  it("rejects oversized input without hashing it", async () => {
    expect(await verifyPassword("$argon2id$v=19$m=19456,t=2,p=1$x$y", "a".repeat(AUTH_LIMITS.passwordMaxLength + 1))).toBe(false);
    await expect(hashPassword("short")).rejects.toThrow();
  });

  it("flags weaker hashes for upgrade", () => {
    expect(needsRehash("$argon2id$v=19$m=4096,t=3,p=1$abc$def")).toBe(true);
    expect(needsRehash("$2b$10$bcrypt")).toBe(true);
  });
});

describe("sessions", () => {
  it("creates, validates and invalidates a session in its own school", async () => {
    const { token, sessionId } = await withSchool(db, schoolA, (tx) => createSession(tx, secret, { schoolId: schoolA, userId }));
    const valid = await withSchool(db, schoolA, (tx) => validateSession(tx, secret, token));
    expect(valid?.user.email).toBe("ngozi@surebloom.test");
    expect(valid?.membership.role).toBe("owner");

    await withSchool(db, schoolA, (tx) => invalidateSession(tx, sessionId));
    expect(await withSchool(db, schoolA, (tx) => validateSession(tx, secret, token))).toBeNull();
  });

  it("does not accept a school A token at school B, even for the same person", async () => {
    const { token } = await withSchool(db, schoolA, (tx) => createSession(tx, secret, { schoolId: schoolA, userId }));
    expect(await withSchool(db, schoolB, (tx) => validateSession(tx, secret, token))).toBeNull();
    expect(await withSchool(db, schoolA, (tx) => validateSession(tx, secret, token))).not.toBeNull();
  });

  it("rejects garbage and tokens signed with another secret", async () => {
    const { token } = await withSchool(db, schoolA, (tx) => createSession(tx, secret, { schoolId: schoolA, userId }));
    const other = AuthSecret.fromBase64(randomBytes(32).toString("base64"));
    expect(await withSchool(db, schoolA, (tx) => validateSession(tx, other, token))).toBeNull();
    expect(await withSchool(db, schoolA, (tx) => validateSession(tx, secret, "nope"))).toBeNull();
    expect(await withSchool(db, schoolA, (tx) => validateSession(tx, secret, generateToken()))).toBeNull();
  });

  it("expires after the idle window and slides while in use", async () => {
    const start = new Date("2026-10-01T08:00:00Z");
    const { token } = await withSchool(db, schoolA, (tx) => createSession(tx, secret, { schoolId: schoolA, userId, now: start }));

    const day20 = new Date(start.getTime() + 20 * 86_400_000);
    const slid = await withSchool(db, schoolA, (tx) => validateSession(tx, secret, token, day20));
    expect(slid?.session.expiresAt.getTime()).toBe(day20.getTime() + AUTH_LIMITS.sessionIdleMs);

    const idleTooLong = new Date(day20.getTime() + AUTH_LIMITS.sessionIdleMs + 1);
    expect(await withSchool(db, schoolA, (tx) => validateSession(tx, secret, token, idleTooLong))).toBeNull();
  });

  it("never outlives the absolute cap", async () => {
    const start = new Date("2026-10-01T08:00:00Z");
    const { token } = await withSchool(db, schoolA, (tx) => createSession(tx, secret, { schoolId: schoolA, userId, now: start }));
    let now = start;
    for (let i = 0; i < 6; i++) {
      now = new Date(now.getTime() + 16 * 86_400_000);
      await withSchool(db, schoolA, (tx) => validateSession(tx, secret, token, now));
    }
    const pastCap = new Date(start.getTime() + AUTH_LIMITS.sessionAbsoluteMs + 1);
    expect(await withSchool(db, schoolA, (tx) => validateSession(tx, secret, token, pastCap))).toBeNull();
  });

  it("stops working when the membership is suspended", async () => {
    const [u] = await db.insert(users).values({ email: "admin@surebloom.test", fullName: "Admin" }).returning();
    await withSchool(db, schoolA, (tx) => tx.insert(schoolMembers).values({ schoolId: schoolA, userId: u!.id, role: "admin" }));
    const { token } = await withSchool(db, schoolA, (tx) => createSession(tx, secret, { schoolId: schoolA, userId: u!.id }));
    expect(await withSchool(db, schoolA, (tx) => validateSession(tx, secret, token))).not.toBeNull();
    await withSchool(db, schoolA, (tx) =>
      tx.update(schoolMembers).set({ status: "suspended" }).where(eqMember(u!.id)),
    );
    expect(await withSchool(db, schoolA, (tx) => validateSession(tx, secret, token))).toBeNull();
  });
});

describe("email codes", () => {
  it("verifies the latest code once, case-insensitively on the email", async () => {
    const { code } = await issueCode(db, secret, "email_verification", { identifier: "New@Owner.test", payload: { draft: 1 } });
    expect(code).toMatch(/^\d{6}$/);
    const ok = await verifyCode(db, secret, "email_verification", "new@owner.test", code);
    expect(ok).toEqual({ ok: true, userId: null, payload: { draft: 1 } });
    expect(await verifyCode(db, secret, "email_verification", "new@owner.test", code)).toEqual({ ok: false, reason: "invalid" });
  });

  it("retires older codes when a new one is sent", async () => {
    const first = await issueCode(db, secret, "email_verification", { identifier: "twice@owner.test" });
    const second = await issueCode(db, secret, "email_verification", { identifier: "twice@owner.test" });
    if (first.code !== second.code) {
      expect((await verifyCode(db, secret, "email_verification", "twice@owner.test", first.code)).ok).toBe(false);
    }
    expect((await verifyCode(db, secret, "email_verification", "twice@owner.test", second.code)).ok).toBe(true);
  });

  it("locks after five wrong guesses, even if the sixth is right", async () => {
    const { code } = await issueCode(db, secret, "email_verification", { identifier: "brute@owner.test" });
    const wrong = code === "000000" ? "111111" : "000000";
    for (let i = 0; i < 4; i++) {
      expect(await verifyCode(db, secret, "email_verification", "brute@owner.test", wrong)).toEqual({ ok: false, reason: "invalid" });
    }
    expect(await verifyCode(db, secret, "email_verification", "brute@owner.test", wrong)).toEqual({ ok: false, reason: "too_many_attempts" });
    expect(await verifyCode(db, secret, "email_verification", "brute@owner.test", code)).toEqual({ ok: false, reason: "too_many_attempts" });
  });

  it("cannot be raced past the attempt limit", async () => {
    const { code } = await issueCode(db, secret, "email_verification", { identifier: "race@owner.test" });
    const guesses = Array.from({ length: 30 }, (_, i) => String(i).padStart(6, "0")).filter((g) => g !== code);
    const results = await Promise.all(guesses.map((g) => verifyCode(db, secret, "email_verification", "race@owner.test", g)));
    expect(results.every((r) => !r.ok)).toBe(true);
    expect(await verifyCode(db, secret, "email_verification", "race@owner.test", code)).toEqual({ ok: false, reason: "too_many_attempts" });
  });

  it("expires after ten minutes", async () => {
    const now = new Date();
    const { code } = await issueCode(db, secret, "email_verification", { identifier: "late@owner.test", now });
    const later = new Date(now.getTime() + AUTH_LIMITS.codeTtlMs + 1);
    expect(await verifyCode(db, secret, "email_verification", "late@owner.test", code, later)).toEqual({ ok: false, reason: "expired" });
  });

  it("reports the resend cooldown", async () => {
    const now = new Date();
    await issueCode(db, secret, "email_verification", { identifier: "wait@owner.test", now });
    expect(await codeResendWaitMs(db, "email_verification", "wait@owner.test", now)).toBe(AUTH_LIMITS.codeResendAfterMs);
    expect(await codeResendWaitMs(db, "email_verification", "wait@owner.test", new Date(now.getTime() + 61_000))).toBe(0);
  });
});

describe("link tokens", () => {
  it("redeems a handover token exactly once, even under a race", async () => {
    const { token } = await issueLinkToken(db, secret, "handover", { identifier: "ngozi@surebloom.test", userId, payload: { schoolId: schoolA } });
    const results = await Promise.all(Array.from({ length: 10 }, () => consumeLinkToken(db, secret, "handover", token)));
    const winners = results.filter(Boolean);
    expect(winners).toHaveLength(1);
    expect(winners[0]).toMatchObject({ userId, payload: { schoolId: schoolA } });
  });

  it("will not redeem a token for a different purpose or after expiry", async () => {
    const now = new Date();
    const { token } = await issueLinkToken(db, secret, "password_reset", { identifier: "ngozi@surebloom.test", now });
    expect(await consumeLinkToken(db, secret, "magic_link", token)).toBeNull();
    const late = new Date(now.getTime() + AUTH_LIMITS.passwordResetTtlMs + 1);
    expect(await consumeLinkToken(db, secret, "password_reset", token, late)).toBeNull();
  });

  it("gives the handover token only 60 seconds", async () => {
    const now = new Date();
    const { expiresAt } = await issueLinkToken(db, secret, "handover", { identifier: "x@y.test", now });
    expect(expiresAt.getTime() - now.getTime()).toBe(60_000);
  });
});

import { eq } from "@brillianda/db";
function eqMember(id: string) {
  return eq(schoolMembers.userId, id);
}

describe("resend cooldown after use", () => {
  it("does not hold back a new code once the last one was redeemed", async () => {
    const { code } = await issueCode(db, secret, "email_verification", { identifier: "used@owner.test" });
    expect(await codeResendWaitMs(db, "email_verification", "used@owner.test")).toBeGreaterThan(0);
    await verifyCode(db, secret, "email_verification", "used@owner.test", code);
    expect(await codeResendWaitMs(db, "email_verification", "used@owner.test")).toBe(0);
  });
});
