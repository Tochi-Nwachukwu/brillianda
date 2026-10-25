/**
 * Student accounts and the student portal (B6 in the front end's backend-requirements.md; flow
 * from its src/data/fake/learners.ts).
 *
 *   GET    /v1/student-accounts            owner, admin: active students and their portal access
 *   POST   /v1/students/{id}/invite        owner, admin: { email } → an invitation with role student
 *   DELETE /v1/students/{id}/access        owner, admin: ends access or cancels the invite; the record stays
 *   GET    /v1/me/student                  the student: their home
 *   GET    /v1/me/timetable                the student: their class's week
 *   GET    /v1/me/report-card?term=        the student: their report card, once published
 *
 * A student's account belongs to their own student record (student_links), and every student
 * endpoint returns only that student. Students are refused everywhere else: every other route
 * names the roles it serves, and none names `student` (ANY_MEMBER routes are the person's own
 * account: GET /v1/me, profile, password, the school switcher).
 *
 * Students are often under 18. They see only their own record; nothing here shows them other
 * students, guardians or staff contact details (teachers appear by name only).
 */
import { fullName, schoolDaysSoFar, termOf } from "@brillianda/core";
import { generateToken } from "@brillianda/auth";
import {
  and,
  armFormTeachers,
  eq,
  gt,
  gte,
  inArray,
  invitations,
  isNull,
  lte,
  registerMarks,
  registers,
  schoolMembers,
  schoolSubjects,
  studentLinks,
  students,
  subjectTeachers,
  timetableLessons,
  timetables,
  users,
  type Tx,
} from "@brillianda/db";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import type { AppEnv } from "../context.js";
import { emails } from "../emails.js";
import { attendanceOf, lagosToday, termsOf } from "../lib/attendance.js";
import { ApiError, problemContent } from "../lib/errors.js";
import { RATE_RULES } from "../lib/rate-limit.js";
import { schoolUrl } from "../lib/urls.js";
import { schoolRoute, type Role } from "../school-route.js";
import { birthdayFor, birthdaySettingsOf } from "./birthdays.js";
import { BookListSchema, bookListsFor } from "./booklists.js";
import { armOptions } from "./classes.js";
import { AttendanceSchema, childResults, ChildResultsSchema } from "./parents.js";
import { buildReportCard, ReportCardSchema, reportTermsOf } from "./reports.js";
import { resultsTermOf } from "./results.js";

export const studentPortalRoutes = new OpenAPIHono<AppEnv>();

const ADMINS: readonly Role[] = ["owner", "admin"];
const STUDENT: readonly Role[] = ["student"];
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const Id = z.string().uuid("Invalid id");
const ok = <T extends z.ZodTypeAny>(description: string, schema: T) => ({ description, content: { "application/json": { schema } } });
const errors = {
  401: problemContent("Not signed in to this school"),
  403: problemContent("Not allowed for this role"),
  404: problemContent("No active school here"),
} as const;
const inviteHash = (c: Context<AppEnv>, token: string) => c.get("deps").secret.hash("invite", token);

type Access = { access: "none" | "invited" | "active"; email: string | null };

/** Each student's portal access: an account linked to them, an open invitation, or none. */
async function accessOf(tx: Tx, studentIds: string[]): Promise<Map<string, Access>> {
  const out = new Map<string, Access>(studentIds.map((id) => [id, { access: "none", email: null }]));
  if (!studentIds.length) return out;
  const open = await tx
    .select({ studentId: invitations.studentId, email: invitations.email })
    .from(invitations)
    .where(and(inArray(invitations.studentId, studentIds), eq(invitations.role, "student"), isNull(invitations.acceptedAt), isNull(invitations.revokedAt), gt(invitations.expiresAt, new Date())));
  for (const i of open) out.set(i.studentId!, { access: "invited", email: i.email });
  const linked = await tx
    .select({ studentId: studentLinks.studentId, email: users.email })
    .from(studentLinks)
    .innerJoin(users, eq(users.id, studentLinks.userId))
    .where(inArray(studentLinks.studentId, studentIds));
  for (const l of linked) out.set(l.studentId, { access: "active", email: l.email });
  return out;
}

