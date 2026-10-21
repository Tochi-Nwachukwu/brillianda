/**
 * Results: settings and score entry (C2 in the front end's backend-requirements.md; shapes and rules
 * follow its src/data/fake/results.ts). Totals, grades and positions use the copied
 * packages/core grading.ts and results.ts, so they never depend on which side worked them out.
 *
 * Owners and admins:
 *   GET  /v1/results/settings                       parts, scale, showPositions, scoresEntered
 *   PUT  /v1/results/settings
 *   GET  /v1/results                                each class's sheets this term, unlock requests
 *   GET  /v1/arms/{armId}/sheets                    one class's sheets
 *   POST /v1/arms/{armId}/subjects/{subjectId}/sheet/unlock          { approve }
 * The subject's teacher (their own sheets), owners and admins:
 *   GET  /v1/me/sheets                              a teacher's sheets this term
 *   GET  /v1/arms/{armId}/subjects/{subjectId}/sheet
 *   PUT  …/sheet/scores                             { studentId, componentId, raw } → { status }
 *   PUT  …/sheet/excluded                           { studentId, excluded }
 *   POST …/sheet/complete
 *   POST …/sheet/unlock-request                     { reason }
 *
 * The term is "<session start year>-<term number>": the session's first term that isn't closed,
 * once it has started (term_closures; closing comes with C5).
 */
import {
  DEFAULT_COMPONENTS,
  DEFAULT_SCALE,
  fullName,
  parseScoreInput,
  sessionName,
  sheetProgress,
  type ScoreComponent,
  type SheetRow,
} from "@brillianda/core";
import {
  and,
  asc,
  classArms,
  classLevelSubjects,
  count,
  eq,
  inArray,
  isNull,
  resultsSettings,
  schoolSubjects,
  scoreExclusions,
  scores,
  sheetCompletions,
  students,
  subjectTeachers,
  termClosures,
  unlockRequests,
  users,
  type Tx,
} from "@brillianda/db";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { ValidSession } from "@brillianda/auth";
import type { AppEnv } from "../context.js";
import { lagosToday } from "../lib/attendance.js";
import { ApiError, problemContent } from "../lib/errors.js";
import { resultsSettingsSchema, unlockRequestSchema } from "../lib/results-rules.js";
import { schoolRoute, type Role } from "../school-route.js";
import { currentSession } from "./calendar.js";
import { armOptions } from "./classes.js";

export const resultsRoutes = new OpenAPIHono<AppEnv>();

const ADMINS: readonly Role[] = ["owner", "admin"];
const STAFF: readonly Role[] = ["owner", "admin", "teacher"];
const Id = z.string().uuid("Invalid id");
const ok = <T extends z.ZodTypeAny>(description: string, schema: T) => ({ description, content: { "application/json": { schema } } });
const json = <T extends z.ZodTypeAny>(schema: T) => ({ content: { "application/json": { schema } }, required: true });
const errors = {
  401: problemContent("Not signed in to this school"),
  403: problemContent("This role can't do this, or it isn't your sheet"),
  404: problemContent("No such class or subject, or no term open for results"),
} as const;
const field = (pointer: string, detail: string) => new ApiError("validation_failed", detail, { extensions: { errors: [{ pointer, detail, code: "invalid" }] } });
const isAdmin = (auth: ValidSession) => auth.membership.role === "owner" || auth.membership.role === "admin";

// ——— The term, the settings ———

export type ResultsTerm = { key: string; name: string; session: string; index: number; isLast: boolean };

/** The session's first term that isn't closed, once it has started; null before then. */
export async function resultsTermOf(tx: Tx): Promise<ResultsTerm | null> {
  const { startYear, terms } = await currentSession(tx);
  const closed = new Set((await tx.select({ key: termClosures.termKey }).from(termClosures)).map((c) => c.key));
  const index = terms.findIndex((_, i) => !closed.has(`${startYear}-${i + 1}`));
  if (index < 0 || terms[index]!.startsOn > lagosToday()) return null;
  return { key: `${startYear}-${index + 1}`, name: terms[index]!.name, session: sessionName(startYear), index, isLast: index === terms.length - 1 };
}

/** The next term, when none is open for results: it opens on its start date. */
export async function nextTermOf(tx: Tx): Promise<{ name: string; startsOn: string } | null> {
  const { startYear, terms } = await currentSession(tx);
  const closed = new Set((await tx.select({ key: termClosures.termKey }).from(termClosures)).map((c) => c.key));
  const next = terms.find((_, i) => !closed.has(`${startYear}-${i + 1}`));
  return next ? { name: next.name, startsOn: next.startsOn } : null;
}

export async function settingsOf(tx: Tx) {
  const [row] = await tx.select().from(resultsSettings).limit(1);
  return row
    ? { components: row.components as ScoreComponent[], scale: row.scale, showPositions: row.showPositions, ratings: { enabled: row.ratingsEnabled, traits: row.ratingTraits } }
    : { components: DEFAULT_COMPONENTS, scale: DEFAULT_SCALE, showPositions: true, ratings: { enabled: false, traits: [] as string[] } };
}

