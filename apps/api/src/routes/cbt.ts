/**
 * CBT: tests taken on Brillianda (B8 in the front end's backend-requirements.md; rules in
 * packages/core/src/cbt.ts and questions.ts, flow from its src/data/fake/cbt.ts).
 *
 * Teachers and admins (a teacher for the classes they teach that subject in; admins any):
 *   GET    /v1/tests                                          their tests (all for admins)
 *   GET    /v1/tests/editor?test=                             what can go in a test, or a draft
 *   POST   /v1/tests  ·  PUT /v1/tests/{id}                   { subjectId, levelId, publish, settings } → { id }
 *   DELETE /v1/tests/{id}                                     before anyone starts
 *   GET    /v1/tests/{id}/results
 *   PUT    /v1/tests/{id}/attempts/{attemptId}/marks/{index}  { marks }: a theory answer
 *   POST   /v1/tests/{id}/send-scores                         → { sent, skipped, lockedClasses }
 * Students:
 *   GET  /v1/me/tests  ·  GET /v1/me/tests/{id}
 *   POST /v1/me/tests/{id}/start { code }  ·  PUT …/answers/{index} { response }  ·  POST …/left  ·  POST …/submit
 *
 * The server keeps the clock: an attempt's deadline is its start plus the test's length, or the
 * close, whichever is first. Answers count up to 30 seconds after it; then the attempt is
 * submitted with what was saved. Students never receive the answers: not in the questions, not
 * hidden, not in their results. No AI is involved anywhere here.
 */
import { randomInt } from "node:crypto";
import { deadlineOf, fullName, GRACE_MS, newAccessCode, scaleTo, scoreAttempt, seededOrder, totalMarks, windowState, type Question, type Response } from "@brillianda/core";
import {
  and,
  asc,
  bankQuestions,
  cbtAttempts,
  cbtTestClasses,
  cbtTests,
  classLevels,
  eq,
  inArray,
  isNull,
  lt,
  scoreExclusions,
  scores,
  schoolSubjects,
  sheetCompletions,
  sql,
  studentLinks,
  students,
  subjectTeachers,
  users,
  type Tx,
} from "@brillianda/db";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { AppEnv } from "../context.js";
import { responseSchema, testSettingsSchema } from "../lib/cbt-rules.js";
import { ApiError, problemContent } from "../lib/errors.js";
import { questionSchema } from "../lib/questions.js";
import { schoolRoute, type Role } from "../school-route.js";
import { armOptions } from "./classes.js";
import { BankQuestionSchema, pairsFor } from "./questions.js";
import { resultsTermOf, settingsOf } from "./results.js";

export const cbtRoutes = new OpenAPIHono<AppEnv>();

const STAFF: readonly Role[] = ["owner", "admin", "teacher"];
const STUDENT: readonly Role[] = ["student"];
const Id = z.string().uuid("Invalid id");
const ok = <T extends z.ZodTypeAny>(description: string, schema: T) => ({ description, content: { "application/json": { schema } } });
const errors = {
  401: problemContent("Not signed in to this school"),
  403: problemContent("Not allowed for this role"),
  404: problemContent("No active school here, or no such test"),
} as const;
const isAdmin = (role: Role) => role === "owner" || role === "admin";
const codeRandom = () => randomInt(0, 1_000_000) / 1_000_000;

type Test = typeof cbtTests.$inferSelect;
type Attempt = typeof cbtAttempts.$inferSelect;
const windowOf = (t: Test) => ({ opensAt: t.opensAt.toISOString(), closesAt: t.closesAt.toISOString() });
const deadline = (t: Test, a: Attempt) => deadlineOf(a.startedAt.getTime(), t.durationMinutes, windowOf(t));
const questionsOf = (t: Test) => t.questions as unknown as Question[];
const responsesOf = (a: Attempt) => a.responses as Record<number, Response>;
const marksOf = (a: Attempt) => a.theoryMarks as Record<number, number>;

/** Submits attempts whose time ran out, at their deadline. The clock is the server's. */
async function settle(tx: Tx, testIds: string[]): Promise<void> {
  if (!testIds.length) return;
  const now = new Date();
  const open = await tx
    .select({ a: cbtAttempts, t: cbtTests })
    .from(cbtAttempts)
    .innerJoin(cbtTests, and(eq(cbtTests.schoolId, cbtAttempts.schoolId), eq(cbtTests.id, cbtAttempts.testId)))
    .where(and(inArray(cbtAttempts.testId, testIds), isNull(cbtAttempts.submittedAt)));
  for (const { a, t } of open) {
    const end = deadline(t, a);
    if (now.getTime() > end + GRACE_MS) await tx.update(cbtAttempts).set({ submittedAt: new Date(end), updatedAt: now }).where(and(eq(cbtAttempts.id, a.id), isNull(cbtAttempts.submittedAt)));
  }
}

/** The classes a person may set a test for, in a subject and class level. */
async function armsFor(tx: Tx, userId: string, admin: boolean, subjectId: string, levelId: string) {
  const arms = (await armOptions(tx)).filter((a) => a.levelId === levelId);
  if (admin) return arms.map((a) => ({ id: a.id, label: a.label }));
  const mine = new Set((await tx.select({ armId: subjectTeachers.classArmId }).from(subjectTeachers).where(and(eq(subjectTeachers.userId, userId), eq(subjectTeachers.schoolSubjectId, subjectId)))).map((r) => r.armId));
  return arms.filter((a) => mine.has(a.id)).map((a) => ({ id: a.id, label: a.label }));
}

