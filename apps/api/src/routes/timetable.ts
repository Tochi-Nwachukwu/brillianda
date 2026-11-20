/**
 * The timetable (B5 in the front end's backend-requirements.md; rules in
 * packages/core/src/timetable.ts, flow from its src/data/fake/timetable.ts).
 *
 *   GET    /v1/timetable                              owner, admin, teacher: the whole timetable
 *   PUT    /v1/timetable/groups                       owner, admin: { groups: [{ id?, name, sections }] } → { removed }
 *   PUT    /v1/timetable/groups/{id}/periods          owner, admin: { periods } → { removed }
 *   PUT    /v1/timetable/groups/{id}/document         owner, admin: multipart `file`, a PDF up to 2 MB
 *   DELETE /v1/timetable/groups/{id}/document         owner, admin
 *   GET    /v1/timetable/groups/{id}/document         owner, admin, teacher: the PDF
 *   PUT    /v1/timetable/periods                      owner, admin: the first timetable's { periods } → { removed }
 *   PUT    /v1/timetable/{armId}/{day}/{periodId}     owner, admin: { subjectId | null }
 *   PUT    /v1/timetable/classes                      owner, admin: { fileName, classes: [{ armId, lessons }] }
 *   PUT    /v1/timetable/document                     the first timetable's document (as above)
 *   DELETE /v1/timetable/document
 *   GET    /v1/timetable/document
 *   GET    /v1/me/lessons?day=                        a teacher's lessons that day, in period order
 *
 * A school has one to four timetables (A4, 30 Oct 2026), each covering some class sections
 * (preschool, primary, junior, senior) with its own bell schedule and document; a class follows the
 * one its level's section is in, else the first. Monday to Friday. A lesson's teacher isn't stored: it is the
 * class's teacher for that subject (PUT /v1/teachers/{id}/subject-classes). A teacher in two
 * classes at overlapping times is flagged, not refused. Uploads are read in the browser; the API receives
 * whole classes' weeks.
 */