async function requireTerm(tx: Tx): Promise<ResultsTerm> {
  const term = await resultsTermOf(tx);
  if (!term) throw new ApiError("not_found", "No term is open for results yet. Results open when the term starts.");
  return term;
}

// ——— Classes, subjects, students ———

export type ArmSubject = { id: string; name: string; code: string; kind: "compulsory" | "elective" };

/** The subjects an arm has sheets for: its level's subjects, matching its department in senior classes. */
export async function subjectsForArm(tx: Tx, armId: string): Promise<ArmSubject[]> {
  const [arm] = await tx.select({ levelId: classArms.classLevelId, department: classArms.department }).from(classArms).where(eq(classArms.id, armId)).limit(1);
  if (!arm) return [];
  const links = await tx
    .select({ id: schoolSubjects.id, name: schoolSubjects.name, code: schoolSubjects.code, kind: classLevelSubjects.kind, department: classLevelSubjects.department })
    .from(classLevelSubjects)
    .innerJoin(schoolSubjects, and(eq(schoolSubjects.schoolId, classLevelSubjects.schoolId), eq(schoolSubjects.id, classLevelSubjects.schoolSubjectId)))
    .where(eq(classLevelSubjects.classLevelId, arm.levelId))
    .orderBy(asc(schoolSubjects.position), asc(schoolSubjects.name));
  return links.filter((l) => !l.department || !arm.department || l.department === arm.department).map((l) => ({ id: l.id, name: l.name, code: l.code, kind: l.kind }));
}

/** Active students in an arm, by surname: who is on its sheets this term. */
export async function pupilsIn(tx: Tx, armIds: string[]) {
  if (!armIds.length) return [];
  const rows = await tx
    .select({ id: students.id, armId: students.classArmId, firstName: students.firstName, otherNames: students.otherNames, lastName: students.lastName, admissionNo: students.admissionNumber })
    .from(students)
    .where(and(inArray(students.classArmId, armIds), eq(students.status, "active"), isNull(students.deletedAt)))
    .orderBy(asc(students.lastName), asc(students.firstName), asc(students.id));
  return rows.map((s) => ({ id: s.id, armId: s.armId, fullName: fullName(s), admissionNo: s.admissionNo }));
}

/** Every score and exclusion on one sheet, as the core's SheetRow per student. */
export async function sheetRows(tx: Tx, term: string, armId: string, subjectId: string, pupilIds: string[]): Promise<Map<string, SheetRow>> {
  const where = and(eq(scores.termKey, term), eq(scores.classArmId, armId), eq(scores.schoolSubjectId, subjectId));
  const cells = await tx.select({ studentId: scores.studentId, componentId: scores.componentId, value: scores.value, isAbsent: scores.isAbsent }).from(scores).where(where);
  const out = new Map<string, SheetRow>(pupilIds.map((id) => [id, { studentId: id, excluded: false, scores: {} }]));
  for (const c of cells) {
    const row = out.get(c.studentId);
    if (row) row.scores[c.componentId] = { value: Number(c.value), isAbsent: c.isAbsent };
  }
  const ex = await tx
    .select({ studentId: scoreExclusions.studentId })
    .from(scoreExclusions)
    .where(and(eq(scoreExclusions.termKey, term), eq(scoreExclusions.classArmId, armId), eq(scoreExclusions.schoolSubjectId, subjectId)));
  for (const e of ex) {
    const row = out.get(e.studentId);
    if (row) row.excluded = true;
  }
  return out;
}

type SheetStatus = "not-started" | "in-progress" | "complete";
type Unlock = { id: string; by: string; reason: string; at: number };

/**
 * Everything the lists need for a term, read once: which cells are filled per student, exclusions,
 * completions, open unlock requests, and each sheet's teacher.
 */
