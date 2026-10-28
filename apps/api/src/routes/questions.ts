/**
 * The question bank and AI-drafted questions (B7 in the front end's backend-requirements.md; flow
 * from its src/data/fake/questions.ts and docs/ai-integration.md).
 *
 *   GET    /v1/questions             the pairs this person may write for, their questions, this month's AI use
 *   POST   /v1/questions/generate    drafts from the AI; nothing is saved
 *   POST   /v1/questions             { subjectId, levelId, questions, source } → { saved }
 *   PUT    /v1/questions/{id}        { question }
 *   DELETE /v1/questions/{id}
 *
 * A teacher sees and writes questions for the subject and class level pairs they teach (their
 * subject classes); owners and admins for all. A teacher changes or deletes only their own.
 * Students never reach any of this.
 *
 * Generating holds no database transaction while the model works (10 to 40 seconds): the checks
 * run first, then the call, then the usage is recorded.
 */
import { MONTHLY_GENERATIONS, type Question } from "@brillianda/core";
import { aiUsage, and, asc, bankQuestions, classArms, classLevels, classLevelSubjects, desc, eq, gte, isNull, schoolSubjects, subjectTeachers, users, withSchool, type Tx } from "@brillianda/db";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { AppEnv } from "../context.js";
import { AiError } from "../lib/ai.js";
import { lagosToday } from "../lib/attendance.js";
import { ApiError, problemContent } from "../lib/errors.js";
import { asQuestion, generateRequestSchema, questionSchema } from "../lib/questions.js";
import { RATE_RULES } from "../lib/rate-limit.js";
import { schoolRoute, type Role } from "../school-route.js";

export const questionRoutes = new OpenAPIHono<AppEnv>();

const STAFF: readonly Role[] = ["owner", "admin", "teacher"];
const ok = <T extends z.ZodTypeAny>(description: string, schema: T) => ({ description, content: { "application/json": { schema } } });
const errors = {
  401: problemContent("Not signed in to this school"),
  403: problemContent("Not this person's subject and class, or not their question"),
  404: problemContent("No active school here"),
} as const;
const NOT_YOURS = "You can only write questions for the subjects and classes you teach.";

type Pair = { subjectId: string; subjectName: string; levelId: string; levelName: string };

/** The subject and class level pairs a person may write for: what they teach, or everything for owners and admins. */
async function pairsFor(tx: Tx, userId: string, admin: boolean): Promise<Pair[]> {
  const levels = await tx.select({ id: classLevels.id, name: classLevels.name, position: classLevels.position }).from(classLevels).where(isNull(classLevels.archivedAt));
  const subjects = new Map((await tx.select({ id: schoolSubjects.id, name: schoolSubjects.name }).from(schoolSubjects)).map((s) => [s.id, s.name]));
  const levelById = new Map(levels.map((l) => [l.id, l]));
  const raw = admin
    ? await tx.select({ subjectId: classLevelSubjects.schoolSubjectId, levelId: classLevelSubjects.classLevelId }).from(classLevelSubjects)
    : await tx
        .select({ subjectId: subjectTeachers.schoolSubjectId, levelId: classArms.classLevelId })
        .from(subjectTeachers)
        .innerJoin(classArms, and(eq(classArms.schoolId, subjectTeachers.schoolId), eq(classArms.id, subjectTeachers.classArmId)))
        .where(eq(subjectTeachers.userId, userId));
  const seen = new Set<string>();
  return raw
    .filter((p) => subjects.has(p.subjectId) && levelById.has(p.levelId) && !seen.has(`${p.subjectId}|${p.levelId}`) && seen.add(`${p.subjectId}|${p.levelId}`))
    .map((p) => ({ subjectId: p.subjectId, subjectName: subjects.get(p.subjectId)!, levelId: p.levelId, levelName: levelById.get(p.levelId)!.name, position: levelById.get(p.levelId)!.position }))
    .sort((a, b) => a.position - b.position || a.subjectName.localeCompare(b.subjectName))
    .map(({ position: _, ...p }) => p);
}

