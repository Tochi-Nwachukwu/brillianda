/**
 * Short-lived secrets on the platform-level verification_tokens table:
 *   - 6-digit codes (email verification, email change): limited attempts, constant-time compare
 *   - link tokens (magic link, password reset, signup handover): 256-bit, single use
 *
 * Every consume is a single conditional UPDATE ... RETURNING, so two concurrent requests
 * can never both redeem the same secret.
 */
import { and, desc, eq, gt, isNull, lt, sql, verificationTokens, type Executor } from "@brillianda/db";
import { AUTH_LIMITS } from "./config.js";
import { type AuthSecret, generateCode, generateToken, looksLikeToken, safeEqualHex } from "./crypto.js";

export type VerificationPurpose = (typeof verificationTokens.$inferSelect)["purpose"];
export type CodePurpose = Extract<VerificationPurpose, "email_verification" | "email_change">;
export type LinkPurpose = Extract<VerificationPurpose, "magic_link" | "password_reset" | "handover">;

export interface IssueInput {
  identifier: string;
  userId?: string | null;
  payload?: Record<string, unknown>;
  ttlMs?: number;
  now?: Date;
}

const normaliseIdentifier = (identifier: string) => identifier.trim().toLowerCase();
const codeHash = (secret: AuthSecret, purpose: string, identifier: string, code: string) =>
  secret.hash("code", purpose, normaliseIdentifier(identifier), code);
const linkHash = (secret: AuthSecret, purpose: string, token: string) => secret.hash("link", purpose, token);

// ── Codes ───────────────────────────────────────────────────────────────────

/** Milliseconds until a new code may be sent for this purpose/identifier (0 = now). */
export async function codeResendWaitMs(
  db: Executor,
  purpose: CodePurpose,
  identifier: string,
  now: Date = new Date(),
): Promise<number> {
  const [last] = await db
    .select({ createdAt: verificationTokens.createdAt })
    .from(verificationTokens)
    .where(and(eq(verificationTokens.purpose, purpose), eq(verificationTokens.identifier, normaliseIdentifier(identifier))))
    .orderBy(desc(verificationTokens.createdAt))
    .limit(1);
  if (!last) return 0;
  return Math.max(0, last.createdAt.getTime() + AUTH_LIMITS.codeResendAfterMs - now.getTime());
}

/**
 * Issues a fresh 6-digit code and retires any open code for the same purpose and identifier,
 * so only the most recent email works. Returns the plaintext code for the email; it is never stored.
 */
export async function issueCode(
  db: Executor,
  secret: AuthSecret,
  purpose: CodePurpose,
  input: IssueInput,
): Promise<{ code: string; id: string; expiresAt: Date }> {
  const now = input.now ?? new Date();
  const identifier = normaliseIdentifier(input.identifier);
  const expiresAt = new Date(now.getTime() + (input.ttlMs ?? AUTH_LIMITS.codeTtlMs));

  await db
    .update(verificationTokens)
    .set({ consumedAt: now })
    .where(
      and(
        eq(verificationTokens.purpose, purpose),
        eq(verificationTokens.identifier, identifier),
        isNull(verificationTokens.consumedAt),
      ),
    );

  // A code is only 6 digits; two live codes for different people can collide, so salt the
  // hash with a per-row nonce kept in the payload to keep token_hash unique.
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = generateCode();
    const nonce = generateToken();
    const rows = await db
      .insert(verificationTokens)
      .values({
        purpose,
        identifier,
        userId: input.userId ?? null,
        tokenHash: codeHash(secret, purpose, identifier, `${code}:${nonce}`),
        payload: { ...(input.payload ?? {}), nonce },
        maxAttempts: AUTH_LIMITS.codeMaxAttempts,
        expiresAt,
        createdAt: now,
      })
      .onConflictDoNothing({ target: verificationTokens.tokenHash })
      .returning({ id: verificationTokens.id });
    if (rows[0]) return { code, id: rows[0].id, expiresAt };
  }
  throw new Error("Could not issue a unique verification code");
}

export type CodeResult =
  | { ok: true; userId: string | null; payload: Record<string, unknown> }
  | { ok: false; reason: "invalid" | "expired" | "too_many_attempts" };

/**
 * Checks a code against the latest open code for this purpose and identifier.
 * Each call spends one attempt BEFORE comparing, so parallel guesses cannot exceed the limit.
 */