export async function termSnapshot(tx: Tx, term: string, components: ScoreComponent[]) {
  const partIds = new Set(components.map((c) => c.id));
  const filled = await tx
    .select({ armId: scores.classArmId, subjectId: scores.schoolSubjectId, studentId: scores.studentId, componentId: scores.componentId })
    .from(scores)
    .where(eq(scores.termKey, term));
  const parts = new Map<string, Set<string>>();
  const started = new Set<string>();
  for (const f of filled) {
    started.add(`${f.armId}|${f.subjectId}`);
    if (!partIds.has(f.componentId)) continue;
    const key = `${f.armId}|${f.subjectId}|${f.studentId}`;
    (parts.get(key) ?? parts.set(key, new Set()).get(key)!).add(f.componentId);
  }
  const excluded = new Set(
    (await tx.select({ a: scoreExclusions.classArmId, s: scoreExclusions.schoolSubjectId, p: scoreExclusions.studentId }).from(scoreExclusions).where(eq(scoreExclusions.termKey, term))).map(
      (e) => `${e.a}|${e.s}|${e.p}`,
    ),
  );
  const completed = new Map(
    (
      await tx
        .select({ a: sheetCompletions.classArmId, s: sheetCompletions.schoolSubjectId, by: users.fullName, at: sheetCompletions.createdAt })
        .from(sheetCompletions)
        .leftJoin(users, eq(users.id, sheetCompletions.completedBy))
        .where(eq(sheetCompletions.termKey, term))
    ).map((c) => [`${c.a}|${c.s}`, { by: c.by ?? "A former staff member", at: c.at.getTime() }]),
  );
  const requests = (
    await tx
      .select({ id: unlockRequests.id, a: unlockRequests.classArmId, s: unlockRequests.schoolSubjectId, by: users.fullName, reason: unlockRequests.reason, at: unlockRequests.createdAt })
      .from(unlockRequests)
      .leftJoin(users, eq(users.id, unlockRequests.requestedBy))
      .where(and(eq(unlockRequests.termKey, term), eq(unlockRequests.status, "open")))
      .orderBy(asc(unlockRequests.createdAt))
  ).map((r) => ({ key: `${r.a}|${r.s}`, armId: r.a, subjectId: r.s, request: { id: r.id, by: r.by ?? "A former staff member", reason: r.reason, at: r.at.getTime() } as Unlock }));
  const teachers = new Map(
    (
      await tx
        .select({ a: subjectTeachers.classArmId, s: subjectTeachers.schoolSubjectId, userId: subjectTeachers.userId, name: users.fullName })
        .from(subjectTeachers)
        .innerJoin(users, eq(users.id, subjectTeachers.userId))
    ).map((t) => [`${t.a}|${t.s}`, { userId: t.userId, name: t.name }]),
  );
  return { parts, started, excluded, completed, requests, teachers, components };
}
type Snapshot = Awaited<ReturnType<typeof termSnapshot>>;

export function statusIn(snap: Snapshot, armId: string, subjectId: string, pupilIds: string[]): { status: SheetStatus; complete: number; of: number } {
  const taking = pupilIds.filter((p) => !snap.excluded.has(`${armId}|${subjectId}|${p}`));
  const complete = taking.filter((p) => (snap.parts.get(`${armId}|${subjectId}|${p}`)?.size ?? 0) === snap.components.length).length;
  const key = `${armId}|${subjectId}`;
  const status: SheetStatus = snap.completed.has(key) ? "complete" : snap.started.has(key) ? "in-progress" : "not-started";
  return { status, complete, of: taking.length };
}

/** One sheet's status, read on its own (after a save). */
async function sheetStatus(tx: Tx, term: string, armId: string, subjectId: string): Promise<{ status: SheetStatus; complete: number; of: number }> {
  const { components } = await settingsOf(tx);
  const pupils = await pupilsIn(tx, [armId]);
  const rows = await sheetRows(tx, term, armId, subjectId, pupils.map((p) => p.id));
  const progress = sheetProgress([...rows.values()], components);
  const [done] = await tx
    .select({ id: sheetCompletions.id })
    .from(sheetCompletions)
    .where(and(eq(sheetCompletions.termKey, term), eq(sheetCompletions.classArmId, armId), eq(sheetCompletions.schoolSubjectId, subjectId)))
    .limit(1);
  if (done) return { status: "complete", ...progress };
  const [any] = await tx
    .select({ n: count() })
    .from(scores)
    .where(and(eq(scores.termKey, term), eq(scores.classArmId, armId), eq(scores.schoolSubjectId, subjectId)));
  return { status: (any?.n ?? 0) > 0 ? "in-progress" : "not-started", ...progress };
}

/**
 * Who may work on a sheet: owners and admins always; a teacher only for a subject they teach in
 * that class. The class must exist and take the subject.
 */
async function sheetAccess(tx: Tx, auth: ValidSession, armId: string, subjectId: string) {
  const arm = (await armOptions(tx)).find((a) => a.id === armId);
  if (!arm) throw new ApiError("not_found", "That class isn’t here any more.");
  const subject = (await subjectsForArm(tx, armId)).find((s) => s.id === subjectId);
  if (!subject) throw new ApiError("not_found", "This class doesn’t take that subject.");
  const admin = isAdmin(auth);
  if (!admin) {
    const [mine] = await tx
      .select({ id: subjectTeachers.id })
      .from(subjectTeachers)
      .where(and(eq(subjectTeachers.classArmId, armId), eq(subjectTeachers.schoolSubjectId, subjectId), eq(subjectTeachers.userId, auth.user.id)))
      .limit(1);
    if (!mine) throw new ApiError("forbidden", "Only this subject’s teacher, or an admin, can open its sheet.");
  }
  return { arm, subject, admin };
}

// ——— Schemas ———

const TermSchema = z
  .object({ key: z.string().openapi({ example: "2026-1" }), name: z.string(), session: z.string(), index: z.number().int(), isLast: z.boolean() })
  .openapi("ResultsTerm");
