/**
 * What a school does with scores (C3 in the front end's backend-requirements.md; shapes and rules
 * follow its src/data/fake/reports.ts): the broadsheet, remarks, behaviour ratings, publishing a
 * class, and report cards. Built on routes/results.ts and the shared maths in core.
 *
 * Owners, admins and the class's form teacher:
 *   GET /v1/arms/{armId}/broadsheet
 *   GET /v1/arms/{armId}/reports                                     remarks and ratings to fill in
 *   PUT /v1/arms/{armId}/students/{studentId}/remarks/{teacher|principal}   { text } (principal: admins)
 *   PUT /v1/arms/{armId}/students/{studentId}/ratings               { trait, value }
 *   GET /v1/students/{id}/report-card?term=                         (form teacher: their own class)
 * Owners and admins:
 *   GET /v1/results/ratings, PUT /v1/results/ratings                { enabled, traits }
 *   PUT /v1/arms/{armId}/published                                  { published }
 *   GET /v1/students/{id}/report-terms
 *
 * Parents read published cards through routes/parents.ts, with the helpers exported here.
 */
import { attendanceSummary, fullName, resolveGrade, rowTotal, classResults, sessionName, type Mark } from "@brillianda/core";
import {
  and,
  armFormTeachers,
  asc,
  eq,
  gte,
  inArray,
  isNull,
  lte,
  publishedResults,
  registerMarks,
  registers,
  reportRatings,
  reportRemarks,
  resultsSettings,
  scoreExclusions,
  scores,
  students,
  termClosures,
  users,
  type Tx,
} from "@brillianda/db";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { ValidSession } from "@brillianda/auth";
import type { AppEnv } from "../context.js";
import { attendanceOf, lagosToday, termsOf, type AttendanceSummary } from "../lib/attendance.js";
import { ApiError, problemContent } from "../lib/errors.js";
import { ratingSchema, ratingSettingsSchema, remarkSchema } from "../lib/results-rules.js";
import type { ResolvedSchool } from "../lib/school-directory.js";
import { schoolRoute, type Role } from "../school-route.js";
import { currentSession } from "./calendar.js";
import { armOptions } from "./classes.js";
import { pupilsIn, resultsTermOf, settingsOf, sheetRows, statusIn, subjectsForArm, termSnapshot, type ResultsTerm } from "./results.js";
import { logoUrl } from "./school.js";

export const reportRoutes = new OpenAPIHono<AppEnv>();

const ADMINS: readonly Role[] = ["owner", "admin"];
const STAFF: readonly Role[] = ["owner", "admin", "teacher"];
const Id = z.string().uuid("Invalid id");
const TermKey = z.string().regex(/^\d{4}-[1-3]$/, "Pick a term");
const ok = <T extends z.ZodTypeAny>(description: string, schema: T) => ({ description, content: { "application/json": { schema } } });
const json = <T extends z.ZodTypeAny>(schema: T) => ({ content: { "application/json": { schema } }, required: true });
const errors = {
  401: problemContent("Not signed in to this school"),
  403: problemContent("This role can't do this, or it isn't your class"),
  404: problemContent("No such class, student or term, or no term open for results"),
} as const;
const isAdmin = (auth: ValidSession) => auth.membership.role === "owner" || auth.membership.role === "admin";

// ——— Shared helpers (also used by parents.ts) ———

/** Admins see every class; a form teacher sees (and remarks on) their own. */
async function classAccess(tx: Tx, auth: ValidSession, armId: string) {
  const arm = (await armOptions(tx, { all: true })).find((a) => a.id === armId);
  if (!arm) throw new ApiError("not_found", "That class isn’t here any more.");
  const admin = isAdmin(auth);
  if (!admin) {
    const [mine] = await tx
      .select({ id: armFormTeachers.id })
      .from(armFormTeachers)
      .where(and(eq(armFormTeachers.classArmId, armId), eq(armFormTeachers.userId, auth.user.id)))
      .limit(1);
    if (!mine) throw new ApiError("forbidden", "Only this class’s form teacher, or an admin, can open this.");
  }
  return { arm, admin };
}

