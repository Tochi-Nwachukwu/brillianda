import { eq, schools, type Database } from "@brillianda/db";

export interface ResolvedSchool {
  id: string;
  name: string;
  subdomain: string;
  status: "active" | "suspended" | "archived";
  brandColor: string | null;
  logoKey: string | null;
}

/**
 * Subdomain → school lookup with a short in-process cache. Only the school's public identity
 * is cached; student and member data is never cached between requests.
 * Call invalidate() when a school's settings, status or subdomain change.
 */
export class SchoolDirectory {
  readonly #cache = new Map<string, { value: ResolvedSchool | null; expiresAt: number }>();

  constructor(
    private readonly db: Database,
    private readonly ttlMs = 60_000,
    private readonly maxEntries = 10_000,
  ) {}

  async bySubdomain(subdomain: string): Promise<ResolvedSchool | null> {
    const key = subdomain.toLowerCase();
    const hit = this.#cache.get(key);
    if (hit && hit.expiresAt > Date.now()) return hit.value;

    const [row] = await this.db
      .select({
        id: schools.id,
        name: schools.name,
        subdomain: schools.subdomain,
        status: schools.status,
        brandColor: schools.brandColor,
        logoKey: schools.logoKey,
      })
      .from(schools)
      .where(eq(schools.subdomain, key))
      .limit(1);

    const value = row ?? null;
    if (this.#cache.size >= this.maxEntries) this.#cache.clear();
    // Cache misses briefly too, so a flood of requests for a non-existent school does not hit Postgres.
    this.#cache.set(key, { value, expiresAt: Date.now() + (value ? this.ttlMs : 10_000) });
    return value;
  }

  invalidate(subdomain: string): void {
    this.#cache.delete(subdomain.toLowerCase());
  }
}