const isAdmin = (role: Role) => role === "owner" || role === "admin";
const pairOf = (pairs: Pair[], subjectId: string, levelId: string) => pairs.find((p) => p.subjectId === subjectId && p.levelId === levelId);

/** This month (Lagos time): when it started, and when the allowance resets. */
function thisMonth() {
  const [y, m] = lagosToday().split("-").map(Number) as [number, number];
  const next = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`;
  return { start: new Date(`${y}-${String(m).padStart(2, "0")}-01T00:00:00+01:00`), resetsOn: next };
}

async function usageOf(tx: Tx, limit: number) {
  const { start, resetsOn } = thisMonth();
  const rows = await tx.select({ id: aiUsage.id }).from(aiUsage).where(gte(aiUsage.createdAt, start));
  return { used: rows.length, limit, resetsOn };
}

const UsageSchema = z.object({ used: z.number().int(), limit: z.number().int(), resetsOn: z.string() }).openapi("AiUsage");
const PairSchema = z.object({ subjectId: z.string().uuid(), subjectName: z.string(), levelId: z.string().uuid(), levelName: z.string() });
const BankQuestionSchema = z
  .object({ id: z.string().uuid(), subjectId: z.string().uuid(), levelId: z.string().uuid(), question: questionSchema, source: z.enum(["ai", "teacher"]), by: z.string(), byMe: z.boolean(), at: z.number().int() })
  .openapi("BankQuestion");
const QuestionBankPageSchema = z
  .object({
    pairs: z.array(PairSchema).openapi({ description: "Subject and class level pairs this person may write questions for" }),
    questions: z.array(BankQuestionSchema).openapi({ description: "Newest first" }),
    usage: UsageSchema.openapi({ description: "This month's AI generations, the school's allowance, and when it resets" }),
    canEditAll: z.boolean(),
    aiEnabled: z.boolean().openapi({ description: "Whether Generate is switched on here (false answers ai_disabled)" }),
  })
  .openapi("QuestionBankPage");

questionRoutes.openapi(
  createRoute({ method: "get", path: "/v1/questions", tags: ["questions"], summary: "The question bank: what this person may write for, their questions, and this month's AI use", responses: { 200: ok("Bank", QuestionBankPageSchema), ...errors } }),
  async (c) => {
    const { ai, config } = c.get("deps");
    const data = await schoolRoute(c, { roles: STAFF }, async ({ tx, auth }) => {
      const admin = isAdmin(auth.membership.role);
      const pairs = await pairsFor(tx, auth.user.id, admin);
      const rows = await tx
        .select({ q: bankQuestions, by: users.fullName })
        .from(bankQuestions)
        .leftJoin(users, eq(users.id, bankQuestions.authorId))
        .orderBy(desc(bankQuestions.createdAt), asc(bankQuestions.id));
      return {
        pairs,
        questions: rows
          .filter((r) => pairOf(pairs, r.q.schoolSubjectId, r.q.classLevelId))
          .map((r) => ({
            id: r.q.id,
            subjectId: r.q.schoolSubjectId,
            levelId: r.q.classLevelId,
            question: r.q.question as Question,
            source: r.q.source,
            by: r.by ?? "A former staff member",
            byMe: r.q.authorId === auth.user.id,
            at: r.q.updatedAt.getTime(),
          })),
        usage: await usageOf(tx, config.aiMonthlyLimit ?? MONTHLY_GENERATIONS),
        canEditAll: admin,
        aiEnabled: ai.enabled,
      };
    });
    return c.json(data, 200);
  },
);

questionRoutes.openapi(
  createRoute({
    method: "post",
    path: "/v1/questions/generate",
    tags: ["questions"],
    summary: "Draft questions with AI for a subject and class this person teaches. Nothing is saved: the teacher checks them, then saves",
    request: { body: { content: { "application/json": { schema: generateRequestSchema } }, required: true } },
    responses: {
      200: ok("Drafts", z.object({ questions: z.array(questionSchema), usage: UsageSchema })),
      422: problemContent("A field needs fixing, or ai_refused: the provider's safety filter blocked it"),
      429: problemContent("ai_quota_exceeded (resetsOn), or rate_limited"),
      502: problemContent("ai_invalid_output"),
      503: problemContent("ai_disabled (not switched on here) or ai_unavailable"),
      ...errors,
    },
  }),
  async (c) => {
    const req = c.req.valid("json");
    const { ai, db, config } = c.get("deps");
    const limit = config.aiMonthlyLimit ?? MONTHLY_GENERATIONS;
    // 1. Who's asking, for what, and whether there's allowance left. No transaction is held after this.
    const ready = await schoolRoute(c, { roles: STAFF, userRateLimit: RATE_RULES.aiGeneratePerUser }, async ({ tx, school, auth }) => {
      const pair = pairOf(await pairsFor(tx, auth.user.id, isAdmin(auth.membership.role)), req.subjectId, req.levelId);
      if (!pair) throw new ApiError("forbidden", NOT_YOURS);
      if (!ai.enabled) throw new ApiError("ai_disabled", "Generating questions isn’t switched on yet. Write questions yourself for now.");
      const usage = await usageOf(tx, limit);
      if (usage.used >= usage.limit) {
        throw new ApiError("ai_quota_exceeded", `Your school has used this month’s ${usage.limit} question generations. They reset on ${usage.resetsOn}.`, { extensions: { resetsOn: usage.resetsOn } });
      }
      return { schoolId: school.id, userId: auth.user.id, pair };
    });
    // 2. The model. Only the subject, the class and the teacher's own words go to it.
    let result;
    try {
      result = await ai.generate(req, { subjectName: ready.pair.subjectName, levelName: ready.pair.levelName });
    } catch (err) {
      if (!(err instanceof AiError)) throw err;
      const code = ({ disabled: "ai_disabled", unavailable: "ai_unavailable", invalid_output: "ai_invalid_output", refused: "ai_refused" } as const)[err.kind];
      throw new ApiError(code, err.message);
    }
    // 3. Record the generation (it counts once it succeeded).
    const usage = await withSchool(db, ready.schoolId, async (tx) => {
      await tx.insert(aiUsage).values({
        schoolId: ready.schoolId,
        userId: ready.userId,
        provider: ai.provider,
        model: result.model,
        purpose: req.purpose,
        questions: result.questions.length,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        createdBy: ready.userId,
        updatedBy: ready.userId,
      });
      return usageOf(tx, limit);
    });
    return c.json({ questions: result.questions, usage }, 200);
  },
);

questionRoutes.openapi(
  createRoute({
    method: "post",
    path: "/v1/questions",
    tags: ["questions"],
    summary: "Save checked questions to the bank for a subject and class level",
    request: {
      body: {
        content: {
          "application/json": {
            schema: z
              .object({
                subjectId: z.string().uuid("Choose a subject"),
                levelId: z.string().uuid("Choose a class"),
                questions: z.array(questionSchema).min(1, "Add at least one question").max(100, "Save at most 100 at a time"),
                source: z.enum(["ai", "teacher"]),
              })
              .openapi("SaveQuestions"),
          },
        },
        required: true,
      },
    },
    responses: { 200: ok("Saved", z.object({ saved: z.number().int() })), 422: problemContent("A question needs fixing, e.g. #/questions/2/answer"), ...errors },
  }),
  async (c) => {
    const input = c.req.valid("json");
    const data = await schoolRoute(c, { roles: STAFF }, async ({ tx, school, auth, audit }) => {
      const pair = pairOf(await pairsFor(tx, auth.user.id, isAdmin(auth.membership.role)), input.subjectId, input.levelId);
      if (!pair) throw new ApiError("forbidden", NOT_YOURS);
      const by = { authorId: auth.user.id, createdBy: auth.user.id, updatedBy: auth.user.id };
      await tx.insert(bankQuestions).values(
        input.questions.map((q) => ({ schoolId: school.id, schoolSubjectId: input.subjectId, classLevelId: input.levelId, question: asQuestion(q) as unknown as Record<string, unknown>, source: input.source, ...by })),
      );
      const n = input.questions.length;
      audit({
        action: "questions.saved",
        entity: "school_subject",
        entityId: input.subjectId,
        changes: { levelId: input.levelId, count: n, source: input.source },
        summary: `Added ${n === 1 ? "1 question" : `${n} questions`} to the ${pair.levelName} ${pair.subjectName} question bank`,
      });
      return { saved: n };
    });
    return c.json(data, 200);
  },
);

/** The question, if this person may change it: their own (in a pair they teach), or any for owners and admins. */
async function changeable(tx: Tx, id: string, userId: string, role: Role) {
  const [row] = await tx.select().from(bankQuestions).where(eq(bankQuestions.id, id)).limit(1);
  if (!row) throw new ApiError("not_found", "That question isn’t in the bank any more.");
  const admin = isAdmin(role);
  if (!admin && !pairOf(await pairsFor(tx, userId, false), row.schoolSubjectId, row.classLevelId)) throw new ApiError("not_found", "That question isn’t in the bank any more.");
  if (!admin && row.authorId !== userId) throw new ApiError("forbidden", "You can change your own questions only. Ask an admin to change this one.");
  return row;
}

const IdParam = z.object({ id: z.string().uuid("Invalid id") });

questionRoutes.openapi(
  createRoute({
    method: "put",
    path: "/v1/questions/{id}",
    tags: ["questions"],
    summary: "Change a question: a teacher their own, owners and admins any",
    request: { params: IdParam, body: { content: { "application/json": { schema: z.object({ question: questionSchema }).openapi("UpdateQuestion") } }, required: true } },
    responses: { 204: { description: "Saved" }, 422: problemContent("The question needs fixing, e.g. #/question/answer"), ...errors, 404: problemContent("No such question") },
  }),
  async (c) => {
    const { id } = c.req.valid("param");
    const { question } = c.req.valid("json");
    await schoolRoute(c, { roles: STAFF }, async ({ tx, auth, audit }) => {
      const row = await changeable(tx, id, auth.user.id, auth.membership.role);
      await tx
        .update(bankQuestions)
        .set({ question: asQuestion(question) as unknown as Record<string, unknown>, updatedBy: auth.user.id, updatedAt: new Date() })
        .where(eq(bankQuestions.id, id));
      audit({ action: "question.updated", entity: "bank_question", entityId: id, changes: { subjectId: row.schoolSubjectId, levelId: row.classLevelId }, summary: "Changed a question in the question bank" });
    });
    return c.body(null, 204);
  },
);

questionRoutes.openapi(
  createRoute({
    method: "delete",
    path: "/v1/questions/{id}",
    tags: ["questions"],
    summary: "Delete a question: a teacher their own, owners and admins any",
    request: { params: IdParam },
    responses: { 204: { description: "Deleted" }, ...errors, 404: problemContent("No such question") },
  }),
  async (c) => {
    const { id } = c.req.valid("param");
    await schoolRoute(c, { roles: STAFF }, async ({ tx, auth, audit }) => {
      const row = await changeable(tx, id, auth.user.id, auth.membership.role);
      await tx.delete(bankQuestions).where(eq(bankQuestions.id, id));
      audit({ action: "question.deleted", entity: "bank_question", entityId: id, changes: { subjectId: row.schoolSubjectId, levelId: row.classLevelId, question: row.question }, summary: "Deleted a question from the question bank" });
    });
    return c.body(null, 204);
  },
);