async function armIdsOf(tx: Tx, testIds: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (!testIds.length) return out;
  for (const r of await tx.select({ testId: cbtTestClasses.testId, armId: cbtTestClasses.classArmId }).from(cbtTestClasses).where(inArray(cbtTestClasses.testId, testIds))) {
    out.set(r.testId, [...(out.get(r.testId) ?? []), r.armId]);
  }
  return out;
}

const activeIn = (tx: Tx, armIds: string[]) =>
  armIds.length
    ? tx
        .select({ id: students.id, firstName: students.firstName, otherNames: students.otherNames, lastName: students.lastName, armId: students.classArmId })
        .from(students)
        .where(and(inArray(students.classArmId, armIds), eq(students.status, "active"), isNull(students.deletedAt)))
    : Promise.resolve([]);

/** A test this person may see and change: their own, or any for owners and admins. */
async function testFor(tx: Tx, id: string, userId: string, role: Role): Promise<Test> {
  const [t] = await tx.select().from(cbtTests).where(eq(cbtTests.id, id)).limit(1);
  if (!t || (!isAdmin(role) && t.authorId !== userId)) throw new ApiError("not_found", "That test isn’t here, or isn’t yours.");
  return t;
}

// ——— Shapes ———

const WhereEnum = z.enum(["anywhere", "school"]);
const WindowEnum = z.enum(["before", "open", "closed"]);
const TestRowSchema = z
  .object({
    id: z.string().uuid(),
    title: z.string(),
    subjectName: z.string(),
    levelName: z.string(),
    armLabels: z.array(z.string()),
    questions: z.number().int(),
    marks: z.number(),
    durationMinutes: z.number().int(),
    opensAt: z.string(),
    closesAt: z.string(),
    where: WhereEnum,
    status: z.enum(["draft", "published"]),
    window: WindowEnum,
    submitted: z.number().int(),
    students: z.number().int(),
    toMark: z.number().int().openapi({ description: "Theory answers still to mark" }),
    sentAt: z.number().int().nullable(),
    by: z.string(),
    byMe: z.boolean(),
  })
  .openapi("TestRow");
type TestRow = z.infer<typeof TestRowSchema>;

async function rowsOf(tx: Tx, tests: Test[], meId: string): Promise<TestRow[]> {
  const ids = tests.map((t) => t.id);
  await settle(tx, ids);
  const arms = await armIdsOf(tx, ids);
  const labels = new Map((await armOptions(tx, { all: true })).map((a) => [a.id, a.label]));
  const subjects = new Map((await tx.select({ id: schoolSubjects.id, name: schoolSubjects.name }).from(schoolSubjects)).map((s) => [s.id, s.name]));
  const levels = new Map((await tx.select({ id: classLevels.id, name: classLevels.name }).from(classLevels)).map((l) => [l.id, l.name]));
  const attempts = ids.length ? await tx.select().from(cbtAttempts).where(inArray(cbtAttempts.testId, ids)) : [];
  const authorIds = [...new Set(tests.map((t) => t.authorId).filter((x): x is string => !!x))];
  const names = new Map(authorIds.length ? (await tx.select({ id: users.id, name: users.fullName }).from(users).where(inArray(users.id, authorIds))).map((u) => [u.id, u.name]) : []);
  const allArms = [...new Set([...arms.values()].flat())];
  const pupils = await activeIn(tx, allArms);
  const now = Date.now();
  return tests.map((t) => {
    const mine = attempts.filter((a) => a.testId === t.id);
    const qs = questionsOf(t);
    const testArms = arms.get(t.id) ?? [];
    return {
      id: t.id,
      title: t.title,
      subjectName: subjects.get(t.schoolSubjectId) ?? "",
      levelName: levels.get(t.classLevelId) ?? "",
      armLabels: testArms.map((id) => labels.get(id) ?? ""),
      questions: qs.length,
      marks: totalMarks(qs),
      durationMinutes: t.durationMinutes,
      opensAt: t.opensAt.toISOString(),
      closesAt: t.closesAt.toISOString(),
      where: t.where,
      status: t.status,
      window: windowState(windowOf(t), now),
      submitted: mine.filter((a) => a.submittedAt).length,
      students: pupils.filter((p) => testArms.includes(p.armId)).length,
      toMark: mine.filter((a) => a.submittedAt).reduce((n, a) => n + scoreAttempt(qs, responsesOf(a), marksOf(a)).toMark, 0),
      sentAt: t.scoresSentAt?.getTime() ?? null,
      by: t.authorId ? (names.get(t.authorId) ?? "A former staff member") : "A former staff member",
      byMe: t.authorId === meId,
    };
  });
}

// ——— Teachers and admins ———

cbtRoutes.openapi(
  createRoute({ method: "get", path: "/v1/tests", tags: ["cbt"], summary: "The person's tests (every test for owners and admins), newest window first", responses: { 200: ok("Tests", z.array(TestRowSchema)), ...errors } }),
  async (c) => {
    const data = await schoolRoute(c, { roles: STAFF }, async ({ tx, auth }) => {
      const all = await tx.select().from(cbtTests).orderBy(sql`${cbtTests.opensAt} desc`, asc(cbtTests.id));
      return rowsOf(tx, all.filter((t) => isAdmin(auth.membership.role) || t.authorId === auth.user.id), auth.user.id);
    });
    return c.json(data, 200);
  },
);