// ——— More › Student accounts ———

const StudentAccountsSchema = z
  .object({
    students: z.array(
      z.object({
        id: z.string().uuid(),
        fullName: z.string(),
        admissionNo: z.string(),
        armId: z.string().uuid(),
        armLabel: z.string(),
        access: z.enum(["none", "invited", "active"]),
        email: z.string().nullable(),
      }),
    ),
    arms: z.array(z.object({ id: z.string().uuid(), label: z.string() })),
  })
  .openapi("StudentAccountsPage");

studentPortalRoutes.openapi(
  createRoute({ method: "get", path: "/v1/student-accounts", tags: ["students"], summary: "Active students, in class order, with their student portal access", responses: { 200: ok("Students", StudentAccountsSchema), ...errors } }),
  async (c) => {
    const data = await schoolRoute(c, { roles: ADMINS }, async ({ tx }) => {
      const arms = await armOptions(tx);
      const labels = new Map(arms.map((a) => [a.id, a.label]));
      const order = new Map(arms.map((a, i) => [a.id, i]));
      const rows = (await tx.select().from(students).where(and(eq(students.status, "active"), isNull(students.deletedAt)))).sort(
        (a, b) => (order.get(a.classArmId) ?? 1e9) - (order.get(b.classArmId) ?? 1e9) || fullName(a).localeCompare(fullName(b)),
      );
      const access = await accessOf(tx, rows.map((s) => s.id));
      return {
        arms: arms.map((a) => ({ id: a.id, label: a.label })),
        students: rows.map((s) => ({ id: s.id, fullName: fullName(s), admissionNo: s.admissionNumber, armId: s.classArmId, armLabel: labels.get(s.classArmId) ?? "No class", ...access.get(s.id)! })),
      };
    });
    return c.json(data, 200);
  },
);

studentPortalRoutes.openapi(
  createRoute({
    method: "post",
    path: "/v1/students/{id}/invite",
    tags: ["students"],
    summary: "Invite a student to the student portal with their own email (or one the school gives them). Inviting again replaces the open invitation",
    request: {
      params: z.object({ id: Id }),
      body: { content: { "application/json": { schema: z.object({ email: z.string({ message: "Enter an email" }).trim().toLowerCase().email("Check this email address").max(254) }).openapi("InviteStudent") } }, required: true },
    },
    responses: {
      201: ok("Invited", z.object({ access: z.literal("invited"), email: z.string(), resent: z.boolean() })),
      409: problemContent("Already uses the portal, or the email has another open invitation"),
      422: problemContent("The email: invalid, or someone at this school already uses it (#/email)"),
      ...errors,
      404: problemContent("No such student"),
    },
  }),
  async (c) => {
    const { id } = c.req.valid("param");
    const { email } = c.req.valid("json");
    const result = await schoolRoute(c, { roles: ADMINS, userRateLimit: RATE_RULES.invitePerUser }, async ({ tx, school, auth, audit }) => {
      const [s] = await tx.select().from(students).where(and(eq(students.id, id), isNull(students.deletedAt))).limit(1);
      if (!s) throw new ApiError("not_found", "That student isn’t here any more.");
      if ((await accessOf(tx, [id])).get(id)!.access === "active") throw new ApiError("conflict", `${s.firstName} already uses the student portal.`);
      const [member] = await tx.select({ userId: schoolMembers.userId }).from(schoolMembers).innerJoin(users, eq(users.id, schoolMembers.userId)).where(eq(users.email, email)).limit(1);
      if (member) {
        throw new ApiError("validation_failed", "Someone at this school already uses that email.", { extensions: { errors: [{ pointer: "#/email", detail: "Someone at this school already uses this email", code: "taken" }] } });
      }
      const open = await tx
        .select({ role: invitations.role, studentId: invitations.studentId })
        .from(invitations)
        .where(and(eq(invitations.email, email), isNull(invitations.acceptedAt), isNull(invitations.revokedAt), gt(invitations.expiresAt, new Date())))
        .limit(1);
      if (open[0] && (open[0].role !== "student" || open[0].studentId !== id)) throw new ApiError("conflict", `${email} already has an open invitation to this school.`);
      const [earlier] = await tx
        .select({ id: invitations.id })
        .from(invitations)
        .where(and(eq(invitations.studentId, id), eq(invitations.role, "student"), isNull(invitations.acceptedAt), isNull(invitations.revokedAt)))
        .limit(1);
      // One open invitation per student and per email: a re-invite replaces the old one.
      await tx
        .update(invitations)
        .set({ revokedAt: new Date(), updatedBy: auth.user.id })
        .where(and(isNull(invitations.acceptedAt), isNull(invitations.revokedAt), eq(invitations.role, "student"), eq(invitations.studentId, id)));
      await tx.update(invitations).set({ revokedAt: new Date(), updatedBy: auth.user.id }).where(and(eq(invitations.email, email), isNull(invitations.acceptedAt), isNull(invitations.revokedAt)));
      const token = generateToken();
      const name = fullName(s);
      await tx.insert(invitations).values({
        schoolId: school.id,
        email,
        fullName: name,
        role: "student",
        studentId: id,
        tokenHash: inviteHash(c, token),
        invitedBy: auth.user.id,
        expiresAt: new Date(Date.now() + INVITE_TTL_MS),
        createdBy: auth.user.id,
        updatedBy: auth.user.id,
      });
      audit({ action: "student.portal_invited", entity: "student", entityId: id, changes: { email }, summary: `Invited ${name} to the student portal` });
      return { school, inviter: auth.user.fullName, token, name, resent: !!(open[0] || earlier) };
    });
    const { mailer, config } = c.get("deps");
    await mailer.send(emails.invitation(email, result.school.name, result.inviter, "student", schoolUrl(config, result.school.subdomain, `/invite?token=${result.token}`), result.name));
    return c.json({ access: "invited" as const, email, resent: result.resent }, 201);
  },
);

