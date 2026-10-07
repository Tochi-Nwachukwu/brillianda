import { createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";

/**
 * The server-side HMAC key for every stored token hash. Loaded once from AUTH_SECRET.
 * Using a keyed hash (not bare SHA-256) means a leaked database alone cannot be used to
 * brute-force 6-digit codes offline.
 */
export class AuthSecret {
  readonly #key: Buffer;

  private constructor(key: Buffer) {
    this.#key = key;
  }

  static fromBase64(value: string | undefined): AuthSecret {
    if (!value) throw new Error("AUTH_SECRET is not set");
    const key = Buffer.from(value, "base64");
    if (key.length < 32) throw new Error("AUTH_SECRET must decode to at least 32 bytes");
    return new AuthSecret(key);
  }

  /** Hex HMAC-SHA256 of `parts` joined with a separator that cannot appear in them. */
  hash(...parts: string[]): string {
    const h = createHmac("sha256", this.#key);
    h.update(parts.join("\u0000"));
    return h.digest("hex");
  }
}

/** 256 bits of randomness, URL-safe. For session cookies, links and handover tokens. */
export function generateToken(): string {
  return randomBytes(32).toString("base64url");
}

/** Uniform 6-digit code, leading zeros kept. */
export function generateCode(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, "0");
}

export function safeEqualHex(a: string, b: string): boolean {
  const ab = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  return ab.length === bb.length && ab.length > 0 && timingSafeEqual(ab, bb);
}

const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;
/** Cheap shape check before touching the database. */
export function looksLikeToken(value: unknown): value is string {
  return typeof value === "string" && TOKEN_SHAPE.test(value);
}