const TestEditorSchema = z
  .object({
    pairs: z.array(z.object({ subjectId: z.string().uuid(), subjectName: z.string(), levelId: z.string().uuid(), levelName: z.string(), arms: z.array(z.object({ id: z.string().uuid(), label: z.string() })) })),
    bank: z.array(BankQuestionSchema),
    components: z.array(z.object({ id: z.string(), name: z.string(), maxScore: z.number() })),
    test: z
      .object({
        id: z.string().uuid(),
        subjectId: z.string().uuid(),
        levelId: z.string().uuid(),
        title: z.string(),
        instructions: z.string(),
        armIds: z.array(z.string().uuid()),
        questionIds: z.array(z.string().uuid()).openapi({ description: "Only the ones still in the bank" }),
        durationMinutes: z.number().int(),
        opensAt: z.string(),
        closesAt: z.string(),
        where: WhereEnum,
        shuffle: z.boolean(),
        showScore: z.boolean(),
        componentId: z.string(),
      })
      .nullable(),
  })
  .openapi("TestEditorData");

cbtRoutes.openapi(
  createRoute({
    method: "get",
    path: "/v1/tests/editor",
    tags: ["cbt"],
    summary: "What can go in a test: subject and class pairs with their classes, the bank, the score-sheet parts, and the draft (?test=)",
    request: { query: z.object({ test: Id.optional() }) },
    responses: { 200: ok("Editor", TestEditorSchema), ...errors },
  }),
  async (c) => {
    const { test: testId } = c.req.valid("query");
    const data = await schoolRoute(c, { roles: STAFF }, async ({ tx, auth }) => {
      const admin = isAdmin(auth.membership.role);
      const pairs: (Awaited<ReturnType<typeof pairsFor>>[number] & { arms: { id: string; label: string }[] })[] = [];
      for (const p of await pairsFor(tx, auth.user.id, admin)) {
        const arms = await armsFor(tx, auth.user.id, admin, p.subjectId, p.levelId);
        if (arms.length) pairs.push({ ...p, arms });
      }
      const t = testId ? await testFor(tx, testId, auth.user.id, auth.membership.role) : null;
      if (t && t.status !== "draft") throw new ApiError("conflict", "Only drafts can be changed. Students may already be taking this test.");
      const rows = await tx.select({ q: bankQuestions, by: users.fullName }).from(bankQuestions).leftJoin(users, eq(users.id, bankQuestions.authorId)).orderBy(sql`${bankQuestions.createdAt} desc`);
      const bank = rows
        .filter((r) => pairs.some((p) => p.subjectId === r.q.schoolSubjectId && p.levelId === r.q.classLevelId))
        .map((r) => ({ id: r.q.id, subjectId: r.q.schoolSubjectId, levelId: r.q.classLevelId, question: r.q.question as Question, source: r.q.source, by: r.by ?? "A former staff member", byMe: r.q.authorId === auth.user.id, at: r.q.updatedAt.getTime() }));
      const armIds = t ? ((await armIdsOf(tx, [t.id])).get(t.id) ?? []) : [];
      return {
        pairs,
        bank,
        components: (await settingsOf(tx)).components,
        test: t
          ? {
              id: t.id,
              subjectId: t.schoolSubjectId,
              levelId: t.classLevelId,
              title: t.title,
              instructions: t.instructions,
              armIds,
              questionIds: t.questionIds.filter((qid) => bank.some((b) => b.id === qid)),
              durationMinutes: t.durationMinutes,
              opensAt: t.opensAt.toISOString(),
              closesAt: t.closesAt.toISOString(),
              where: t.where,
              shuffle: t.shuffle,
              showScore: t.showScore,
              componentId: t.componentId,
            }
          : null,
      };
    });
    return c.json(data, 200);
  },
);

const SaveTestSchema = z
  .object({ subjectId: Id, levelId: Id, publish: z.boolean().default(false), settings: testSettingsSchema })
  .openapi("SaveTest", { description: "publish: true sets the test (students see it in its window); false keeps it a draft" });