studentPortalRoutes.openapi(
  createRoute({
    method: "delete",
    path: "/v1/students/{id}/access",
    tags: ["students"],
    summary: "End a student's portal access, or cancel their invite. Their record stays",
    request: { params: z.object({ id: Id }) },
    responses: { 204: { description: "Ended" }, ...errors, 404: problemContent("No such student") },
  }),
  async (c) => {
    const { id } = c.req.valid("param");
    await schoolRoute(c, { roles: ADMINS }, async ({ tx, auth, audit }) => {
      const [s] = await tx.select().from(students).where(eq(students.id, id)).limit(1);
      if (!s) throw new ApiError("not_found", "That student isn’t here any more.");
      const cancelled = await tx
        .update(invitations)
        .set({ revokedAt: new Date(), updatedBy: auth.user.id })
        .where(and(eq(invitations.studentId, id), eq(invitations.role, "student"), isNull(invitations.acceptedAt), isNull(invitations.revokedAt)))
        .returning({ id: invitations.id });
      const links = await tx.delete(studentLinks).where(eq(studentLinks.studentId, id)).returning({ userId: studentLinks.userId });
      // The account leaves the school (its sessions here end with the membership).
      for (const { userId } of links) await tx.delete(schoolMembers).where(and(eq(schoolMembers.userId, userId), eq(schoolMembers.role, "student")));
      if (cancelled.length || links.length) {
        audit({ action: "student.portal_ended", entity: "student", entityId: id, changes: { accounts: links.length, invitations: cancelled.length }, summary: `Ended ${fullName(s)}’s student portal access` });
      }
    });
    return c.body(null, 204);
  },
);

// ——— What a student sees ———

/** The signed-in student's own record. */
async function myRecord(tx: Tx, userId: string) {
  const [row] = await tx
    .select({ student: students })
    .from(studentLinks)
    .innerJoin(students, and(eq(students.schoolId, studentLinks.schoolId), eq(students.id, studentLinks.studentId)))
    .where(and(eq(studentLinks.userId, userId), isNull(students.deletedAt)))
    .limit(1);
  if (!row) throw new ApiError("not_found", "Your student record isn’t here any more. Ask your school.");
  return row.student;
}