const ComponentSchema = z.object({ id: z.string(), name: z.string(), maxScore: z.number() });
const BandSchema = z.object({ minScore: z.number(), grade: z.string(), remark: z.string(), isPass: z.boolean() });
const StatusEnum = z.enum(["not-started", "in-progress", "complete"]);
const UnlockSchema = z.object({ id: z.string().uuid(), by: z.string(), reason: z.string(), at: z.number().int() }).openapi("UnlockRequest");
const SheetSummarySchema = z
  .object({
    armId: z.string().uuid(),
    armLabel: z.string(),
    subjectId: z.string().uuid(),
    subjectName: z.string(),
    kind: z.enum(["compulsory", "elective"]),
    teacher: z.string().nullable(),
    status: StatusEnum,
    complete: z.number().int(),
    of: z.number().int(),
    unlockRequest: UnlockSchema.nullable(),
  })
  .openapi("SheetSummary");

function summaries(snap: Snapshot, arm: { id: string; label: string }, subjects: ArmSubject[], pupilIds: string[]) {
  return subjects.map((s) => ({
    armId: arm.id,
    armLabel: arm.label,
    subjectId: s.id,
    subjectName: s.name,
    kind: s.kind,
    teacher: snap.teachers.get(`${arm.id}|${s.id}`)?.name ?? null,
    ...statusIn(snap, arm.id, s.id, pupilIds),
    unlockRequest: snap.requests.find((r) => r.key === `${arm.id}|${s.id}`)?.request ?? null,
  }));
}

// ——— Settings ———

const SettingsDataSchema = z
  .object({
    components: z.array(ComponentSchema),
    scale: z.array(BandSchema),
    showPositions: z.boolean(),
    scoresEntered: z.boolean().openapi({ description: "Parts can't change once scores are in this term (names and the scale always can)" }),
  })
  .openapi("ResultsSettingsData");

async function scoresEnteredThisTerm(tx: Tx): Promise<boolean> {
  const term = await resultsTermOf(tx);
  if (!term) return false;
  const [any] = await tx.select({ n: count() }).from(scores).where(eq(scores.termKey, term.key));
  return (any?.n ?? 0) > 0;
}

resultsRoutes.openapi(
  createRoute({ method: "get", path: "/v1/results/settings", tags: ["results"], summary: "Results settings: score parts, grading scale, positions", responses: { 200: ok("Settings", SettingsDataSchema), ...errors } }),
  async (c) => {
    const data = await schoolRoute(c, { roles: ADMINS }, async ({ tx }) => {
      const { components, scale, showPositions } = await settingsOf(tx);
      return { components, scale, showPositions, scoresEntered: await scoresEnteredThisTerm(tx) };
    });
    return c.json(data, 200);
  },
);

resultsRoutes.openapi(
  createRoute({
    method: "put",
    path: "/v1/results/settings",
    tags: ["results"],
    summary: "Save results settings. Parts add up to 100 and can't change once scores are in this term",
    request: { body: json(resultsSettingsSchema.openapi("ResultsSettings")) },
    responses: { 204: { description: "Saved" }, 409: problemContent("Scores are in this term, so the parts can't change"), 422: problemContent("A field needs fixing"), ...errors },
  }),
  async (c) => {
    const input = c.req.valid("json");
    await schoolRoute(c, { roles: ADMINS }, async ({ tx, school, auth, audit }) => {
      const current = await settingsOf(tx);
      const partsChanged = current.components.length !== input.components.length || current.components.some((p, i) => p.id !== input.components[i]?.id || p.maxScore !== input.components[i]?.maxScore);
      if (partsChanged && (await scoresEnteredThisTerm(tx))) {
        throw new ApiError("conflict", "Scores are already in for this term, so the parts and their marks can’t change until next term. Names and grades can.");
      }
      const value = { components: input.components, scale: [...input.scale].sort((a, b) => b.minScore - a.minScore), showPositions: input.showPositions };
      await tx
        .insert(resultsSettings)
        .values({ schoolId: school.id, ...value, createdBy: auth.user.id, updatedBy: auth.user.id })
        .onConflictDoUpdate({ target: resultsSettings.schoolId, set: { ...value, updatedBy: auth.user.id, updatedAt: new Date() } });
      audit({ action: "results.settings_changed", entity: "school", entityId: school.id, changes: value, summary: "Changed the results settings" });
    });
    return c.body(null, 204);
  },
);

// ——— Lists ———

const OverviewSchema = z
  .object({
    term: TermSchema.nullable(),
    next: z.object({ name: z.string(), startsOn: z.string() }).nullable().openapi({ description: "When no term is open: the next one, opening on its start date" }),
    arms: z.array(z.object({ armId: z.string().uuid(), label: z.string(), sheets: z.number().int(), complete: z.number().int(), inProgress: z.number().int() })),
    requests: z.array(UnlockSchema.extend({ armId: z.string().uuid(), armLabel: z.string(), subjectId: z.string().uuid(), subjectName: z.string() })),
  })
  .openapi("ResultsOverview");