import { createHash } from "node:crypto";
import { clashes as findClashes, DAYS, DAY_NAME, groupFor, SECTION_SHORT, SECTIONS, TIME, type Day } from "@brillianda/core";
import {
  and,
  asc,
  classLevelSubjects,
  eq,
  inArray,
  schoolSubjects,
  sql,
  subjectTeachers,
  timetableGroups,
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
import { armOptions, type ArmOption } from "./classes.js";

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

const SECTION_ENUM = z.enum(["preschool", "primary", "junior", "senior"]);

// The front end's groupsSchema, with the same rules.
const groupsSchema = z
  .object({
    groups: z
      .array(
        z.object({
          id: z.string().min(1).max(40).optional(),
          name: z.string().trim().min(1, "Give each timetable a name").max(40, "Use at most 40 characters for a name"),
          sections: z.array(SECTION_ENUM).min(1, "Pick the classes each timetable covers"),
        }),
      )
      .min(1, "Keep at least one timetable")
      .max(4, "Use at most 4 timetables"),
  })
  .superRefine((r, ctx) => {
    const seen = new Set<string>();
    const names = new Set<string>();
    r.groups.forEach((g, i) => {
      for (const s of g.sections) {
        if (seen.has(s)) ctx.addIssue({ code: "custom", path: ["groups", i, "sections"], message: `${SECTION_SHORT[s]} is in two timetables. Each class belongs to one` });
        seen.add(s);
      }
      const key = g.name.trim().toLowerCase();
      if (names.has(key)) ctx.addIssue({ code: "custom", path: ["groups", i, "name"], message: "Two timetables have the same name" });
      names.add(key);
    });
  });

export type TimetableGroup = typeof timetableGroups.$inferSelect;

/**
 * The school's timetables, in order. A school that has none yet gets its first, covering every
 * section, made from the old single timetable (its bell schedule and document) if it had one.
 */
export async function groupsOf(tx: Tx, schoolId: string): Promise<TimetableGroup[]> {
  const read = () => tx.select().from(timetableGroups).orderBy(asc(timetableGroups.position), asc(timetableGroups.createdAt), asc(timetableGroups.id));
  let rows = await read();
  if (rows.length) return rows;
  // Two first requests at once must not make two.
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`timetable_groups:${schoolId}`}, 0))`);
  rows = await read();
  if (rows.length) return rows;
  const [old] = await tx.select().from(timetables).limit(1);
  const [made] = await tx
    .insert(timetableGroups)
    .values({
      schoolId,
      name: "Whole school",
      sections: [...SECTIONS],
      position: 0,
      periods: old?.periods ?? [],
      fileName: old?.fileName ?? null,
      fileBytes: old?.fileBytes ?? null,
      fileSha256: old?.fileSha256 ?? null,
      fileBy: old?.fileBy ?? null,
      fileAt: old?.fileAt ?? null,
      createdBy: old?.createdBy ?? null,
      updatedBy: old?.updatedBy ?? null,
    })
    .returning();
  return [made!];
}

/** The timetable a class follows. */
export const groupOfArm = (groups: TimetableGroup[], arm: Pick<ArmOption, "section"> | undefined) => groupFor(groups, arm?.section);

/** A class's bell schedule: its own timetable's periods. */
export async function periodsForArm(tx: Tx, schoolId: string, armId: string): Promise<TimetablePeriod[]> {
  const groups = await groupsOf(tx, schoolId);
  const arm = (await armOptions(tx, { all: true })).find((a) => a.id === armId);
  return groupOfArm(groups, arm).periods;
}

/** Drops lessons that aren't in a lesson period of their class's timetable (only `only`'s classes, if given). */
async function dropStrayLessons(tx: Tx, groups: TimetableGroup[], arms: ArmOption[], only?: string): Promise<number> {
  const lessonPeriods = new Map(groups.map((g) => [g.id, new Set(g.periods.filter((p) => p.kind === "lesson").map((p) => p.id))]));
  const byId = new Map(arms.map((a) => [a.id, a]));
  const lessons = await tx.select({ id: timetableLessons.id, armId: timetableLessons.classArmId, periodId: timetableLessons.periodId }).from(timetableLessons);
  const stray = lessons
    .filter((l) => {
      const arm = byId.get(l.armId);
      if (!arm) return false;
      const group = groupOfArm(groups, arm);
      if (only && group.id !== only) return false;
      return !lessonPeriods.get(group.id)!.has(l.periodId);
    })
    .map((l) => l.id);
  for (let i = 0; i < stray.length; i += 500) await tx.delete(timetableLessons).where(inArray(timetableLessons.id, stray.slice(i, i + 500)));
  return stray.length;
}

/** "Primary", "Primary and JSS", "Primary, JSS and SSS". */
const listed = (names: string[]) => (names.length < 2 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`);

/** Who teaches each class its subject: "armId|subjectId" → userId. */
async function teachersOf(tx: Tx): Promise<Map<string, string>> {
  const rows = await tx.select({ armId: subjectTeachers.classArmId, subjectId: subjectTeachers.schoolSubjectId, userId: subjectTeachers.userId }).from(subjectTeachers);
  return new Map(rows.map((r) => [`${r.armId}|${r.subjectId}`, r.userId]));
}

const docUrl = (groupId: string, sha256: string) => `/api/v1/timetable/groups/${groupId}/document?v=${sha256.slice(0, 16)}`;
const fileOf = (g: TimetableGroup, by: string | null) =>
  g.fileBytes && g.fileSha256 ? { name: g.fileName ?? "timetable.pdf", size: g.fileBytes.length, url: docUrl(g.id, g.fileSha256), by: by ?? "A former staff member", at: g.fileAt!.getTime() } : null;

