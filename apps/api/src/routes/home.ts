/**
 * Home on a school's address (plan: "The setup checklist"). Owners and admins.
 *
 *   GET /v1/setup          the checklist: which steps are done, and whether it is hidden
 *   PUT /v1/setup/hidden   hide or show the checklist on Home
 *   GET /v1/home           counts and the latest changes

 */
import { and, auditLog, count, desc, eq, inArray, invitations, isNotNull, isNull, schoolMembers, schools, sql, students, users } from "@brillianda/db";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { AppEnv } from "../context.js";
import { problemContent } from "../lib/errors.js";
import { schoolRoute } from "../school-route.js";
import { currentSession } from "./calendar.js";
import { classCounts } from "./classes.js";
import { subjectCounts } from "./subjects.js";

export const homeRoutes = new OpenAPIHono<AppEnv>();

const STEPS = ["branding", "calendar", "classes", "arms", "subjects", "students", "admins"] as const;

const SetupProgressSchema = z
  .object({
    items: z.array(z.object({ id: z.enum(STEPS), done: z.boolean() })).openapi({ description: "In the plan's order" }),
    hidden: z.boolean(),
  })
  .openapi("SetupProgress");

const ChangeEntrySchema = z
  .object({
    id: z.string().uuid(),
    at: z.string().openapi({ description: "ISO 8601" }),
    who: z.string().openapi({ description: "The person's name, or \"Someone\" if their account is gone" }),
    what: z.string().openapi({ example: "Set the 2026/2027 calendar" }),
  })
  .openapi("ChangeEntry");

const HomeSummarySchema = z
  .object({
    students: z.number().int(),
    classes: z.number().int().openapi({ description: "Class arms in use, e.g. JSS 1 Gold" }),
    arms: z.number().int().openapi({ description: "Arm names, e.g. Gold" }),
    subjects: z.number().int(),
    admins: z.number().int().openapi({ description: "Everyone with access, the owner included" }),
    recent: z.array(ChangeEntrySchema).openapi({ description: "The 6 latest changes, newest first" }),
  })
  .openapi("HomeSummary");

const errors = {
  401: problemContent("Not signed in to this school"),
  403: problemContent("Not allowed"),
  404: problemContent("No active school here"),
} as const;

homeRoutes.openapi(
  createRoute({
    method: "get",
    path: "/v1/setup",
    tags: ["home"],
    summary: "The setup checklist: which steps are done, and whether it is hidden",
    responses: { 200: { description: "Progress", content: { "application/json": { schema: SetupProgressSchema } } }, ...errors },
  }),
  async (c) => {
    const data = await schoolRoute(c, {}, async ({ tx, school }) => {
      const [row] = await tx
        .select({ settings: schools.settings, brandColor: schools.brandColor, logoKey: schools.logoKey })
        .from(schools)
        .where(eq(schools.id, school.id));
      const session = await currentSession(tx);
      const [members] = await tx.select({ n: count() }).from(schoolMembers).where(and(eq(schoolMembers.status, "active"), inArray(schoolMembers.role, ["owner", "admin"])));
      const [invited] = await tx.select({ n: count() }).from(invitations).where(eq(invitations.role, "admin"));
      const classes = await classCounts(tx);
      const subjects = await subjectCounts(tx);
      const [enrolled] = await tx.select({ n: count() }).from(students).where(isNull(students.deletedAt));
      const done: Record<(typeof STEPS)[number], boolean> = {
        branding: row?.settings?.brandingSaved === true || row?.brandColor != null || row?.logoKey != null,
        calendar: session.confirmed,
        classes: classes.levels > 0,
        arms: classes.classes > 0,
        subjects: subjects.links > 0,
        students: (enrolled?.n ?? 0) > 0,
        admins: (members?.n ?? 0) > 1 || (invited?.n ?? 0) > 0,
      };
      return { items: STEPS.map((id) => ({ id, done: done[id] })), hidden: row?.settings?.setupChecklistHidden === true };
    });
    return c.json(data, 200);
  },
);

homeRoutes.openapi(
  createRoute({
    method: "put",
    path: "/v1/setup/hidden",
    tags: ["home"],
    summary: "Hide or show the setup checklist on Home",
    request: { body: { content: { "application/json": { schema: z.object({ hidden: z.boolean() }).openapi("ChecklistHidden") } }, required: true } },
    responses: { 204: { description: "Saved" }, ...errors },
  }),
  async (c) => {
    const { hidden } = c.req.valid("json");
    await schoolRoute(c, {}, async ({ tx, school }) => {
      await tx
        .update(schools)
        .set({ settings: sql`${schools.settings} || jsonb_build_object('setupChecklistHidden', ${hidden}::boolean)` })
        .where(eq(schools.id, school.id));
    });
    return c.body(null, 204);
  },
);

homeRoutes.openapi(
  createRoute({
    method: "get",
    path: "/v1/home",
    tags: ["home"],
    summary: "Counts for Home and the 6 latest changes",
    responses: { 200: { description: "Summary", content: { "application/json": { schema: HomeSummarySchema } } }, ...errors },
  }),
  async (c) => {
    const data = await schoolRoute(c, {}, async ({ tx }) => {
      const [members] = await tx.select({ n: count() }).from(schoolMembers).where(and(eq(schoolMembers.status, "active"), inArray(schoolMembers.role, ["owner", "admin"])));
      const classes = await classCounts(tx);
      const subjects = await subjectCounts(tx);
      const [active] = await tx.select({ n: count() }).from(students).where(and(isNull(students.deletedAt), eq(students.status, "active")));
      const recent = await tx
        .select({ id: auditLog.id, at: auditLog.createdAt, who: users.fullName, what: auditLog.summary })
        .from(auditLog)
        .leftJoin(users, eq(users.id, auditLog.actorUserId))
        .where(isNotNull(auditLog.summary))
        .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
        .limit(6);
      return {
        students: active?.n ?? 0,
        classes: classes.classes,
        arms: classes.armNames,
        subjects: subjects.subjects,
        admins: members?.n ?? 0,
        recent: recent.map((r) => ({ id: r.id, at: r.at.toISOString(), who: r.who ?? "Someone", what: r.what! })),
      };
    });
    return c.json(data, 200);
  },
);
