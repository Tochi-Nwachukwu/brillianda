import { uuidv7 } from "uuidv7";
import type { Database } from "../src/client.js";
import { academicSessions, arms, auditLog, classArms, classLevels, classLevelSubjects, counters, enrolments, guardians, importBatches, schoolLogos, schoolSubjects, studentGuardians, students, invitations, schoolMembers, schools, sessions, terms, users } from "../src/schema/index.js";
import { withSchool } from "../src/with-school.js";

export interface SeededSchool {
  schoolId: string;
  ownerId: string;
  sessionId: string;
}

/** Creates a school with one row in EVERY school table, so isolation checks have something to leak. */
export async function seedSchool(db: Database, subdomain: string): Promise<SeededSchool> {
  const ownerId = uuidv7();
  const schoolId = uuidv7();
  const sessionId = uuidv7();
  const now = new Date();
  const later = new Date(now.getTime() + 86_400_000);

  await db.insert(users).values({ id: ownerId, email: `owner@${subdomain}.test`, fullName: `Owner ${subdomain}` });
  await db.insert(schools).values({ id: schoolId, name: `School ${subdomain}`, subdomain, ownerUserId: ownerId });

  await withSchool(db, schoolId, async (tx) => {
    await tx.insert(schoolMembers).values({ schoolId, userId: ownerId, role: "owner" });
    await tx.insert(sessions).values({
      id: sessionId,
      schoolId,
      userId: ownerId,
      tokenHash: `hash-${subdomain}-${sessionId}`,
      expiresAt: later,
      absoluteExpiresAt: later,
    });
    await tx.insert(auditLog).values({ schoolId, actorUserId: ownerId, action: "school.created", entity: "school", entityId: schoolId });
    await tx.insert(invitations).values({
      schoolId,
      email: `admin@${subdomain}.test`,
      role: "admin",
      tokenHash: `invite-${subdomain}-${sessionId}`,
      invitedBy: ownerId,
      expiresAt: later,
    });
    const [year] = await tx
      .insert(academicSessions)
      .values({ schoolId, startYear: 2026, name: "2026/2027", startsOn: "2026-09-14", endsOn: "2027-07-23", isCurrent: true })
      .returning({ id: academicSessions.id });
    await tx.insert(terms).values({ schoolId, sessionId: year!.id, name: "First Term", position: 1, startsOn: "2026-09-14", endsOn: "2026-12-18" });
    const [level] = await tx.insert(classLevels).values({ schoolId, key: "jss1", name: "JSS 1", shortName: "JSS1", section: "junior", position: 0 }).returning({ id: classLevels.id });
    const [arm] = await tx.insert(arms).values({ schoolId, name: "Gold", code: "GOL", position: 0 }).returning({ id: arms.id });
    const [classArm] = await tx.insert(classArms).values({ schoolId, classLevelId: level!.id, armId: arm!.id }).returning({ id: classArms.id });
    const [batch] = await tx.insert(importBatches).values({ schoolId, fileName: "class-list.csv", rowCount: 1, createdCount: 1 }).returning({ id: importBatches.id });
    const [student] = await tx
      .insert(students)
      .values({ schoolId, admissionNumber: `${subdomain}/0001`, firstName: "Ada", lastName: "Obi", gender: "female", admissionDate: "2026-09-14", classArmId: classArm!.id, importBatchId: batch!.id })
      .returning({ id: students.id });
    const [guardian] = await tx.insert(guardians).values({ schoolId, fullName: "Mrs Obi", phone: "+2348030000001" }).returning({ id: guardians.id });
    await tx.insert(studentGuardians).values({ schoolId, studentId: student!.id, guardianId: guardian!.id });
    await tx.insert(enrolments).values({ schoolId, studentId: student!.id, classArmId: classArm!.id, startedOn: "2026-09-14" });
    await tx.insert(counters).values({ schoolId, name: "admission", nextValue: 2 });
    await tx.insert(schoolLogos).values({ schoolId, contentType: "image/png", bytes: Buffer.from([137, 80, 78, 71]), sha256: "x", width: 1, height: 1 });
    const [subject] = await tx.insert(schoolSubjects).values({ schoolId, catalogueId: "mathematics", name: "Mathematics", code: "MTH", position: 0 }).returning({ id: schoolSubjects.id });
    await tx.insert(classLevelSubjects).values({ schoolId, classLevelId: level!.id, schoolSubjectId: subject!.id, kind: "compulsory" });
  });

  return { schoolId, ownerId, sessionId };
}

/** Drizzle wraps driver errors ("Failed query: ..."); match against the Postgres message underneath. */
export async function pgError(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    const e = err as { message?: string; cause?: { message?: string; constraint?: string } };
    return [e.message, e.cause?.message, e.cause?.constraint].filter(Boolean).join(" | ");
  }
  throw new Error("Expected the query to fail, but it succeeded");
}