resultsRoutes.openapi(
  createRoute({ method: "get", path: "/v1/results", tags: ["results"], summary: "Each class's sheets this term (complete, in progress) and unlock requests waiting", responses: { 200: ok("Overview", OverviewSchema), ...errors } }),
  async (c) => {
    const data = await schoolRoute(c, { roles: ADMINS }, async ({ tx }) => {
      const term = await resultsTermOf(tx);
      if (!term) return { term: null, next: await nextTermOf(tx), arms: [], requests: [] };
      const { components } = await settingsOf(tx);
      const snap = await termSnapshot(tx, term.key, components);
      const allArms = await armOptions(tx);
      const pupils = await pupilsIn(tx, allArms.map((a) => a.id));
      const arms = allArms.filter((a) => pupils.some((p) => p.armId === a.id));
      const subjectNames = new Map<string, string>();
      const out = [];
      for (const a of arms) {
        const subjects = await subjectsForArm(tx, a.id);
        for (const s of subjects) subjectNames.set(s.id, s.name);
        const sheets = summaries(snap, a, subjects, pupils.filter((p) => p.armId === a.id).map((p) => p.id));
        out.push({ armId: a.id, label: a.label, sheets: sheets.length, complete: sheets.filter((s) => s.status === "complete").length, inProgress: sheets.filter((s) => s.status === "in-progress").length });
      }
      const labels = new Map(arms.map((a) => [a.id, a.label]));
      return {
        term,
        next: null,
        arms: out,
        requests: snap.requests
          .filter((r) => labels.has(r.armId))
          .map((r) => ({ ...r.request, armId: r.armId, armLabel: labels.get(r.armId)!, subjectId: r.subjectId, subjectName: subjectNames.get(r.subjectId) ?? "A subject" })),
      };
    });
    return c.json(data, 200);
  },
);

resultsRoutes.openapi(
  createRoute({
    method: "get",
    path: "/v1/arms/{armId}/sheets",
    tags: ["results"],
    summary: "One class's sheets this term, with teacher, status and progress",
    request: { params: z.object({ armId: Id }) },
    responses: { 200: ok("Sheets", z.object({ term: TermSchema, armLabel: z.string(), sheets: z.array(SheetSummarySchema) }).openapi("ArmSheets")), ...errors },
  }),
  async (c) => {
    const { armId } = c.req.valid("param");
    const data = await schoolRoute(c, { roles: ADMINS }, async ({ tx }) => {
      const arm = (await armOptions(tx)).find((a) => a.id === armId);
      if (!arm) throw new ApiError("not_found", "That class isn’t here any more.");
      const term = await requireTerm(tx);
      const snap = await termSnapshot(tx, term.key, (await settingsOf(tx)).components);
      const pupils = (await pupilsIn(tx, [armId])).map((p) => p.id);
      return { term, armLabel: arm.label, sheets: summaries(snap, arm, await subjectsForArm(tx, armId), pupils) };
    });
    return c.json(data, 200);
  },
);

resultsRoutes.openapi(
  createRoute({
    method: "get",
    path: "/v1/me/sheets",
    tags: ["results"],
    summary: "A teacher's own sheets this term, with progress",
    responses: { 200: ok("Sheets", z.object({ term: TermSchema.nullable(), sheets: z.array(SheetSummarySchema) }).openapi("MySheets")), ...errors },
  }),
  async (c) => {
    const data = await schoolRoute(c, { roles: STAFF }, async ({ tx, auth }) => {
      const term = await resultsTermOf(tx);
      if (!term) return { term: null, sheets: [] };
      const mine = await tx.select({ armId: subjectTeachers.classArmId, subjectId: subjectTeachers.schoolSubjectId }).from(subjectTeachers).where(eq(subjectTeachers.userId, auth.user.id));
      if (!mine.length) return { term, sheets: [] };
      const snap = await termSnapshot(tx, term.key, (await settingsOf(tx)).components);
      const arms = await armOptions(tx);
      const pupils = await pupilsIn(tx, [...new Set(mine.map((m) => m.armId))]);
      const sheets = [];
      for (const arm of arms) {
        const here = mine.filter((m) => m.armId === arm.id);
        if (!here.length) continue;
        const subjects = (await subjectsForArm(tx, arm.id)).filter((s) => here.some((m) => m.subjectId === s.id));
        sheets.push(...summaries(snap, arm, subjects, pupils.filter((p) => p.armId === arm.id).map((p) => p.id)));
      }
      return { term, sheets };
    });
    return c.json(data, 200);
  },
);

// ——— One sheet ———

