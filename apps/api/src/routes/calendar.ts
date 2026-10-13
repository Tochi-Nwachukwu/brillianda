/**
 * The school's calendar (plan: "Academic calendar"), on its own address. Owners and admins.
 *
 *   GET /v1/session    the current session and its terms; suggested dates if never saved
 *   PUT /v1/session    save it: start year and 2 or 3 terms. Marks the checklist's calendar step done
 *
 * Signup creates the first session with suggested dates (confirmed: false). The same rules as the
 * frontend's sessionSchema apply here (packages/core sessionProblems), so the error a person sees
 * is the same whichever side catches it.
 */
import { defaultSessionStart, defaultTerms, sessionName, sessionProblems } from "@brillianda/core";
import { academicSessions, and, asc, eq, gt, terms, type Tx } from "@brillianda/db";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { AppEnv } from "../context.js";
import { ApiError, problemContent } from "../lib/errors.js";
import { schoolRoute } from "../school-route.js";

export const calendarRoutes = new OpenAPIHono<AppEnv>();

const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Choose a date").openapi({ example: "2026-09-14" });

const TermSchema = z
  .object({
    name: z.string().trim().min(1, "Give the term a name").max(40, "Use at most 40 characters"),
    startsOn: Day,
    endsOn: Day,
  })
  .openapi("Term");

const SessionSetupSchema = z
  .object({
    startYear: z.number().int().openapi({ example: 2026 }),
    name: z.string().openapi({ example: "2026/2027" }),
    terms: z.array(TermSchema),
    confirmed: z.boolean().openapi({ description: "false until someone saves the calendar; the dates are only suggestions until then" }),
  })
  .openapi("SessionSetup");

const SaveSessionSchema = z
  .object({
    startYear: z.number().int().min(2000, "Choose a year").max(2100, "Choose a year"),
    terms: z.array(TermSchema).min(2, "A session has two or three terms").max(3, "A session has two or three terms"),
  })
  .superRefine((input, ctx) => {
    for (const p of sessionProblems(input.startYear, input.terms)) ctx.addIssue({ code: "custom", path: p.path, message: p.message });
  })
  .openapi("SaveSession");

const errors = {
  401: problemContent("Not signed in to this school"),
  403: problemContent("Not allowed"),
  404: problemContent("No active school here"),
} as const;

type SessionSetup = z.infer<typeof SessionSetupSchema>;

/** The current session as the frontend's SessionSetup, or suggested dates when there is none. */
export async function currentSession(tx: Tx): Promise<SessionSetup> {
  const [session] = await tx.select().from(academicSessions).where(eq(academicSessions.isCurrent, true)).limit(1);
  if (!session) {
    const { year } = defaultSessionStart(new Date());
    return { startYear: year, name: sessionName(year), terms: defaultTerms(year), confirmed: false };
  }
  const rows = await tx
    .select({ name: terms.name, startsOn: terms.startsOn, endsOn: terms.endsOn })
    .from(terms)
    .where(eq(terms.sessionId, session.id))
    .orderBy(asc(terms.position));
  return { startYear: session.startYear, name: session.name, terms: rows, confirmed: session.confirmedAt !== null };
}

calendarRoutes.openapi(
  createRoute({
    method: "get",
    path: "/v1/session",
    tags: ["calendar"],
    summary: "The current session and its terms (suggested dates until saved)",
    responses: { 200: { description: "Session", content: { "application/json": { schema: SessionSetupSchema } } }, ...errors },
  }),
  async (c) => {
    const data = await schoolRoute(c, {}, ({ tx }) => currentSession(tx));
    return c.json(data, 200);
  },
);

calendarRoutes.openapi(
  createRoute({
    method: "put",
    path: "/v1/session",
    tags: ["calendar"],
    summary: "Save the current session: its start year and 2 or 3 terms. Confirms the calendar",
    request: { body: { content: { "application/json": { schema: SaveSessionSchema } }, required: true } },
    responses: {
      200: { description: "Saved", content: { "application/json": { schema: SessionSetupSchema } } },
      409: problemContent("Another session already uses that year"),
      422: problemContent("A field needs fixing; errors[] points at it, e.g. #/terms/1/startsOn"),
      ...errors,
    },
  }),
  async (c) => {
    const input = c.req.valid("json");
    const data = await schoolRoute(c, {}, async ({ tx, auth, audit }) => {
      const name = sessionName(input.startYear);
      const startsOn = input.terms[0]!.startsOn;
      const endsOn = input.terms[input.terms.length - 1]!.endsOn;
      const now = new Date();

      const [existing] = await tx.select().from(academicSessions).where(eq(academicSessions.isCurrent, true)).limit(1);
      const [clash] = await tx
        .select({ id: academicSessions.id })
        .from(academicSessions)
        .where(eq(academicSessions.startYear, input.startYear))
        .limit(1);
      if (clash && clash.id !== existing?.id) throw new ApiError("conflict", `There is already a ${name} session.`);

      let sessionId: string;
      if (existing) {
        await tx
          .update(academicSessions)
          .set({ startYear: input.startYear, name, startsOn, endsOn, confirmedAt: now, updatedBy: auth.user.id })
          .where(eq(academicSessions.id, existing.id));
        sessionId = existing.id;
      } else {
        const [created] = await tx
          .insert(academicSessions)
          .values({ schoolId: auth.session.schoolId, startYear: input.startYear, name, startsOn, endsOn, isCurrent: true, confirmedAt: now, createdBy: auth.user.id, updatedBy: auth.user.id })
          .returning({ id: academicSessions.id });
        sessionId = created!.id;
      }

      // Terms by position: update the ones that stay, add a third, or drop one going from three to two.
      const current = await tx.select({ id: terms.id, position: terms.position }).from(terms).where(eq(terms.sessionId, sessionId));
      await tx.delete(terms).where(and(eq(terms.sessionId, sessionId), gt(terms.position, input.terms.length)));
      for (const [i, term] of input.terms.entries()) {
        const position = i + 1;
        const row = current.find((t) => t.position === position);
        if (row) {
          await tx.update(terms).set({ name: term.name, startsOn: term.startsOn, endsOn: term.endsOn, updatedBy: auth.user.id }).where(eq(terms.id, row.id));
        } else {
          await tx.insert(terms).values({ schoolId: auth.session.schoolId, sessionId, name: term.name, position, startsOn: term.startsOn, endsOn: term.endsOn, createdBy: auth.user.id, updatedBy: auth.user.id });
        }
      }

      audit({
        action: "session.saved",
        entity: "academic_session",
        entityId: sessionId,
        changes: { startYear: input.startYear, terms: input.terms },
        summary: `${existing?.confirmedAt ? "Changed" : "Set"} the ${name} calendar`,
      });
      return { startYear: input.startYear, name, terms: input.terms, confirmed: true };
    });
    return c.json(data, 200);
  },
);
