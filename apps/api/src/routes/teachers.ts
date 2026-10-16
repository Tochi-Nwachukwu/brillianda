/**
 * Teachers and the daily register (C1 in the front end's backend-requirements.md; shapes and rules
 * follow its src/data/fake/teaching.ts and packages/core/src/attendance.ts).
 *
 * Owners and admins:
 *   GET    /v1/teachers                                    the Teachers page
 *   DELETE /v1/teachers/{id}                               remove a teacher, or cancel their invite
 *   PUT    /v1/arms/{armId}/form-teacher                   { userId | null }
 *   PUT    /v1/teachers/{id}/subject-classes               [{ armId, subjectId }]: their whole list
 *   GET    /v1/registers/today                             Home's register card
 * Owners, admins and the arm's form teacher:
 *   GET    /v1/arms/{armId}/register?date=                 one day's register
 *   PUT    /v1/arms/{armId}/register                       save it
 * Teachers (and anyone on the staff):
 *   GET    /v1/me/teaching                                 a teacher's home
 *   GET    /v1/arms/{armId}/subjects/{subjectId}/students  a subject class (its teacher, or admins)
 *
 * Teachers are invited with POST /v1/invitations { role: "teacher" }.
 */
import { attendanceSummary, fullName, latestSchoolDay, MARKS, registerDayProblem, schoolDaysSoFar, termOf } from "@brillianda/core";
import {
  and,
  armFormTeachers,
  asc,
  count,
  eq,
  gt,
  gte,
  inArray,
  invitations,
  isNull,
  lte,
  or,
  registerMarks,
  registers,
  schoolMembers,
  schoolSubjects,
  students,
  subjectTeachers,
  users,
  type Tx,
} from "@brillianda/db";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { ValidSession } from "@brillianda/auth";
import type { AppEnv } from "../context.js";
import { ApiError, problemContent } from "../lib/errors.js";
import { schoolRoute, type Role } from "../school-route.js";
import { armOptions, type ArmOption } from "./classes.js";
import { lagosToday, termsOf } from "../lib/attendance.js";

export const teacherRoutes = new OpenAPIHono<AppEnv>();

const ADMINS: readonly Role[] = ["owner", "admin"];
const STAFF: readonly Role[] = ["owner", "admin", "teacher"];
const Id = z.string().uuid("Invalid id");
const Day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Pick a day")
  .refine((d) => !Number.isNaN(Date.parse(`${d}T12:00:00Z`)) && new Date(`${d}T12:00:00Z`).toISOString().slice(0, 10) === d, "Pick a real day");
const json = <T extends z.ZodTypeAny>(schema: T) => ({ content: { "application/json": { schema } }, required: true });
const ok = <T extends z.ZodTypeAny>(description: string, schema: T) => ({ description, content: { "application/json": { schema } } });

const errors = {
  401: problemContent("Not signed in to this school"),
  403: problemContent("This role can't do this"),
  404: problemContent("No such class, subject or teacher here"),
} as const;

const fieldError = (pointer: string, detail: string) =>
  new ApiError("validation_failed", detail, { extensions: { errors: [{ pointer, detail, code: "invalid" }] } });

// ——— Shared reads ———

/** Active students in a class, by last name then first name, as the register lists them. */
async function studentsIn(tx: Tx, armId: string) {
  const rows = await tx
    .select({ id: students.id, firstName: students.firstName, otherNames: students.otherNames, lastName: students.lastName, admissionNo: students.admissionNumber })
    .from(students)
    .where(and(eq(students.classArmId, armId), eq(students.status, "active"), isNull(students.deletedAt)))
    .orderBy(asc(students.lastName), asc(students.firstName), asc(students.id));
  return rows.map((s) => ({ id: s.id, fullName: fullName(s), admissionNo: s.admissionNo }));
}

async function activeCounts(tx: Tx, armIds: string[]): Promise<Map<string, number>> {
  if (!armIds.length) return new Map();
  const rows = await tx
    .select({ armId: students.classArmId, n: count() })
    .from(students)
    .where(and(inArray(students.classArmId, armIds), eq(students.status, "active"), isNull(students.deletedAt)))
    .groupBy(students.classArmId);
  return new Map(rows.map((r) => [r.armId, r.n]));
}

