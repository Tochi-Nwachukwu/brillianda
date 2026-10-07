import { AuthSecret, createSession } from "@brillianda/auth";
import { schoolMembers, schools, users, withSchool, type Database } from "@brillianda/db";
import { createTestDatabase, type TestDatabase } from "@brillianda/db/testing";
import { randomBytes } from "node:crypto";
import { createApp } from "../src/app.js";
import type { AppConfig, AppDeps } from "../src/context.js";
import { silentLogger } from "../src/lib/logger.js";
import { MemoryRateLimiter } from "../src/lib/rate-limit.js";
import { SchoolDirectory } from "../src/lib/school-directory.js";

export const PROXY_SECRET = "test-proxy-secret-0123456789";

export interface Harness {
  t: TestDatabase;
  db: Database;
  deps: AppDeps;
  app: ReturnType<typeof createApp>;
}

export async function createHarness(config: Partial<AppConfig> = {}): Promise<Harness> {
  const t = await createTestDatabase();
  const deps: AppDeps = {
    db: t.db,
    secret: AuthSecret.fromBase64(randomBytes(32).toString("base64")),
    rateLimiter: new MemoryRateLimiter(),
    schools: new SchoolDirectory(t.db, 0),
    logger: silentLogger,
    config: {
      rootDomain: "brillianda.test",
      protocol: "https",
      proxySecret: PROXY_SECRET,
      allowSchoolQueryParam: false,
      secureCookies: false,
      ...config,
    },
  };
  return { t, db: t.db, deps, app: createApp(deps) };
}

export async function seedSchoolWithMember(
  h: Harness,
  subdomain: string,
  opts: { email?: string; role?: "owner" | "admin"; status?: "active" | "suspended" | "archived" } = {},
) {
  const email = opts.email ?? `owner@${subdomain}.test`;
  let [user] = await h.db.select().from(users).where(eqEmail(email));
  user ??= (await h.db.insert(users).values({ email, fullName: `Person ${subdomain}` }).returning())[0]!;
  const [school] = await h.db
    .insert(schools)
    .values({ name: `School ${subdomain}`, subdomain, ownerUserId: user.id, status: opts.status ?? "active" })
    .returning();
  await withSchool(h.db, school!.id, (tx) =>
    tx.insert(schoolMembers).values({ schoolId: school!.id, userId: user!.id, role: opts.role ?? "owner" }),
  );
  return { school: school!, user };
}

export async function addMember(h: Harness, schoolId: string, email: string, role: "owner" | "admin") {
  const [user] = await h.db.insert(users).values({ email, fullName: email }).returning();
  await withSchool(h.db, schoolId, (tx) => tx.insert(schoolMembers).values({ schoolId, userId: user!.id, role }));
  return user!;
}

export async function signIn(h: Harness, schoolId: string, userId: string): Promise<string> {
  const { token } = await withSchool(h.db, schoolId, (tx) => createSession(tx, h.deps.secret, { schoolId, userId }));
  return token;
}

export function hostHeaders(host: string, extra: Record<string, string> = {}): Record<string, string> {
  return { host, ...extra };
}

import { eq } from "@brillianda/db";
function eqEmail(email: string) {
  return eq(users.email, email);
}