const PeriodOut = z.object({ id: z.string(), label: z.string(), start: z.string(), end: z.string(), kind: z.enum(["lesson", "break"]) }).openapi("Period");
const DayOut = z.number().int().min(1).max(5);
const FileOut = z.object({ name: z.string(), size: z.number().int(), url: z.string(), by: z.string(), at: z.number().int() });
const TimetablePageSchema = z
  .object({
    groups: z
      .array(z.object({ id: z.string().uuid(), name: z.string(), sections: z.array(SECTION_ENUM), periods: z.array(PeriodOut), file: FileOut.nullable() }))
      .openapi({ description: "One to four timetables, in order; a class follows the one its section is in, else the first" }),
    canSplit: z.boolean().openapi({ description: "Always true: PUT /v1/timetable/groups splits or joins" }),
    periods: z.array(PeriodOut).openapi({ description: "Deprecated: the first timetable's periods (use groups)" }),
    arms: z.array(z.object({ id: z.string().uuid(), label: z.string(), levelId: z.string().uuid(), section: SECTION_ENUM })),
    subjects: z.array(z.object({ id: z.string().uuid(), name: z.string(), code: z.string(), levelIds: z.array(z.string().uuid()) })).openapi({ description: "The school's subjects, and which class levels take each" }),
    lessons: z.array(z.object({ armId: z.string().uuid(), day: DayOut, periodId: z.string(), subjectId: z.string().uuid(), teacherId: z.string().uuid().nullable(), teacherName: z.string().nullable() })),
    clashes: z.array(z.object({ teacherName: z.string(), day: DayOut, periodId: z.string(), armLabels: z.array(z.string()) })).openapi({ description: "A teacher in two classes at overlapping times" }),
    file: FileOut.nullable().openapi({ description: "Deprecated: the first timetable's document (use groups)" }),
    me: z.object({ userId: z.string().uuid(), canEdit: z.boolean() }),
  })
  .openapi("TimetablePage");

timetableRoutes.openapi(
  createRoute({ method: "get", path: "/v1/timetable", tags: ["timetable"], summary: "The whole timetable for staff: periods, classes, subjects, lessons with their teacher, clashes, the document", responses: { 200: ok("Timetable", TimetablePageSchema), ...errors } }),
  async (c) => {
    const data = await schoolRoute(c, { roles: STAFF }, async ({ tx, school, auth }) => {
      const arms = await armOptions(tx);
      const labels = new Map(arms.map((a) => [a.id, a.label]));
      const byArm = new Map(arms.map((a) => [a.id, a]));
      const groups = await groupsOf(tx, school.id);
      const uploaders = groups.map((g) => g.fileBy).filter((id): id is string => !!id);
      const uploader = new Map(uploaders.length ? (await tx.select({ id: users.id, name: users.fullName }).from(users).where(inArray(users.id, uploaders))).map((u) => [u.id, u.name]) : []);
      const subjects = await tx.select({ id: schoolSubjects.id, name: schoolSubjects.name, code: schoolSubjects.code }).from(schoolSubjects).orderBy(asc(schoolSubjects.name));
      const links = await tx.select({ subjectId: classLevelSubjects.schoolSubjectId, levelId: classLevelSubjects.classLevelId }).from(classLevelSubjects);
      const lessons = (await tx.select().from(timetableLessons)).filter((l) => labels.has(l.classArmId)).map((l) => ({ armId: l.classArmId, day: l.day as Day, periodId: l.periodId, subjectId: l.schoolSubjectId }));
      const teachers = await teachersOf(tx);
      const teacherOf = (armId: string, subjectId: string) => teachers.get(`${armId}|${subjectId}`) ?? null;
      const timeOf = (armId: string, periodId: string) => groupOfArm(groups, byArm.get(armId)).periods.find((p) => p.id === periodId) ?? null;
      const ids = [...new Set(teachers.values())];
      const names = new Map(ids.length ? (await tx.select({ id: users.id, name: users.fullName }).from(users).where(inArray(users.id, ids))).map((u) => [u.id, u.name]) : []);
      const shown = groups.map((g) => ({ id: g.id, name: g.name, sections: g.sections, periods: g.periods, file: fileOf(g, g.fileBy ? (uploader.get(g.fileBy) ?? null) : null) }));
      const first = shown[0]!;
      return {
        groups: shown,
        canSplit: true,
        periods: first.periods,
        arms: arms.map((a) => ({ id: a.id, label: a.label, levelId: a.levelId, section: a.section })),
        subjects: subjects.map((s) => ({ ...s, levelIds: links.filter((l) => l.subjectId === s.id).map((l) => l.levelId) })),
        lessons: lessons.map((l) => {
          const teacherId = teacherOf(l.armId, l.subjectId);
          return { ...l, teacherId, teacherName: teacherId ? (names.get(teacherId) ?? null) : null };
        }),
        clashes: findClashes(lessons, teacherOf, timeOf).map((k) => ({ teacherName: names.get(k.teacherId) ?? "A teacher", day: k.day, periodId: k.periodId, armLabels: k.armIds.map((id) => labels.get(id) ?? "") })),
        file: first.file ? { ...first.file, url: first.file.url.replace(`/groups/${first.id}/document`, "/document") } : null,
        me: { userId: auth.user.id, canEdit: auth.membership.role === "owner" || auth.membership.role === "admin" },
      };
    });
    return c.json(data, 200);
  },
);