async function teacherById(tx: Tx, userId: string) {
  const [row] = await tx
    .select({ id: users.id, fullName: users.fullName, email: users.email })
    .from(schoolMembers)
    .innerJoin(users, eq(users.id, schoolMembers.userId))
    .where(and(eq(schoolMembers.userId, userId), eq(schoolMembers.role, "teacher"), eq(schoolMembers.status, "active")))
    .limit(1);
  return row;
}

function armOf(arms: ArmOption[], armId: string): ArmOption {
  const arm = arms.find((a) => a.id === armId);
  if (!arm) throw new ApiError("not_found", "That class isn’t here any more.");
  return arm;
}

/** Owners and admins may open any register; a teacher only their own form classes'. */
async function requireRegisterAccess(tx: Tx, auth: ValidSession, armId: string): Promise<void> {
  if (auth.membership.role !== "teacher") return;
  const [mine] = await tx
    .select({ id: armFormTeachers.id })
    .from(armFormTeachers)
    .where(and(eq(armFormTeachers.classArmId, armId), eq(armFormTeachers.userId, auth.user.id)))
    .limit(1);
  if (!mine) throw new ApiError("forbidden", "Only this class’s form teacher, or an admin, can open its register.");
}

// ——— The Teachers page ———

const ArmRef = z.object({ armId: z.string().uuid(), label: z.string() });
const TeacherSummarySchema = z
  .object({
    id: z.string().uuid().openapi({ description: "The user id; for an open invite, the invitation id" }),
    fullName: z.string().openapi({ description: "Empty for an invite sent without a name" }),
    email: z.string().email(),
    status: z.enum(["active", "invited"]),
    invitedAt: z.number().int().optional().openapi({ description: "Invites only: when it was sent (ms since epoch)" }),
    formArms: z.array(ArmRef),
    subjectClasses: z.array(z.object({ armId: z.string().uuid(), subjectId: z.string().uuid(), label: z.string().openapi({ example: "Mathematics, JSS 1 Gold" }) })),
  })
  .openapi("TeacherSummary");
const TeachersPageSchema = z
  .object({
    teachers: z.array(TeacherSummarySchema).openapi({ description: "Teachers by name, then open invites" }),
    arms: z.array(z.object({ id: z.string().uuid(), label: z.string(), formTeacherId: z.string().uuid().nullable() })),
    subjects: z.array(z.object({ id: z.string().uuid(), name: z.string(), code: z.string() })),
  })
  .openapi("TeachersPage");

teacherRoutes.openapi(
  createRoute({
    method: "get",
    path: "/v1/teachers",
    tags: ["teachers"],
    summary: "The Teachers page: teachers and open invites with what they teach, every class with its form teacher, the subjects",
    responses: { 200: ok("Teachers", TeachersPageSchema), ...errors },
  }),
  async (c) => {
    const data = await schoolRoute(c, { roles: ADMINS }, async ({ tx }) => {
      const arms = await armOptions(tx);
      const armIds = new Set(arms.map((a) => a.id));
      const label = (armId: string) => arms.find((a) => a.id === armId)?.label ?? "an old class";
      const subjects = await tx.select({ id: schoolSubjects.id, name: schoolSubjects.name, code: schoolSubjects.code }).from(schoolSubjects).orderBy(asc(schoolSubjects.position), asc(schoolSubjects.name));
      const subjectName = (id: string) => subjects.find((s) => s.id === id)?.name ?? "a subject";
      const people = await tx
        .select({ id: users.id, fullName: users.fullName, email: users.email })
        .from(schoolMembers)
        .innerJoin(users, eq(users.id, schoolMembers.userId))
        .where(and(eq(schoolMembers.role, "teacher"), eq(schoolMembers.status, "active")))
        .orderBy(asc(users.fullName))
        .limit(1000);
      const forms = await tx.select({ armId: armFormTeachers.classArmId, userId: armFormTeachers.userId }).from(armFormTeachers);
      const classes = await tx
        .select({ armId: subjectTeachers.classArmId, subjectId: subjectTeachers.schoolSubjectId, userId: subjectTeachers.userId })
        .from(subjectTeachers);
      const invites = await tx
        .select({ id: invitations.id, fullName: invitations.fullName, email: invitations.email, createdAt: invitations.createdAt })
        .from(invitations)
        .where(and(eq(invitations.role, "teacher"), isNull(invitations.acceptedAt), isNull(invitations.revokedAt), gt(invitations.expiresAt, new Date())))
        .orderBy(asc(invitations.createdAt));
      return {
        teachers: [
          ...people.map((u) => ({
            id: u.id,
            fullName: u.fullName,
            email: u.email,
            status: "active" as const,
            formArms: forms.filter((f) => f.userId === u.id && armIds.has(f.armId)).map((f) => ({ armId: f.armId, label: label(f.armId) })),
            subjectClasses: classes
              .filter((t) => t.userId === u.id && armIds.has(t.armId))
              .map((t) => ({ armId: t.armId, subjectId: t.subjectId, label: `${subjectName(t.subjectId)}, ${label(t.armId)}` })),
          })),
          ...invites.map((i) => ({
            id: i.id,
            fullName: i.fullName ?? "",
            email: i.email,
            status: "invited" as const,
            invitedAt: i.createdAt.getTime(),
            formArms: [],
            subjectClasses: [],
          })),
        ],
        arms: arms.map((a) => ({ id: a.id, label: a.label, formTeacherId: forms.find((f) => f.armId === a.id)?.userId ?? null })),
        subjects,
      };
    });
    return c.json(data, 200);
  },
);

