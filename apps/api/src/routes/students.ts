/**
 * Students and guardians (plan: "Students", "Managing students"), on the school's own address.
 * Owners and admins. Shapes and rules follow the frontend's batch 8 (src/data/fake/students.ts,
 * packages/core/src/students.ts and admission.ts).
 *
 *   GET    /v1/students                 every student not deleted, the classes they can sit in, the next admission number
 *   GET    /v1/students/{id}            one student: details, guardian and siblings, class history, changes
 *   POST   /v1/students                 add one (blank admission number takes the school's next)
 *   PUT    /v1/students/{id}            edit; a new class is added to the class history
 *   POST   /v1/students/move            move several to one class
 *   POST   /v1/students/status          change several students' status
 *   DELETE /v1/students/{id}            soft delete, for mistakes only
 *   GET    /v1/guardians?phone=         a guardian already on file, so siblings share one
 *   GET    /v1/admission-numbers        the format, the next number and a preview
 *   PUT    /v1/admission-numbers        set the format ({YEAR}, {NUMBER}, digits)
 */
import {
  admissionPatternProblems,
  defaultAdmissionPattern,
  formatAdmissionNo,
  fullName,
  GENDERS,
  NIGERIAN_STATES,
  normaliseNigerianPhone,
  PERSON_NAME,
  STATUS_LABEL,
  STUDENT_STATUSES,
} from "@brillianda/core";
import {
  and,
  asc,
  auditLog,
  counters,
  desc,
  enrolments,
  eq,
  guardians,
  inArray,
  isNotNull,
  isNull,
  ne,
  schools,
  sql,
  studentGuardians,
  students,
  users,
  type Tx,
} from "@brillianda/db";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { AppEnv } from "../context.js";
import { ApiError, problemContent } from "../lib/errors.js";
import type { ResolvedSchool } from "../lib/school-directory.js";
import { schoolRoute } from "../school-route.js";
import { attendanceOf, lagosToday, parentAccessOf, termsOf } from "../lib/attendance.js";
import { currentSession } from "./calendar.js";
import { armOptions } from "./classes.js";

export const studentRoutes = new OpenAPIHono<AppEnv>();

// ── Input ───────────────────────────────────────────────────────────────────────────────────────

const clean = (v: unknown) => (typeof v === "string" ? v.normalize("NFC").trim().replace(/\s+/g, " ") : v);
const PersonName = (label: string) =>
  z.preprocess(clean, z.string().min(1, `Enter the ${label}`).max(60, "Use at most 60 characters").regex(PERSON_NAME, "Letters, spaces, hyphens and apostrophes only"));