const SheetParams = z.object({ armId: Id, subjectId: Id });
const CellSchema = z.object({ value: z.number(), isAbsent: z.boolean() });
const ScoreSheetSchema = z
  .object({
    term: TermSchema,
    armId: z.string().uuid(),
    armLabel: z.string(),
    subjectId: z.string().uuid(),
    subjectName: z.string(),
    kind: z.enum(["compulsory", "elective"]),
    components: z.array(ComponentSchema),
    scale: z.array(BandSchema),
    status: StatusEnum,
    canEdit: z.boolean().openapi({ description: "Admins always; a teacher until the sheet is marked complete" }),
    isAdmin: z.boolean(),
    completedBy: z.object({ by: z.string(), at: z.number().int() }).nullable(),
    unlockRequest: UnlockSchema.nullable(),
    rows: z.array(
      z.object({
        studentId: z.string().uuid(),
        fullName: z.string(),
        admissionNo: z.string(),
        excluded: z.boolean(),
        scores: z.record(z.string(), CellSchema).openapi({ description: "By part id; a missing part is empty" }),
      }),
    ),
  })
  .openapi("ScoreSheet");

resultsRoutes.openapi(
  createRoute({
    method: "get",
    path: "/v1/arms/{armId}/subjects/{subjectId}/sheet",
    tags: ["results"],
    summary: "One score sheet: parts, scale, status, each student's scores and whether they take the subject",
    request: { params: SheetParams },
    responses: { 200: ok("Sheet", ScoreSheetSchema), ...errors },
  }),
  async (c) => {
    const { armId, subjectId } = c.req.valid("param");
    const data = await schoolRoute(c, { roles: STAFF }, async ({ tx, auth }) => {
      const { arm, subject, admin } = await sheetAccess(tx, auth, armId, subjectId);
      const term = await requireTerm(tx);
      const settings = await settingsOf(tx);
      const pupils = await pupilsIn(tx, [armId]);
      const rows = await sheetRows(tx, term.key, armId, subjectId, pupils.map((p) => p.id));
      const snap = await termSnapshot(tx, term.key, settings.components);
      const { status } = statusIn(snap, armId, subjectId, pupils.map((p) => p.id));
      return {
        term,
        armId,
        armLabel: arm.label,
        subjectId,
        subjectName: subject.name,
        kind: subject.kind,
        components: settings.components,
        scale: settings.scale,
        status,
        canEdit: admin || status !== "complete",
        isAdmin: admin,
        completedBy: snap.completed.get(`${armId}|${subjectId}`) ?? null,
        unlockRequest: snap.requests.find((r) => r.key === `${armId}|${subjectId}`)?.request ?? null,
        rows: pupils.map((p) => {
          const row = rows.get(p.id)!;
          return { studentId: p.id, fullName: p.fullName, admissionNo: p.admissionNo, excluded: row.excluded, scores: row.scores as Record<string, { value: number; isAbsent: boolean }> };
        }),
      };
    });
    return c.json(data, 200);
  },
);

async function editableSheet(tx: Tx, auth: ValidSession, armId: string, subjectId: string) {
  const access = await sheetAccess(tx, auth, armId, subjectId);
  const term = await requireTerm(tx);
  const [done] = await tx
    .select({ id: sheetCompletions.id })
    .from(sheetCompletions)
    .where(and(eq(sheetCompletions.termKey, term.key), eq(sheetCompletions.classArmId, armId), eq(sheetCompletions.schoolSubjectId, subjectId)))
    .limit(1);
  if (done && !access.admin) throw new ApiError("conflict", "This sheet is marked complete. Ask an admin to unlock it.");
  return { ...access, term, complete: !!done };
}

resultsRoutes.openapi(
  createRoute({
    method: "put",
    path: "/v1/arms/{armId}/subjects/{subjectId}/sheet/scores",
    tags: ["results"],
    summary: "Save one score: \"\" clears it, \"ABS\" marks absent, else a number from 0 to the part's marks (2 decimals)",
    request: { params: SheetParams, body: json(z.object({ studentId: Id, componentId: z.string().min(1).max(40), raw: z.string().max(20) }).openapi("SaveScore")) },
    responses: { 200: ok("Saved", z.object({ status: StatusEnum }).openapi("SheetStatusAfterSave")), 409: problemContent("Locked, or the student or part isn't on this sheet any more"), 422: problemContent("#/raw isn't a score"), ...errors },
  }),
  async (c) => {
    const { armId, subjectId } = c.req.valid("param");
    const { studentId, componentId, raw } = c.req.valid("json");
    const data = await schoolRoute(c, { roles: STAFF }, async ({ tx, school, auth }) => {
      const { term } = await editableSheet(tx, auth, armId, subjectId);
      const component = (await settingsOf(tx)).components.find((p) => p.id === componentId);
      const onSheet = (await pupilsIn(tx, [armId])).some((p) => p.id === studentId);
      if (!component || !onSheet) throw new ApiError("conflict", "That student or part isn’t on this sheet any more. Reload the page.");
      const [excluded] = await tx
        .select({ id: scoreExclusions.id })
        .from(scoreExclusions)
        .where(and(eq(scoreExclusions.termKey, term.key), eq(scoreExclusions.classArmId, armId), eq(scoreExclusions.schoolSubjectId, subjectId), eq(scoreExclusions.studentId, studentId)))
        .limit(1);
      if (excluded) throw new ApiError("conflict", "This student doesn’t take this subject. Include them first.");
      const parsed = parseScoreInput(raw, component.maxScore);
      if (!parsed.ok) throw field("#/raw", parsed.error);
      const cell = and(
        eq(scores.termKey, term.key),
        eq(scores.classArmId, armId),
        eq(scores.schoolSubjectId, subjectId),
        eq(scores.studentId, studentId),
        eq(scores.componentId, componentId),
      );
      if (!parsed.cell) await tx.delete(scores).where(cell);
      else
        await tx
          .insert(scores)
          .values({ schoolId: school.id, termKey: term.key, classArmId: armId, schoolSubjectId: subjectId, studentId, componentId, ...parsed.cell, createdBy: auth.user.id, updatedBy: auth.user.id })
          .onConflictDoUpdate({
            target: [scores.schoolId, scores.termKey, scores.classArmId, scores.schoolSubjectId, scores.studentId, scores.componentId],
            set: { value: parsed.cell.value, isAbsent: parsed.cell.isAbsent, updatedBy: auth.user.id, updatedAt: new Date() },
          });
      return { status: (await sheetStatus(tx, term.key, armId, subjectId)).status };
    });
    return c.json(data, 200);
  },
);

