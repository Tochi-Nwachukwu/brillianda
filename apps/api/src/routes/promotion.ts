/**
 * Promotion at the end of the session (B1 in the front end's backend-requirements.md; rules in
 * packages/core/src/promotion.ts, flow from its src/data/fake/promotion.ts). Owners and admins.
 *
 *   GET  /v1/promotion                  the plan: each class, each student's yearly average and decision
 *   PUT  /v1/promotion/pass-mark        { passMark }
 *   PUT  /v1/promotion/students/{id}    { decision, reason }; choosing the suggestion clears the change
 *   POST /v1/promotion/complete         { closeUnpublished, startsOn?, endsOn? }
 *
 * Completing, in the session's last term only: closes that term, moves each student as decided
 * (graduates leave with status graduated), and starts the next session with its first term's
 * dates. Classes, subjects and teachers stay as they are.
 */
import {
  DEFAULT_COMPONENTS,
  DEFAULT_SCALE,
  DECISIONS,
  defaultPassMark,
  defaultTerms,
  fullName,
  nextArm,
  sessionName,
  suggestDecision,
  yearlyAverage,
  type Decision,
} from "@brillianda/core";
import {
  academicSessions,
  and,
  asc,
  classArms,
  classLevels,
  enrolments,
  eq,
  inArray,
  isNull,
  promotionDecisions,
  resultsSettings,
  scoreExclusions,
  scores,
  students,
  terms,
  type Tx,
} from "@brillianda/db";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { AppEnv } from "../context.js";
import { lagosToday } from "../lib/attendance.js";
import { ApiError, problemContent } from "../lib/errors.js";
import { schoolRoute, type Role } from "../school-route.js";
import { currentSession } from "./calendar.js";
import { armOptions } from "./classes.js";
import { computeClass } from "./reports.js";
import { resultsTermOf, settingsOf } from "./results.js";
import { closeOpenTerm, unpublishedClasses } from "./terms.js";

export const promotionRoutes = new OpenAPIHono<AppEnv>();

const ADMINS: readonly Role[] = ["owner", "admin"];
const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Pick a day");
const ok = <T extends z.ZodTypeAny>(description: string, schema: T) => ({ description, content: { "application/json": { schema } } });
const errors = {
  401: problemContent("Not signed in to this school"),
  403: problemContent("Only owners and admins"),
  404: problemContent("No active school here"),
} as const;
const field = (pointer: string, detail: string) => new ApiError("validation_failed", detail, { extensions: { errors: [{ pointer, detail, code: "invalid" }] } });

// The front end's passMarkSchema and decisionSchema, with the same rules.
const passMarkSchema = z.object({ passMark: z.coerce.number({ message: "Enter a number" }).min(0, "0 or more").max(100, "100 or less") });
const decisionSchema = z.object({
  decision: z.enum(DECISIONS, { message: "Pick moves up, repeats or graduates" }),
  reason: z.string().trim().max(200, "Use at most 200 characters").nullable().default(null),
});

async function passMarkOf(tx: Tx): Promise<number> {
  const [row] = await tx.select({ passMark: resultsSettings.passMark }).from(resultsSettings).limit(1);
  return row?.passMark ?? defaultPassMark((await settingsOf(tx)).scale);
}

/** Each student's average in every term of the session that has results (one class computation per term and class). */
async function termAverages(tx: Tx, startYear: number, termCount: number, openKey: string | undefined) {
  const byStudent = new Map<string, (number | null)[]>();
  for (let i = 1; i <= termCount; i++) {
    const key = `${startYear}-${i}`;
    const armIds = new Set([
      ...(await tx.selectDistinct({ id: scores.classArmId }).from(scores).where(eq(scores.termKey, key))).map((r) => r.id),
      ...(await tx.selectDistinct({ id: scoreExclusions.classArmId }).from(scoreExclusions).where(eq(scoreExclusions.termKey, key))).map((r) => r.id),
    ]);
    for (const armId of armIds) {
      for (const [studentId, r] of (await computeClass(tx, key, armId, openKey)).results) byStudent.set(studentId, [...(byStudent.get(studentId) ?? []), r.average]);
    }
  }
  return byStudent;
}

type PlanStudent = {
  id: string;
  fullName: string;
  admissionNo: string;
  yearlyAverage: number | null;
  termsCounted: number;
  suggested: Decision;
  decision: Decision;
  reason: string | null;
  destination: string | null;
  /** Where completing moves them: an arm id, or null for graduates. Stays on the server. */
  moveTo: string | null;
};