async function requireTerm(tx: Tx): Promise<ResultsTerm> {
  const term = await resultsTermOf(tx);
  if (!term) throw new ApiError("not_found", "No term is open for results yet. Results open when the term starts.");
  return term;
}

/**
 * Who belongs to a class's results for a term: its students now, for the open term; for a closed
 * term, the students who had scores (or were left out of an elective) there then.
 */
async function pupilsFor(tx: Tx, termKey: string, armId: string, openKey: string | undefined) {
  if (termKey === openKey) return pupilsIn(tx, [armId]);
  const ids = new Set([
    ...(await tx.select({ id: scores.studentId }).from(scores).where(and(eq(scores.termKey, termKey), eq(scores.classArmId, armId)))).map((r) => r.id),
    ...(await tx.select({ id: scoreExclusions.studentId }).from(scoreExclusions).where(and(eq(scoreExclusions.termKey, termKey), eq(scoreExclusions.classArmId, armId)))).map((r) => r.id),
  ]);
  if (!ids.size) return [];
  const rows = await tx
    .select({ id: students.id, armId: students.classArmId, firstName: students.firstName, otherNames: students.otherNames, lastName: students.lastName, admissionNo: students.admissionNumber })
    .from(students)
    .where(and(inArray(students.id, [...ids]), isNull(students.deletedAt)))
    .orderBy(asc(students.lastName), asc(students.firstName), asc(students.id));
  return rows.map((s) => ({ id: s.id, armId, fullName: fullName(s), admissionNo: s.admissionNo }));
}

export type SubjectCell = { total: number; grade: string } | "excluded" | null;

/** Each student's subject totals (complete rows only) and the class's averages and positions. */
export async function computeClass(tx: Tx, termKey: string, armId: string, openKey: string | undefined) {
  const settings = await settingsOf(tx);
  const subjects = await subjectsForArm(tx, armId);
  const pupils = await pupilsFor(tx, termKey, armId, openKey);
  const ids = pupils.map((p) => p.id);
  const cells = new Map<string, Record<string, SubjectCell>>(ids.map((id) => [id, {}]));
  const rowsBySubject = new Map<string, Awaited<ReturnType<typeof sheetRows>>>();
  const totals: { studentId: string; subjectId: string; total: number }[] = [];
  for (const subject of subjects) {
    const rows = await sheetRows(tx, termKey, armId, subject.id, ids);
    rowsBySubject.set(subject.id, rows);
    for (const row of rows.values()) {
      const mine = cells.get(row.studentId)!;
      if (row.excluded) {
        mine[subject.id] = "excluded";
        continue;
      }
      const total = rowTotal(row, settings.components);
      mine[subject.id] = total === null ? null : { total, grade: resolveGrade(total, settings.scale).grade };
      if (total !== null) totals.push({ studentId: row.studentId, subjectId: subject.id, total });
    }
  }
  return { settings, subjects, pupils, cells, rowsBySubject, results: classResults(ids, totals) };
}

export async function publishedFor(tx: Tx, termKey: string, armId: string) {
  const [p] = await tx
    .select({ by: users.fullName, at: publishedResults.createdAt })
    .from(publishedResults)
    .leftJoin(users, eq(users.id, publishedResults.publishedBy))
    .where(and(eq(publishedResults.termKey, termKey), eq(publishedResults.classArmId, armId)))
    .limit(1);
  return p ? { by: p.by ?? "A former staff member", at: p.at.getTime() } : null;
}