const GroupParam = z.object({ id: z.string().uuid("Invalid id") });

timetableRoutes.openapi(
  createRoute({
    method: "put",
    path: "/v1/timetable/groups",
    tags: ["timetable"],
    summary:
      "Split or join the timetable: one to four, every class section the school has in exactly one, names unique. A new one starts with the first one's bell schedule; lessons not in a lesson period of their class's new timetable are removed and counted; a removed timetable's document goes with it",
    request: { body: { content: { "application/json": { schema: groupsSchema.openapi("TimetableGroups") } }, required: true } },
    responses: { 200: ok("Saved", z.object({ removed: z.number().int() })), 422: problemContent("A timetable needs fixing, e.g. #/groups/1/sections"), ...errors },
  }),
  async (c) => {
    const input = c.req.valid("json");
    const data = await schoolRoute(c, { roles: ADMINS }, async ({ tx, school, auth, audit }) => {
      const before = await groupsOf(tx, school.id);
      const known = new Map(before.map((g) => [g.id, g]));
      input.groups.forEach((g, i) => {
        if (g.id && !known.has(g.id)) throw field(`#/groups/${i}/id`, "That timetable isn’t here any more. Reload and try again.");
      });
      const arms = await armOptions(tx, { all: true });
      const open = new Set((await armOptions(tx)).map((a) => a.section));
      const covered = new Set(input.groups.flatMap((g) => g.sections));
      const missing = SECTIONS.filter((s) => open.has(s) && !covered.has(s));
      if (missing.length) throw field("#/groups", `${listed(missing.map((s) => SECTION_SHORT[s]))} ${missing.length === 1 ? "isn’t" : "aren’t"} in any timetable. Each class belongs to one.`);
      const firstPeriods = before[0]!.periods;
      const kept = new Set(input.groups.flatMap((g) => (g.id ? [g.id] : [])));
      const gone = before.filter((g) => !kept.has(g.id));
      if (gone.length) await tx.delete(timetableGroups).where(inArray(timetableGroups.id, gone.map((g) => g.id)));
      for (const [i, g] of input.groups.entries()) {
        const sections = SECTIONS.filter((s) => g.sections.includes(s));
        if (g.id) {
          await tx.update(timetableGroups).set({ name: g.name, sections, position: i, updatedBy: auth.user.id, updatedAt: new Date() }).where(eq(timetableGroups.id, g.id));
        } else {
          await tx.insert(timetableGroups).values({ schoolId: school.id, name: g.name, sections, position: i, periods: firstPeriods, createdBy: auth.user.id, updatedBy: auth.user.id });
        }
      }
      const after = await groupsOf(tx, school.id);
      const removed = await dropStrayLessons(tx, after, arms);
      const names = input.groups.map((g) => g.name);
      audit({
        action: "timetable.groups_saved",
        entity: "school",
        entityId: school.id,
        changes: { groups: input.groups.map((g) => ({ name: g.name, sections: g.sections })), removedGroups: gone.map((g) => g.name), removedLessons: removed },
        summary: names.length > 1 ? `Split the timetable: ${listed(names)}` : `Made one timetable for the school: ${names[0]}`,
      });
      return { removed };
    });
    return c.json(data, 200);
  },
);

