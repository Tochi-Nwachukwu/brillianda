/**
 * The timetable (B5 in the front end's backend-requirements.md; rules in
 * packages/core/src/timetable.ts, flow from its src/data/fake/timetable.ts).
 *
 *   GET    /v1/timetable                              owner, admin, teacher: the whole timetable
 *   PUT    /v1/timetable/periods                      owner, admin: { periods } → { removed }
 *   PUT    /v1/timetable/{armId}/{day}/{periodId}     owner, admin: { subjectId | null }
 *   PUT    /v1/timetable/classes                      owner, admin: { fileName, classes: [{ armId, lessons }] }
 *   PUT    /v1/timetable/document                     owner, admin: multipart `file`, a PDF up to 2 MB
 *   DELETE /v1/timetable/document                     owner, admin
 *   GET    /v1/timetable/document                     owner, admin, teacher: the PDF
 *   GET    /v1/me/lessons?day=                        a teacher's lessons that day, in period order
 *
 * One bell schedule per school, Monday to Friday. A lesson's teacher isn't stored: it is the
 * class's teacher for that subject (PUT /v1/teachers/{id}/subject-classes). A teacher in two
 * classes at once is flagged, not refused. Uploads are read in the browser; the API receives
 * whole classes' weeks.
 */
import { createHash } from "node:crypto";
import { clashes as findClashes, DAYS, DAY_NAME, TIME, type Day } from "@brillianda/core";
import {
  and,
  asc,
  classLevelSubjects,
  eq,
  inArray,
  notInArray,
  schoolSubjects,
  subjectTeachers,
  timetableLessons,
  timetables,
  users,
  type TimetablePeriod,
  type Tx,
} from "@brillianda/db";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import type { AppEnv } from "../context.js";
import { ApiError, problemContent } from "../lib/errors.js";
import { schoolRoute, type Role } from "../school-route.js";
import { armOptions } from "./classes.js";

export const timetableRoutes = new OpenAPIHono<AppEnv>();

const ADMINS: readonly Role[] = ["owner", "admin"];
const STAFF: readonly Role[] = ["owner", "admin", "teacher"];
export const TIMETABLE_FILE_MAX_BYTES = 2 * 1024 * 1024;
const ok = <T extends z.ZodTypeAny>(description: string, schema: T) => ({ description, content: { "application/json": { schema } } });
const errors = {
  401: problemContent("Not signed in to this school"),
  403: problemContent("Only owners and admins change it; teachers read it"),
  404: problemContent("No active school here"),
} as const;
const field = (pointer: string, detail: string) => new ApiError("validation_failed", detail, { extensions: { errors: [{ pointer, detail, code: "invalid" }] } });

// The front end's periodsSchema, lessonInputSchema and timetableImportSchema, with the same rules.
const PeriodSchema = z.object({
  id: z.string().trim().min(1).max(40),
  label: z.string().trim().min(1, "Name the period").max(30, "Use at most 30 characters"),
  start: z.string().regex(TIME, "Use a time like 08:00"),
  end: z.string().regex(TIME, "Use a time like 08:40"),
  kind: z.enum(["lesson", "break"]),
});
const periodsSchema = z
  .array(PeriodSchema)
  .min(1, "Add at least one period")
  .max(16, "Use at most 16 periods")
  .superRefine((periods, ctx) => {
    const ids = new Set<string>();
    periods.forEach((p, i) => {
      if (ids.has(p.id)) ctx.addIssue({ code: "custom", path: [i, "id"], message: "Each period needs its own id" });
      ids.add(p.id);
      if (TIME.test(p.start) && TIME.test(p.end) && p.end <= p.start) ctx.addIssue({ code: "custom", path: [i, "end"], message: "Ends after it starts" });
      const before = periods[i - 1];
      if (before && TIME.test(p.start) && TIME.test(before.end) && p.start < before.end) ctx.addIssue({ code: "custom", path: [i, "start"], message: `Starts after ${before.label} ends` });
    });
    if (!periods.some((p) => p.kind === "lesson")) ctx.addIssue({ code: "custom", path: [], message: "Keep at least one lesson period" });
  });