/** A term by its key: the open one, or a closed one. */
export async function termByKey(tx: Tx, key: string): Promise<ResultsTerm | null> {
  const open = await resultsTermOf(tx);
  if (open?.key === key) return open;
  const [closed] = await tx.select({ name: termClosures.name, sessionName: termClosures.sessionName }).from(termClosures).where(eq(termClosures.termKey, key)).limit(1);
  if (!closed) return null;
  const [year, number] = key.split("-").map(Number) as [number, number];
  const { startYear, terms } = await currentSession(tx);
  const known = startYear === year ? terms[number - 1] : undefined;
  return {
    key,
    name: closed.name ?? known?.name ?? `Term ${number}`,
    session: closed.sessionName ?? sessionName(year),
    index: number - 1,
    isLast: startYear === year ? number === terms.length : false,
  };
}

/** The class a student was in for a term: where their scores are, else where they are now. */
async function armIn(tx: Tx, studentId: string, termKey: string, fallback: string): Promise<string> {
  const [s] = await tx.select({ armId: scores.classArmId }).from(scores).where(and(eq(scores.termKey, termKey), eq(scores.studentId, studentId))).limit(1);
  if (s) return s.armId;
  const [e] = await tx.select({ armId: scoreExclusions.classArmId }).from(scoreExclusions).where(and(eq(scoreExclusions.termKey, termKey), eq(scoreExclusions.studentId, studentId))).limit(1);
  return e?.armId ?? fallback;
}

const ReportCardSchema = z
  .object({
    school: z.object({ name: z.string(), logoUrl: z.string().nullable(), brandColor: z.string().nullable().openapi({ description: "null: your default, as on GET /v1/school" }) }),
    term: z.object({ key: z.string(), name: z.string(), session: z.string(), index: z.number().int(), isLast: z.boolean() }),
    student: z.object({ id: z.string().uuid(), fullName: z.string(), admissionNo: z.string(), armLabel: z.string() }),
    components: z.array(z.object({ id: z.string(), name: z.string(), maxScore: z.number() })),
    subjects: z.array(
      z.object({
        name: z.string(),
        scores: z.record(z.string(), z.object({ value: z.number(), isAbsent: z.boolean() }).nullable()),
        total: z.number().nullable(),
        grade: z.string().nullable(),
        remark: z.string().nullable(),
      }),
    ),
    average: z.number().nullable(),
    position: z.number().int().nullable(),
    of: z.number().int(),
    showPositions: z.boolean(),
    attendance: z.object({ term: z.string(), days: z.number().int(), present: z.number().int(), late: z.number().int(), absent: z.number().int() }).nullable(),
    ratings: z.array(z.object({ trait: z.string(), value: z.number().int().nullable() })),
    teacherRemark: z.string().nullable(),
    principalRemark: z.string().nullable(),
    formTeacher: z.string().nullable(),
    nextTermBegins: z.string().nullable(),
    scale: z.array(z.object({ minScore: z.number(), grade: z.string(), remark: z.string(), isPass: z.boolean() })),
    published: z.boolean(),
  })
  .openapi("ReportCardData");
export type ReportCard = z.infer<typeof ReportCardSchema>;
export { ReportCardSchema };