/** The classes with active students, the final class level, and each student's suggestion and decision. */
async function buildPlan(tx: Tx) {
  const session = await currentSession(tx);
  const open = await resultsTermOf(tx);
  const passMark = await passMarkOf(tx);
  const options = await armOptions(tx);
  const label = new Map(options.map((o) => [o.id, o.label]));
  const levels = (await tx.select({ id: classLevels.id, position: classLevels.position }).from(classLevels).where(isNull(classLevels.archivedAt)));
  const lastPosition = Math.max(...levels.map((l) => l.position));
  const arms = (await tx.select({ id: classArms.id, levelId: classArms.classLevelId, armNameId: classArms.armId }).from(classArms).where(isNull(classArms.archivedAt))).filter((a) => label.has(a.id));
  const pupils = await tx
    .select({ id: students.id, armId: students.classArmId, firstName: students.firstName, otherNames: students.otherNames, lastName: students.lastName, admissionNo: students.admissionNumber })
    .from(students)
    .where(and(eq(students.status, "active"), isNull(students.deletedAt)))
    .orderBy(asc(students.lastName), asc(students.firstName), asc(students.id));
  const changes = new Map((await tx.select().from(promotionDecisions).where(eq(promotionDecisions.startYear, session.startYear))).map((d) => [d.studentId, d]));
  const averages = await termAverages(tx, session.startYear, session.terms.length, open?.key);

  const classes = options
    .map((o) => {
      const arm = arms.find((a) => a.id === o.id)!;
      const destination = levels.find((l) => l.id === arm.levelId)?.position === lastPosition ? null : nextArm(levels, arms, arm);
      const finalClass = !destination;
      const studentsHere: PlanStudent[] = pupils
        .filter((p) => p.armId === o.id)
        .map((p) => {
          const termList = averages.get(p.id) ?? [];
          const average = yearlyAverage(termList);
          const suggested = suggestDecision(average, passMark, finalClass);
          const changed = changes.get(p.id);
          const decision = changed?.decision ?? suggested;
          const moveTo = decision === "promote" ? (destination?.id ?? null) : decision === "repeat" ? o.id : null;
          return {
            id: p.id,
            fullName: fullName(p),
            admissionNo: p.admissionNo,
            yearlyAverage: average,
            termsCounted: termList.filter((a) => a !== null).length,
            suggested,
            decision,
            reason: changed?.reason ?? null,
            destination: moveTo ? label.get(moveTo)! : null,
            moveTo,
          };
        });
      return { armId: o.id, label: o.label, finalClass, students: studentsHere };
    })
    .filter((c) => c.students.length > 0);
  return { session, open, passMark, classes };
}

/** The next session's terms: the same number and names as this one, at their suggested dates. */
function nextTerms(session: Awaited<ReturnType<typeof currentSession>>) {
  const count = session.terms.length === 2 ? 2 : 3;
  return defaultTerms(session.startYear + 1, count).map((t, i) => ({ ...t, name: session.terms[i]?.name ?? t.name }));
}

const DecisionEnum = z.enum(DECISIONS);
const PromotionPlanSchema = z
  .object({
    sessionName: z.string(),
    nextSessionName: z.string(),
    passMark: z.number(),
    open: z.boolean().openapi({ description: "True only while the session's last term is the one open for results" }),
    lastTerm: z.string(),
    classes: z.array(
      z.object({
        armId: z.string().uuid(),
        label: z.string(),
        finalClass: z.boolean(),
        students: z.array(
          z.object({
            id: z.string().uuid(),
            fullName: z.string(),
            admissionNo: z.string(),
            yearlyAverage: z.number().nullable(),
            termsCounted: z.number().int(),
            suggested: DecisionEnum,
            decision: DecisionEnum,
            reason: z.string().nullable(),
            destination: z.string().nullable().openapi({ description: "Next session's class; null for graduates" }),
          }),
        ),
      }),
    ),
    counts: z.object({ promote: z.number().int(), repeat: z.number().int(), graduate: z.number().int() }),
    unpublished: z.array(z.object({ armId: z.string().uuid(), label: z.string() })),
    firstTerm: z.object({ name: z.string(), startsOn: z.string(), endsOn: z.string() }).openapi({ description: "The next session's suggested first term, for the dialog" }),
  })
  .openapi("PromotionPlan");

promotionRoutes.openapi(
  createRoute({ method: "get", path: "/v1/promotion", tags: ["promotion"], summary: "The promotion plan: each class with each student's yearly average and decision", responses: { 200: ok("Plan", PromotionPlanSchema), ...errors } }),
  async (c) => {
    const data = await schoolRoute(c, { roles: ADMINS }, async ({ tx }) => {
      const { session, open, passMark, classes } = await buildPlan(tx);
      const counts: Record<Decision, number> = { promote: 0, repeat: 0, graduate: 0 };
      for (const k of classes) for (const s of k.students) counts[s.decision]++;
      const first = nextTerms(session)[0]!;
      return {
        sessionName: session.name,
        nextSessionName: sessionName(session.startYear + 1),
        passMark,
        open: !!open?.isLast,
        lastTerm: session.terms.at(-1)?.name ?? "",
        classes: classes.map((k) => ({ ...k, students: k.students.map(({ moveTo: _, ...s }) => s) })),
        counts,
        unpublished: open?.isLast ? await unpublishedClasses(tx, open.key) : [],
        firstTerm: { name: first.name, startsOn: first.startsOn, endsOn: first.endsOn },
      };
    });
    return c.json(data, 200);
  },
);

