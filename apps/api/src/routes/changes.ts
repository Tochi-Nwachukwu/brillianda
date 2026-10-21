/**
 * The school's change history (plan: "Audit log of changes"), on its own address. Owners and admins.
 * Filtering happens here, on the server, as a record of years must. Follows the frontend's
 * listChanges (src/data/fake/changes.ts) and its CSV export route.
 *
 *   GET /v1/changes          ?who=&search=&from=&to=&studentId=&limit=   newest first
 *   GET /v1/changes/export   the same filters as CSV (up to 1,000 lines, formula-safe cells)
 *
 * Only entries with a summary are changes people made to the school's records; sign-ins and other
 * security events stay in the audit log but are never listed here.
 */
import { fullName, searchKey, toCsv } from "@brillianda/core";
import { and, auditLog, count, desc, eq, isNotNull, sql, students, users, type Tx } from "@brillianda/db";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { AppEnv } from "../context.js";
import { problemContent } from "../lib/errors.js";
import { schoolRoute } from "../school-route.js";

export const changeRoutes = new OpenAPIHono<AppEnv>();

const Day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD")
  .refine((v) => {
    const d = new Date(`${v}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
  }, "Use a real date");
const FilterSchema = z.object({
  who: z.string().max(120).optional().openapi({ description: "A person's name, as listed in `people`" }),
  search: z.string().max(200).optional().openapi({ description: "Every word must appear in who, what or the student's name; accents ignored" }),
  from: Day.optional().openapi({ description: "First day, Lagos time, included" }),
  to: Day.optional().openapi({ description: "Last day, Lagos time, included" }),
  studentId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional().openapi({ description: "Default 50, at most 1,000" }),
});
type Filter = z.infer<typeof FilterSchema>;

const StudentRef = z.object({ id: z.string().uuid(), name: z.string() }).nullable();
const ChangeLogSchema = z
  .object({
    entries: z.array(z.object({ id: z.string().uuid(), at: z.string(), who: z.string(), what: z.string(), student: StudentRef })),
    total: z.number().int().openapi({ description: "How many match, before the limit" }),
    people: z.array(z.string()).openapi({ description: "Everyone who appears in the history, for the filter" }),
    student: StudentRef.openapi({ description: "The filtered student, when studentId is given" }),
  })
  .openapi("ChangeLog");

const errors = {
  401: problemContent("Not signed in to this school"),
  403: problemContent("Not allowed"),
  404: problemContent("No active school here"),
} as const;

const who = sql<string>`coalesce(${users.fullName}, ${auditLog.actorName}, 'Someone')`;
const lagosDay = sql`(${auditLog.createdAt} at time zone 'Africa/Lagos')::date`;
const studentName = sql<string>`coalesce(${students.firstName} || ' ' || nullif(${students.otherNames}, '') || ' ' || ${students.lastName}, ${students.firstName} || ' ' || ${students.lastName}, '')`;
const escapeLike = (word: string) => word.replace(/[\\%_]/g, (m) => `\\${m}`);

async function changeLog(tx: Tx, f: Filter) {
  const conditions = [isNotNull(auditLog.summary)];
  if (f.who) conditions.push(sql`${who} = ${f.who}`);
  if (f.studentId) conditions.push(and(eq(auditLog.entity, "student"), eq(auditLog.entityId, f.studentId))!);
  if (f.from) conditions.push(sql`${lagosDay} >= ${f.from}::date`);
  if (f.to) conditions.push(sql`${lagosDay} <= ${f.to}::date`);
  for (const word of searchKey(f.search ?? "").split(" ").filter(Boolean)) {
    const haystack = sql`lower(app_unaccent(${who} || ' ' || ${auditLog.summary} || ' ' || ${studentName}))`;
    conditions.push(sql`${haystack} like ${`%${escapeLike(word)}%`}`);
  }
  const where = and(...conditions);
  const base = () =>
    tx
      .select({ id: auditLog.id, at: auditLog.createdAt, who, what: auditLog.summary, studentId: students.id, student: students })
      .from(auditLog)
      .leftJoin(users, eq(users.id, auditLog.actorUserId))
      .leftJoin(students, and(eq(auditLog.entity, "student"), eq(students.schoolId, auditLog.schoolId), eq(students.id, auditLog.entityId)));

  const rows = await base().where(where).orderBy(desc(auditLog.createdAt), desc(auditLog.id)).limit(f.limit ?? 50);
  const [total] = await tx
    .select({ n: count() })
    .from(auditLog)
    .leftJoin(users, eq(users.id, auditLog.actorUserId))
    .leftJoin(students, and(eq(auditLog.entity, "student"), eq(students.schoolId, auditLog.schoolId), eq(students.id, auditLog.entityId)))
    .where(where);
  const people = await tx
    .selectDistinct({ who })
    .from(auditLog)
    .leftJoin(users, eq(users.id, auditLog.actorUserId))
    .where(isNotNull(auditLog.summary));
  let student: { id: string; name: string } | null = null;
  if (f.studentId) {
    const [s] = await tx.select().from(students).where(eq(students.id, f.studentId)).limit(1);
    student = s ? { id: s.id, name: fullName(s) } : null;
  }
  return {
    entries: rows.map((r) => ({
      id: r.id,
      at: r.at.toISOString(),
      who: r.who,
      what: r.what!,
      student: r.student ? { id: r.student.id, name: fullName(r.student) } : null,
    })),
    total: total?.n ?? 0,
    people: people.map((p) => p.who).sort((a, b) => a.localeCompare(b)),
    student,
  };
}

changeRoutes.openapi(
  createRoute({
    method: "get",
    path: "/v1/changes",
    tags: ["changes"],
    summary: "The change history, filtered on the server, newest first",
    request: { query: FilterSchema },
    responses: { 200: { description: "Changes", content: { "application/json": { schema: ChangeLogSchema } } }, ...errors },
  }),
  async (c) => {
    const filter = c.req.valid("query");
    const data = await schoolRoute(c, {}, ({ tx }) => changeLog(tx, filter));
    return c.json(data, 200);
  },
);

const whenLagos = new Intl.DateTimeFormat("en-GB", { timeZone: "Africa/Lagos", dateStyle: "short", timeStyle: "short" });

changeRoutes.openapi(
  createRoute({
    method: "get",
    path: "/v1/changes/export",
    tags: ["changes"],
    summary: "The change history as CSV, same filters (up to 1,000 lines). Cells are escaped so a spreadsheet never runs one as a formula",
    request: { query: FilterSchema.omit({ limit: true }) },
    responses: { 200: { description: "CSV file", content: { "text/csv": { schema: z.string() } } }, ...errors },
  }),
  async (c) => {
    const filter = c.req.valid("query");
    const { log, subdomain } = await schoolRoute(c, {}, async ({ tx, school }) => ({ log: await changeLog(tx, { ...filter, limit: 1000 }), subdomain: school.subdomain }));
    const csv = toCsv(
      ["When (Lagos time)", "Who", "What", "Student"],
      log.entries.map((e) => [whenLagos.format(new Date(e.at)), e.who, e.what, e.student?.name ?? ""]),
    );
    const day = new Date(Date.now() + 3_600_000).toISOString().slice(0, 10);
    return c.body(csv, 200, {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${subdomain}-changes-${day}.csv"`,
      "cache-control": "no-store",
    });
  },
);
