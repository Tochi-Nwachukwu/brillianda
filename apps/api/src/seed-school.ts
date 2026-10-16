/**
 * A ready-to-use test school for staging (the frontend team's ask A2): an owner and an admin,
 * a confirmed calendar, JSS 1 to SS 3 with two arms, the NERDC subjects for those classes, and
 * 20 students with guardians (some siblings). Everything after the people is created through the
 * API's own endpoints, so the data is exactly what the screens would have made, history included.
 *
 * Run from scripts/seed-test-school.ts. Refuses to touch a school that already exists.
 */
import { randomBytes } from "node:crypto";
import { createSession, hashPassword } from "@brillianda/auth";
import { CATALOGUE, defaultTerms, preTicked } from "@brillianda/core";
import { auditLog, eq, schoolMembers, schools, scopeToSchool, users } from "@brillianda/db";
import { createApp } from "./app.js";
import type { AppDeps } from "./context.js";
import { MemoryMailer } from "./lib/mailer.js";
import { MemoryRateLimiter } from "./lib/rate-limit.js";
import { createFirstSession } from "./routes/signup.js";

export interface SeedOptions {
  subdomain: string;
  name: string;
  ownerEmail: string;
  adminEmail: string;
}

export interface SeedResult {
  schoolId: string;
  owner: { email: string; password: string };
  admin: { email: string; password: string };
  students: number;
}

const FIRST = ["Chiamaka", "Tobi", "Emeka", "Aisha", "Ifeoma", "Kunle", "Zainab", "Obinna", "Funmilayo", "Musa", "Ngozi", "Segun", "Halima", "Chinedu", "Amaka", "Yusuf", "Bisola", "Ikenna", "Fatima", "Tunde"];
const LAST = ["Okafor", "Okafor", "Eze", "Bello", "Nwosu", "Adeyemi", "Abubakar", "Okeke", "Adebayo", "Ibrahim", "Obi", "Ogunleye", "Sani", "Uche", "Nnamdi", "Lawal", "Ajayi", "Onyeka", "Danjuma", "Bakare"];

const password = () => randomBytes(12).toString("base64url");

export async function seedTestSchool(base: AppDeps, opts: SeedOptions): Promise<SeedResult> {
  const { db } = base;
  const [existing] = await db.select({ id: schools.id }).from(schools).where(eq(schools.subdomain, opts.subdomain));
  if (existing) throw new Error(`A school at "${opts.subdomain}" already exists. Pick another address, or remove it first.`);
  for (const email of [opts.ownerEmail, opts.adminEmail]) {
    const [taken] = await db.select({ id: users.id }).from(users).where(eq(users.email, email));
    if (taken) throw new Error(`${email} already has a Brillianda account. Use another email.`);
  }

  const owner = { email: opts.ownerEmail, password: password() };
  const admin = { email: opts.adminEmail, password: password() };
  const startYear = new Date().getUTCMonth() >= 7 ? new Date().getUTCFullYear() : new Date().getUTCFullYear() - 1;

  // The people and the school, as signup and an accepted invitation would make them.
  const { schoolId, ownerId } = await db.transaction(async (tx) => {
    const [o] = await tx
      .insert(users)
      .values({ email: owner.email, fullName: "Test Owner", passwordHash: await hashPassword(owner.password), emailVerifiedAt: new Date() })
      .returning({ id: users.id });
    const [a] = await tx
      .insert(users)
      .values({ email: admin.email, fullName: "Test Admin", passwordHash: await hashPassword(admin.password), emailVerifiedAt: new Date() })
      .returning({ id: users.id });
    const [s] = await tx
      .insert(schools)
      .values({ name: opts.name, subdomain: opts.subdomain, ownerUserId: o!.id, levelsOffered: ["secondary"], state: "Lagos", phone: "+2348030000000", settings: {} })
      .returning({ id: schools.id });
    await scopeToSchool(tx, s!.id);
    await tx.insert(schoolMembers).values([
      { schoolId: s!.id, userId: o!.id, role: "owner", createdBy: o!.id, updatedBy: o!.id },
      { schoolId: s!.id, userId: a!.id, role: "admin", invitedBy: o!.id, createdBy: o!.id, updatedBy: o!.id },
    ]);
    await createFirstSession(tx, s!.id, o!.id, { sessionStartYear: startYear } as Parameters<typeof createFirstSession>[3]);
    await tx.insert(auditLog).values({ schoolId: s!.id, actorUserId: o!.id, action: "school.created", entity: "school", entityId: s!.id, changes: { via: "seed" }, summary: "Created the school" });
    return { schoolId: s!.id, ownerId: o!.id };
  });

  // The rest through the API itself, signed in as the owner, with nothing sent anywhere.
  const deps: AppDeps = { ...base, mailer: new MemoryMailer(), rateLimiter: new MemoryRateLimiter(), config: { ...base.config, secureCookies: false, protocol: "https", frontendUrl: undefined } };
  const app = createApp(deps);
  const host = `${opts.subdomain}.${deps.config.rootDomain}`;
  const { token } = await db.transaction(async (tx) => {
    await scopeToSchool(tx, schoolId);
    return createSession(tx, deps.secret, { schoolId, userId: ownerId });
  });
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await app.request(path, {
      method,
      headers: { host, origin: `https://${host}`, cookie: `bd_session=${token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (res.status >= 400) throw new Error(`${method} ${path} → ${res.status}: ${await res.text()}`);
    return res.status === 204 ? null : res.json();
  };

  await call("PUT", "/v1/session", { startYear, terms: defaultTerms(startYear) });
  const levels = [
    ...[1, 2, 3].map((n) => ({ key: `jss${n}`, name: `JSS ${n}`, short: `JSS${n}`, section: "junior" })),
    ...[1, 2, 3].map((n) => ({ key: `ss${n}`, name: `SS ${n}`, short: `SS${n}`, section: "senior" })),
  ];
  await call("POST", "/v1/classes/setup", { levels, arms: [{ name: "Gold", code: "GOL" }, { name: "Blue", code: "BLU" }], armsByLevel: levels.map(() => [0, 1]) });
  await call("POST", "/v1/subjects", { catalogueIds: preTicked(CATALOGUE, ["junior", "senior"]), custom: [] });

  const { arms } = (await call("GET", "/v1/students")) as { arms: { id: string }[] };
  for (let i = 0; i < FIRST.length; i++) {
    // Pairs with the same surname share a guardian's phone, so they show as siblings.
    const family = LAST.indexOf(LAST[i]!);
    const phone = `0803${String(5_550_000 + family).padStart(7, "0")}`;
    const { guardian } = (await call("GET", `/v1/guardians?phone=${phone}`)) as { guardian: { id: string } | null };
    await call("POST", "/v1/students", {
      firstName: FIRST[i],
      lastName: LAST[i],
      gender: i % 2 ? "male" : "female",
      armId: arms[i % arms.length]!.id,
      dateOfBirth: `${2010 + (i % 5)}-0${1 + (i % 9)}-1${i % 9}`,
      ...(guardian ? { guardianId: guardian.id } : { guardianName: `Mr/Mrs ${LAST[i]}`, guardianPhone: phone }),
      stateOfOrigin: "Lagos",
    });
  }

  return { schoolId, owner, admin, students: FIRST.length };
}