teacherRoutes.openapi(
  createRoute({
    method: "delete",
    path: "/v1/teachers/{id}",
    tags: ["teachers"],
    summary: "Remove a teacher (their classes are freed; registers they took keep their name), or cancel a teacher invite",
    request: { params: z.object({ id: Id }) },
    responses: { 204: { description: "Removed" }, ...errors },
  }),
  async (c) => {
    const { id } = c.req.valid("param");
    await schoolRoute(c, { roles: ADMINS }, async ({ tx, auth, audit }) => {
      const [invite] = await tx
        .update(invitations)
        .set({ revokedAt: new Date(), updatedBy: auth.user.id })
        .where(and(eq(invitations.id, id), eq(invitations.role, "teacher"), isNull(invitations.acceptedAt), isNull(invitations.revokedAt)))
        .returning({ id: invitations.id, email: invitations.email, fullName: invitations.fullName });
      if (invite) {
        audit({ action: "invitation.revoked", entity: "invitation", entityId: invite.id, changes: { email: invite.email, role: "teacher" }, summary: `Cancelled ${invite.fullName || invite.email}’s teacher invite` });
        return;
      }
      const teacher = await teacherById(tx, id);
      if (!teacher) throw new ApiError("not_found", "They aren’t a teacher here any more.");
      // Form and subject classes go with the membership (composite keys cascade), and so do their
      // sessions here (sessions_membership_fk), so they are signed out at once.
      await tx.delete(schoolMembers).where(and(eq(schoolMembers.userId, id), eq(schoolMembers.role, "teacher")));
      audit({ action: "member.removed", entity: "user", entityId: id, changes: { email: teacher.email, fullName: teacher.fullName, role: "teacher" }, summary: `Removed ${teacher.fullName} as a teacher` });
    });
    return c.body(null, 204);
  },
);

teacherRoutes.openapi(
  createRoute({
    method: "put",
    path: "/v1/arms/{armId}/form-teacher",
    tags: ["teachers"],
    summary: "Set a class's form teacher (replacing the last), or null for none",
    request: {
      params: z.object({ armId: Id }),
      body: json(z.object({ userId: Id.nullable() }).openapi("FormTeacher")),
    },
    responses: { 204: { description: "Saved" }, 422: problemContent("Not a teacher here"), ...errors },
  }),
  async (c) => {
    const { armId } = c.req.valid("param");
    const { userId } = c.req.valid("json");
    await schoolRoute(c, { roles: ADMINS }, async ({ tx, school, auth, audit }) => {
      const arm = armOf(await armOptions(tx), armId);
      const teacher = userId ? await teacherById(tx, userId) : null;
      if (userId && !teacher) throw fieldError("#/userId", "They aren’t a teacher here.");
      await tx.delete(armFormTeachers).where(eq(armFormTeachers.classArmId, armId));
      if (teacher) await tx.insert(armFormTeachers).values({ schoolId: school.id, classArmId: armId, userId: teacher.id, createdBy: auth.user.id, updatedBy: auth.user.id });
      audit({
        action: "arm.form_teacher_set",
        entity: "class_arm",
        entityId: armId,
        changes: { userId: teacher?.id ?? null },
        summary: teacher ? `Made ${teacher.fullName} form teacher of ${arm.label}` : `Left ${arm.label} without a form teacher`,
      });
    });
    return c.body(null, 204);
  },
);