resultsRoutes.openapi(
  createRoute({
    method: "put",
    path: "/v1/arms/{armId}/subjects/{subjectId}/sheet/excluded",
    tags: ["results"],
    summary: "An elective a student doesn't take (or does again). Leaving it out clears their scores on this sheet",
    request: { params: SheetParams, body: json(z.object({ studentId: Id, excluded: z.boolean() }).openapi("SetExcluded")) },
    responses: { 204: { description: "Saved" }, 409: problemContent("Locked, compulsory, or not on this sheet"), ...errors },
  }),
  async (c) => {
    const { armId, subjectId } = c.req.valid("param");
    const { studentId, excluded } = c.req.valid("json");
    await schoolRoute(c, { roles: STAFF }, async ({ tx, school, auth, audit }) => {
      const { term, subject, arm } = await editableSheet(tx, auth, armId, subjectId);
      if (subject.kind !== "elective") throw new ApiError("conflict", "Every student takes a compulsory subject.");
      const pupil = (await pupilsIn(tx, [armId])).find((p) => p.id === studentId);
      if (!pupil) throw new ApiError("conflict", "That student isn’t on this sheet any more. Reload the page.");
      const row = and(eq(scoreExclusions.termKey, term.key), eq(scoreExclusions.classArmId, armId), eq(scoreExclusions.schoolSubjectId, subjectId), eq(scoreExclusions.studentId, studentId));
      if (excluded) {
        await tx
          .insert(scoreExclusions)
          .values({ schoolId: school.id, termKey: term.key, classArmId: armId, schoolSubjectId: subjectId, studentId, createdBy: auth.user.id, updatedBy: auth.user.id })
          .onConflictDoNothing();
        await tx.delete(scores).where(and(eq(scores.termKey, term.key), eq(scores.classArmId, armId), eq(scores.schoolSubjectId, subjectId), eq(scores.studentId, studentId)));
      } else {
        await tx.delete(scoreExclusions).where(row);
      }
      audit({
        action: excluded ? "results.excluded" : "results.included",
        entity: "student",
        entityId: studentId,
        changes: { term: term.key, armId, subjectId },
        summary: excluded ? `Marked ${pupil.fullName} as not taking ${subject.name} in ${arm.label}` : `Marked ${pupil.fullName} as taking ${subject.name} in ${arm.label}`,
      });
    });
    return c.body(null, 204);
  },
);

resultsRoutes.openapi(
  createRoute({
    method: "post",
    path: "/v1/arms/{armId}/subjects/{subjectId}/sheet/complete",
    tags: ["results"],
    summary: "Mark a sheet complete (locks it for its teacher). Refused while a student who takes it has an empty part",
    request: { params: SheetParams },
    responses: { 204: { description: "Complete" }, 409: problemContent("Already complete, or scores still empty (detail says how many)"), ...errors },
  }),
  async (c) => {
    const { armId, subjectId } = c.req.valid("param");
    await schoolRoute(c, { roles: STAFF }, async ({ tx, school, auth, audit }) => {
      const { term, subject, arm, complete } = await editableSheet(tx, auth, armId, subjectId);
      if (complete) throw new ApiError("conflict", "It’s already marked complete.");
      const s = await sheetStatus(tx, term.key, armId, subjectId);
      if (s.complete < s.of) {
        const left = s.of - s.complete;
        throw new ApiError("conflict", `${left} ${left === 1 ? "student still has" : "students still have"} empty scores. Enter them, or ABS for absent.`);
      }
      await tx.insert(sheetCompletions).values({ schoolId: school.id, termKey: term.key, classArmId: armId, schoolSubjectId: subjectId, completedBy: auth.user.id, createdBy: auth.user.id, updatedBy: auth.user.id });
      audit({ action: "results.sheet_completed", entity: "class_arm", entityId: armId, changes: { term: term.key, subjectId }, summary: `Marked ${subject.name} complete for ${arm.label}` });
    });
    return c.body(null, 204);
  },
);

