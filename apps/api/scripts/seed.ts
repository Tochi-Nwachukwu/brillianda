/**
 * Local demo data: Surebloom School with an owner, reachable at surebloom.localhost.
 *   pnpm db:seed
 * Prints a session cookie so you can call the API before the login endpoint exists.
 */
import { AuthSecret, createSession, hashPassword } from "@brillianda/auth";
import { auditLog, closeDatabase, createDatabase, eq, schoolMembers, schools, users, withSchool } from "@brillianda/db";
import { loadEnv } from "../src/env.js";

const env = loadEnv();
if (env.NODE_ENV === "production") {
  console.error("Refusing to seed demo data with NODE_ENV=production.");
  process.exit(1);
}

const db = createDatabase(env.DATABASE_URL, { max: 2 });
const secret = AuthSecret.fromBase64(env.AUTH_SECRET);
const email = "owner@surebloom.test";
const password = "surebloom-demo-password";

try {
  let [owner] = await db.select().from(users).where(eq(users.email, email));
  owner ??= (
    await db
      .insert(users)
      .values({ email, fullName: "Ngozi Okafor", passwordHash: await hashPassword(password), emailVerifiedAt: new Date() })
      .returning()
  )[0]!;

  let [school] = await db.select().from(schools).where(eq(schools.subdomain, "surebloom"));
  if (!school) {
    school = (
      await db
        .insert(schools)
        .values({
          name: "Surebloom School",
          subdomain: "surebloom",
          ownerUserId: owner.id,
          levelsOffered: ["secondary"],
          state: "Rivers",
          brandColor: "#1F6F5C",
        })
        .returning()
    )[0]!;
    await withSchool(db, school.id, async (tx) => {
      await tx.insert(schoolMembers).values({ schoolId: school!.id, userId: owner!.id, role: "owner" });
      await tx.insert(auditLog).values({
        schoolId: school!.id,
        actorUserId: owner!.id,
        action: "school.created",
        entity: "school",
        entityId: school!.id,
        changes: { source: "seed" },
      });
    });
  }

  const { token } = await withSchool(db, school.id, (tx) => createSession(tx, secret, { schoolId: school!.id, userId: owner!.id }));
  const host = `surebloom.${env.ROOT_DOMAIN}:${env.PORT}`;
  console.log(`Seeded Surebloom School (${school.id})`);
  console.log(`  owner: ${email} / ${password}`);
  console.log(`  try:   curl -H "Host: ${host}" -b "bd_session=${token}" http://localhost:${env.PORT}/v1/me`);
} finally {
  await closeDatabase(db);
}