const SubjectClassesSchema = z
  .array(z.object({ armId: Id, subjectId: Id }))
  .max(200, "At most 200 classes")
  .openapi("SubjectClasses", { description: "The teacher's whole list. A class taken here leaves its last teacher" });

teacherRoutes.openapi(
  createRoute({
    method: "put",
    path: "/v1/teachers/{id}/subject-classes",
    tags: ["teachers"],
    summary: "Set a teacher's whole list of subject classes. Each class's subject has one teacher, so this takes it from anyone else",
    request: { params: z.object({ id: Id }), body: json(SubjectClassesSchema) },
    responses: { 204: { description: "Saved" }, 409: problemContent("A class or subject isn't here any more"), ...errors },
  }),
  async (c) => {
    const { id } = c.req.valid("param");
    const wanted = c.req.valid("json");
    await schoolRoute(c, { roles: ADMINS }, async ({ tx, school, auth, audit }) => {
      const teacher = await teacherById(tx, id);
      if (!teacher) throw new ApiError("not_found", "They aren’t a teacher here.");
      const armIds = new Set((await armOptions(tx)).map((a) => a.id));
      const subjectIds = new Set((await tx.select({ id: schoolSubjects.id }).from(schoolSubjects)).map((s) => s.id));
      if (wanted.some((w) => !armIds.has(w.armId) || !subjectIds.has(w.subjectId))) {
        throw new ApiError("conflict", "A class or subject isn’t here any more. Reload the page.");
      }
      const key = (w: { armId: string; subjectId: string }) => `${w.armId}|${w.subjectId}`;
      const unique = [...new Map(wanted.map((w) => [key(w), w])).values()];

      // Drop the teacher's old list, and whoever had the classes now wanted.
      await tx.delete(subjectTeachers).where(eq(subjectTeachers.userId, id));
      for (let i = 0; i < unique.length; i += 100) {
        const chunk = unique.slice(i, i + 100);
        await tx
          .delete(subjectTeachers)
          .where(or(...chunk.map((w) => and(eq(subjectTeachers.classArmId, w.armId), eq(subjectTeachers.schoolSubjectId, w.subjectId)))));
        await tx.insert(subjectTeachers).values(
          chunk.map((w) => ({ schoolId: school.id, classArmId: w.armId, schoolSubjectId: w.subjectId, userId: id, createdBy: auth.user.id, updatedBy: auth.user.id })),
        );
      }
      audit({
        action: "teacher.subjects_set",
        entity: "user",
        entityId: id,
        changes: { classes: unique.length },
        summary: `Set ${teacher.fullName}’s subjects (${unique.length} ${unique.length === 1 ? "class" : "classes"})`,
      });
    });
    return c.body(null, 204);
  },
);

// ——— The register ———

const MarkEnum = z.enum(MARKS);
const RegisterSchema = z
  .object({
    armId: z.string().uuid(),
    armLabel: z.string(),
    date: z.string().openapi({ example: "2026-10-14" }),
    problem: z.string().nullable().openapi({ description: "Why this day can't be marked (a weekend, outside this term); null if it can" }),
    taken: z
      .object({
        by: z.string(),
        at: z.number().int().openapi({ description: "ms since epoch" }),
        updatedBy: z.string().optional(),
        updatedAt: z.number().int().optional(),
      })
      .nullable(),
    students: z.array(z.object({ id: z.string().uuid(), fullName: z.string(), admissionNo: z.string(), mark: MarkEnum.nullable(), note: z.string() })),
    days: z.array(z.object({ date: z.string(), taken: z.boolean() })).openapi({ description: "This term's school days so far, newest first" }),
  })
  .openapi("Register");

const SaveRegisterSchema = z
  .object({
    date: Day,
    marks: z
      .array(
        z.object({
          studentId: Id,
          mark: z.enum(MARKS, { message: "Choose present, late or absent" }),
          note: z.string().trim().max(120, "Use at most 120 characters").optional(),
        }),
      )
      .min(1, "There are no students to mark")
      .max(500),
  })
  .openapi("SaveRegister");

const whoName = (name: string | null) => name ?? "A former staff member";