/** Saves a new test or a draft. Throws the reason it can't. */
async function saveTest(tx: Tx, ctx: { schoolId: string; userId: string; role: Role }, id: string | null, input: z.infer<typeof SaveTestSchema>, audit: (e: { action: string; entity: string; entityId: string; changes?: Record<string, unknown>; summary: string }) => void) {
  const { settings: s } = input;
  const allowed = new Set((await armsFor(tx, ctx.userId, isAdmin(ctx.role), input.subjectId, input.levelId)).map((a) => a.id));
  if (!allowed.size || s.armIds.some((a) => !allowed.has(a))) throw new ApiError("forbidden", "You can set tests only for the classes you teach this subject in.");
  const picked = await tx.select({ id: bankQuestions.id, question: bankQuestions.question }).from(bankQuestions).where(and(inArray(bankQuestions.id, s.questionIds), eq(bankQuestions.schoolSubjectId, input.subjectId), eq(bankQuestions.classLevelId, input.levelId)));
  const byId = new Map(picked.map((q) => [q.id, q.question]));
  if (s.questionIds.some((qid) => !byId.has(qid))) throw new ApiError("conflict", "A question isn’t in this subject’s bank any more. Reload and choose again.");
  if (new Set(s.questionIds).size !== s.questionIds.length) throw new ApiError("validation_failed", "A question is in the test twice.", { extensions: { errors: [{ pointer: "#/settings/questionIds", detail: "A question is in the test twice", code: "invalid" }] } });
  if (!(await settingsOf(tx)).components.some((p) => p.id === s.componentId)) throw new ApiError("validation_failed", "Choose where the scores go.", { extensions: { errors: [{ pointer: "#/settings/componentId", detail: "Choose where the scores go", code: "invalid" }] } });
  // A copy, checked again: changing the bank later doesn't change a test students have taken.
  const questions = s.questionIds.map((qid) => questionSchema.parse(byId.get(qid)) as unknown as Record<string, unknown>);
  const fields = {
    schoolSubjectId: input.subjectId,
    classLevelId: input.levelId,
    title: s.title,
    instructions: s.instructions,
    questions,
    questionIds: s.questionIds,
    durationMinutes: s.durationMinutes,
    opensAt: new Date(s.opensAt),
    closesAt: new Date(s.closesAt),
    where: s.where,
    shuffle: s.shuffle,
    showScore: s.showScore,
    componentId: s.componentId,
    status: input.publish ? ("published" as const) : ("draft" as const),
    updatedBy: ctx.userId,
  };
  let testId: string;
  if (id) {
    const t = await testFor(tx, id, ctx.userId, ctx.role);
    if (t.status !== "draft") throw new ApiError("conflict", "Only drafts can be changed. Students may already be taking this test.");
    await tx.update(cbtTests).set({ ...fields, updatedAt: new Date() }).where(eq(cbtTests.id, id));
    await tx.delete(cbtTestClasses).where(eq(cbtTestClasses.testId, id));
    testId = id;
  } else {
    const [created] = await tx
      .insert(cbtTests)
      .values({ schoolId: ctx.schoolId, ...fields, accessCode: newAccessCode(codeRandom), authorId: ctx.userId, createdBy: ctx.userId })
      .returning({ id: cbtTests.id });
    testId = created!.id;
  }
  await tx.insert(cbtTestClasses).values(s.armIds.map((armId) => ({ schoolId: ctx.schoolId, testId, classArmId: armId, createdBy: ctx.userId, updatedBy: ctx.userId })));
  if (input.publish) {
    const [subject] = await tx.select({ name: schoolSubjects.name }).from(schoolSubjects).where(eq(schoolSubjects.id, input.subjectId));
    const [level] = await tx.select({ name: classLevels.name }).from(classLevels).where(eq(classLevels.id, input.levelId));
    audit({ action: "test.set", entity: "cbt_test", entityId: testId, changes: { title: s.title, questions: questions.length, classes: s.armIds.length }, summary: `Set the test “${s.title}” for ${level?.name ?? ""} ${subject?.name ?? ""}` });
  }
  return { id: testId };
}

cbtRoutes.openapi(
  createRoute({
    method: "post",
    path: "/v1/tests",
    tags: ["cbt"],
    summary: "Save a new test from the bank: a draft, or set (publish) it",
    request: { body: { content: { "application/json": { schema: SaveTestSchema } }, required: true } },
    responses: { 200: ok("Saved", z.object({ id: z.string().uuid() })), 409: problemContent("A question left the bank"), 422: problemContent("A setting needs fixing, e.g. #/settings/closesAt"), ...errors },
  }),
  async (c) => {
    const input = c.req.valid("json");
    const data = await schoolRoute(c, { roles: STAFF }, ({ tx, school, auth, audit }) => saveTest(tx, { schoolId: school.id, userId: auth.user.id, role: auth.membership.role }, null, input, audit));
    return c.json(data, 200);
  },
);

cbtRoutes.openapi(
  createRoute({
    method: "put",
    path: "/v1/tests/{id}",
    tags: ["cbt"],
    summary: "Change a draft, or set (publish) it. Set tests don't change",
    request: { params: z.object({ id: Id }), body: { content: { "application/json": { schema: SaveTestSchema } }, required: true } },
    responses: { 200: ok("Saved", z.object({ id: z.string().uuid() })), 409: problemContent("Not a draft, or a question left the bank"), 422: problemContent("A setting needs fixing"), ...errors },
  }),
  async (c) => {
    const { id } = c.req.valid("param");
    const input = c.req.valid("json");
    const data = await schoolRoute(c, { roles: STAFF }, ({ tx, school, auth, audit }) => saveTest(tx, { schoolId: school.id, userId: auth.user.id, role: auth.membership.role }, id, input, audit));
    return c.json(data, 200);
  },
);

cbtRoutes.openapi(
  createRoute({
    method: "delete",
    path: "/v1/tests/{id}",
    tags: ["cbt"],
    summary: "Delete a test before any student starts it",
    request: { params: z.object({ id: Id }) },
    responses: { 204: { description: "Deleted" }, 409: problemContent("Students have started it"), ...errors },
  }),
  async (c) => {
    const { id } = c.req.valid("param");
    await schoolRoute(c, { roles: STAFF }, async ({ tx, auth, audit }) => {
      const t = await testFor(tx, id, auth.user.id, auth.membership.role);
      const [started] = await tx.select({ id: cbtAttempts.id }).from(cbtAttempts).where(eq(cbtAttempts.testId, id)).limit(1);
      if (started) throw new ApiError("conflict", "Students have started this test, so it stays. You can stop sending its scores.");
      await tx.delete(cbtTests).where(eq(cbtTests.id, id));
      audit({ action: "test.deleted", entity: "cbt_test", entityId: id, changes: { title: t.title, status: t.status }, summary: `Deleted the test “${t.title}”` });
    });
    return c.body(null, 204);
  },
);

const ScoredSchema = z.object({ auto: z.number(), theory: z.number(), total: z.number(), max: z.number(), toMark: z.number().int() });
const TestResultsSchema = z
  .object({
    test: TestRowSchema.extend({
      accessCode: z.string(),
      showScore: z.boolean(),
      component: z.object({ id: z.string(), name: z.string(), maxScore: z.number() }).nullable(),
      questionList: z.array(questionSchema),
    }),
    rows: z.array(
      z.object({
        studentId: z.string().uuid(),
        fullName: z.string(),
        armLabel: z.string(),
        state: z.enum(["not started", "in progress", "submitted"]),
        attemptId: z.string().uuid().nullable(),
        score: ScoredSchema.nullable(),
        leftPage: z.number().int(),
        responses: z.record(z.string(), responseSchema),
        theoryMarks: z.record(z.string(), z.number()),
      }),
    ),
    stats: z.array(z.object({ answered: z.number().int(), right: z.number().int().nullable() })).openapi({ description: "Per question: how many answered, and how many got it right (theory: null)" }),
  })
  .openapi("TestResults");

