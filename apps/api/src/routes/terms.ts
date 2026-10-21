/**
 * Running the school year: closing a term (C5 in the front end's backend-requirements.md; rules
 * follow its src/data/fake/schoolyear.ts). Owners and admins.
 *
 *   GET  /v1/terms/status   the open term, the term after it, the next one when none is open,
 *                           unpublished classes, closed terms
 *   POST /v1/terms/close    { closeUnpublished, nextStartsOn?, nextEndsOn? }
 *
 * Closing locks the term's scores (results move to the next term; nothing is deleted), keeps its
 * results and publishing, and declines its open unlock requests. The session's last term isn't
 * closed here: completing promotion closes it (C6, which reuses closeOpenTerm).
 */
import {
  academicSessions,
  and,
  asc,
  desc,
  eq,
  isNull,
  publishedResults,
  students,
  termClosures,
  terms,
  unlockRequests,
  users,
  type Tx,
} from "@brillianda/db";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { AppEnv } from "../context.js";
import { ApiError, problemContent } from "../lib/errors.js";
import { schoolRoute, type Role } from "../school-route.js";
import { currentSession } from "./calendar.js";
import { armOptions } from "./classes.js";
import { nextTermOf, resultsTermOf, subjectsForArm, type ResultsTerm } from "./results.js";

export const termRoutes = new OpenAPIHono<AppEnv>();

const ADMINS: readonly Role[] = ["owner", "admin"];
const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Pick a day");
const ok = <T extends z.ZodTypeAny>(description: string, schema: T) => ({ description, content: { "application/json": { schema } } });
const errors = {
  401: problemContent("Not signed in to this school"),
  403: problemContent("Only owners and admins"),
  404: problemContent("No active school here"),
} as const;
const field = (pointer: string, detail: string) => new ApiError("validation_failed", detail, { extensions: { errors: [{ pointer, detail, code: "invalid" }] } });

/** Classes with active students and subjects whose results aren't published for a term. */
export async function unpublishedClasses(tx: Tx, termKey: string): Promise<{ armId: string; label: string }[]> {
  const arms = await armOptions(tx);
  const withStudents = new Set((await tx.selectDistinct({ armId: students.classArmId }).from(students).where(and(eq(students.status, "active"), isNull(students.deletedAt)))).map((r) => r.armId));
  const published = new Set((await tx.select({ armId: publishedResults.classArmId }).from(publishedResults).where(eq(publishedResults.termKey, termKey))).map((r) => r.armId));
  const out = [];
  for (const a of arms) {
    if (!withStudents.has(a.id) || published.has(a.id)) continue;
    if ((await subjectsForArm(tx, a.id)).length) out.push({ armId: a.id, label: a.label });
  }
  return out;
}

/** Records the open term as closed and declines its open unlock requests. Used by closing and by promotion. */
export async function closeOpenTerm(tx: Tx, schoolId: string, userId: string, term: ResultsTerm): Promise<void> {
  await tx.insert(termClosures).values({ schoolId, termKey: term.key, name: term.name, sessionName: term.session, closedBy: userId, createdBy: userId, updatedBy: userId });
  // Requests to unlock a sheet end with its term.
  await tx
    .update(unlockRequests)
    .set({ status: "declined", resolvedBy: userId, resolvedAt: new Date(), updatedBy: userId })
    .where(and(eq(unlockRequests.termKey, term.key), eq(unlockRequests.status, "open")));
}

const TermStatusSchema = z
  .object({
    open: z.object({ key: z.string(), name: z.string(), session: z.string(), index: z.number().int(), isLast: z.boolean() }).nullable(),
    following: z.object({ name: z.string(), startsOn: z.string(), endsOn: z.string() }).nullable().openapi({ description: "The term after the open one, whose dates can be adjusted when closing" }),
    waiting: z.object({ name: z.string(), startsOn: z.string() }).nullable().openapi({ description: "When no term is open: the next one, opening on its start date" }),
    unpublished: z.array(z.object({ armId: z.string().uuid(), label: z.string() })),
    closed: z.array(z.object({ key: z.string(), name: z.string(), session: z.string(), by: z.string(), at: z.number().int() })),
  })
  .openapi("TermStatusData");

