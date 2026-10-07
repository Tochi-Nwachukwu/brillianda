/**
 * Subdomain rules from docs/plan.md ("Subdomain rules").
 *
 * - 3 to 30 characters: lowercase letters, digits and single hyphens.
 * - Starts with a letter, never ends with a hyphen.
 * - A reserved list blocks platform names and names that impersonate exam bodies or agencies.
 * - Uniqueness is case-insensitive (citext + unique index in the database).
 */

export const SUBDOMAIN_MIN = 3;
export const SUBDOMAIN_MAX = 30;

const SUBDOMAIN_PATTERN = /^[a-z](?:[a-z0-9]|-(?=[a-z0-9]))*$/;

export const RESERVED_SUBDOMAINS: ReadonlySet<string> = new Set([
  // Platform
  "www", "app", "api", "admin", "auth", "mail", "status", "help", "docs", "blog", "cdn", "staging",
  // Extra platform names worth holding now so no school can claim them first
  "dev", "test", "demo", "support", "billing", "login", "signup", "static", "assets", "files",
  "email", "smtp", "imap", "ftp", "ns1", "ns2", "brillianda",
  // Exam bodies and agencies
  "waec", "neco", "jamb", "ubec", "nabteb", "nerdc", "fme", "nuc", "ndpc", "nitda",
]);

export type SubdomainProblem = "too_short" | "too_long" | "invalid_characters" | "reserved";

export type SubdomainCheck =
  | { ok: true; subdomain: string }
  | { ok: false; subdomain: string; problem: SubdomainProblem };

/** Lowercases and trims; does NOT otherwise rewrite what the person typed. */
export function normaliseSubdomain(input: string): string {
  return input.trim().toLowerCase();
}

export function validateSubdomain(input: string): SubdomainCheck {
  const subdomain = normaliseSubdomain(input);
  if (subdomain.length < SUBDOMAIN_MIN) return { ok: false, subdomain, problem: "too_short" };
  if (subdomain.length > SUBDOMAIN_MAX) return { ok: false, subdomain, problem: "too_long" };
  if (!SUBDOMAIN_PATTERN.test(subdomain)) return { ok: false, subdomain, problem: "invalid_characters" };
  if (RESERVED_SUBDOMAINS.has(subdomain)) return { ok: false, subdomain, problem: "reserved" };
  return { ok: true, subdomain };
}

/** Too generic to offer on their own: someone would take them in the first hour. */
const GENERIC_WORDS = new Set(["school", "schools", "academy", "college", "college-school", "the", "and"]);

/** Turns free text into a valid-shaped slug fragment, or "" if nothing usable remains. */
function slugWords(name: string): string[] {
  return name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * Suggestions from the school name, in the order the plan gives:
 * "Surebloom School" → surebloom, surebloomschool, surebloom-school.
 * Only valid, non-reserved candidates are returned; availability is checked by the caller.
 */
export function suggestSubdomains(schoolName: string, limit = 5): string[] {
  const words = slugWords(schoolName);
  if (words.length === 0) return [];

  const candidates = [
    words[0]!,
    words.join(""),
    words.join("-"),
    words.length > 1 ? words.slice(0, 2).join("") : "",
    words.map((w) => w[0]).join("") + (words.length > 1 ? "" : "school"),
    `${words[0]}-school`,
  ];

  const out: string[] = [];
  for (const raw of candidates) {
    const candidate = raw.replace(/^[^a-z]+/, "").slice(0, SUBDOMAIN_MAX).replace(/-+$/, "");
    if (!candidate || out.includes(candidate) || GENERIC_WORDS.has(candidate)) continue;
    if (validateSubdomain(candidate).ok) out.push(candidate);
    if (out.length >= limit) break;
  }
  return out;
}