const DaySchema = z.coerce.number().int().refine((d): d is Day => (DAYS as readonly number[]).includes(d), "Monday to Friday only");
const timetableImportSchema = z.object({
  fileName: z.string().trim().max(200),
  classes: z
    .array(
      z.object({
        armId: z.string().uuid("Invalid class"),
        lessons: z.array(z.object({ day: DaySchema, periodId: z.string().min(1), subjectId: z.string().uuid("Invalid subject") })).max(100),
      }),
    )
    .min(1, "Nothing to import")
    .max(200),
});

async function periodsOf(tx: Tx): Promise<TimetablePeriod[]> {
  const [row] = await tx.select({ periods: timetables.periods }).from(timetables).limit(1);
  return row?.periods ?? [];
}

/** Who teaches each class its subject: "armId|subjectId" → userId. */
async function teachersOf(tx: Tx): Promise<Map<string, string>> {
  const rows = await tx.select({ armId: subjectTeachers.classArmId, subjectId: subjectTeachers.schoolSubjectId, userId: subjectTeachers.userId }).from(subjectTeachers);
  return new Map(rows.map((r) => [`${r.armId}|${r.subjectId}`, r.userId]));
}

const docUrl = (sha256: string) => `/api/v1/timetable/document?v=${sha256.slice(0, 16)}`;

const PeriodOut = z.object({ id: z.string(), label: z.string(), start: z.string(), end: z.string(), kind: z.enum(["lesson", "break"]) }).openapi("Period");
const DayOut = z.number().int().min(1).max(5);
const TimetablePageSchema = z
  .object({
    periods: z.array(PeriodOut),
    arms: z.array(z.object({ id: z.string().uuid(), label: z.string(), levelId: z.string().uuid() })),
    subjects: z.array(z.object({ id: z.string().uuid(), name: z.string(), code: z.string(), levelIds: z.array(z.string().uuid()) })).openapi({ description: "The school's subjects, and which class levels take each" }),
    lessons: z.array(z.object({ armId: z.string().uuid(), day: DayOut, periodId: z.string(), subjectId: z.string().uuid(), teacherId: z.string().uuid().nullable(), teacherName: z.string().nullable() })),
    clashes: z.array(z.object({ teacherName: z.string(), day: DayOut, periodId: z.string(), armLabels: z.array(z.string()) })).openapi({ description: "A teacher in two classes at once" }),
    file: z.object({ name: z.string(), size: z.number().int(), url: z.string(), by: z.string(), at: z.number().int() }).nullable(),
    me: z.object({ userId: z.string().uuid(), canEdit: z.boolean() }),
  })
  .openapi("TimetablePage");