termRoutes.openapi(
  createRoute({ method: "get", path: "/v1/terms/status", tags: ["terms"], summary: "The term open for results, what closing it would leave out, and past terms", responses: { 200: ok("Status", TermStatusSchema), ...errors } }),
  async (c) => {
    const data = await schoolRoute(c, { roles: ADMINS }, async ({ tx }) => {
      const open = await resultsTermOf(tx);
      const { terms: calendar } = await currentSession(tx);
      const following = open ? (calendar[open.index + 1] ?? null) : null;
      const closed = await tx
        .select({ key: termClosures.termKey, name: termClosures.name, session: termClosures.sessionName, by: users.fullName, at: termClosures.createdAt })
        .from(termClosures)
        .leftJoin(users, eq(users.id, termClosures.closedBy))
        .orderBy(desc(termClosures.termKey));
      return {
        open,
        following: following ? { name: following.name, startsOn: following.startsOn, endsOn: following.endsOn } : null,
        waiting: open ? null : await nextTermOf(tx),
        unpublished: open ? await unpublishedClasses(tx, open.key) : [],
        closed: closed.map((t) => ({ key: t.key, name: t.name ?? `Term ${t.key.slice(-1)}`, session: t.session ?? "", by: t.by ?? "A former staff member", at: t.at.getTime() })),
      };
    });
    return c.json(data, 200);
  },
);

termRoutes.openapi(
  createRoute({
    method: "post",
    path: "/v1/terms/close",
    tags: ["terms"],
    summary: "Close the open term (not the session's last: promotion closes that). Refused while classes are unpublished unless closeUnpublished",
    request: {
      body: {
        content: { "application/json": { schema: z.object({ closeUnpublished: z.boolean().default(false), nextStartsOn: Day.optional(), nextEndsOn: Day.optional() }).openapi("CloseTerm") } },
        required: true,
      },
    },
    responses: {
      200: ok("Closed", z.object({ closed: z.string(), next: z.string().nullable() }).openapi("TermClosed")),
      409: problemContent("No term open, the last term, or classes unpublished (detail lists them)"),
      422: problemContent("The next term's dates"),
      ...errors,
    },
  }),
  async (c) => {
    const input = c.req.valid("json");
    const data = await schoolRoute(c, { roles: ADMINS }, async ({ tx, school, auth, audit }) => {
      const term = await resultsTermOf(tx);
      if (!term) throw new ApiError("conflict", "No term is open for results.");
      if (term.isLast) throw new ApiError("conflict", `${term.name} is the last term of the session. It closes when you complete promotion.`);
      const waiting = await unpublishedClasses(tx, term.key);
      if (waiting.length && !input.closeUnpublished) {
        throw new ApiError("conflict", `${waiting.length} ${waiting.length === 1 ? "class isn’t" : "classes aren’t"} published yet: ${waiting.map((w) => w.label).join(", ")}. Publish them, or close anyway.`);
      }

      // Adjust the next term's dates on the way, when the calendar is saved.
      const [session] = await tx.select({ id: academicSessions.id }).from(academicSessions).where(eq(academicSessions.isCurrent, true)).limit(1);
      const saved = session ? await tx.select().from(terms).where(eq(terms.sessionId, session.id)).orderBy(asc(terms.position)) : [];
      const current = saved[term.index];
      const next = saved[term.index + 1];
      if ((input.nextStartsOn || input.nextEndsOn) && next && current) {
        const startsOn = input.nextStartsOn ?? next.startsOn;
        const endsOn = input.nextEndsOn ?? next.endsOn;
        if (endsOn <= startsOn) throw field("#/nextEndsOn", "The next term must end after it starts.");
        if (startsOn <= current.startsOn) throw field("#/nextStartsOn", `The next term must start after ${term.name} did.`);
        const after = saved[term.index + 2];
        if (after && endsOn >= after.startsOn) throw field("#/nextEndsOn", `The next term must end before ${after.name} starts.`);
        await tx.update(terms).set({ startsOn, endsOn, updatedBy: auth.user.id, updatedAt: new Date() }).where(eq(terms.id, next.id));
      }

      await closeOpenTerm(tx, school.id, auth.user.id, term);
      audit({
        action: "term.closed",
        entity: "school",
        entityId: school.id,
        changes: { term: term.key, unpublished: waiting.map((w) => w.label) },
        summary: `Closed ${term.name} ${term.session}${waiting.length ? ` (${waiting.length} unpublished)` : ""}`,
      });
      const { terms: calendar } = await currentSession(tx);
      return { closed: term.name, next: calendar[term.index + 1]?.name ?? null };
    });
    return c.json(data, 200);
  },
);