teacherRoutes.openapi(
  createRoute({
    method: "get",
    path: "/v1/arms/{armId}/register",
    tags: ["registers"],
    summary: "One class's register for a day (default: the latest school day), with this term's days. Admins, or the class's form teacher",
    request: { params: z.object({ armId: Id }), query: z.object({ date: Day.optional() }) },
    responses: { 200: ok("Register", RegisterSchema), ...errors },
  }),
  async (c) => {
    const { armId } = c.req.valid("param");
    const { date } = c.req.valid("query");
    const data = await schoolRoute(c, { roles: STAFF }, async ({ tx, auth }) => {
      const arm = armOf(await armOptions(tx), armId);
      await requireRegisterAccess(tx, auth, armId);
      const terms = await termsOf(tx);
      const today = lagosToday();
      const day = date ?? latestSchoolDay(today, terms) ?? today;
      const term = termOf(today, terms);
      const pupils = await studentsIn(tx, armId);

      const [reg] = await tx.select().from(registers).where(and(eq(registers.classArmId, armId), eq(registers.day, day))).limit(1);
      const names = new Map<string, string>();
      const ids = [reg?.takenBy, reg?.changedBy].filter((x): x is string => !!x);
      if (ids.length) for (const u of await tx.select({ id: users.id, fullName: users.fullName }).from(users).where(inArray(users.id, ids))) names.set(u.id, u.fullName);
      const marks = reg
        ? new Map((await tx.select({ studentId: registerMarks.studentId, mark: registerMarks.mark, note: registerMarks.note }).from(registerMarks).where(eq(registerMarks.registerId, reg.id))).map((m) => [m.studentId, m]))
        : new Map<string, { mark: (typeof MARKS)[number]; note: string }>();
      const takenDays = term
        ? new Set(
            (await tx.select({ day: registers.day }).from(registers).where(and(eq(registers.classArmId, armId), gte(registers.day, term.startsOn), lte(registers.day, term.endsOn)))).map((r) => r.day),
          )
        : new Set<string>();

      return {
        armId,
        armLabel: arm.label,
        date: day,
        problem: registerDayProblem(day, today, terms),
        taken: reg
          ? {
              by: whoName(reg.takenBy ? (names.get(reg.takenBy) ?? null) : null),
              at: reg.takenAt.getTime(),
              ...(reg.changedAt ? { updatedBy: whoName(reg.changedBy ? (names.get(reg.changedBy) ?? null) : null), updatedAt: reg.changedAt.getTime() } : {}),
            }
          : null,
        students: pupils.map((s) => ({ ...s, mark: marks.get(s.id)?.mark ?? null, note: marks.get(s.id)?.note ?? "" })),
        days: term ? schoolDaysSoFar(term, today).map((d) => ({ date: d, taken: takenDays.has(d) })) : [],
      };
    });
    return c.json(data, 200);
  },
);

