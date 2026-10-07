import { hash, verify } from "@node-rs/argon2";
import { ARGON2_PARAMS, AUTH_LIMITS } from "./config.js";

export type PasswordProblem = "too_short" | "too_long";

export function checkPasswordShape(password: string): PasswordProblem | null {
  if (password.length < AUTH_LIMITS.passwordMinLength) return "too_short";
  if (password.length > AUTH_LIMITS.passwordMaxLength) return "too_long";
  return null;
}

/** Argon2id (the library default algorithm) with OWASP parameters. Returns a PHC string. */
export async function hashPassword(password: string): Promise<string> {
  if (checkPasswordShape(password)) throw new Error("Password failed shape check; validate before hashing");
  return hash(password.normalize("NFKC"), ARGON2_PARAMS);
}

let dummyHash: Promise<string> | undefined;
function getDummyHash(): Promise<string> {
  dummyHash ??= hash("brillianda-timing-equaliser", ARGON2_PARAMS);
  return dummyHash;
}

/**
 * Verifies a password. When there is no stored hash (unknown email, or a user with no password)
 * it still runs a full Argon2 verify against a dummy hash, so response time does not reveal
 * whether the account exists.
 */
export async function verifyPassword(storedHash: string | null | undefined, password: string): Promise<boolean> {
  if (password.length > AUTH_LIMITS.passwordMaxLength) {
    await verify(await getDummyHash(), "x").catch(() => false);
    return false;
  }
  const target = storedHash ?? (await getDummyHash());
  let ok = false;
  try {
    ok = await verify(target, password.normalize("NFKC"));
  } catch {
    ok = false;
  }
  return Boolean(storedHash) && ok;
}

/** True when a stored hash uses weaker parameters than today's; re-hash after a successful login. */
export function needsRehash(storedHash: string): boolean {
  const m = /\$argon2id\$v=\d+\$m=(\d+),t=(\d+),p=(\d+)\$/.exec(storedHash);
  if (!m) return true;
  const [, mem, time, par] = m.map(Number) as [number, number, number, number];
  return mem < ARGON2_PARAMS.memoryCost || time < ARGON2_PARAMS.timeCost || par < ARGON2_PARAMS.parallelism;
}