export async function verifyCode(
  db: Executor,
  secret: AuthSecret,
  purpose: CodePurpose,
  identifier: string,
  code: string,
  now: Date = new Date(),
): Promise<CodeResult> {
  const id = normaliseIdentifier(identifier);
  if (!/^\d{6}$/.test(code)) return { ok: false, reason: "invalid" };

  const [open] = await db
    .select()
    .from(verificationTokens)
    .where(and(eq(verificationTokens.purpose, purpose), eq(verificationTokens.identifier, id), isNull(verificationTokens.consumedAt)))
    .orderBy(desc(verificationTokens.createdAt))
    .limit(1);
  if (!open) return { ok: false, reason: "invalid" };
  if (open.expiresAt <= now) return { ok: false, reason: "expired" };

  const [spent] = await db
    .update(verificationTokens)
    .set({ attempts: sql`${verificationTokens.attempts} + 1` })
    .where(
      and(
        eq(verificationTokens.id, open.id),
        isNull(verificationTokens.consumedAt),
        lt(verificationTokens.attempts, verificationTokens.maxAttempts),
      ),
    )
    .returning({ attempts: verificationTokens.attempts });
  if (!spent) return { ok: false, reason: "too_many_attempts" };

  const nonce = String(open.payload.nonce ?? "");
  if (!safeEqualHex(codeHash(secret, purpose, id, `${code}:${nonce}`), open.tokenHash)) {
    return { ok: false, reason: spent.attempts >= open.maxAttempts ? "too_many_attempts" : "invalid" };
  }

  const [consumed] = await db
    .update(verificationTokens)
    .set({ consumedAt: now })
    .where(and(eq(verificationTokens.id, open.id), isNull(verificationTokens.consumedAt)))
    .returning({ id: verificationTokens.id });
  if (!consumed) return { ok: false, reason: "invalid" };

  const { nonce: _nonce, ...payload } = open.payload;
  return { ok: true, userId: open.userId, payload };
}

// ── Link tokens ─────────────────────────────────────────────────────────────

const LINK_TTL: Record<LinkPurpose, number> = {
  magic_link: AUTH_LIMITS.magicLinkTtlMs,
  password_reset: AUTH_LIMITS.passwordResetTtlMs,
  handover: AUTH_LIMITS.handoverTtlMs,
};

export async function issueLinkToken(
  db: Executor,
  secret: AuthSecret,
  purpose: LinkPurpose,
  input: IssueInput,
): Promise<{ token: string; id: string; expiresAt: Date }> {
  const now = input.now ?? new Date();
  const token = generateToken();
  const expiresAt = new Date(now.getTime() + (input.ttlMs ?? LINK_TTL[purpose]));
  const [row] = await db
    .insert(verificationTokens)
    .values({
      purpose,
      identifier: normaliseIdentifier(input.identifier),
      userId: input.userId ?? null,
      tokenHash: linkHash(secret, purpose, token),
      payload: input.payload ?? {},
      maxAttempts: 1,
      expiresAt,
      createdAt: now,
    })
    .returning({ id: verificationTokens.id });
  return { token, id: row!.id, expiresAt };
}

export interface ConsumedLink {
  id: string;
  identifier: string;
  userId: string | null;
  payload: Record<string, unknown>;
}

/** Redeems a link token exactly once. Null for unknown, expired, wrong-purpose or used tokens. */
export async function consumeLinkToken(
  db: Executor,
  secret: AuthSecret,
  purpose: LinkPurpose,
  token: string,
  now: Date = new Date(),
): Promise<ConsumedLink | null> {
  if (!looksLikeToken(token)) return null;
  const [row] = await db
    .update(verificationTokens)
    .set({ consumedAt: now })
    .where(
      and(
        eq(verificationTokens.tokenHash, linkHash(secret, purpose, token)),
        eq(verificationTokens.purpose, purpose),
        isNull(verificationTokens.consumedAt),
        gt(verificationTokens.expiresAt, now),
      ),
    )
    .returning({
      id: verificationTokens.id,
      identifier: verificationTokens.identifier,
      userId: verificationTokens.userId,
      payload: verificationTokens.payload,
    });
  return row ?? null;
}

/** Housekeeping: drop secrets that expired more than a day ago. Run from a scheduled job. */
export async function purgeExpiredTokens(db: Executor, now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const rows = await db
    .delete(verificationTokens)
    .where(lt(verificationTokens.expiresAt, cutoff))
    .returning({ id: verificationTokens.id });
  return rows.length;
}