teacherRoutes.openapi(
  createRoute({
    method: "put",
    path: "/v1/arms/{armId}/register",
    tags: ["registers"],
    summary: "Save a class's register: every student present, late or absent, on a school day this term up to today",
    request: { params: z.object({ armId: Id }), body: json(SaveRegisterSchema) },
    responses: {
      200: ok("Saved", z.object({ present: z.number().int().openapi({ description: "Late counts as present" }), absent: z.number().int() }).openapi("RegisterSaved")),
      409: problemContent("The class changed while marking: reload and mark again"),
      422: problemContent("The day can't be marked, or not every student is marked"),
      ...errors,
    },
  }),
  async (c) => {
    const { armId } = c.req.valid("param");
    const input = c.req.valid("json");
    const result = await schoolRoute(c, { roles: STAFF }, async ({ tx, school, auth, audit }) => {
      const arm = armOf(await armOptions(tx), armId);
      await requireRegisterAccess(tx, auth, armId);
      const problem = registerDayProblem(input.date, lagosToday(), await termsOf(tx));
      if (problem) throw fieldError("#/date", problem);

      const pupils = new Set((await studentsIn(tx, armId)).map((s) => s.id));
      const marked = new Set(input.marks.map((m) => m.studentId));
      if (marked.size !== input.marks.length) throw fieldError("#/marks", "Each student can be marked once.");
      if (input.marks.some((m) => !pupils.has(m.studentId))) throw new ApiError("conflict", "The class changed while you were marking. Reload and mark again.");
      if (marked.size !== pupils.size) throw fieldError("#/marks", "Mark every student, then save.");

      const now = new Date();
      const [existing] = await tx.select({ id: registers.id }).from(registers).where(and(eq(registers.classArmId, armId), eq(registers.day, input.date))).limit(1);
      let registerId: string;
      if (existing) {
        await tx.update(registers).set({ changedBy: auth.user.id, changedAt: now, updatedBy: auth.user.id, updatedAt: now }).where(eq(registers.id, existing.id));
        await tx.delete(registerMarks).where(eq(registerMarks.registerId, existing.id));
        registerId = existing.id;
      } else {
        const [created] = await tx
          .insert(registers)
          .values({ schoolId: school.id, classArmId: armId, day: input.date, takenBy: auth.user.id, takenAt: now, createdBy: auth.user.id, updatedBy: auth.user.id })
          .returning({ id: registers.id });
        registerId = created!.id;
      }
      await tx.insert(registerMarks).values(
        input.marks.map((m) => ({ schoolId: school.id, registerId, studentId: m.studentId, mark: m.mark, note: m.note ?? "", createdBy: auth.user.id, updatedBy: auth.user.id })),
      );
      const summary = attendanceSummary(input.marks.map((m) => m.mark));
      audit({
        action: existing ? "register.changed" : "register.taken",
        entity: "register",
        entityId: registerId,
        changes: { date: input.date, present: summary.present, late: summary.late, absent: summary.absent },
        summary: `${existing ? "Changed" : "Took"} the register for ${arm.label} on ${input.date}`,
      });
      return { present: summary.present, absent: summary.absent };
    });
    return c.json(result, 200);
  },
);

// ——— What teachers see ———

const TeacherHomeSchema = z
  .object({
    fullName: z.string(),
    today: z.string().nullable().openapi({ description: "Today, when it's a school day; null at weekends and in breaks" }),
    formArms: z.array(
      z.object({
        armId: z.string().uuid(),
        label: z.string(),
        students: z.number().int(),
        takenToday: z.boolean(),
        takenThisTerm: z.number().int(),
        daysThisTerm: z.number().int(),
      }),
    ),
    subjects: z.array(z.object({ armId: z.string().uuid(), subjectId: z.string().uuid(), label: z.string(), subjectName: z.string(), students: z.number().int() })),
  })
  .openapi("TeacherHome");

teacherRoutes.openapi(
  createRoute({
    method: "get",
    path: "/v1/me/teaching",
    tags: ["teachers"],
    summary: "A teacher's home: their form classes (taken today? days taken this term) and subject classes",
    responses: { 200: ok("Teacher home", TeacherHomeSchema), ...errors },
  }),
  async (c) => {
    const data = await schoolRoute(c, { roles: STAFF }, async ({ tx, auth }) => {
      const terms = await termsOf(tx);
      const today = lagosToday();
      const term = termOf(today, terms);
      const daysThisTerm = term ? schoolDaysSoFar(term, today).length : 0;
      const arms = await armOptions(tx);
      const armIds = new Set(arms.map((a) => a.id));
      const label = (armId: string) => arms.find((a) => a.id === armId)!.label;
      const position = (armId: string) => arms.findIndex((a) => a.id === armId);

      const forms = (await tx.select({ armId: armFormTeachers.classArmId }).from(armFormTeachers).where(eq(armFormTeachers.userId, auth.user.id))).filter((f) =>
        armIds.has(f.armId),
      );
      const taught = (
        await tx
          .select({ armId: subjectTeachers.classArmId, subjectId: subjectTeachers.schoolSubjectId, subjectName: schoolSubjects.name })
          .from(subjectTeachers)
          .innerJoin(schoolSubjects, and(eq(schoolSubjects.schoolId, subjectTeachers.schoolId), eq(schoolSubjects.id, subjectTeachers.schoolSubjectId)))
          .where(eq(subjectTeachers.userId, auth.user.id))
      ).filter((t) => armIds.has(t.armId));
      const counts = await activeCounts(tx, [...new Set([...forms.map((f) => f.armId), ...taught.map((t) => t.armId)])]);
      const formIds = forms.map((f) => f.armId);
      const taken = formIds.length && term
        ? await tx
            .select({ armId: registers.classArmId, day: registers.day })
            .from(registers)
            .where(and(inArray(registers.classArmId, formIds), gte(registers.day, term.startsOn), lte(registers.day, today)))
        : [];

      return {
        fullName: auth.user.fullName,
        today: latestSchoolDay(today, terms) === today ? today : null,
        formArms: forms
          .sort((a, b) => position(a.armId) - position(b.armId))
          .map((f) => ({
            armId: f.armId,
            label: label(f.armId),
            students: counts.get(f.armId) ?? 0,
            takenToday: taken.some((r) => r.armId === f.armId && r.day === today),
            takenThisTerm: taken.filter((r) => r.armId === f.armId).length,
            daysThisTerm,
          })),
        subjects: taught
          .map((t) => ({ armId: t.armId, subjectId: t.subjectId, label: label(t.armId), subjectName: t.subjectName, students: counts.get(t.armId) ?? 0 }))
          .sort((a, b) => a.subjectName.localeCompare(b.subjectName) || position(a.armId) - position(b.armId)),
      };
    });
    return c.json(data, 200);
  },
);