resultsRoutes.openapi(
  createRoute({
    method: "post",
    path: "/v1/arms/{armId}/subjects/{subjectId}/sheet/unlock-request",
    tags: ["results"],
    summary: "Ask an admin to unlock a completed sheet, with a reason (5 to 200 characters)",
    request: { params: SheetParams, body: json(unlockRequestSchema.openapi("UnlockRequestInput")) },
    responses: { 204: { description: "Asked" }, 409: problemContent("Not locked, or a request is already waiting"), 422: problemContent("#/reason"), ...errors },
  }),
  async (c) => {
    const { armId, subjectId } = c.req.valid("param");
    const { reason } = c.req.valid("json");
    await schoolRoute(c, { roles: STAFF }, async ({ tx, school, auth, audit }) => {
      const { subject, arm } = await sheetAccess(tx, auth, armId, subjectId);
      const term = await requireTerm(tx);
      if ((await sheetStatus(tx, term.key, armId, subjectId)).status !== "complete") throw new ApiError("conflict", "It isn’t locked.");
      const [open] = await tx
        .select({ id: unlockRequests.id })
        .from(unlockRequests)
        .where(and(eq(unlockRequests.termKey, term.key), eq(unlockRequests.classArmId, armId), eq(unlockRequests.schoolSubjectId, subjectId), eq(unlockRequests.status, "open")))
        .limit(1);
      if (open) throw new ApiError("conflict", "A request is already waiting for an admin.");
      await tx.insert(unlockRequests).values({ schoolId: school.id, termKey: term.key, classArmId: armId, schoolSubjectId: subjectId, requestedBy: auth.user.id, reason, createdBy: auth.user.id, updatedBy: auth.user.id });
      audit({ action: "results.unlock_requested", entity: "class_arm", entityId: armId, changes: { term: term.key, subjectId, reason }, summary: `Asked to unlock ${subject.name} for ${arm.label}: ${reason}` });
    });
    return c.body(null, 204);
  },
);

resultsRoutes.openapi(
  createRoute({
    method: "post",
    path: "/v1/arms/{armId}/subjects/{subjectId}/sheet/unlock",
    tags: ["results"],
    summary: "Owners and admins: reopen a sheet (answering a request if there is one), or decline a request (approve: false)",
    request: { params: SheetParams, body: json(z.object({ approve: z.boolean() }).openapi("ResolveUnlock")) },
    responses: { 204: { description: "Done" }, 409: problemContent("Nothing to reopen or decline"), ...errors },
  }),
  async (c) => {
    const { armId, subjectId } = c.req.valid("param");
    const { approve } = c.req.valid("json");
    await schoolRoute(c, { roles: ADMINS }, async ({ tx, auth, audit }) => {
      const { subject, arm } = await sheetAccess(tx, auth, armId, subjectId);
      const term = await requireTerm(tx);
      const sheet = { term: eq(unlockRequests.termKey, term.key), arm: eq(unlockRequests.classArmId, armId), subject: eq(unlockRequests.schoolSubjectId, subjectId) };
      const [request] = await tx
        .select({ id: unlockRequests.id, by: users.fullName })
        .from(unlockRequests)
        .leftJoin(users, eq(users.id, unlockRequests.requestedBy))
        .where(and(sheet.term, sheet.arm, sheet.subject, eq(unlockRequests.status, "open")))
        .limit(1);
      if (request) await tx.update(unlockRequests).set({ status: approve ? "approved" : "declined", resolvedBy: auth.user.id, resolvedAt: new Date(), updatedBy: auth.user.id }).where(eq(unlockRequests.id, request.id));
      if (approve) {
        const reopened = await tx
          .delete(sheetCompletions)
          .where(and(eq(sheetCompletions.termKey, term.key), eq(sheetCompletions.classArmId, armId), eq(sheetCompletions.schoolSubjectId, subjectId)))
          .returning({ id: sheetCompletions.id });
        if (!reopened.length && !request) throw new ApiError("conflict", "It isn’t locked.");
        audit({ action: "results.sheet_unlocked", entity: "class_arm", entityId: armId, changes: { term: term.key, subjectId }, summary: `Unlocked ${subject.name} for ${arm.label}` });
      } else {
        if (!request) throw new ApiError("conflict", "There’s no request to decline.");
        audit({ action: "results.unlock_declined", entity: "class_arm", entityId: armId, changes: { term: term.key, subjectId }, summary: `Declined ${request.by ?? "a teacher"}’s request to unlock ${subject.name} for ${arm.label}` });
      }
    });
    return c.body(null, 204);
  },
);