timetableRoutes.openapi(
  createRoute({ method: "get", path: "/v1/timetable", tags: ["timetable"], summary: "The whole timetable for staff: periods, classes, subjects, lessons with their teacher, clashes, the document", responses: { 200: ok("Timetable", TimetablePageSchema), ...errors } }),
  async (c) => {
    const data = await schoolRoute(c, { roles: STAFF }, async ({ tx, auth }) => {
      const arms = await armOptions(tx);
      const labels = new Map(arms.map((a) => [a.id, a.label]));
      const [row] = await tx.select({ t: timetables, by: users.fullName }).from(timetables).leftJoin(users, eq(users.id, timetables.fileBy)).limit(1);
      const periods = row?.t.periods ?? [];
      const subjects = await tx.select({ id: schoolSubjects.id, name: schoolSubjects.name, code: schoolSubjects.code }).from(schoolSubjects).orderBy(asc(schoolSubjects.name));
      const links = await tx.select({ subjectId: classLevelSubjects.schoolSubjectId, levelId: classLevelSubjects.classLevelId }).from(classLevelSubjects);
      const lessons = (await tx.select().from(timetableLessons)).filter((l) => labels.has(l.classArmId)).map((l) => ({ armId: l.classArmId, day: l.day as Day, periodId: l.periodId, subjectId: l.schoolSubjectId }));
      const teachers = await teachersOf(tx);
      const teacherOf = (armId: string, subjectId: string) => teachers.get(`${armId}|${subjectId}`) ?? null;
      const ids = [...new Set(teachers.values())];
      const names = new Map(ids.length ? (await tx.select({ id: users.id, name: users.fullName }).from(users).where(inArray(users.id, ids))).map((u) => [u.id, u.name]) : []);
      return {
        periods,
        arms: arms.map((a) => ({ id: a.id, label: a.label, levelId: a.levelId })),
        subjects: subjects.map((s) => ({ ...s, levelIds: links.filter((l) => l.subjectId === s.id).map((l) => l.levelId) })),
        lessons: lessons.map((l) => {
          const teacherId = teacherOf(l.armId, l.subjectId);
          return { ...l, teacherId, teacherName: teacherId ? (names.get(teacherId) ?? null) : null };
        }),
        clashes: findClashes(lessons, teacherOf).map((k) => ({ teacherName: names.get(k.teacherId) ?? "A teacher", day: k.day, periodId: k.periodId, armLabels: k.armIds.map((id) => labels.get(id) ?? "") })),
        file:
          row?.t.fileBytes && row.t.fileSha256
            ? { name: row.t.fileName ?? "timetable.pdf", size: row.t.fileBytes.length, url: docUrl(row.t.fileSha256), by: row.by ?? "A former staff member", at: row.t.fileAt!.getTime() }
            : null,
        me: { userId: auth.user.id, canEdit: auth.membership.role === "owner" || auth.membership.role === "admin" },
      };
    });
    return c.json(data, 200);
  },
);

timetableRoutes.openapi(
  createRoute({
    method: "put",
    path: "/v1/timetable/periods",
    tags: ["timetable"],
    summary: "Save the bell schedule (up to 16 periods, in order, no overlaps). Lessons in a removed period, or one made a break, are dropped",
    request: { body: { content: { "application/json": { schema: z.object({ periods: periodsSchema }).openapi("BellSchedule") } }, required: true } },
    responses: { 200: ok("Saved", z.object({ removed: z.number().int() })), 422: problemContent("A period needs fixing, e.g. #/periods/2/start"), ...errors },
  }),
  async (c) => {
    const { periods } = c.req.valid("json");
    const data = await schoolRoute(c, { roles: ADMINS }, async ({ tx, school, auth, audit }) => {
      const lessonIds = periods.filter((p) => p.kind === "lesson").map((p) => p.id);
      const removed = await tx.delete(timetableLessons).where(notInArray(timetableLessons.periodId, lessonIds)).returning({ id: timetableLessons.id });
      await tx
        .insert(timetables)
        .values({ schoolId: school.id, periods, createdBy: auth.user.id, updatedBy: auth.user.id })
        .onConflictDoUpdate({ target: timetables.schoolId, set: { periods, updatedBy: auth.user.id, updatedAt: new Date() } });
      audit({ action: "timetable.periods_saved", entity: "school", entityId: school.id, changes: { periods: periods.length, removedLessons: removed.length }, summary: "Changed the bell schedule" });
      return { removed: removed.length };
    });
    return c.json(data, 200);
  },
);

/** The class, and a lesson period in the bell schedule. */
async function checkSlot(tx: Tx, armId: string, periodId: string, periods: TimetablePeriod[], arms: Map<string, string>): Promise<void> {
  if (!arms.has(armId)) throw new ApiError("not_found", "That class isn’t here any more.");
  const period = periods.find((p) => p.id === periodId);
  if (!period) throw new ApiError("not_found", "That period isn’t in the bell schedule any more.");
  if (period.kind === "break") throw new ApiError("conflict", "No lessons in a break.");
}