cbtRoutes.openapi(
  createRoute({ method: "get", path: "/v1/tests/{id}/results", tags: ["cbt"], summary: "A test's results: each student's state, answers and score, and how each question went", request: { params: z.object({ id: Id }) }, responses: { 200: ok("Results", TestResultsSchema), ...errors } }),
  async (c) => {
    const { id } = c.req.valid("param");
    const data = await schoolRoute(c, { roles: STAFF }, async ({ tx, auth }) => {
      const t = await testFor(tx, id, auth.user.id, auth.membership.role);
      const [row] = await rowsOf(tx, [t], auth.user.id);
      const qs = questionsOf(t);
      const armIds = (await armIdsOf(tx, [t.id])).get(t.id) ?? [];
      const labels = new Map((await armOptions(tx, { all: true })).map((a) => [a.id, a.label]));
      const attempts = await tx.select().from(cbtAttempts).where(eq(cbtAttempts.testId, t.id));
      const pupils = await activeIn(tx, armIds);
      const component = (await settingsOf(tx)).components.find((p) => p.id === t.componentId) ?? null;
      const rows = pupils
        .map((s) => {
          const a = attempts.find((x) => x.studentId === s.id);
          return {
            studentId: s.id,
            fullName: fullName(s),
            armLabel: labels.get(s.armId) ?? "",
            state: !a ? ("not started" as const) : a.submittedAt ? ("submitted" as const) : ("in progress" as const),
            attemptId: a?.id ?? null,
            score: a ? scoreAttempt(qs, responsesOf(a), marksOf(a)) : null,
            leftPage: a?.leftPage ?? 0,
            responses: a ? responsesOf(a) : {},
            theoryMarks: a ? marksOf(a) : {},
          };
        })
        .sort((x, y) => x.armLabel.localeCompare(y.armLabel) || x.fullName.localeCompare(y.fullName));
      const done = attempts.filter((a) => a.submittedAt);
      const stats = qs.map((q, i) => {
        const answered = done.filter((a) => responsesOf(a)[i] !== undefined).length;
        if (q.type === "theory") return { answered, right: null };
        return { answered, right: done.filter((a) => scoreAttempt([q], { 0: responsesOf(a)[i] }, {}).auto === q.marks).length };
      });
      return { test: { ...row!, accessCode: t.accessCode, showScore: t.showScore, component, questionList: qs }, rows, stats };
    });
    return c.json(data, 200);
  },
);

cbtRoutes.openapi(
  createRoute({
    method: "put",
    path: "/v1/tests/{id}/attempts/{attemptId}/marks/{index}",
    tags: ["cbt"],
    summary: "Mark one theory answer: 0 to the question's marks, in halves",
    request: {
      params: z.object({ id: Id, attemptId: Id, index: z.coerce.number().int().min(0) }),
      body: { content: { "application/json": { schema: z.object({ marks: z.coerce.number({ message: "Give a mark" }) }).openapi("TheoryMark") } }, required: true },
    },
    responses: { 204: { description: "Saved" }, 409: problemContent("Not submitted yet, or not a theory question"), 422: problemContent("Out of range (#/marks)"), ...errors },
  }),
  async (c) => {
    const { id, attemptId, index } = c.req.valid("param");
    const { marks } = c.req.valid("json");
    await schoolRoute(c, { roles: STAFF }, async ({ tx, auth }) => {
      const t = await testFor(tx, id, auth.user.id, auth.membership.role);
      await settle(tx, [t.id]);
      const [a] = await tx.select().from(cbtAttempts).where(and(eq(cbtAttempts.id, attemptId), eq(cbtAttempts.testId, id))).limit(1);
      if (!a) throw new ApiError("not_found", "That answer isn’t here any more.");
      const q = questionsOf(t)[index];
      if (!q || q.type !== "theory") throw new ApiError("conflict", "Only theory answers are marked by hand.");
      if (!a.submittedAt) throw new ApiError("conflict", "Wait until the student submits.");
      if (marks < 0 || marks > q.marks) throw new ApiError("validation_failed", `Give between 0 and ${q.marks} marks.`, { extensions: { errors: [{ pointer: "#/marks", detail: `Give between 0 and ${q.marks} marks`, code: "too_big" }] } });
      await tx
        .update(cbtAttempts)
        .set({ theoryMarks: { ...marksOf(a), [index]: Math.round(marks * 2) / 2 }, updatedBy: auth.user.id, updatedAt: new Date() })
        .where(eq(cbtAttempts.id, a.id));
    });
    return c.body(null, 204);
  },
);

