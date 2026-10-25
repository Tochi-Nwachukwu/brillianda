import { uuidv7 } from "uuidv7";
import type { Database } from "../src/client.js";
import { academicSessions, armFormTeachers, arms, auditLog, classArms, classLevels, classLevelSubjects, counters, enrolments, parentLinks, registerMarks, resultsSettings, termClosures, scores, scoreExclusions, sheetCompletions, unlockRequests, reportRemarks, reportRatings, publishedResults, promotionDecisions, birthdaySettings, birthdayTexts, bookLists, correctionRequests, registers, subjectTeachers, guardians, importBatches, schoolLogos, schoolSubjects, studentGuardians, students, invitations, schoolMembers, schools, sessions, terms, users } from "../src/schema/index.js";
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
    await tx.insert(armFormTeachers).values({ schoolId, classArmId: classArm!.id, userId: ownerId });
    await tx.insert(subjectTeachers).values({ schoolId, classArmId: classArm!.id, schoolSubjectId: subject!.id, userId: ownerId });
    const [register] = await tx.insert(registers).values({ schoolId, classArmId: classArm!.id, day: "2026-09-14", takenBy: ownerId }).returning({ id: registers.id });
    await tx.insert(registerMarks).values({ schoolId, registerId: register!.id, studentId: student!.id, mark: "present" });
    await tx.insert(parentLinks).values({ schoolId, guardianId: guardian!.id, userId: ownerId });
    await tx.insert(resultsSettings).values({ schoolId, components: [{ id: "exam", name: "Exam", maxScore: 100 }], scale: [{ minScore: 0, grade: "F", remark: "", isPass: false }] });
    await tx.insert(termClosures).values({ schoolId, termKey: "2025-1" });
    const sheet = { schoolId, termKey: "2026-1", classArmId: classArm!.id, schoolSubjectId: subject!.id };
    await tx.insert(scores).values({ ...sheet, studentId: student!.id, componentId: "exam", value: 71.5 });
    await tx.insert(scoreExclusions).values({ ...sheet, studentId: student!.id });
    await tx.insert(sheetCompletions).values(sheet);
    await tx.insert(unlockRequests).values({ ...sheet, reason: "A typo in the exam score" });
    await tx.insert(reportRemarks).values({ schoolId, termKey: "2026-1", studentId: student!.id, kind: "teacher", text: "A steady term." });
    await tx.insert(reportRatings).values({ schoolId, termKey: "2026-1", studentId: student!.id, trait: "Neatness", value: 4 });
    await tx.insert(publishedResults).values({ schoolId, termKey: "2026-1", classArmId: classArm!.id });
    await tx.insert(promotionDecisions).values({ schoolId, startYear: 2026, studentId: student!.id, decision: "repeat", reason: "Fixture" });
    await tx.insert(birthdaySettings).values({ schoolId, enabled: true, message: "Happy birthday, {name}!" });
    await tx.insert(birthdayTexts).values({ schoolId, studentId: student!.id, day: "2026-10-15", phone: null, text: "Happy birthday, Ada!", status: "no_phone" });
    await tx.insert(bookLists).values({ schoolId, classLevelId: level!.id, startYear: 2026, items: [{ id: "i1", category: "textbook", name: "Basic Science", detail: "", quantity: 1, price: 2500 }], shared: true });
    await tx.insert(correctionRequests).values({ schoolId, studentId: student!.id, guardianId: guardian!.id, changes: [{ field: "firstName", from: "Ada", to: "Adaeze" }] });
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