timetableRoutes.openapi(
  createRoute({
    method: "put",
    path: "/v1/timetable/{armId}/{day}/{periodId}",
    tags: ["timetable"],
    summary: "One class's lesson in one period; a null subject makes it free",
    request: {
      params: z.object({ armId: z.string().uuid("Invalid id"), day: DaySchema, periodId: z.string().min(1).max(40) }),
      body: { content: { "application/json": { schema: z.object({ subjectId: z.string().uuid("Choose a subject").nullable() }).openapi("SetLesson") } }, required: true },
    },
    responses: { 204: { description: "Saved" }, 409: problemContent("A break"), ...errors, 404: problemContent("No such class, period or subject") },
  }),
  async (c) => {
    const { armId, day, periodId } = c.req.valid("param");
    const { subjectId } = c.req.valid("json");
    await schoolRoute(c, { roles: ADMINS }, async ({ tx, school, auth, audit }) => {
      const periods = await periodsOf(tx);
      const arms = new Map((await armOptions(tx)).map((a) => [a.id, a.label]));
      await checkSlot(tx, armId, periodId, periods, arms);
      let subjectName: string | null = null;
      if (subjectId) {
        const [s] = await tx.select({ name: schoolSubjects.name }).from(schoolSubjects).where(eq(schoolSubjects.id, subjectId)).limit(1);
        if (!s) throw new ApiError("not_found", "That subject isn’t here any more.");
        subjectName = s.name;
      }
      const slot = and(eq(timetableLessons.classArmId, armId), eq(timetableLessons.day, day), eq(timetableLessons.periodId, periodId));
      if (subjectId) {
        await tx
          .insert(timetableLessons)
          .values({ schoolId: school.id, classArmId: armId, day, periodId, schoolSubjectId: subjectId, createdBy: auth.user.id, updatedBy: auth.user.id })
          .onConflictDoUpdate({ target: [timetableLessons.schoolId, timetableLessons.classArmId, timetableLessons.day, timetableLessons.periodId], set: { schoolSubjectId: subjectId, updatedBy: auth.user.id, updatedAt: new Date() } });
      } else {
        await tx.delete(timetableLessons).where(slot);
      }
      const label = periods.find((p) => p.id === periodId)!.label;
      audit({
        action: "timetable.lesson_set",
        entity: "class_arm",
        entityId: armId,
        changes: { day, periodId, subjectId },
        summary: `${subjectName ? `Set ${arms.get(armId)}’s ${DAY_NAME[day]} ${label} to ${subjectName}` : `Made ${arms.get(armId)}’s ${DAY_NAME[day]} ${label} free`}`,
      });
    });
    return c.body(null, 204);
  },
);

timetableRoutes.openapi(
  createRoute({
    method: "put",
    path: "/v1/timetable/classes",
    tags: ["timetable"],
    summary: "Replace whole classes' weeks, read from an uploaded file in the browser",
    request: { body: { content: { "application/json": { schema: timetableImportSchema.openapi("TimetableImport") } }, required: true } },
    responses: { 200: ok("Imported", z.object({ classes: z.number().int(), lessons: z.number().int() })), 409: problemContent("A lesson in a break"), 422: problemContent("A lesson needs fixing, e.g. #/classes/0/lessons/3/periodId"), ...errors, 404: problemContent("A class or subject that isn't here") },
  }),
  async (c) => {
    const input = c.req.valid("json");
    const data = await schoolRoute(c, { roles: ADMINS }, async ({ tx, school, auth, audit }) => {
      const periods = await periodsOf(tx);
      const arms = new Map((await armOptions(tx)).map((a) => [a.id, a.label]));
      const subjectIds = new Set((await tx.select({ id: schoolSubjects.id }).from(schoolSubjects)).map((s) => s.id));
      const armIds = new Set<string>();
      for (const [i, k] of input.classes.entries()) {
        if (armIds.has(k.armId)) throw field(`#/classes/${i}/armId`, "This class is in the upload twice.");
        armIds.add(k.armId);
        if (!arms.has(k.armId)) throw new ApiError("not_found", "A class in the file isn’t here any more.");
        const slots = new Set<string>();
        for (const [j, l] of k.lessons.entries()) {
          const period = periods.find((p) => p.id === l.periodId);
          if (!period) throw field(`#/classes/${i}/lessons/${j}/periodId`, "That period isn’t in the bell schedule any more.");
          if (period.kind === "break") throw new ApiError("conflict", "No lessons in a break.");
          if (!subjectIds.has(l.subjectId)) throw new ApiError("not_found", "A subject in the file isn’t here any more.");
          const slot = `${l.day}|${l.periodId}`;
          if (slots.has(slot)) throw field(`#/classes/${i}/lessons/${j}`, `${arms.get(k.armId)} has two lessons on ${DAY_NAME[l.day as Day]} in ${period.label}.`);
          slots.add(slot);
        }
      }
      await tx.delete(timetableLessons).where(inArray(timetableLessons.classArmId, [...armIds]));
      const rows = input.classes.flatMap((k) => k.lessons.map((l) => ({ schoolId: school.id, classArmId: k.armId, day: l.day, periodId: l.periodId, schoolSubjectId: l.subjectId, createdBy: auth.user.id, updatedBy: auth.user.id })));
      if (rows.length) await tx.insert(timetableLessons).values(rows);
      const n = input.classes.length;
      audit({
        action: "timetable.imported",
        entity: "school",
        entityId: school.id,
        changes: { fileName: input.fileName, classes: n, lessons: rows.length },
        summary: `Uploaded the timetable for ${n === 1 ? "1 class" : `${n} classes`}${input.fileName ? ` from ${input.fileName}` : ""}`,
      });
      return { classes: n, lessons: rows.length };
    });
    return c.json(data, 200);
  },
);