cbtRoutes.openapi(
  createRoute({
    method: "post",
    path: "/v1/tests/{id}/send-scores",
    tags: ["cbt"],
    summary: "Put every submitted, fully marked attempt's score into this term's sheet, scaled to the part's marks. Sheets marked complete are skipped",
    request: { params: z.object({ id: Id }) },
    responses: { 200: ok("Sent", z.object({ sent: z.number().int(), skipped: z.number().int(), lockedClasses: z.array(z.string()) })), 409: problemContent("No term open, or the part left the results settings"), ...errors },
  }),
  async (c) => {
    const { id } = c.req.valid("param");
    const data = await schoolRoute(c, { roles: STAFF }, async ({ tx, school, auth, audit }) => {
      const t = await testFor(tx, id, auth.user.id, auth.membership.role);
      const term = await resultsTermOf(tx);
      if (!term) throw new ApiError("conflict", "No term is open for scores.");
      const component = (await settingsOf(tx)).components.find((p) => p.id === t.componentId);
      if (!component) throw new ApiError("conflict", "The score-sheet part this test sends to isn’t in the results settings any more.");
      await settle(tx, [t.id]);
      const armIds = (await armIdsOf(tx, [t.id])).get(t.id) ?? [];
      const labels = new Map((await armOptions(tx, { all: true })).map((a) => [a.id, a.label]));
      const locked = armIds.length
        ? (await tx.select({ armId: sheetCompletions.classArmId }).from(sheetCompletions).where(and(eq(sheetCompletions.termKey, term.key), eq(sheetCompletions.schoolSubjectId, t.schoolSubjectId), inArray(sheetCompletions.classArmId, armIds)))).map((r) => r.armId)
        : [];
      const excluded = new Set(
        (await tx.select({ studentId: scoreExclusions.studentId }).from(scoreExclusions).where(and(eq(scoreExclusions.termKey, term.key), eq(scoreExclusions.schoolSubjectId, t.schoolSubjectId)))).map((r) => r.studentId),
      );
      const pupils = new Map((await activeIn(tx, armIds)).map((p) => [p.id, p]));
      const qs = questionsOf(t);
      let sent = 0;
      let skipped = 0;
      for (const a of await tx.select().from(cbtAttempts).where(eq(cbtAttempts.testId, t.id))) {
        const s = pupils.get(a.studentId);
        if (!s || locked.includes(s.armId)) continue;
        const score = scoreAttempt(qs, responsesOf(a), marksOf(a));
        if (!a.submittedAt || score.toMark > 0 || excluded.has(s.id)) {
          skipped++;
          continue;
        }
        const value = scaleTo(score.total, score.max, component.maxScore);
        await tx
          .insert(scores)
          .values({ schoolId: school.id, termKey: term.key, classArmId: s.armId, schoolSubjectId: t.schoolSubjectId, studentId: s.id, componentId: component.id, value, isAbsent: false, createdBy: auth.user.id, updatedBy: auth.user.id })
          .onConflictDoUpdate({
            target: [scores.schoolId, scores.termKey, scores.classArmId, scores.schoolSubjectId, scores.studentId, scores.componentId],
            set: { value, isAbsent: false, updatedBy: auth.user.id, updatedAt: new Date() },
          });
        sent++;
      }
      await tx.update(cbtTests).set({ scoresSentAt: new Date(), updatedBy: auth.user.id, updatedAt: new Date() }).where(eq(cbtTests.id, t.id));
      audit({ action: "test.scores_sent", entity: "cbt_test", entityId: t.id, changes: { sent, skipped, component: component.id, term: term.key }, summary: `Sent ${sent} scores from “${t.title}” to ${component.name}` });
      return { sent, skipped, lockedClasses: locked.map((armId) => labels.get(armId) ?? "") };
    });
    return c.json(data, 200);
  },
);

// ——— Students ———

/** The signed-in student's record. */
async function me(tx: Tx, userId: string) {
  const [row] = await tx
    .select({ id: students.id, armId: students.classArmId })
    .from(studentLinks)
    .innerJoin(students, and(eq(students.schoolId, studentLinks.schoolId), eq(students.id, studentLinks.studentId)))
    .where(and(eq(studentLinks.userId, userId), isNull(students.deletedAt)))
    .limit(1);
  if (!row) throw new ApiError("not_found", "Your student record isn’t here any more. Ask your school.");
  return row;
}

/** Published tests for the student's class. */
async function myTests(tx: Tx, armId: string): Promise<Test[]> {
  const ids = (await tx.select({ testId: cbtTestClasses.testId }).from(cbtTestClasses).where(eq(cbtTestClasses.classArmId, armId))).map((r) => r.testId);
  if (!ids.length) return [];
  return tx.select().from(cbtTests).where(and(inArray(cbtTests.id, ids), eq(cbtTests.status, "published"))).orderBy(asc(cbtTests.opensAt));
}

async function myTest(tx: Tx, armId: string, id: string): Promise<Test> {
  const t = (await myTests(tx, armId)).find((x) => x.id === id);
  if (!t) throw new ApiError("not_found", "This test isn’t for your class.");
  return t;
}

const attemptOf = async (tx: Tx, testId: string, studentId: string) => (await tx.select().from(cbtAttempts).where(and(eq(cbtAttempts.testId, testId), eq(cbtAttempts.studentId, studentId))).limit(1))[0] ?? null;

const StudentTestRowSchema = z
  .object({
    id: z.string().uuid(),
    title: z.string(),
    subjectName: z.string(),
    durationMinutes: z.number().int(),
    questions: z.number().int(),
    opensAt: z.string(),
    closesAt: z.string(),
    where: WhereEnum,
    window: WindowEnum,
    attempt: z.enum(["none", "in progress", "submitted"]),
    score: z.object({ total: z.number(), max: z.number(), complete: z.boolean() }).nullable().openapi({ description: "Once submitted, when the teacher allows it" }),
  })
  .openapi("StudentTestRow");

/** What a student may see of their score: only once submitted, and only if the test shows it. */
function studentScore(t: Test, a: Attempt | null) {
  if (!a?.submittedAt || !t.showScore) return null;
  const s = scoreAttempt(questionsOf(t), responsesOf(a), marksOf(a));
  return { total: s.total, max: s.max, complete: s.toMark === 0 };
}