/** Saves one timetable's bell schedule; only its classes lose lessons. */
async function saveBellSchedule(c: Context<AppEnv>, groupId: string | null, periods: TimetablePeriod[]): Promise<{ removed: number }> {
  return schoolRoute(c, { roles: ADMINS }, async ({ tx, school, auth, audit }) => {
    const groups = await groupsOf(tx, school.id);
    const group = groupId ? groups.find((g) => g.id === groupId) : groups[0];
    if (!group) throw new ApiError("not_found", "That timetable isn’t here any more.");
    await tx.update(timetableGroups).set({ periods, updatedBy: auth.user.id, updatedAt: new Date() }).where(eq(timetableGroups.id, group.id));
    const after = groups.map((g) => (g.id === group.id ? { ...g, periods } : g));
    const removed = await dropStrayLessons(tx, after, await armOptions(tx, { all: true }), group.id);
    audit({
      action: "timetable.periods_saved",
      entity: "school",
      entityId: school.id,
      changes: { group: group.name, periods: periods.length, removedLessons: removed },
      summary: groups.length > 1 ? `Changed the ${group.name} bell schedule` : "Changed the bell schedule",
    });
    return { removed };
  });
}

const BellSchedule = z.object({ periods: periodsSchema }).openapi("BellSchedule");

timetableRoutes.openapi(
  createRoute({
    method: "put",
    path: "/v1/timetable/groups/{id}/periods",
    tags: ["timetable"],
    summary: "Save one timetable's bell schedule (up to 16 periods, in order, no overlaps). Its classes' lessons in a removed period, or one made a break, are dropped",
    request: { params: GroupParam, body: { content: { "application/json": { schema: BellSchedule } }, required: true } },
    responses: { 200: ok("Saved", z.object({ removed: z.number().int() })), 422: problemContent("A period needs fixing, e.g. #/periods/2/start"), ...errors, 404: problemContent("No such timetable") },
  }),
  async (c) => c.json(await saveBellSchedule(c, c.req.valid("param").id, c.req.valid("json").periods), 200),
);