// ——— The document ———

function fileError(detail: string) {
  return new ApiError("validation_failed", detail, { extensions: { errors: [{ pointer: "#/file", detail, code: "invalid_file" }] } });
}

async function readPdf(c: Context<AppEnv>): Promise<{ name: string; bytes: Uint8Array }> {
  const form = (c.req.valid as (target: "form") => Record<string, unknown>)("form");
  const file = form.file;
  if (!(file instanceof File)) throw fileError("Send the PDF as multipart/form-data, in a field named file.");
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.length > TIMETABLE_FILE_MAX_BYTES) throw new ApiError("payload_too_large", "This PDF is over 2 MB. Save a smaller copy and try again.");
  if (Buffer.from(bytes.subarray(0, 5)).toString("latin1") !== "%PDF-") throw fileError("Upload a PDF.");
  const name = (file.name || "timetable.pdf").replace(/[\\/\r\n"]/g, "").slice(0, 200) || "timetable.pdf";
  return { name, bytes };
}

timetableRoutes.openapi(
  createRoute({
    method: "put",
    path: "/v1/timetable/document",
    tags: ["timetable"],
    summary: "Upload the timetable document: multipart/form-data, one file named `file`, a PDF up to 2 MB",
    request: { body: { content: { "multipart/form-data": { schema: z.object({ file: z.any().optional().openapi({ type: "string", format: "binary" }) }) } }, required: true } },
    responses: { 204: { description: "Saved" }, 413: problemContent("Over 2 MB"), 422: problemContent("Not a PDF"), ...errors },
  }),
  async (c) => {
    await schoolRoute(c, { roles: ADMINS }, async ({ tx, school, auth, audit }) => {
      const { name, bytes } = await readPdf(c);
      const fileSha256 = createHash("sha256").update(bytes).digest("hex");
      const set = { fileName: name, fileBytes: Buffer.from(bytes), fileSha256, fileBy: auth.user.id, fileAt: new Date(), updatedBy: auth.user.id };
      await tx
        .insert(timetables)
        .values({ schoolId: school.id, ...set, createdBy: auth.user.id })
        .onConflictDoUpdate({ target: timetables.schoolId, set: { ...set, updatedAt: new Date() } });
      audit({ action: "timetable.document_uploaded", entity: "school", entityId: school.id, changes: { name, size: bytes.length, sha256: fileSha256 }, summary: `Uploaded the timetable document ${name}` });
    });
    return c.body(null, 204);
  },
);

timetableRoutes.openapi(
  createRoute({ method: "delete", path: "/v1/timetable/document", tags: ["timetable"], summary: "Remove the timetable document", responses: { 204: { description: "Removed" }, ...errors } }),
  async (c) => {
    await schoolRoute(c, { roles: ADMINS }, async ({ tx, school, auth, audit }) => {
      const removed = await tx
        .update(timetables)
        .set({ fileName: null, fileBytes: null, fileSha256: null, fileBy: null, fileAt: null, updatedBy: auth.user.id, updatedAt: new Date() })
        .where(eq(timetables.schoolId, school.id))
        .returning({ name: timetables.fileName });
      if (removed.length) audit({ action: "timetable.document_removed", entity: "school", entityId: school.id, summary: "Removed the timetable document" });
    });
    return c.body(null, 204);
  },
);

timetableRoutes.openapi(
  createRoute({
    method: "get",
    path: "/v1/timetable/document",
    tags: ["timetable"],
    summary: "The timetable document (a PDF), for staff",
    request: { query: z.object({ v: z.string().max(64).optional() }) },
    responses: { 200: { description: "The PDF", content: { "application/pdf": { schema: z.string() } } }, ...errors, 404: problemContent("No document") },
  }),
  async (c) => {
    const doc = await schoolRoute(c, { roles: STAFF }, async ({ tx }) => {
      const [row] = await tx.select({ name: timetables.fileName, bytes: timetables.fileBytes, sha256: timetables.fileSha256 }).from(timetables).limit(1);
      if (!row?.bytes) throw new ApiError("not_found", "There’s no timetable document.");
      return row;
    });
    const ascii = (doc.name ?? "timetable.pdf").replace(/[^\x20-\x7e]/g, "_");
    return c.body(new Uint8Array(doc.bytes!), 200, {
      "content-type": "application/pdf",
      "content-disposition": `inline; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(doc.name ?? "timetable.pdf")}`,
      etag: `"${doc.sha256}"`,
      "cache-control": "private, max-age=300",
      "x-content-type-options": "nosniff",
    });
  },
);

// ——— A teacher's day ———

/** Today's weekday in Lagos, 1 Monday to 5 Friday; null at the weekend. */
function lagosWeekday(): Day | null {
  const d = new Date(Date.now() + 3_600_000).getUTCDay();
  return d >= 1 && d <= 5 ? (d as Day) : null;
}

timetableRoutes.openapi(
  createRoute({
    method: "get",
    path: "/v1/me/lessons",
    tags: ["timetable"],
    summary: "The signed-in teacher's lessons on a day (default today; none at weekends), in period order",
    request: { query: z.object({ day: DaySchema.optional() }) },
    responses: { 200: ok("Lessons", z.array(z.object({ period: PeriodOut, armLabel: z.string(), subjectName: z.string() }))), ...errors },
  }),
  async (c) => {
    const { day: asked } = c.req.valid("query");
    const data = await schoolRoute(c, { roles: STAFF }, async ({ tx, auth }) => {
      const day = asked ?? lagosWeekday();
      if (!day) return [];
      const mine = await tx.select({ armId: subjectTeachers.classArmId, subjectId: subjectTeachers.schoolSubjectId }).from(subjectTeachers).where(eq(subjectTeachers.userId, auth.user.id));
      if (!mine.length) return [];
      const teaches = new Set(mine.map((m) => `${m.armId}|${m.subjectId}`));
      const periods = await periodsOf(tx);
      const labels = new Map((await armOptions(tx)).map((a) => [a.id, a.label]));
      const names = new Map((await tx.select({ id: schoolSubjects.id, name: schoolSubjects.name }).from(schoolSubjects)).map((s) => [s.id, s.name]));
      const lessons = await tx.select().from(timetableLessons).where(eq(timetableLessons.day, day));
      return lessons
        .filter((l) => teaches.has(`${l.classArmId}|${l.schoolSubjectId}`) && labels.has(l.classArmId))
        .map((l) => ({ period: periods.find((p) => p.id === l.periodId), armLabel: labels.get(l.classArmId)!, subjectName: names.get(l.schoolSubjectId) ?? "" }))
        .filter((x): x is { period: TimetablePeriod; armLabel: string; subjectName: string } => !!x.period)
        .sort((a, b) => a.period.start.localeCompare(b.period.start));
    });
    return c.json(data, 200);
  },
);