cbtRoutes.openapi(
  createRoute({ method: "get", path: "/v1/me/tests", tags: ["cbt"], summary: "The student's tests: their class's set tests, in window order", responses: { 200: ok("Tests", z.array(StudentTestRowSchema)), ...errors } }),
  async (c) => {
    const data = await schoolRoute(c, { roles: STUDENT }, async ({ tx, auth }) => {
      const s = await me(tx, auth.user.id);
      const tests = await myTests(tx, s.armId);
      await settle(tx, tests.map((t) => t.id));
      const subjects = new Map((await tx.select({ id: schoolSubjects.id, name: schoolSubjects.name }).from(schoolSubjects)).map((x) => [x.id, x.name]));
      const now = Date.now();
      const rows = [];
      for (const t of tests) {
        const a = await attemptOf(tx, t.id, s.id);
        rows.push({
          id: t.id,
          title: t.title,
          subjectName: subjects.get(t.schoolSubjectId) ?? "",
          durationMinutes: t.durationMinutes,
          questions: questionsOf(t).length,
          opensAt: t.opensAt.toISOString(),
          closesAt: t.closesAt.toISOString(),
          where: t.where,
          window: windowState(windowOf(t), now),
          attempt: !a ? ("none" as const) : a.submittedAt ? ("submitted" as const) : ("in progress" as const),
          score: studentScore(t, a),
        });
      }
      return rows;
    });
    return c.json(data, 200);
  },
);

const TakingTestSchema = z
  .object({
    id: z.string().uuid(),
    title: z.string(),
    instructions: z.string(),
    subjectName: z.string(),
    durationMinutes: z.number().int(),
    where: WhereEnum,
    deadline: z.number().int().nullable().openapi({ description: "Milliseconds since 1970, on the server's clock; null until started" }),
    now: z.number().int().openapi({ description: "The server's time, so the countdown doesn't trust the device's clock" }),
    submitted: z.boolean(),
    questions: z
      .array(z.object({ index: z.number().int(), type: z.enum(["objective", "trueFalse", "fillGap", "theory"]), text: z.string(), marks: z.number(), options: z.array(z.object({ index: z.number().int(), text: z.string() })) }))
      .openapi({ description: "In this student's order, options shuffled, no answers. Empty until started" }),
    responses: z.record(z.string(), responseSchema),
  })
  .openapi("TakingTest");

cbtRoutes.openapi(
  createRoute({
    method: "get",
    path: "/v1/me/tests/{id}",
    tags: ["cbt"],
    summary: "One test, for its start page or while taking it. Never includes the answers",
    request: { params: z.object({ id: Id }) },
    responses: { 200: ok("Test", TakingTestSchema), ...errors },
  }),
  async (c) => {
    const { id } = c.req.valid("param");
    const data = await schoolRoute(c, { roles: STUDENT }, async ({ tx, auth }) => {
      const s = await me(tx, auth.user.id);
      const t = await myTest(tx, s.armId, id);
      await settle(tx, [t.id]);
      const a = await attemptOf(tx, t.id, s.id);
      const [subject] = await tx.select({ name: schoolSubjects.name }).from(schoolSubjects).where(eq(schoolSubjects.id, t.schoolSubjectId));
      const qs = questionsOf(t);
      // The order is fixed per attempt, so reloading doesn't reshuffle and neighbours differ.
      const seed = a?.id ?? t.id;
      const order = t.shuffle ? seededOrder(qs.length, seed) : qs.map((_, i) => i);
      return {
        id: t.id,
        title: t.title,
        instructions: t.instructions,
        subjectName: subject?.name ?? "",
        durationMinutes: t.durationMinutes,
        where: t.where,
        deadline: a ? deadline(t, a) : null,
        now: Date.now(),
        submitted: !!a?.submittedAt,
        // Only what a student needs to answer: never `answer`, `answers` or `guide`.
        questions: a
          ? order.map((index) => {
              const q = qs[index]!;
              const options =
                q.type === "objective" ? (t.shuffle ? seededOrder(q.options.length, `${seed}:${index}`) : q.options.map((_, i) => i)).map((i) => ({ index: i, text: q.options[i]! })) : [];
              return { index, type: q.type, text: q.text, marks: q.marks, options };
            })
          : [],
        responses: a ? responsesOf(a) : {},
      };
    });
    return c.json(data, 200);
  },
);

cbtRoutes.openapi(
  createRoute({
    method: "post",
    path: "/v1/me/tests/{id}/start",
    tags: ["cbt"],
    summary: "Start the test, inside its window. School-only tests need the code shown in the room",
    request: { params: z.object({ id: Id }), body: { content: { "application/json": { schema: z.object({ code: z.string().trim().max(20).default("") }).openapi("StartTest") } }, required: true } },
    responses: { 204: { description: "Started (or already started)" }, 409: problemContent("Not open yet, or closed"), 422: problemContent("Wrong code (#/code)"), ...errors },
  }),
  async (c) => {
    const { id } = c.req.valid("param");
    const { code } = c.req.valid("json");
    await schoolRoute(c, { roles: STUDENT }, async ({ tx, school, auth }) => {
      const s = await me(tx, auth.user.id);
      const t = await myTest(tx, s.armId, id);
      if (await attemptOf(tx, t.id, s.id)) return;
      const state = windowState(windowOf(t), Date.now());
      if (state === "before") throw new ApiError("conflict", "This test hasn’t opened yet.");
      if (state === "closed") throw new ApiError("conflict", "This test has closed.");
      if (t.where === "school" && code.toUpperCase() !== t.accessCode) {
        throw new ApiError("validation_failed", "That code isn’t right. Ask your teacher for the code in the room.", { extensions: { errors: [{ pointer: "#/code", detail: "That code isn’t right", code: "invalid" }] } });
      }
      await tx.insert(cbtAttempts).values({ schoolId: school.id, testId: t.id, studentId: s.id, startedAt: new Date(), createdBy: auth.user.id, updatedBy: auth.user.id }).onConflictDoNothing();
    });
    return c.body(null, 204);
  },
);

