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
import { and, auditLog, eq, guardians, parentLinks, schoolMembers, schools, scopeToSchool, studentGuardians, students, users } from "@brillianda/db";
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
  const call = await apiAs(base, opts.subdomain, schoolId, ownerId);

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

/** Calls this app in-process as one member of a school, with nothing sent anywhere. */
async function apiAs(base: AppDeps, subdomain: string, schoolId: string, userId: string) {
  const { db } = base;
  const deps: AppDeps = { ...base, mailer: new MemoryMailer(), rateLimiter: new MemoryRateLimiter(), config: { ...base.config, secureCookies: false, protocol: "https", frontendUrl: undefined } };
  const app = createApp(deps);
  const host = `${subdomain}.${deps.config.rootDomain}`;
  const { token } = await db.transaction(async (tx) => {
    await scopeToSchool(tx, schoolId);
    return createSession(tx, deps.secret, { schoolId, userId });
  });
  return async (method: string, path: string, body?: unknown) => {
    const res = await app.request(path, {
      method,
      headers: { host, origin: `https://${host}`, cookie: `bd_session=${token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (res.status >= 400) throw new Error(`${method} ${path} → ${res.status}: ${await res.text()}`);
    return res.status === 204 ? null : res.json();
  };
}

export interface TeacherSeedOptions {
  subdomain: string;
  formTeacherEmail: string;
  subjectTeacherEmail: string;
}

export interface TeacherSeedResult {
  formTeacher: { email: string; password: string; formClass: string; subjects: string[] };
  subjectTeacher: { email: string; password: string; subjects: string[] };
}

/**
 * Two teachers for an existing test school (C1): a form teacher of its first class who also
 * teaches Mathematics in the first two classes, and a subject-only teacher of English in the
 * first four. Their accounts are made as an accepted invitation would; the assignments through the
 * API as the school's owner, so they show in the change history.
 */
export async function seedTestTeachers(base: AppDeps, opts: TeacherSeedOptions): Promise<TeacherSeedResult> {
  const { db } = base;
  const [school] = await db.select({ id: schools.id, ownerId: schools.ownerUserId }).from(schools).where(eq(schools.subdomain, opts.subdomain));
  if (!school) throw new Error(`There is no school at "${opts.subdomain}". Run seed:test-school first.`);

  // Check the school is ready before touching any account, so a failed run leaves nothing behind.
  const call = await apiAs(base, opts.subdomain, school.id, school.ownerId);
  const page = (await call("GET", "/v1/teachers")) as { arms: { id: string; label: string }[]; subjects: { id: string; name: string }[] };
  if (page.arms.length < 2) throw new Error(`"${opts.subdomain}" needs at least two classes. Add them on its Classes page first.`);
  if (!page.subjects.length) throw new Error(`"${opts.subdomain}" has no subjects yet. Add some on its Subjects page first.`);
  const subjectNamed = (name: string) => page.subjects.find((s) => s.name.toLowerCase().startsWith(name)) ?? page.subjects[0]!;
  const maths = subjectNamed("mathematics");
  const english = subjectNamed("english");

  const form = { email: opts.formTeacherEmail, password: password() };
  const subject = { email: opts.subjectTeacherEmail, password: password() };
  const [formId, subjectId] = await db.transaction(async (tx) => {
    await scopeToSchool(tx, school.id);
    const ids: string[] = [];
    for (const [who, fullName] of [[form, "Test Form Teacher"], [subject, "Test Subject Teacher"]] as const) {
      const passwordHash = await hashPassword(who.password);
      const [existing] = await tx.select({ id: users.id, fullName: users.fullName }).from(users).where(eq(users.email, who.email));
      if (existing) {
        // A re-run (say, after an earlier one stopped half-way): reuse the account only if this seed
        // made it as a teacher here, and give it a fresh password to print.
        const [member] = await tx.select({ role: schoolMembers.role }).from(schoolMembers).where(eq(schoolMembers.userId, existing.id));
        if (member?.role !== "teacher" || existing.fullName !== fullName) throw new Error(`${who.email} already has a Brillianda account. Use another email.`);
        await tx.update(users).set({ passwordHash, updatedAt: new Date() }).where(eq(users.id, existing.id));
        ids.push(existing.id);
        continue;
      }
      const [u] = await tx.insert(users).values({ email: who.email, fullName, passwordHash, emailVerifiedAt: new Date() }).returning({ id: users.id });
      await tx.insert(schoolMembers).values({ schoolId: school.id, userId: u!.id, role: "teacher", invitedBy: school.ownerId, createdBy: school.ownerId, updatedBy: school.ownerId });
      await tx.insert(auditLog).values({ schoolId: school.id, actorUserId: u!.id, action: "member.joined", entity: "user", entityId: u!.id, changes: { via: "seed", role: "teacher" }, summary: "Joined as a teacher" });
      ids.push(u!.id);
    }
    return ids;
  });

  const [first, second] = page.arms;
  await call("PUT", `/v1/arms/${first!.id}/form-teacher`, { userId: formId });
  await call("PUT", `/v1/teachers/${formId}/subject-classes`, [first!, second!].map((a) => ({ armId: a.id, subjectId: maths.id })));
  const englishArms = page.arms.slice(0, 4);
  await call("PUT", `/v1/teachers/${subjectId}/subject-classes`, englishArms.map((a) => ({ armId: a.id, subjectId: english.id })));
  return {
    formTeacher: { ...form, formClass: first!.label, subjects: [first!, second!].map((a) => `${maths.name}, ${a.label}`) },
    subjectTeacher: { ...subject, subjects: englishArms.map((a) => `${english.name}, ${a.label}`) },
  };
}

export interface ParentSeedResult {
  email: string;
  password: string;
  guardian: string;
  children: string[];
}

/**
 * A parent for an existing test school (C2): the account of the guardian of the Okafor siblings
 * (seed:test-school), made as an accepted parent invitation would. Falls back to the first
 * guardian on file.
 */
export async function seedTestParent(base: AppDeps, opts: { subdomain: string; email: string }): Promise<ParentSeedResult> {
  const { db } = base;
  const [school] = await db.select({ id: schools.id, ownerId: schools.ownerUserId }).from(schools).where(eq(schools.subdomain, opts.subdomain));
  if (!school) throw new Error(`There is no school at "${opts.subdomain}". Run seed:test-school first.`);
  const [taken] = await db.select({ id: users.id }).from(users).where(eq(users.email, opts.email));
  if (taken) throw new Error(`${opts.email} already has a Brillianda account. Use another email.`);
  const parent = { email: opts.email, password: password() };
  return db.transaction(async (tx) => {
    await scopeToSchool(tx, school.id);
    const rows = await tx
      .select({ guardianId: guardians.id, guardianName: guardians.fullName, firstName: students.firstName, lastName: students.lastName, otherNames: students.otherNames })
      .from(guardians)
      .innerJoin(studentGuardians, and(eq(studentGuardians.schoolId, guardians.schoolId), eq(studentGuardians.guardianId, guardians.id)))
      .innerJoin(students, and(eq(students.schoolId, studentGuardians.schoolId), eq(students.id, studentGuardians.studentId)));
    if (!rows.length) throw new Error(`"${opts.subdomain}" has no students with guardians yet.`);
    const okafor = rows.find((r) => r.lastName === "Okafor") ?? rows[0]!;
    const kids = rows.filter((r) => r.guardianId === okafor.guardianId).map((r) => `${r.firstName} ${r.lastName}`);
    const [u] = await tx
      .insert(users)
      .values({ email: parent.email, fullName: okafor.guardianName, passwordHash: await hashPassword(parent.password), emailVerifiedAt: new Date() })
      .returning({ id: users.id });
    await tx.insert(schoolMembers).values({ schoolId: school.id, userId: u!.id, role: "parent", invitedBy: school.ownerId, createdBy: school.ownerId, updatedBy: school.ownerId });
    await tx.insert(parentLinks).values({ schoolId: school.id, guardianId: okafor.guardianId, userId: u!.id, createdBy: school.ownerId, updatedBy: school.ownerId });
    await tx.insert(auditLog).values({ schoolId: school.id, actorUserId: u!.id, action: "member.joined", entity: "user", entityId: u!.id, changes: { via: "seed", role: "parent" }, summary: "Joined the parent app" });
    return { ...parent, guardian: okafor.guardianName, children: kids };
  });
}