promotionRoutes.openapi(
  createRoute({
    method: "put",
    path: "/v1/promotion/pass-mark",
    tags: ["promotion"],
    summary: "Set the pass mark (0 to 100). Students below it are suggested to repeat",
    request: { body: { content: { "application/json": { schema: passMarkSchema.openapi("PassMark") } }, required: true } },
    responses: { 204: { description: "Saved" }, 422: problemContent("Not 0 to 100"), ...errors },
  }),
  async (c) => {
    const { passMark } = c.req.valid("json");
    await schoolRoute(c, { roles: ADMINS }, async ({ tx, school, auth, audit }) => {
      const by = { createdBy: auth.user.id, updatedBy: auth.user.id };
      await tx
        .insert(resultsSettings)
        .values({ schoolId: school.id, components: DEFAULT_COMPONENTS, scale: DEFAULT_SCALE, passMark, ...by })
        .onConflictDoUpdate({ target: resultsSettings.schoolId, set: { passMark, updatedBy: auth.user.id, updatedAt: new Date() } });
      audit({ action: "promotion.pass_mark_set", entity: "school", entityId: school.id, changes: { passMark }, summary: `Set the promotion pass mark to ${passMark}` });
    });
    return c.body(null, 204);
  },
);

promotionRoutes.openapi(
  createRoute({
    method: "put",
    path: "/v1/promotion/students/{id}",
    tags: ["promotion"],
    summary: "Change a student's decision, with an optional reason. Choosing the suggestion clears the change",
    request: {
      params: z.object({ id: z.string().uuid("Invalid id") }),
      body: { content: { "application/json": { schema: decisionSchema.openapi("PromotionDecisionInput") } }, required: true },
    },
    responses: { 204: { description: "Saved" }, 422: problemContent("A field needs fixing"), ...errors, 404: problemContent("Not a student in a class this session") },
  }),
  async (c) => {
    const { id } = c.req.valid("param");
    const input = c.req.valid("json");
    await schoolRoute(c, { roles: ADMINS }, async ({ tx, school, auth, audit }) => {
      const { session, classes } = await buildPlan(tx);
      const student = classes.flatMap((k) => k.students).find((s) => s.id === id);
      if (!student) throw new ApiError("not_found", "That student isn’t in a class this session.");
      const where = and(eq(promotionDecisions.startYear, session.startYear), eq(promotionDecisions.studentId, id));
      if (input.decision === student.suggested) {
        await tx.delete(promotionDecisions).where(where);
      } else {
        const reason = input.reason || null;
        await tx
          .insert(promotionDecisions)
          .values({ schoolId: school.id, startYear: session.startYear, studentId: id, decision: input.decision, reason, createdBy: auth.user.id, updatedBy: auth.user.id })
          .onConflictDoUpdate({ target: [promotionDecisions.schoolId, promotionDecisions.startYear, promotionDecisions.studentId], set: { decision: input.decision, reason, updatedBy: auth.user.id, updatedAt: new Date() } });
      }
      const word = { promote: "moves up", repeat: "repeats", graduate: "graduates" }[input.decision];
      audit({
        action: "promotion.decision_set",
        entity: "student",
        entityId: id,
        changes: { from: student.decision, to: input.decision, reason: input.reason, suggested: input.decision === student.suggested },
        summary: `${student.fullName} ${word} at the end of ${session.name}${input.decision === student.suggested ? " (as suggested)" : ""}`,
      });
    });
    return c.body(null, 204);
  },
);