const SubjectClassSchema = z
  .object({
    armLabel: z.string(),
    subjectName: z.string(),
    students: z.array(z.object({ id: z.string().uuid(), fullName: z.string(), admissionNo: z.string() })),
  })
  .openapi("SubjectClass");

teacherRoutes.openapi(
  createRoute({
    method: "get",
    path: "/v1/arms/{armId}/subjects/{subjectId}/students",
    tags: ["teachers"],
    summary: "The students in one subject class. Its teacher, or owners and admins",
    request: { params: z.object({ armId: Id, subjectId: Id }) },
    responses: { 200: ok("Subject class", SubjectClassSchema), ...errors },
  }),
  async (c) => {
    const { armId, subjectId } = c.req.valid("param");
    const data = await schoolRoute(c, { roles: STAFF }, async ({ tx, auth }) => {
      const arm = armOf(await armOptions(tx), armId);
      const [subject] = await tx.select({ name: schoolSubjects.name }).from(schoolSubjects).where(eq(schoolSubjects.id, subjectId)).limit(1);
      if (!subject) throw new ApiError("not_found", "That subject isn’t here any more.");
      if (auth.membership.role === "teacher") {
        const [mine] = await tx
          .select({ id: subjectTeachers.id })
          .from(subjectTeachers)
          .where(and(eq(subjectTeachers.classArmId, armId), eq(subjectTeachers.schoolSubjectId, subjectId), eq(subjectTeachers.userId, auth.user.id)))
          .limit(1);
        if (!mine) throw new ApiError("forbidden", "Only this subject’s teacher, or an admin, can open this class.");
      }
      return { armLabel: arm.label, subjectName: subject.name, students: await studentsIn(tx, armId) };
    });
    return c.json(data, 200);
  },
);

// ——— What admins see ———

const RegistersTodaySchema = z
  .object({
    date: z.string().nullable().openapi({ description: "Today on a school day; null at weekends and in breaks" }),
    taken: z.number().int(),
    total: z.number().int().openapi({ description: "Classes with at least one active student" }),
    missing: z.array(z.object({ armId: z.string().uuid(), label: z.string() })),
  })
  .openapi("RegistersToday");

teacherRoutes.openapi(
  createRoute({
    method: "get",
    path: "/v1/registers/today",
    tags: ["registers"],
    summary: "Home's register card: today's registers in, and which classes are missing",
    responses: { 200: ok("Today", RegistersTodaySchema), ...errors },
  }),
  async (c) => {
    const data = await schoolRoute(c, { roles: ADMINS }, async ({ tx }) => {
      const today = lagosToday();
      const terms = await termsOf(tx);
      const all = await armOptions(tx);
      const counts = await activeCounts(tx, all.map((a) => a.id));
      const arms = all.filter((a) => (counts.get(a.id) ?? 0) > 0);
      const taken = new Set((await tx.select({ armId: registers.classArmId }).from(registers).where(eq(registers.day, today))).map((r) => r.armId));
      return {
        date: latestSchoolDay(today, terms) === today ? today : null,
        taken: arms.filter((a) => taken.has(a.id)).length,
        total: arms.length,
        missing: arms.filter((a) => !taken.has(a.id)).map((a) => ({ armId: a.id, label: a.label })),
      };
    });
    return c.json(data, 200);
  },
);