/** Today's weekday in Lagos, 1 Monday to 5 Friday; null at the weekend. */
function lagosWeekday(today: string): number | null {
  const d = new Date(`${today}T12:00:00Z`).getUTCDay();
  return d >= 1 && d <= 5 ? d : null;
}

const PeriodSchema = z.object({ id: z.string(), label: z.string(), start: z.string(), end: z.string(), kind: z.enum(["lesson", "break"]) });

const StudentHomeSchema = z
  .object({
    fullName: z.string(),
    armLabel: z.string(),
    admissionNo: z.string(),
    formTeacher: z.string().nullable(),
    birthday: z.string().nullable().openapi({ description: "On their birthday, when the school sends birthday messages: the school's message" }),
    lessonsToday: z.array(z.object({ periodLabel: z.string(), start: z.string(), end: z.string(), subjectName: z.string() })).openapi({ description: "In order; empty at weekends or when the timetable has none" }),
    attendance: AttendanceSchema,
    recent: z.array(z.object({ date: z.string(), mark: z.enum(["present", "late", "absent"]).nullable() })).openapi({ description: "The latest ten school days this term, newest first" }),
    results: ChildResultsSchema,
    pastTerms: z.array(z.object({ key: z.string(), label: z.string() })),
    bookLists: z.array(z.object({ label: z.string(), list: BookListSchema })),
  })
  .openapi("StudentHome");

studentPortalRoutes.openapi(
  createRoute({ method: "get", path: "/v1/me/student", tags: ["student portal"], summary: "The student's home: class, today's lessons, attendance, published results, book lists", responses: { 200: ok("Home", StudentHomeSchema), ...errors } }),
  async (c) => {
    const data = await schoolRoute(c, { roles: STUDENT }, async ({ tx, auth, school }) => {
      const s = await myRecord(tx, auth.user.id);
      const today = lagosToday();
      const terms = await termsOf(tx);
      const term = termOf(today, terms);
      const days = term ? schoolDaysSoFar(term, today).slice(0, 10) : [];
      const marks = new Map<string, "present" | "late" | "absent">();
      if (days.length) {
        const rows = await tx
          .select({ day: registers.day, mark: registerMarks.mark })
          .from(registerMarks)
          .innerJoin(registers, and(eq(registers.schoolId, registerMarks.schoolId), eq(registers.id, registerMarks.registerId)))
          .where(and(eq(registerMarks.studentId, s.id), gte(registers.day, days.at(-1)!), lte(registers.day, days[0]!)));
        for (const r of rows) marks.set(r.day, r.mark);
      }
      const arms = await armOptions(tx, { all: true });
      const arm = arms.find((a) => a.id === s.classArmId);
      const [form] = await tx.select({ name: users.fullName }).from(armFormTeachers).innerJoin(users, eq(users.id, armFormTeachers.userId)).where(eq(armFormTeachers.classArmId, s.classArmId)).limit(1);
      const weekday = lagosWeekday(today);
      let lessonsToday: z.infer<typeof StudentHomeSchema>["lessonsToday"] = [];
      if (weekday) {
        const [t] = await tx.select({ periods: timetables.periods }).from(timetables).limit(1);
        const lessons = await tx
          .select({ periodId: timetableLessons.periodId, subjectName: schoolSubjects.name })
          .from(timetableLessons)
          .innerJoin(schoolSubjects, and(eq(schoolSubjects.schoolId, timetableLessons.schoolId), eq(schoolSubjects.id, timetableLessons.schoolSubjectId)))
          .where(and(eq(timetableLessons.classArmId, s.classArmId), eq(timetableLessons.day, weekday)));
        lessonsToday = (t?.periods ?? [])
          .filter((p) => p.kind === "lesson")
          .flatMap((p) => {
            const l = lessons.find((x) => x.periodId === p.id);
            return l ? [{ periodLabel: p.label, start: p.start, end: p.end, subjectName: l.subjectName }] : [];
          });
      }
      const open = await resultsTermOf(tx);
      return {
        fullName: fullName(s),
        armLabel: arm?.label ?? "No class",
        admissionNo: s.admissionNumber,
        formTeacher: form?.name ?? null,
        birthday: birthdayFor(await birthdaySettingsOf(tx), school.name, s, today),
        lessonsToday,
        attendance: (await attendanceOf(tx, [s.id], terms, today)).get(s.id) ?? null,
        recent: days.map((date) => ({ date, mark: marks.get(date) ?? null })),
        results: open ? await childResults(tx, s.id, s.classArmId, open) : null,
        pastTerms: (await reportTermsOf(tx, s.id)).filter((t) => t.published && !t.open).map((t) => ({ key: t.key, label: `${t.name}, ${t.session}` })),
        bookLists: await bookListsFor(tx, arm?.levelId ?? null),
      };
    });
    return c.json(data, 200);
  },
);