timetableRoutes.openapi(
  createRoute({
    method: "put",
    path: "/v1/timetable/periods",
    tags: ["timetable"],
    summary: "The first timetable's bell schedule (same as PUT /v1/timetable/groups/{id}/periods for the first one)",
    request: { body: { content: { "application/json": { schema: BellSchedule } }, required: true } },
    responses: { 200: ok("Saved", z.object({ removed: z.number().int() })), 422: problemContent("A period needs fixing, e.g. #/periods/2/start"), ...errors },
  }),
  async (c) => c.json(await saveBellSchedule(c, null, c.req.valid("json").periods), 200),
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

/** The timetable a document request is for: by id, or the first. */
async function documentGroup(tx: Tx, schoolId: string, groupId: string | null): Promise<{ group: TimetableGroup; count: number }> {
  const groups = await groupsOf(tx, schoolId);
  const group = groupId ? groups.find((g) => g.id === groupId) : groups[0];
  if (!group) throw new ApiError("not_found", "That timetable isn’t here any more.");
  return { group, count: groups.length };
}

const of = (name: string, count: number) => (count > 1 ? ` for ${name}` : "");

async function uploadDocument(c: Context<AppEnv>, groupId: string | null) {
  await schoolRoute(c, { roles: ADMINS }, async ({ tx, school, auth, audit }) => {
    const { group, count } = await documentGroup(tx, school.id, groupId);
    const { name, bytes } = await readPdf(c);
    const fileSha256 = createHash("sha256").update(bytes).digest("hex");
    await tx
      .update(timetableGroups)
      .set({ fileName: name, fileBytes: Buffer.from(bytes), fileSha256, fileBy: auth.user.id, fileAt: new Date(), updatedBy: auth.user.id, updatedAt: new Date() })
      .where(eq(timetableGroups.id, group.id));
    audit({ action: "timetable.document_uploaded", entity: "school", entityId: school.id, changes: { group: group.name, name, size: bytes.length, sha256: fileSha256 }, summary: `Uploaded the timetable document ${name}${of(group.name, count)}` });
  });
  return c.body(null, 204);
}

async function removeDocument(c: Context<AppEnv>, groupId: string | null) {
  await schoolRoute(c, { roles: ADMINS }, async ({ tx, school, auth, audit }) => {
    const { group, count } = await documentGroup(tx, school.id, groupId);
    if (!group.fileBytes) return;
    await tx
      .update(timetableGroups)
      .set({ fileName: null, fileBytes: null, fileSha256: null, fileBy: null, fileAt: null, updatedBy: auth.user.id, updatedAt: new Date() })
      .where(eq(timetableGroups.id, group.id));
    audit({ action: "timetable.document_removed", entity: "school", entityId: school.id, changes: { group: group.name }, summary: `Removed the timetable document${of(group.name, count)}` });
  });
  return c.body(null, 204);
}

async function sendDocument(c: Context<AppEnv>, groupId: string | null) {
  const doc = await schoolRoute(c, { roles: STAFF }, async ({ tx, school }) => {
    const { group } = await documentGroup(tx, school.id, groupId);
    if (!group.fileBytes) throw new ApiError("not_found", "There’s no timetable document.");
    return { name: group.fileName, bytes: group.fileBytes, sha256: group.fileSha256 };
  });
  const ascii = (doc.name ?? "timetable.pdf").replace(/[^\x20-\x7e]/g, "_");
  return c.body(new Uint8Array(doc.bytes), 200, {
    "content-type": "application/pdf",
    "content-disposition": `inline; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(doc.name ?? "timetable.pdf")}`,
    etag: `"${doc.sha256}"`,
    "cache-control": "private, max-age=300",
    "x-content-type-options": "nosniff",
  });
}

const UploadBody = { content: { "multipart/form-data": { schema: z.object({ file: z.any().optional().openapi({ type: "string", format: "binary" }) }) } }, required: true };
const uploadResponses = { 204: { description: "Saved" }, 413: problemContent("Over 2 MB"), 422: problemContent("Not a PDF"), ...errors, 404: problemContent("No such timetable") };
const pdfResponses = { 200: { description: "The PDF", content: { "application/pdf": { schema: z.string() } } }, ...errors, 404: problemContent("No document") };
const VersionQuery = z.object({ v: z.string().max(64).optional() });

timetableRoutes.openapi(
  createRoute({ method: "put", path: "/v1/timetable/groups/{id}/document", tags: ["timetable"], summary: "Upload one timetable's document: multipart/form-data, one file named `file`, a PDF up to 2 MB", request: { params: GroupParam, body: UploadBody }, responses: uploadResponses }),
  async (c) => uploadDocument(c, c.req.valid("param").id),
);
timetableRoutes.openapi(
  createRoute({ method: "delete", path: "/v1/timetable/groups/{id}/document", tags: ["timetable"], summary: "Remove one timetable's document", request: { params: GroupParam }, responses: { 204: { description: "Removed" }, ...errors, 404: problemContent("No such timetable") } }),
  async (c) => removeDocument(c, c.req.valid("param").id),
);
timetableRoutes.openapi(
  createRoute({ method: "get", path: "/v1/timetable/groups/{id}/document", tags: ["timetable"], summary: "One timetable's document (a PDF), for staff", request: { params: GroupParam, query: VersionQuery }, responses: pdfResponses }),
  async (c) => sendDocument(c, c.req.valid("param").id),
);
timetableRoutes.openapi(
  createRoute({ method: "put", path: "/v1/timetable/document", tags: ["timetable"], summary: "The first timetable's document (as PUT /v1/timetable/groups/{id}/document)", request: { body: UploadBody }, responses: uploadResponses }),
  async (c) => uploadDocument(c, null),
);
timetableRoutes.openapi(
  createRoute({ method: "delete", path: "/v1/timetable/document", tags: ["timetable"], summary: "Remove the first timetable's document", responses: { 204: { description: "Removed" }, ...errors } }),
  async (c) => removeDocument(c, null),
);
timetableRoutes.openapi(
  createRoute({ method: "get", path: "/v1/timetable/document", tags: ["timetable"], summary: "The first timetable's document (a PDF), for staff", request: { query: VersionQuery }, responses: pdfResponses }),
  async (c) => sendDocument(c, null),
);

// ——— Lessons ———

/** The class, and a lesson period in its own timetable's bell schedule. */
function checkSlot(armId: string, periodId: string, groups: TimetableGroup[], arms: Map<string, ArmOption>): TimetablePeriod {
  const arm = arms.get(armId);
  if (!arm) throw new ApiError("not_found", "That class isn’t here any more.");
  const period = groupOfArm(groups, arm).periods.find((p) => p.id === periodId);
  if (!period) throw new ApiError("not_found", "That period isn’t in this class’s bell schedule any more.");
  if (period.kind === "break") throw new ApiError("conflict", "No lessons in a break.");
  return period;
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
      const groups = await groupsOf(tx, school.id);
      const arms = new Map((await armOptions(tx)).map((a) => [a.id, a]));
      const period = checkSlot(armId, periodId, groups, arms);
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
      const label = period.label;
      const armName = arms.get(armId)!.label;
      audit({
        action: "timetable.lesson_set",
        entity: "class_arm",
        entityId: armId,
        changes: { day, periodId, subjectId },
        summary: `${subjectName ? `Set ${armName}’s ${DAY_NAME[day]} ${label} to ${subjectName}` : `Made ${armName}’s ${DAY_NAME[day]} ${label} free`}`,
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
      const groups = await groupsOf(tx, school.id);
      const options = new Map((await armOptions(tx)).map((a) => [a.id, a]));
      const arms = new Map([...options].map(([id, a]) => [id, a.label]));
      const subjectIds = new Set((await tx.select({ id: schoolSubjects.id }).from(schoolSubjects)).map((s) => s.id));
      const armIds = new Set<string>();
      for (const [i, k] of input.classes.entries()) {
        if (armIds.has(k.armId)) throw field(`#/classes/${i}/armId`, "This class is in the upload twice.");
        armIds.add(k.armId);
        if (!arms.has(k.armId)) throw new ApiError("not_found", "A class in the file isn’t here any more.");
        const slots = new Set<string>();
        const periods = groupOfArm(groups, options.get(k.armId)).periods;
        for (const [j, l] of k.lessons.entries()) {
          const period = periods.find((p) => p.id === l.periodId);
          if (!period) throw field(`#/classes/${i}/lessons/${j}/periodId`, `That period isn’t in ${arms.get(k.armId)}’s bell schedule.`);
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
    const data = await schoolRoute(c, { roles: STAFF }, async ({ tx, school, auth }) => {
      const day = asked ?? lagosWeekday();
      if (!day) return [];
      const mine = await tx.select({ armId: subjectTeachers.classArmId, subjectId: subjectTeachers.schoolSubjectId }).from(subjectTeachers).where(eq(subjectTeachers.userId, auth.user.id));
      if (!mine.length) return [];
      const teaches = new Set(mine.map((m) => `${m.armId}|${m.subjectId}`));
      const groups = await groupsOf(tx, school.id);
      const options = new Map((await armOptions(tx)).map((a) => [a.id, a]));
      const labels = new Map([...options].map(([id, a]) => [id, a.label]));
      const names = new Map((await tx.select({ id: schoolSubjects.id, name: schoolSubjects.name }).from(schoolSubjects)).map((s) => [s.id, s.name]));
      const lessons = await tx.select().from(timetableLessons).where(eq(timetableLessons.day, day));
      return lessons
        .filter((l) => teaches.has(`${l.classArmId}|${l.schoolSubjectId}`) && labels.has(l.classArmId))
        .map((l) => ({ period: groupOfArm(groups, options.get(l.classArmId)).periods.find((p) => p.id === l.periodId && p.kind === "lesson"), armLabel: labels.get(l.classArmId)!, subjectName: names.get(l.schoolSubjectId) ?? "" }))
        .filter((x): x is { period: TimetablePeriod; armLabel: string; subjectName: string } => !!x.period)
        .sort((a, b) => a.period.start.localeCompare(b.period.start) || a.period.end.localeCompare(b.period.end));
    });
    return c.json(data, 200);
  },
);