/**
 * The student's attempt while it can still take answers. Past the deadline (plus the grace) it is
 * submitted here and "expired" comes back, so the caller can commit that before refusing: an
 * error thrown inside the transaction would roll the submission back.
 */
async function liveAttempt(tx: Tx, t: Test, studentId: string): Promise<Attempt | "expired"> {
  const a = await attemptOf(tx, t.id, studentId);
  if (!a) throw new ApiError("conflict", "Start the test first.");
  if (a.submittedAt) throw new ApiError("conflict", "You’ve already submitted this test.");
  if (Date.now() > deadline(t, a) + GRACE_MS) {
    await settle(tx, [t.id]);
    return "expired";
  }
  return a;
}
const TIME_UP = () => new ApiError("conflict", "Time is up. Your answers were submitted.");

const FITS: Record<Question["type"], (r: Response) => boolean> = {
  objective: (r) => "option" in r,
  trueFalse: (r) => "value" in r,
  fillGap: (r) => "text" in r,
  theory: (r) => "text" in r,
};

cbtRoutes.openapi(
  createRoute({
    method: "put",
    path: "/v1/me/tests/{id}/answers/{index}",
    tags: ["cbt"],
    summary: "Save one answer as the student goes (null clears it). Refused after the deadline plus 30 seconds",
    request: {
      params: z.object({ id: Id, index: z.coerce.number().int().min(0) }),
      body: { content: { "application/json": { schema: z.object({ response: responseSchema.nullable() }).openapi("SaveAnswer") } }, required: true },
    },
    responses: { 204: { description: "Saved" }, 409: problemContent("Not started, submitted, or time is up"), 422: problemContent("Doesn't fit the question"), ...errors },
  }),
  async (c) => {
    const { id, index } = c.req.valid("param");
    const { response } = c.req.valid("json");
    const outcome = await schoolRoute(c, { roles: STUDENT }, async ({ tx, auth }) => {
      const s = await me(tx, auth.user.id);
      const t = await myTest(tx, s.armId, id);
      const a = await liveAttempt(tx, t, s.id);
      if (a === "expired") return "expired" as const;
      const q = questionsOf(t)[index];
      if (!q) throw new ApiError("not_found", "That question isn’t in this test.");
      if (response && (!FITS[q.type](response) || ("option" in response && q.type === "objective" && response.option >= q.options.length))) {
        throw new ApiError("validation_failed", "That answer doesn’t fit this question.", { extensions: { errors: [{ pointer: "#/response", detail: "That answer doesn’t fit this question", code: "invalid" }] } });
      }
      const next = { ...responsesOf(a) } as Record<number, Response>;
      if (response) next[index] = response;
      else delete next[index];
      await tx.update(cbtAttempts).set({ responses: next, updatedAt: new Date() }).where(and(eq(cbtAttempts.id, a.id), isNull(cbtAttempts.submittedAt)));
      return "saved" as const;
    });
    // The submission above is committed; now say why the answer wasn't taken.
    if (outcome === "expired") throw TIME_UP();
    return c.body(null, 204);
  },
);

cbtRoutes.openapi(
  createRoute({
    method: "post",
    path: "/v1/me/tests/{id}/left",
    tags: ["cbt"],
    summary: "The test page was hidden (another tab or app): the teacher sees how often",
    request: { params: z.object({ id: Id }) },
    responses: { 204: { description: "Noted" }, ...errors },
  }),
  async (c) => {
    const { id } = c.req.valid("param");
    await schoolRoute(c, { roles: STUDENT }, async ({ tx, auth }) => {
      const s = await me(tx, auth.user.id);
      const t = await myTest(tx, s.armId, id);
      await tx
        .update(cbtAttempts)
        .set({ leftPage: sql`${cbtAttempts.leftPage} + 1`, updatedAt: new Date() })
        .where(and(eq(cbtAttempts.testId, t.id), eq(cbtAttempts.studentId, s.id), isNull(cbtAttempts.submittedAt), lt(cbtAttempts.leftPage, 10_000)));
    });
    return c.body(null, 204);
  },
);

cbtRoutes.openapi(
  createRoute({
    method: "post",
    path: "/v1/me/tests/{id}/submit",
    tags: ["cbt"],
    summary: "Submit the test. Returns the score when the test shows it",
    request: { params: z.object({ id: Id }) },
    responses: { 200: ok("Submitted", z.object({ score: z.object({ total: z.number(), max: z.number(), complete: z.boolean() }).nullable() })), 409: problemContent("Not started"), ...errors },
  }),
  async (c) => {
    const { id } = c.req.valid("param");
    const data = await schoolRoute(c, { roles: STUDENT }, async ({ tx, auth }) => {
      const s = await me(tx, auth.user.id);
      const t = await myTest(tx, s.armId, id);
      let a = await attemptOf(tx, t.id, s.id);
      if (!a) throw new ApiError("conflict", "Start the test first.");
      if (!a.submittedAt) {
        const at = new Date(Math.min(Date.now(), deadline(t, a) + GRACE_MS));
        a = (await tx.update(cbtAttempts).set({ submittedAt: at, updatedAt: new Date() }).where(eq(cbtAttempts.id, a.id)).returning())[0] ?? a;
      }
      return { score: studentScore(t, a) };
    });
    return c.json(data, 200);
  },
);