const ClassTimetableSchema = z
  .object({
    armLabel: z.string(),
    periods: z.array(PeriodSchema),
    lessons: z.array(z.object({ day: z.number().int().min(1).max(5), periodId: z.string(), subjectName: z.string(), teacherName: z.string().nullable() })),
  })
  .openapi("ClassTimetable");

studentPortalRoutes.openapi(
  createRoute({ method: "get", path: "/v1/me/timetable", tags: ["student portal"], summary: "The student's class week: periods and lessons with their teachers' names", responses: { 200: ok("Timetable", ClassTimetableSchema), ...errors } }),
  async (c) => {
    const data = await schoolRoute(c, { roles: STUDENT }, async ({ tx, auth }) => {
      const s = await myRecord(tx, auth.user.id);
      const [t] = await tx.select({ periods: timetables.periods }).from(timetables).limit(1);
      const lessons = await tx
        .select({ day: timetableLessons.day, periodId: timetableLessons.periodId, subjectId: timetableLessons.schoolSubjectId, subjectName: schoolSubjects.name })
        .from(timetableLessons)
        .innerJoin(schoolSubjects, and(eq(schoolSubjects.schoolId, timetableLessons.schoolId), eq(schoolSubjects.id, timetableLessons.schoolSubjectId)))
        .where(eq(timetableLessons.classArmId, s.classArmId));
      const teachers = new Map(
        (
          await tx
            .select({ subjectId: subjectTeachers.schoolSubjectId, name: users.fullName })
            .from(subjectTeachers)
            .innerJoin(users, eq(users.id, subjectTeachers.userId))
            .where(eq(subjectTeachers.classArmId, s.classArmId))
        ).map((r) => [r.subjectId, r.name]),
      );
      const arm = (await armOptions(tx, { all: true })).find((a) => a.id === s.classArmId);
      return {
        armLabel: arm?.label ?? "",
        periods: t?.periods ?? [],
        lessons: lessons.map((l) => ({ day: l.day, periodId: l.periodId, subjectName: l.subjectName, teacherName: teachers.get(l.subjectId) ?? null })),
      };
    });
    return c.json(data, 200);
  },
);

studentPortalRoutes.openapi(
  createRoute({
    method: "get",
    path: "/v1/me/report-card",
    tags: ["student portal"],
    summary: "The student's report card for a published term (default: this term). Anything else answers not found",
    request: { query: z.object({ term: z.string().regex(/^\d{4}-[1-3]$/, "Pick a term").optional() }) },
    responses: { 200: ok("Report card", ReportCardSchema), ...errors },
  }),
  async (c) => {
    const { term } = c.req.valid("query");
    const data = await schoolRoute(c, { roles: STUDENT }, async ({ tx, auth, school }) => {
      const s = await myRecord(tx, auth.user.id);
      const card = await buildReportCard(tx, school, s.id, term);
      if (!card?.published) throw new ApiError("not_found", "There’s no published report card for that term.");
      return card;
    });
    return c.json(data, 200);
  },
);