promotionRoutes.openapi(
  createRoute({
    method: "post",
    path: "/v1/promotion/complete",
    tags: ["promotion"],
    summary: "End the session: close its last term, move students as decided, start the next session. Refused while classes are unpublished unless closeUnpublished",
    request: {
      body: {
        content: { "application/json": { schema: z.object({ closeUnpublished: z.boolean().default(false), startsOn: Day.optional(), endsOn: Day.optional() }).openapi("CompletePromotion") } },
        required: true,
      },
    },
    responses: {
      200: ok("Completed", z.object({ promoted: z.number().int(), repeating: z.number().int(), graduated: z.number().int(), session: z.string() }).openapi("PromotionCompleted")),
      409: problemContent("Not the session's last term, or classes unpublished (detail lists them)"),
      422: problemContent("The first term's dates"),
      ...errors,
    },
  }),
  async (c) => {
    const input = c.req.valid("json");
    const data = await schoolRoute(c, { roles: ADMINS }, async ({ tx, school, auth, audit }) => {
      const { session, open, classes } = await buildPlan(tx);
      if (!open?.isLast) throw new ApiError("conflict", "Promotion opens in the session’s last term.");
      const waiting = await unpublishedClasses(tx, open.key);
      if (waiting.length && !input.closeUnpublished) {
        throw new ApiError("conflict", `${waiting.length} ${waiting.length === 1 ? "class isn’t" : "classes aren’t"} published yet: ${waiting.map((w) => w.label).join(", ")}. Publish them, or complete anyway.`);
      }

      // The next session's first term, at the chosen dates.
      const upcoming = nextTerms(session);
      const first = { ...upcoming[0]!, startsOn: input.startsOn ?? upcoming[0]!.startsOn, endsOn: input.endsOn ?? upcoming[0]!.endsOn };
      upcoming[0] = first;
      const last = session.terms.at(-1)!;
      if (first.endsOn <= first.startsOn) throw field("#/endsOn", "The first term must end after it starts.");
      if (first.startsOn <= last.startsOn) throw field("#/startsOn", `The new session must start after ${last.name} did (${last.startsOn}).`);
      const second = upcoming[1];
      if (second && first.endsOn >= second.startsOn) throw field("#/endsOn", `The first term must end before ${second.name} starts (${second.startsOn}). You can change the later terms after.`);

      // Move everyone as decided.
      const today = lagosToday();
      const by = { createdBy: auth.user.id, updatedBy: auth.user.id };
      const all = classes.flatMap((k) => k.students);
      const graduates = all.filter((s) => !s.moveTo).map((s) => s.id);
      const movers = all.filter((s) => s.decision === "promote" && s.moveTo);
      const repeating = all.length - graduates.length - movers.length;
      const ending = [...graduates, ...movers.map((s) => s.id)];
      if (ending.length) await tx.update(enrolments).set({ endedOn: today, updatedBy: auth.user.id, updatedAt: new Date() }).where(and(inArray(enrolments.studentId, ending), isNull(enrolments.endedOn)));
      if (graduates.length) await tx.update(students).set({ status: "graduated", updatedBy: auth.user.id, updatedAt: new Date() }).where(inArray(students.id, graduates));

      // Start the next session (reusing a row for that year if the school saved one before).
      const name = sessionName(session.startYear + 1);
      await tx.update(academicSessions).set({ isCurrent: false, updatedBy: auth.user.id }).where(eq(academicSessions.isCurrent, true));
      const values = { startYear: session.startYear + 1, name, startsOn: first.startsOn, endsOn: upcoming.at(-1)!.endsOn, isCurrent: true, confirmedAt: new Date(), updatedBy: auth.user.id };
      const [existing] = await tx.select({ id: academicSessions.id }).from(academicSessions).where(eq(academicSessions.startYear, session.startYear + 1)).limit(1);
      let sessionId: string;
      if (existing) {
        await tx.update(academicSessions).set(values).where(eq(academicSessions.id, existing.id));
        await tx.delete(terms).where(eq(terms.sessionId, existing.id));
        sessionId = existing.id;
      } else {
        sessionId = (await tx.insert(academicSessions).values({ schoolId: school.id, ...values, createdBy: auth.user.id }).returning({ id: academicSessions.id }))[0]!.id;
      }
      await tx.insert(terms).values(upcoming.map((t, i) => ({ schoolId: school.id, sessionId, name: t.name, position: i + 1, startsOn: t.startsOn, endsOn: t.endsOn, ...by })));

      for (const s of movers) await tx.update(students).set({ classArmId: s.moveTo!, updatedBy: auth.user.id, updatedAt: new Date() }).where(eq(students.id, s.id));
      if (movers.length) await tx.insert(enrolments).values(movers.map((s) => ({ schoolId: school.id, studentId: s.id, classArmId: s.moveTo!, sessionId, startedOn: first.startsOn, ...by })));

      await closeOpenTerm(tx, school.id, auth.user.id, open);
      audit({
        action: "promotion.completed",
        entity: "school",
        entityId: school.id,
        changes: { session: session.name, next: name, promoted: movers.length, repeating, graduated: graduates.length, startsOn: first.startsOn, unpublished: waiting.map((w) => w.label) },
        summary: `Completed promotion: ${movers.length} moved up, ${repeating} repeating, ${graduates.length} graduated. ${name} begins ${first.startsOn}`,
      });
      return { promoted: movers.length, repeating, graduated: graduates.length, session: name };
    });
    return c.json(data, 200);
  },
);