/** One student's card for a term (default: the open one); null if there's no such term or student. */
export async function buildReportCard(tx: Tx, school: ResolvedSchool, studentId: string, termKey?: string): Promise<ReportCard | null> {
  const [student] = await tx.select().from(students).where(and(eq(students.id, studentId), isNull(students.deletedAt))).limit(1);
  if (!student) return null;
  const open = await resultsTermOf(tx);
  const term = termKey ? await termByKey(tx, termKey) : open;
  if (!term) return null;
  const armId = await armIn(tx, studentId, term.key, student.classArmId);
  const { settings, subjects, pupils, results, rowsBySubject } = await computeClass(tx, term.key, armId, open?.key);
  const mine = results.get(studentId);
  const labels = new Map((await armOptions(tx, { all: true })).map((a) => [a.id, a.label]));

  const { startYear, terms } = await currentSession(tx);
  const [year, number] = term.key.split("-").map(Number) as [number, number];
  const dates = startYear === year ? { term: terms[number - 1] ?? null, next: terms[number] ?? null } : null;

  // Attendance within the term's own dates; the open term uses this term's register.
  let attendance: AttendanceSummary = null;
  if (term.key === open?.key) attendance = (await attendanceOf(tx, [studentId], await termsOf(tx), lagosToday())).get(studentId) ?? null;
  else if (dates?.term) {
    const marks = await tx
      .select({ mark: registerMarks.mark })
      .from(registerMarks)
      .innerJoin(registers, and(eq(registers.schoolId, registerMarks.schoolId), eq(registers.id, registerMarks.registerId)))
      .where(and(eq(registerMarks.studentId, studentId), gte(registers.day, dates.term.startsOn), lte(registers.day, dates.term.endsOn)));
    attendance = { term: term.name, ...attendanceSummary(marks.map((m) => m.mark as Mark)) };
  }

  const remarks = await tx.select({ kind: reportRemarks.kind, text: reportRemarks.text }).from(reportRemarks).where(and(eq(reportRemarks.termKey, term.key), eq(reportRemarks.studentId, studentId)));
  const ratings = await tx.select({ trait: reportRatings.trait, value: reportRatings.value }).from(reportRatings).where(and(eq(reportRatings.termKey, term.key), eq(reportRatings.studentId, studentId)));
  const [form] = await tx
    .select({ name: users.fullName })
    .from(armFormTeachers)
    .innerJoin(users, eq(users.id, armFormTeachers.userId))
    .where(eq(armFormTeachers.classArmId, armId))
    .limit(1);

  return {
    school: { name: school.name, logoUrl: logoUrl(school.logoKey), brandColor: school.brandColor },
    term,
    student: { id: student.id, fullName: fullName(student), admissionNo: student.admissionNumber, armLabel: labels.get(armId) ?? "A class that was removed" },
    components: settings.components,
    subjects: subjects
      .map((subject) => {
        const row = rowsBySubject.get(subject.id)?.get(studentId);
        if (!row || row.excluded) return null;
        const total = rowTotal(row, settings.components);
        const band = total === null ? null : resolveGrade(total, settings.scale);
        return {
          name: subject.name,
          scores: Object.fromEntries(settings.components.map((c) => [c.id, row.scores[c.id] ?? null])),
          total,
          grade: band?.grade ?? null,
          remark: band?.remark ?? null,
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null),
    average: mine?.average ?? null,
    position: settings.showPositions ? (mine?.position ?? null) : null,
    of: pupils.length,
    showPositions: settings.showPositions,
    attendance,
    ratings: settings.ratings.enabled ? settings.ratings.traits.map((trait) => ({ trait, value: ratings.find((r) => r.trait === trait)?.value ?? null })) : [],
    teacherRemark: remarks.find((r) => r.kind === "teacher")?.text ?? null,
    principalRemark: remarks.find((r) => r.kind === "principal")?.text ?? null,
    formTeacher: form?.name ?? null,
    nextTermBegins: dates?.next?.startsOn ?? null,
    scale: settings.scale,
    published: !!(await publishedFor(tx, term.key, armId)),
  };
}

export type ReportTerm = { key: string; name: string; session: string; published: boolean; open: boolean };

/** Every term a student has results in, newest first, and whether each was published. */
export async function reportTermsOf(tx: Tx, studentId: string): Promise<ReportTerm[]> {
  const keys = [
    ...new Set([
      ...(await tx.selectDistinct({ key: scores.termKey }).from(scores).where(eq(scores.studentId, studentId))).map((r) => r.key),
      ...(await tx.selectDistinct({ key: scoreExclusions.termKey }).from(scoreExclusions).where(eq(scoreExclusions.studentId, studentId))).map((r) => r.key),
    ]),
  ];
  const open = (await resultsTermOf(tx))?.key;
  const out: ReportTerm[] = [];
  for (const key of keys) {
    const term = await termByKey(tx, key);
    if (!term) continue;
    const armId = await armIn(tx, studentId, key, "");
    out.push({ key, name: term.name, session: term.session, published: !!(armId && (await publishedFor(tx, key, armId))), open: key === open });
  }
  return out.sort((a, b) => b.key.localeCompare(a.key));
}

// ——— The broadsheet ———

const TermSchema = z.object({ key: z.string(), name: z.string(), session: z.string(), index: z.number().int(), isLast: z.boolean() });
const CellSchema = z.union([z.object({ total: z.number(), grade: z.string() }), z.literal("excluded"), z.null()]);
const BroadsheetSchema = z
  .object({
    term: TermSchema,
    armId: z.string().uuid(),
    armLabel: z.string(),
    showPositions: z.boolean(),
    subjects: z.array(z.object({ id: z.string().uuid(), name: z.string(), code: z.string(), status: z.enum(["not-started", "in-progress", "complete"]) })),
    rows: z.array(
      z.object({
        studentId: z.string().uuid(),
        fullName: z.string(),
        admissionNo: z.string(),
        cells: z.record(z.string(), CellSchema).openapi({ description: "By subject id: total and grade, \"excluded\", or null while a part is empty" }),
        average: z.number().nullable(),
        position: z.number().int().nullable(),
      }),
    ),
    allComplete: z.boolean(),
    published: z.object({ by: z.string(), at: z.number().int() }).nullable(),
    canPublish: z.boolean().openapi({ description: "Owners and admins; the form teacher only reads" }),
  })
  .openapi("Broadsheet");

reportRoutes.openapi(
  createRoute({
    method: "get",
    path: "/v1/arms/{armId}/broadsheet",
    tags: ["reports"],
    summary: "A class's broadsheet this term: every student against every subject, with average and position (when shown)",
    request: { params: z.object({ armId: Id }) },
    responses: { 200: ok("Broadsheet", BroadsheetSchema), ...errors },
  }),
  async (c) => {
    const { armId } = c.req.valid("param");
    const data = await schoolRoute(c, { roles: STAFF }, async ({ tx, auth }) => {
      const { arm, admin } = await classAccess(tx, auth, armId);
      const term = await requireTerm(tx);
      const { settings, subjects, pupils, cells, results } = await computeClass(tx, term.key, armId, term.key);
      const snap = await termSnapshot(tx, term.key, settings.components);
      const statuses = subjects.map((s) => ({ id: s.id, name: s.name, code: s.code, status: statusIn(snap, armId, s.id, pupils.map((p) => p.id)).status }));
      return {
        term,
        armId,
        armLabel: arm.label,
        showPositions: settings.showPositions,
        subjects: statuses,
        rows: pupils.map((p) => ({
          studentId: p.id,
          fullName: p.fullName,
          admissionNo: p.admissionNo,
          cells: cells.get(p.id) ?? {},
          average: results.get(p.id)?.average ?? null,
          position: settings.showPositions ? (results.get(p.id)?.position ?? null) : null,
        })),
        allComplete: statuses.length > 0 && statuses.every((s) => s.status === "complete"),
        published: await publishedFor(tx, term.key, armId),
        canPublish: admin,
      };
    });
    return c.json(data, 200);
  },
);

// ——— Remarks and ratings ———

const ClassReportsSchema = z
  .object({
    term: TermSchema,
    armId: z.string().uuid(),
    armLabel: z.string(),
    ratings: z.object({ enabled: z.boolean(), traits: z.array(z.string()) }),
    canWritePrincipal: z.boolean(),
    rows: z.array(z.object({ studentId: z.string().uuid(), fullName: z.string(), teacherRemark: z.string(), principalRemark: z.string(), ratings: z.record(z.string(), z.number().int()) })),
  })
  .openapi("ClassReports");

reportRoutes.openapi(
  createRoute({
    method: "get",
    path: "/v1/arms/{armId}/reports",
    tags: ["reports"],
    summary: "Remarks and ratings for a class this term, and the school's rating traits",
    request: { params: z.object({ armId: Id }) },
    responses: { 200: ok("Class reports", ClassReportsSchema), ...errors },
  }),
  async (c) => {
    const { armId } = c.req.valid("param");
    const data = await schoolRoute(c, { roles: STAFF }, async ({ tx, auth }) => {
      const { arm, admin } = await classAccess(tx, auth, armId);
      const term = await requireTerm(tx);
      const pupils = await pupilsIn(tx, [armId]);
      const ids = pupils.map((p) => p.id);
      const remarks = ids.length
        ? await tx.select({ studentId: reportRemarks.studentId, kind: reportRemarks.kind, text: reportRemarks.text }).from(reportRemarks).where(and(eq(reportRemarks.termKey, term.key), inArray(reportRemarks.studentId, ids)))
        : [];
      const ratings = ids.length
        ? await tx.select({ studentId: reportRatings.studentId, trait: reportRatings.trait, value: reportRatings.value }).from(reportRatings).where(and(eq(reportRatings.termKey, term.key), inArray(reportRatings.studentId, ids)))
        : [];
      return {
        term,
        armId,
        armLabel: arm.label,
        ratings: (await settingsOf(tx)).ratings,
        canWritePrincipal: admin,
        rows: pupils.map((p) => ({
          studentId: p.id,
          fullName: p.fullName,
          teacherRemark: remarks.find((r) => r.studentId === p.id && r.kind === "teacher")?.text ?? "",
          principalRemark: remarks.find((r) => r.studentId === p.id && r.kind === "principal")?.text ?? "",
          ratings: Object.fromEntries(ratings.filter((r) => r.studentId === p.id).map((r) => [r.trait, r.value])),
        })),
      };
    });
    return c.json(data, 200);
  },
);

async function studentInClass(tx: Tx, armId: string, studentId: string) {
  const pupil = (await pupilsIn(tx, [armId])).find((p) => p.id === studentId);
  if (!pupil) throw new ApiError("conflict", "That student isn’t in this class any more. Reload the page.");
  return pupil;
}

reportRoutes.openapi(
  createRoute({
    method: "put",
    path: "/v1/arms/{armId}/students/{studentId}/remarks/{kind}",
    tags: ["reports"],
    summary: "Save a remark for this term (empty clears it). teacher: the form teacher or an admin; principal: owners and admins",
    request: { params: z.object({ armId: Id, studentId: Id, kind: z.enum(["teacher", "principal"]) }), body: json(remarkSchema.openapi("Remark")) },
    responses: { 204: { description: "Saved" }, 409: problemContent("Not in this class any more"), 422: problemContent("#/text over 300 characters"), ...errors },
  }),
  async (c) => {
    const { armId, studentId, kind } = c.req.valid("param");
    const { text } = c.req.valid("json");
    await schoolRoute(c, { roles: STAFF }, async ({ tx, school, auth }) => {
      const { admin } = await classAccess(tx, auth, armId);
      if (kind === "principal" && !admin) throw new ApiError("forbidden", "Only the school’s owner and admins write the principal’s remark.");
      const term = await requireTerm(tx);
      await studentInClass(tx, armId, studentId);
      const one = and(eq(reportRemarks.termKey, term.key), eq(reportRemarks.studentId, studentId), eq(reportRemarks.kind, kind));
      if (!text) await tx.delete(reportRemarks).where(one);
      else
        await tx
          .insert(reportRemarks)
          .values({ schoolId: school.id, termKey: term.key, studentId, kind, text, createdBy: auth.user.id, updatedBy: auth.user.id })
          .onConflictDoUpdate({ target: [reportRemarks.schoolId, reportRemarks.termKey, reportRemarks.studentId, reportRemarks.kind], set: { text, updatedBy: auth.user.id, updatedAt: new Date() } });
    });
    return c.body(null, 204);
  },
);

reportRoutes.openapi(
  createRoute({
    method: "put",
    path: "/v1/arms/{armId}/students/{studentId}/ratings",
    tags: ["reports"],
    summary: "Save a behaviour rating for this term: 1 (Poor) to 5 (Excellent), or null to clear it",
    request: { params: z.object({ armId: Id, studentId: Id }), body: json(ratingSchema.openapi("Rating")) },
    responses: { 204: { description: "Saved" }, 409: problemContent("Trait not rated here, or student not in this class"), ...errors },
  }),
  async (c) => {
    const { armId, studentId } = c.req.valid("param");
    const { trait, value } = c.req.valid("json");
    await schoolRoute(c, { roles: STAFF }, async ({ tx, school, auth }) => {
      await classAccess(tx, auth, armId);
      const term = await requireTerm(tx);
      const { ratings } = await settingsOf(tx);
      if (!ratings.enabled || !ratings.traits.includes(trait)) throw new ApiError("conflict", "That trait isn’t rated here any more. Reload the page.");
      await studentInClass(tx, armId, studentId);
      const one = and(eq(reportRatings.termKey, term.key), eq(reportRatings.studentId, studentId), eq(reportRatings.trait, trait));
      if (value === null) await tx.delete(reportRatings).where(one);
      else
        await tx
          .insert(reportRatings)
          .values({ schoolId: school.id, termKey: term.key, studentId, trait, value, createdBy: auth.user.id, updatedBy: auth.user.id })
          .onConflictDoUpdate({ target: [reportRatings.schoolId, reportRatings.termKey, reportRatings.studentId, reportRatings.trait], set: { value, updatedBy: auth.user.id, updatedAt: new Date() } });
    });
    return c.body(null, 204);
  },
);

const RatingSettingsSchema = z.object({ enabled: z.boolean(), traits: z.array(z.string()) }).openapi("RatingSettings");

reportRoutes.openapi(
  createRoute({ method: "get", path: "/v1/results/ratings", tags: ["reports"], summary: "Behaviour ratings: on or off, and the traits", responses: { 200: ok("Rating settings", RatingSettingsSchema), ...errors } }),
  async (c) => {
    const data = await schoolRoute(c, { roles: ADMINS }, async ({ tx }) => (await settingsOf(tx)).ratings);
    return c.json(data, 200);
  },
);

reportRoutes.openapi(
  createRoute({
    method: "put",
    path: "/v1/results/ratings",
    tags: ["reports"],
    summary: "Turn behaviour ratings on or off and set the traits (at most 12, each up to 30 characters)",
    request: { body: json(ratingSettingsSchema.openapi("RatingSettingsInput")) },
    responses: { 204: { description: "Saved" }, 422: problemContent("A trait needs fixing"), ...errors },
  }),
  async (c) => {
    const input = c.req.valid("json");
    await schoolRoute(c, { roles: ADMINS }, async ({ tx, school, auth, audit }) => {
      const current = await settingsOf(tx);
      await tx
        .insert(resultsSettings)
        .values({ schoolId: school.id, components: current.components, scale: current.scale, showPositions: current.showPositions, ratingsEnabled: input.enabled, ratingTraits: input.traits, createdBy: auth.user.id, updatedBy: auth.user.id })
        .onConflictDoUpdate({ target: resultsSettings.schoolId, set: { ratingsEnabled: input.enabled, ratingTraits: input.traits, updatedBy: auth.user.id, updatedAt: new Date() } });
      audit({ action: "results.ratings_set", entity: "school", entityId: school.id, changes: input, summary: input.enabled ? `Set behaviour ratings: ${input.traits.join(", ")}` : "Turned behaviour ratings off" });
    });
    return c.body(null, 204);
  },
);

// ——— Publishing ———

reportRoutes.openapi(
  createRoute({
    method: "put",
    path: "/v1/arms/{armId}/published",
    tags: ["reports"],
    summary: "Publish a class's results for this term (every subject complete first), or take them back",
    request: { params: z.object({ armId: Id }), body: json(z.object({ published: z.boolean() }).openapi("SetPublished")) },
    responses: { 204: { description: "Done" }, 409: problemContent("Subjects not complete (detail lists them), or already so"), ...errors },
  }),
  async (c) => {
    const { armId } = c.req.valid("param");
    const { published } = c.req.valid("json");
    await schoolRoute(c, { roles: ADMINS }, async ({ tx, school, auth, audit }) => {
      const { arm } = await classAccess(tx, auth, armId);
      const term = await requireTerm(tx);
      const already = await publishedFor(tx, term.key, armId);
      if (published) {
        if (already) throw new ApiError("conflict", `${arm.label} is already published.`);
        const { components } = await settingsOf(tx);
        const snap = await termSnapshot(tx, term.key, components);
        const pupils = (await pupilsIn(tx, [armId])).map((p) => p.id);
        const open = (await subjectsForArm(tx, armId)).filter((s) => statusIn(snap, armId, s.id, pupils).status !== "complete");
        if (open.length) throw new ApiError("conflict", `${open.length} ${open.length === 1 ? "subject isn’t" : "subjects aren’t"} complete yet: ${open.map((o) => o.name).join(", ")}.`);
        await tx.insert(publishedResults).values({ schoolId: school.id, termKey: term.key, classArmId: armId, publishedBy: auth.user.id, createdBy: auth.user.id, updatedBy: auth.user.id });
        audit({ action: "results.published", entity: "class_arm", entityId: armId, changes: { term: term.key }, summary: `Published ${term.name} results for ${arm.label}` });
      } else {
        if (!already) throw new ApiError("conflict", `${arm.label} isn’t published.`);
        await tx.delete(publishedResults).where(and(eq(publishedResults.termKey, term.key), eq(publishedResults.classArmId, armId)));
        audit({ action: "results.unpublished", entity: "class_arm", entityId: armId, changes: { term: term.key }, summary: `Took back ${term.name} results for ${arm.label}` });
      }
    });
    return c.body(null, 204);
  },
);

// ——— Report cards ———

reportRoutes.openapi(
  createRoute({
    method: "get",
    path: "/v1/students/{id}/report-card",
    tags: ["reports"],
    summary: "A student's report card for this term, or a past one (?term=2026-1). Owners, admins, and the form teacher of the student's class",
    request: { params: z.object({ id: Id }), query: z.object({ term: TermKey.optional() }) },
    responses: { 200: ok("Report card", ReportCardSchema), ...errors },
  }),
  async (c) => {
    const { id } = c.req.valid("param");
    const { term } = c.req.valid("query");
    const data = await schoolRoute(c, { roles: STAFF }, async ({ tx, auth, school }) => {
      const [s] = await tx.select({ armId: students.classArmId }).from(students).where(and(eq(students.id, id), isNull(students.deletedAt))).limit(1);
      if (!s) throw new ApiError("not_found", "That student isn’t here.");
      await classAccess(tx, auth, s.armId);
      const card = await buildReportCard(tx, school, id, term);
      if (!card) throw new ApiError("not_found", "There’s no such term for this student.");
      return card;
    });
    return c.json(data, 200);
  },
);

reportRoutes.openapi(
  createRoute({
    method: "get",
    path: "/v1/students/{id}/report-terms",
    tags: ["reports"],
    summary: "Every term a student has results in, newest first, and whether each was published",
    request: { params: z.object({ id: Id }) },
    responses: {
      200: ok("Terms", z.array(z.object({ key: z.string(), name: z.string(), session: z.string(), published: z.boolean(), open: z.boolean() }).openapi("ReportTerm"))),
      ...errors,
    },
  }),
  async (c) => {
    const { id } = c.req.valid("param");
    const data = await schoolRoute(c, { roles: ADMINS }, async ({ tx }) => {
      const [s] = await tx.select({ id: students.id }).from(students).where(and(eq(students.id, id), isNull(students.deletedAt))).limit(1);
      if (!s) throw new ApiError("not_found", "That student isn’t here.");
      return reportTermsOf(tx, id);
    });
    return c.json(data, 200);
  },
);
