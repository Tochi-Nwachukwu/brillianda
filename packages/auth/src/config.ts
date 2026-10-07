const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

export const AUTH_LIMITS = {
  /** A session dies after this long without use. */
  sessionIdleMs: 30 * DAY,
  /** ...and after this long no matter what. */
  sessionAbsoluteMs: 90 * DAY,
  /** Extend the sliding expiry only when less than this remains (saves a write per request). */
  sessionRenewWhenRemainingMs: 15 * DAY,

  /** 6-digit email codes (plan: expire in 10 minutes, resend after 60 seconds). */
  codeTtlMs: 10 * MINUTE,
  codeResendAfterMs: MINUTE,
  codeMaxAttempts: 5,

  /** Signup → subdomain handover (plan: one-time, 60 seconds). */
  handoverTtlMs: MINUTE,
  magicLinkTtlMs: 15 * MINUTE,
  passwordResetTtlMs: 30 * MINUTE,

  passwordMinLength: 8,
  /** Argon2 cost is per byte; cap input so a 1 MB "password" cannot burn CPU. */
  passwordMaxLength: 128,
} as const;

/**
 * Argon2id parameters: OWASP's first recommended configuration
 * (m=19 MiB, t=2, p=1). Revisit when hardware changes; verify() reads params from the hash,
 * so raising them later only affects new hashes, and needsRehash() upgrades on next login.
 */
export const ARGON2_PARAMS = {
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
  outputLen: 32,
} as const;