const OptionalName = z.preprocess(
  clean,
  z.union([z.literal(""), z.string().max(60, "Use at most 60 characters").regex(PERSON_NAME, "Letters, spaces, hyphens and apostrophes only")]),
);
const realDay = (v: string) => {
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
};
const Day = z.union([z.literal(""), z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Choose a date").refine(realDay, "Choose a date")]);
const Text = (max: number) => z.string().trim().max(max, `Use at most ${max} characters`);
const Id = z.string().uuid("Invalid id");

/** The frontend's studentSchema. Gender is accepted in any case (MALE or male) and stored lowercase. */
const StudentInputSchema = z
  .object({
    firstName: PersonName("first name"),
    lastName: PersonName("last name"),
    otherNames: OptionalName.default(""),
    gender: z.preprocess((v) => (typeof v === "string" ? v.toLowerCase() : v), z.enum(GENDERS, { message: "Choose Male or Female" })),
    armId: z.string().min(1, "Choose a class"),
    dateOfBirth: Day.default(""),
    admissionNo: Text(30).default(""),
    admissionDate: Day.default(""),
    address: Text(200).default(""),
    stateOfOrigin: z.union([z.literal(""), z.enum(NIGERIAN_STATES, { message: "Choose a state" })]).default(""),
    guardianId: z.union([z.literal(""), z.string().uuid("Choose a guardian from the list")]).default(""),
    guardianName: Text(120).default(""),
    guardianPhone: z.string().trim().default(""),
    guardianEmail: z.union([z.literal(""), z.string().trim().email("Check this email address")]).default(""),
  })
  .superRefine((s, ctx) => {
    if (s.guardianPhone && !normaliseNigerianPhone(s.guardianPhone)) ctx.addIssue({ code: "custom", path: ["guardianPhone"], message: "Enter a Nigerian number, e.g. 0803 000 0001" });
    if (s.dateOfBirth && s.dateOfBirth > lagosToday()) ctx.addIssue({ code: "custom", path: ["dateOfBirth"], message: "A birth date can’t be in the future" });
    if ((s.guardianPhone || s.guardianEmail) && !s.guardianName && !s.guardianId) ctx.addIssue({ code: "custom", path: ["guardianName"], message: "Add the guardian’s name too" });
  })
  .openapi("StudentInput");
type StudentInput = z.infer<typeof StudentInputSchema>;

/** Today in Lagos (UTC+1, no daylight saving), as an ISO day. */
export { lagosToday };

// ── Output ──────────────────────────────────────────────────────────────────────────────────────

const StudentRowSchema = z
  .object({
    id: z.string().uuid(),
    fullName: z.string(),
    admissionNo: z.string(),
    gender: z.enum(GENDERS),
    status: z.enum(STUDENT_STATUSES),
    armId: z.string().uuid(),
    dateOfBirth: z.string().openapi({ description: "ISO day, or \"\" when unknown" }),
    guardianName: z.string().nullable(),
    guardianPhone: z.string().nullable(),
  })
  .openapi("StudentRow");
const ArmOptionSchema = z
  .object({ id: z.string().uuid(), label: z.string(), chip: z.string(), levelId: z.string().uuid(), levelName: z.string(), levelPosition: z.number().int() })
  .openapi("ArmOption");
const ChangeEntrySchema = z.object({ id: z.string().uuid(), at: z.string(), who: z.string(), what: z.string() });
const StudentDetailSchema = StudentRowSchema.extend({
  firstName: z.string(),
  lastName: z.string(),
  otherNames: z.string(),
  admissionDate: z.string(),
  address: z.string(),
  stateOfOrigin: z.string(),
  guardian: z
    .object({
      id: z.string().uuid(),
      name: z.string(),
      phone: z.string().nullable(),
      email: z.string().nullable(),
      siblings: z.array(z.object({ id: z.string().uuid(), fullName: z.string(), armLabel: z.string() })),
      parentAccess: z.enum(["none", "invited", "active"]).openapi({ description: "Whether this guardian uses the parent app" }),
    })
    .nullable(),
  attendance: z
    .object({ term: z.string(), days: z.number().int(), present: z.number().int(), late: z.number().int(), absent: z.number().int() })
    .nullable()
    .openapi({ description: "This term's register marks (late counts as present); null outside a term" }),
  classHistory: z.array(z.object({ armLabel: z.string(), from: z.string() })),
  changes: z.array(ChangeEntrySchema).openapi({ description: "Changes to this student, newest first" }),
}).openapi("StudentDetail");
const AdmissionSettingsSchema = z
  .object({ pattern: z.string(), digits: z.number().int(), next: z.number().int(), preview: z.string() })
  .openapi("AdmissionSettings");

const errors = {
  401: problemContent("Not signed in to this school"),
  403: problemContent("Not allowed"),
  404: problemContent("No such student here"),
} as const;
const json = <T extends z.ZodTypeAny>(schema: T) => ({ content: { "application/json": { schema } }, required: true });
const ok = <T extends z.ZodTypeAny>(description: string, schema: T) => ({ description, content: { "application/json": { schema } } });
const fieldError = (pointer: string, detail: string, message: string) =>
  new ApiError("validation_failed", message, { extensions: { errors: [{ pointer, detail, code: "invalid" }] } });

// ── Admission numbers ───────────────────────────────────────────────────────────────────────────

type AdmissionFormat = { pattern: string; digits: number };

export async function admissionFormat(tx: Tx, school: ResolvedSchool): Promise<AdmissionFormat> {
  const [row] = await tx.select({ settings: schools.settings }).from(schools).where(eq(schools.id, school.id));
  const saved = row?.settings?.admission as Partial<AdmissionFormat> | undefined;
  if (saved?.pattern && saved.digits) return { pattern: saved.pattern, digits: saved.digits };
  return { pattern: defaultAdmissionPattern(school.name), digits: 4 };
}

async function peekCounter(tx: Tx): Promise<number> {
  const [row] = await tx.select({ next: counters.nextValue }).from(counters).where(eq(counters.name, "admission"));
  return row?.next ?? 1;
}

/** Takes the school's next number. Row-locked, so two admins adding at once never share one. */
async function takeCounter(tx: Tx, schoolId: string): Promise<number> {
  const result = await tx.execute<{ taken: number }>(sql`
    insert into counters (id, school_id, name, next_value) values (gen_random_uuid(), ${schoolId}, 'admission', 2)
    on conflict (school_id, name) do update set next_value = counters.next_value + 1, updated_at = now()
    returning next_value - 1 as taken`);
  return Number(result.rows[0]!.taken);
}

async function admissionTaken(tx: Tx, admissionNo: string, exceptId?: string): Promise<boolean> {
  const [hit] = await tx
    .select({ id: students.id })
    .from(students)
    .where(and(sql`lower(${students.admissionNumber}) = lower(${admissionNo.trim()})`, isNull(students.deletedAt), exceptId ? ne(students.id, exceptId) : undefined))
    .limit(1);
  return !!hit;
}

/** The school's next free admission number, taken from its counter. */
export async function nextAdmissionNumber(tx: Tx, school: ResolvedSchool): Promise<string> {
  const format = await admissionFormat(tx, school);
  const year = (await currentSession(tx)).startYear;
  for (;;) {
    const candidate = formatAdmissionNo(format, year, await takeCounter(tx, school.id));
    if (!(await admissionTaken(tx, candidate))) return candidate;
  }
}

async function admissionSettings(tx: Tx, school: ResolvedSchool) {
  const format = await admissionFormat(tx, school);
  const next = await peekCounter(tx);
  const year = (await currentSession(tx)).startYear;
  return { ...format, next, preview: formatAdmissionNo(format, year, next) };
}

// ── Reads ───────────────────────────────────────────────────────────────────────────────────────

async function primaryGuardians(tx: Tx, studentIds: string[]) {
  if (!studentIds.length) return new Map<string, typeof guardians.$inferSelect>();
  const rows = await tx
    .select({ studentId: studentGuardians.studentId, guardian: guardians })
    .from(studentGuardians)
    .innerJoin(guardians, and(eq(guardians.schoolId, studentGuardians.schoolId), eq(guardians.id, studentGuardians.guardianId)))
    .where(and(inArray(studentGuardians.studentId, studentIds), eq(studentGuardians.primaryContact, true)));
  return new Map(rows.map((r) => [r.studentId, r.guardian]));
}

type StudentRecord = typeof students.$inferSelect;
function toRow(s: StudentRecord, g: typeof guardians.$inferSelect | undefined) {
  return {
    id: s.id,
    fullName: fullName(s),
    admissionNo: s.admissionNumber,
    gender: s.gender,
    status: s.status,
    armId: s.classArmId,
    dateOfBirth: s.dateOfBirth ?? "",
    guardianName: g?.fullName ?? null,
    guardianPhone: g?.phone ?? null,
  };
}

async function studentOr404(tx: Tx, id: string) {
  const [s] = await tx.select().from(students).where(and(eq(students.id, id), isNull(students.deletedAt))).limit(1);
  if (!s) throw new ApiError("not_found", "That student isn’t here any more.");
  return s;
}

studentRoutes.openapi(
  createRoute({
    method: "get",
    path: "/v1/students",
    tags: ["students"],
    summary: "Every student not deleted (by name), the classes they can sit in, and the next admission number",
    responses: {
      200: ok("Students", z.object({ students: z.array(StudentRowSchema), arms: z.array(ArmOptionSchema), nextAdmissionNo: z.string() }).openapi("StudentsList")),
      ...errors,
    },
  }),
  async (c) => {
    const data = await schoolRoute(c, {}, async ({ tx, school }) => {
      const rows = await tx.select().from(students).where(isNull(students.deletedAt)).orderBy(asc(students.firstName), asc(students.otherNames), asc(students.lastName));
      const g = await primaryGuardians(tx, rows.map((r) => r.id));
      const settings = await admissionSettings(tx, school);
      return { students: rows.map((s) => toRow(s, g.get(s.id))), arms: await armOptions(tx), nextAdmissionNo: settings.preview };
    });
    return c.json(data, 200);
  },
);

studentRoutes.openapi(
  createRoute({
    method: "get",
    path: "/v1/students/{id}",
    tags: ["students"],
    summary: "One student: details, guardian with siblings, classes over time and changes",
    request: { params: z.object({ id: Id }) },
    responses: { 200: ok("Student", StudentDetailSchema), ...errors },
  }),
  async (c) => {
    const { id } = c.req.valid("param");
    const data = await schoolRoute(c, {}, async ({ tx }) => {
      const s = await studentOr404(tx, id);
      const guardian = (await primaryGuardians(tx, [id])).get(id);
      const labels = new Map((await armOptions(tx, { all: true })).map((a) => [a.id, a.label]));
      let siblings: { id: string; fullName: string; armLabel: string }[] = [];
      if (guardian) {
        const rows = await tx
          .select({ student: students })
          .from(studentGuardians)
          .innerJoin(students, and(eq(students.schoolId, studentGuardians.schoolId), eq(students.id, studentGuardians.studentId)))
          .where(and(eq(studentGuardians.guardianId, guardian.id), ne(students.id, id), isNull(students.deletedAt)));
        siblings = rows.map(({ student }) => ({ id: student.id, fullName: fullName(student), armLabel: labels.get(student.classArmId) ?? "A class that was removed" }));
      }
      const history = await tx.select().from(enrolments).where(eq(enrolments.studentId, id)).orderBy(asc(enrolments.startedOn), asc(enrolments.createdAt));
      const changes = await tx
        .select({ id: auditLog.id, at: auditLog.createdAt, who: sql<string | null>`coalesce(${users.fullName}, ${auditLog.actorName})`, what: auditLog.summary })
        .from(auditLog)
        .leftJoin(users, eq(users.id, auditLog.actorUserId))
        .where(and(eq(auditLog.entity, "student"), eq(auditLog.entityId, id), isNotNull(auditLog.summary)))
        .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
        .limit(200);
      const access = guardian ? (await parentAccessOf(tx, [guardian.id])).get(guardian.id)! : "none";
      const attendance = (await attendanceOf(tx, [id], await termsOf(tx), lagosToday())).get(id) ?? null;
      return {
        ...toRow(s, guardian),
        firstName: s.firstName,
        lastName: s.lastName,
        otherNames: s.otherNames,
        admissionDate: s.admissionDate,
        address: s.address,
        stateOfOrigin: s.stateOfOrigin,
        guardian: guardian ? { id: guardian.id, name: guardian.fullName, phone: guardian.phone, email: guardian.email, siblings, parentAccess: access } : null,
        attendance,
        classHistory: history.map((e) => ({ armLabel: labels.get(e.classArmId) ?? "A class that was removed", from: e.startedOn })),
        changes: changes.map((x) => ({ id: x.id, at: x.at.toISOString(), who: x.who ?? "Someone", what: x.what! })),
      };
    });
    return c.json(data, 200);
  },
);

studentRoutes.openapi(
  createRoute({
    method: "get",
    path: "/v1/guardians",
    tags: ["students"],
    summary: "A guardian already on file with this phone number, so a sibling can share them",
    request: { query: z.object({ phone: z.string().max(32) }) },
    responses: {
      200: ok(
        "The match, or null",
        z.object({ guardian: z.object({ id: z.string().uuid(), name: z.string(), phone: z.string(), children: z.array(z.string()).openapi({ description: "First names" }) }).nullable() }).openapi("GuardianMatch"),
      ),
      ...errors,
    },
  }),
  async (c) => {
    const { phone } = c.req.valid("query");
    const guardian = await schoolRoute(c, {}, async ({ tx }) => {
      const normalised = normaliseNigerianPhone(phone);
      if (!normalised) return null;
      const [g] = await tx.select().from(guardians).where(eq(guardians.phone, normalised)).orderBy(asc(guardians.createdAt)).limit(1);
      if (!g) return null;
      const children = await tx
        .select({ firstName: students.firstName })
        .from(studentGuardians)
        .innerJoin(students, and(eq(students.schoolId, studentGuardians.schoolId), eq(students.id, studentGuardians.studentId)))
        .where(and(eq(studentGuardians.guardianId, g.id), isNull(students.deletedAt)));
      return { id: g.id, name: g.fullName, phone: normalised, children: children.map((x) => x.firstName) };
    });
    return c.json({ guardian }, 200);
  },
);

// ── Writes ──────────────────────────────────────────────────────────────────────────────────────

async function requireOpenArm(tx: Tx, armId: string) {
  const arm = (await armOptions(tx)).find((a) => a.id === armId);
  if (!arm) throw fieldError("#/armId", "Choose a class", "That class isn’t open any more.");
  return arm;
}

/** The guardian a student's form points at: one on file (guardianId), a new one (guardianName), or none. */
async function guardianFor(tx: Tx, schoolId: string, userId: string, input: StudentInput): Promise<string | null> {
  if (input.guardianId) {
    const [g] = await tx.select({ id: guardians.id }).from(guardians).where(eq(guardians.id, input.guardianId)).limit(1);
    if (g) return g.id;
    throw fieldError("#/guardianId", "That guardian isn’t here any more", "That guardian isn’t here any more. Search by phone again.");
  }
  if (!input.guardianName) return null;
  const [g] = await tx
    .insert(guardians)
    .values({ schoolId, fullName: input.guardianName, phone: normaliseNigerianPhone(input.guardianPhone), email: input.guardianEmail || null, createdBy: userId, updatedBy: userId })
    .returning({ id: guardians.id });
  return g!.id;
}

async function linkGuardian(tx: Tx, schoolId: string, userId: string, studentId: string, guardianId: string | null) {
  await tx.delete(studentGuardians).where(eq(studentGuardians.studentId, studentId));
  if (guardianId) await tx.insert(studentGuardians).values({ schoolId, studentId, guardianId, primaryContact: true, createdBy: userId, updatedBy: userId });
}

studentRoutes.openapi(
  createRoute({
    method: "post",
    path: "/v1/students",
    tags: ["students"],
    summary: "Add a student. A blank admission number takes the school's next one",
    request: { body: json(StudentInputSchema) },
    responses: {
      201: ok("Added", z.object({ id: z.string().uuid(), admissionNo: z.string(), fullName: z.string() })),
      422: problemContent("A field needs fixing, e.g. the admission number is taken"),
      ...errors,
    },
  }),
  async (c) => {
    const input = c.req.valid("json");
    const data = await schoolRoute(c, {}, async ({ tx, school, auth, audit }) => {
      await requireOpenArm(tx, input.armId);
      let admissionNo = input.admissionNo;
      if (admissionNo) {
        if (await admissionTaken(tx, admissionNo)) throw fieldError("#/admissionNo", "Already used by another student", "Another student has this admission number.");
      } else {
        admissionNo = await nextAdmissionNumber(tx, school);
      }
      const admissionDate = input.admissionDate || lagosToday();
      const by = { createdBy: auth.user.id, updatedBy: auth.user.id };
      const [s] = await tx
        .insert(students)
        .values({
          schoolId: school.id,
          admissionNumber: admissionNo,
          firstName: input.firstName,
          lastName: input.lastName,
          otherNames: input.otherNames,
          gender: input.gender,
          dateOfBirth: input.dateOfBirth || null,
          admissionDate,
          classArmId: input.armId,
          address: input.address,
          stateOfOrigin: input.stateOfOrigin,
          ...by,
        })
        .returning();
      await linkGuardian(tx, school.id, auth.user.id, s!.id, await guardianFor(tx, school.id, auth.user.id, input));
      await tx.insert(enrolments).values({ schoolId: school.id, studentId: s!.id, classArmId: input.armId, startedOn: admissionDate, ...by });
      const name = fullName(s!);
      audit({ action: "student.added", entity: "student", entityId: s!.id, changes: { admissionNo, armId: input.armId }, summary: `Added ${name}` });
      return { id: s!.id, admissionNo, fullName: name };
    });
    return c.json(data, 201);
  },
);

studentRoutes.openapi(
  createRoute({
    method: "put",
    path: "/v1/students/{id}",
    tags: ["students"],
    summary: "Edit a student. A new class is added to the class history",
    request: { params: z.object({ id: Id }), body: json(StudentInputSchema) },
    responses: { 204: { description: "Saved" }, 422: problemContent("A field needs fixing"), ...errors },
  }),
  async (c) => {
    const { id } = c.req.valid("param");
    const input = c.req.valid("json");
    await schoolRoute(c, {}, async ({ tx, school, auth, audit }) => {
      const s = await studentOr404(tx, id);
      const admissionNo = input.admissionNo || s.admissionNumber;
      if (await admissionTaken(tx, admissionNo, id)) throw fieldError("#/admissionNo", "Already used by another student", "Another student has this admission number.");
      const moved = s.classArmId !== input.armId;
      const arm = moved ? await requireOpenArm(tx, input.armId) : undefined;
      await tx
        .update(students)
        .set({
          firstName: input.firstName,
          lastName: input.lastName,
          otherNames: input.otherNames,
          gender: input.gender,
          dateOfBirth: input.dateOfBirth || null,
          admissionNumber: admissionNo,
          admissionDate: input.admissionDate || s.admissionDate,
          address: input.address,
          stateOfOrigin: input.stateOfOrigin,
          classArmId: input.armId,
          updatedBy: auth.user.id,
        })
        .where(eq(students.id, id));

      // Guardian, as the fake does it: pick another on file, edit the one linked, or add one.
      if (input.guardianId || input.guardianName) {
        const existing = (await primaryGuardians(tx, [id])).get(id);
        if (input.guardianId && input.guardianId !== existing?.id) {
          await linkGuardian(tx, school.id, auth.user.id, id, await guardianFor(tx, school.id, auth.user.id, input));
        } else if (existing && !input.guardianId) {
          await tx
            .update(guardians)
            .set({ fullName: input.guardianName, phone: normaliseNigerianPhone(input.guardianPhone), email: input.guardianEmail || null, updatedBy: auth.user.id })
            .where(eq(guardians.id, existing.id));
        } else if (!existing) {
          await linkGuardian(tx, school.id, auth.user.id, id, await guardianFor(tx, school.id, auth.user.id, input));
        }
      }

      const name = fullName(input);
      if (moved) {
        await moveEnrolment(tx, school.id, auth.user.id, id, input.armId);
        audit({ action: "student.moved", entity: "student", entityId: id, changes: { from: s.classArmId, to: input.armId }, summary: `Moved ${name} to ${arm!.label}` });
      }
      audit({ action: "student.updated", entity: "student", entityId: id, changes: { admissionNo }, summary: `Updated ${name}’s details` });
    });
    return c.body(null, 204);
  },
);

async function moveEnrolment(tx: Tx, schoolId: string, userId: string, studentId: string, armId: string) {
  const today = lagosToday();
  await tx.update(enrolments).set({ endedOn: today, updatedBy: userId }).where(and(eq(enrolments.studentId, studentId), isNull(enrolments.endedOn)));
  await tx.insert(enrolments).values({ schoolId, studentId, classArmId: armId, startedOn: today, createdBy: userId, updatedBy: userId });
}

const StudentIds = z.array(Id).min(1, "Pick at least one student").max(5000);

studentRoutes.openapi(
  createRoute({
    method: "post",
    path: "/v1/students/move",
    tags: ["students"],
    summary: "Move several students to one class",
    request: { body: json(z.object({ studentIds: StudentIds, armId: z.string().min(1, "Choose a class") }).openapi("MoveStudents")) },
    responses: { 200: ok("Moved", z.object({ moved: z.number().int() })), 409: problemContent("That class isn't open"), ...errors },
  }),
  async (c) => {
    const { studentIds, armId } = c.req.valid("json");
    const moved = await schoolRoute(c, {}, async ({ tx, school, auth, audit }) => {
      const arm = (await armOptions(tx)).find((a) => a.id === armId);
      if (!arm) throw new ApiError("conflict", "That class isn’t open any more.");
      const rows = await tx
        .select()
        .from(students)
        .where(and(inArray(students.id, studentIds), isNull(students.deletedAt), ne(students.classArmId, armId)));
      if (!rows.length) return 0;
      await tx.update(students).set({ classArmId: armId, updatedBy: auth.user.id }).where(inArray(students.id, rows.map((r) => r.id)));
      for (const s of rows) {
        await moveEnrolment(tx, school.id, auth.user.id, s.id, armId);
        audit({ action: "student.moved", entity: "student", entityId: s.id, changes: { from: s.classArmId, to: armId }, summary: `Moved ${fullName(s)} to ${arm.label}` });
      }
      if (rows.length > 1) audit({ action: "students.moved", entity: "school", entityId: school.id, changes: { count: rows.length, to: armId }, summary: `Moved ${rows.length} students to ${arm.label}` });
      return rows.length;
    });
    return c.json({ moved }, 200);
  },
);

studentRoutes.openapi(
  createRoute({
    method: "post",
    path: "/v1/students/status",
    tags: ["students"],
    summary: "Change several students' status: active, suspended, withdrawn, transferred or graduated",
    request: { body: json(z.object({ studentIds: StudentIds, status: z.enum(STUDENT_STATUSES) }).openapi("StudentStatusChange")) },
    responses: { 200: ok("Changed", z.object({ changed: z.number().int() })), ...errors },
  }),
  async (c) => {
    const { studentIds, status } = c.req.valid("json");
    const changed = await schoolRoute(c, {}, async ({ tx, auth, audit }) => {
      const rows = await tx
        .select()
        .from(students)
        .where(and(inArray(students.id, studentIds), isNull(students.deletedAt), ne(students.status, status)));
      if (!rows.length) return 0;
      await tx.update(students).set({ status, updatedBy: auth.user.id }).where(inArray(students.id, rows.map((r) => r.id)));
      for (const s of rows) {
        audit({ action: "student.status_changed", entity: "student", entityId: s.id, changes: { from: s.status, to: status }, summary: `Marked ${fullName(s)} as ${STATUS_LABEL[status].toLowerCase()}` });
      }
      return rows.length;
    });
    return c.json({ changed }, 200);
  },
);

studentRoutes.openapi(
  createRoute({
    method: "delete",
    path: "/v1/students/{id}",
    tags: ["students"],
    summary: "Delete a student added by mistake. Soft: the record stays, hidden. Leaving the school is a status instead",
    request: { params: z.object({ id: Id }) },
    responses: { 204: { description: "Deleted" }, ...errors },
  }),
  async (c) => {
    const { id } = c.req.valid("param");
    await schoolRoute(c, {}, async ({ tx, auth, audit }) => {
      const s = await studentOr404(tx, id);
      await tx.update(students).set({ deletedAt: new Date(), updatedBy: auth.user.id }).where(eq(students.id, id));
      audit({ action: "student.deleted", entity: "student", entityId: id, changes: { admissionNo: s.admissionNumber }, summary: `Deleted ${fullName(s)}, added by mistake` });
    });
    return c.body(null, 204);
  },
);

// ── Admission number format ─────────────────────────────────────────────────────────────────────

studentRoutes.openapi(
  createRoute({
    method: "get",
    path: "/v1/admission-numbers",
    tags: ["students"],
    summary: "The school's admission number format, its next number and a preview",
    responses: { 200: ok("Settings", AdmissionSettingsSchema), ...errors },
  }),
  async (c) => {
    const data = await schoolRoute(c, {}, ({ tx, school }) => admissionSettings(tx, school));
    return c.json(data, 200);
  },
);

studentRoutes.openapi(
  createRoute({
    method: "put",
    path: "/v1/admission-numbers",
    tags: ["students"],
    summary: "Set the format: {YEAR} is the session's first year, {NUMBER} the running count padded to `digits`",
    request: {
      body: json(
        z
          .object({ pattern: z.string().max(60), digits: z.number().int() })
          .superRefine((f, ctx) => {
            for (const message of admissionPatternProblems(f)) ctx.addIssue({ code: "custom", path: ["pattern"], message });
          })
          .openapi("AdmissionFormat"),
      ),
    },
    responses: { 200: ok("Saved", AdmissionSettingsSchema), 422: problemContent("The pattern can't be used"), ...errors },
  }),
  async (c) => {
    const { pattern, digits } = c.req.valid("json");
    const data = await schoolRoute(c, {}, async ({ tx, school, audit }) => {
      const value = { pattern: pattern.trim(), digits };
      await tx
        .update(schools)
        .set({ settings: sql`${schools.settings} || jsonb_build_object('admission', ${JSON.stringify(value)}::jsonb)` })
        .where(eq(schools.id, school.id));
      audit({ action: "admission_format.set", entity: "school", entityId: school.id, changes: value, summary: `Set admission numbers to ${value.pattern}` });
      return admissionSettings(tx, school);
    });
    return c.json(data, 200);
  },
);
