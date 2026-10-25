/**
 * Corrections parents ask for (B4 in the front end's backend-requirements.md; rules from its
 * packages/core/src/corrections.ts, flow from its src/data/fake/corrections.ts).
 *
 *   POST /v1/me/children/{studentId}/corrections   the parent: { changes: [{ field, value }], note }
 *   GET  /v1/corrections                           owner, admin: waiting, then the latest 20 answered
 *   GET  /v1/corrections/count                     owner, admin: { open }
 *   POST /v1/corrections/{id}/resolve              owner, admin: { approve, reason? }
 *
 * A parent asks only about their own children, through their family record: phone and email
 * changes go to that guardian record. Values matching the record are dropped; nothing left is
 * refused. Approving changes the record in one go and writes it to the student's change history.
 */
import { CORRECTABLE, CORRECTION_LABEL_FOR_SCHOOL, fullName, GENDERS, NIGERIAN_STATES, normaliseNigerianPhone, type CorrectableField } from "@brillianda/core";
import { alias, and, asc, correctionRequests, desc, eq, guardians, inArray, isNull, ne, parentLinks, studentGuardians, students, users, type CorrectionChange, type SQL, type Tx } from "@brillianda/db";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { AppEnv } from "../context.js";
import { lagosToday } from "../lib/attendance.js";
import { ApiError, problemContent } from "../lib/errors.js";
import { schoolRoute, type Role } from "../school-route.js";
import { armOptions } from "./classes.js";
import { OptionalName, PersonName, realDay } from "./students.js";

export const correctionRoutes = new OpenAPIHono<AppEnv>();

const ADMINS: readonly Role[] = ["owner", "admin"];
const ok = <T extends z.ZodTypeAny>(description: string, schema: T) => ({ description, content: { "application/json": { schema } } });
const errors = {
  401: problemContent("Not signed in to this school"),
  403: problemContent("Not allowed for this role"),
  404: problemContent("No active school here"),
} as const;
const field = (pointer: string, detail: string) => new ApiError("validation_failed", detail, { extensions: { errors: [{ pointer, detail, code: "invalid" }] } });

// Each field's rule: the school's student form, plus the front end's checkCorrection.
const RULES: Record<CorrectableField, z.ZodType<string, unknown>> = {
  firstName: PersonName("first name") as z.ZodType<string, unknown>,
  otherNames: OptionalName as z.ZodType<string, unknown>,
  lastName: PersonName("last name") as z.ZodType<string, unknown>,
  dateOfBirth: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Choose a date")
    .refine(realDay, "Choose a date")
    .refine((d) => d <= lagosToday(), "A birth date can’t be in the future"),
  gender: z.preprocess((v) => (typeof v === "string" ? v.trim().toLowerCase() : v), z.enum(GENDERS, { message: "Choose Male or Female" })),
  stateOfOrigin: z.enum(NIGERIAN_STATES, { message: "Choose a state" }),
  address: z.string().trim().min(5, "Enter the address").max(200, "Use at most 200 characters"),
  guardianPhone: z
    .string()
    .trim()
    .refine((v) => normaliseNigerianPhone(v) !== null, "Enter a Nigerian number, e.g. 0803 000 0001")
    .transform((v) => normaliseNigerianPhone(v)!),
  guardianEmail: z.string().trim().toLowerCase().email("Check this email address"),
};

const correctionRequestSchema = z
  .object({
    changes: z
      .array(z.object({ field: z.enum(CORRECTABLE, { message: "Choose what to correct" }), value: z.string({ message: "Enter the right value" }) }))
      .min(1, "Say what needs correcting")
      .max(CORRECTABLE.length),
    note: z.string().trim().max(300, "Use at most 300 characters").default(""),
  })
  .superRefine((input, ctx) => {
    const seen = new Set<string>();
    input.changes.forEach((change, i) => {
      if (seen.has(change.field)) ctx.addIssue({ code: "custom", path: ["changes", i, "field"], message: "This one is already in the request" });
      seen.add(change.field);
      const checked = RULES[change.field].safeParse(change.value);
      if (!checked.success) ctx.addIssue({ code: "custom", path: ["changes", i, "value"], message: checked.error.issues[0]?.message ?? "Check this" });
    });
  })
  .transform((input) => ({ note: input.note, changes: input.changes.map((c) => ({ field: c.field, value: RULES[c.field].parse(c.value) as string })) }))
  .openapi("CorrectionRequest");

const declineSchema = z.object({
  approve: z.boolean({ message: "Approve or decline" }),
  reason: z.string().trim().max(200, "Use at most 200 characters").nullable().optional(),
});

type Student = typeof students.$inferSelect;
type Guardian = typeof guardians.$inferSelect;

/** What the record says now, for one field. */
function current(s: Student, g: Guardian | null, f: CorrectableField): string {
  if (f === "guardianPhone") return g?.phone ?? "";
  if (f === "guardianEmail") return g?.email ?? "";
  return String(s[f] ?? "");
}

/** The parent's own children here, each with the family record they're linked through. */
export async function childrenOfParent(tx: Tx, userId: string): Promise<Map<string, { student: Student; guardian: Guardian }>> {
  const rows = await tx
    .select({ student: students, guardian: guardians })
    .from(parentLinks)
    .innerJoin(guardians, and(eq(guardians.schoolId, parentLinks.schoolId), eq(guardians.id, parentLinks.guardianId)))
    .innerJoin(studentGuardians, and(eq(studentGuardians.schoolId, parentLinks.schoolId), eq(studentGuardians.guardianId, parentLinks.guardianId)))
    .innerJoin(students, and(eq(students.schoolId, studentGuardians.schoolId), eq(students.id, studentGuardians.studentId)))
    .where(and(eq(parentLinks.userId, userId), isNull(students.deletedAt)))
    .orderBy(asc(parentLinks.createdAt));
  const out = new Map<string, { student: Student; guardian: Guardian }>();
  for (const r of rows) if (!out.has(r.student.id)) out.set(r.student.id, r);
  return out;
}

export const ChildDetailsSchema = z
  .object({
    firstName: z.string(),
    otherNames: z.string(),
    lastName: z.string(),
    dateOfBirth: z.string().openapi({ description: "ISO day, or \"\" when unknown" }),
    gender: z.enum(GENDERS),
    admissionDate: z.string(),
    stateOfOrigin: z.string(),
    address: z.string(),
    guardian: z.object({ name: z.string(), phone: z.string().nullable(), email: z.string().nullable() }).nullable().openapi({ description: "The parent's own family record" }),
  })
  .openapi("ChildDetails");

export function detailsOf(s: Student, g: Guardian | null): z.infer<typeof ChildDetailsSchema> {
  return {
    firstName: s.firstName,
    otherNames: s.otherNames,
    lastName: s.lastName,
    dateOfBirth: s.dateOfBirth ?? "",
    gender: s.gender,
    admissionDate: s.admissionDate,
    stateOfOrigin: s.stateOfOrigin,
    address: s.address,
    guardian: g ? { name: g.fullName, phone: g.phone, email: g.email } : null,
  };
}

export const CorrectionRowSchema = z
  .object({
    id: z.string().uuid(),
    at: z.number().int(),
    studentId: z.string().uuid(),
    studentName: z.string(),
    armLabel: z.string(),
    by: z.string(),
    changes: z.array(z.object({ field: z.enum(CORRECTABLE), from: z.string(), to: z.string() })),
    note: z.string(),
    status: z.enum(["open", "approved", "declined"]),
    decided: z.object({ by: z.string(), at: z.number().int(), reason: z.string().nullable() }).nullable(),
  })
  .openapi("CorrectionRow");
type CorrectionRow = z.infer<typeof CorrectionRowSchema>;

const decider = alias(users, "decider");

/** Requests as rows, newest first. */
export async function correctionRows(tx: Tx, where: SQL, limit?: number): Promise<CorrectionRow[]> {
  const q = tx
    .select({ c: correctionRequests, student: students, by: users.fullName, guardianName: guardians.fullName, decidedBy: decider.fullName })
    .from(correctionRequests)
    .innerJoin(students, and(eq(students.schoolId, correctionRequests.schoolId), eq(students.id, correctionRequests.studentId)))
    .innerJoin(guardians, and(eq(guardians.schoolId, correctionRequests.schoolId), eq(guardians.id, correctionRequests.guardianId)))
    .leftJoin(users, eq(users.id, correctionRequests.requestedBy))
    .leftJoin(decider, eq(decider.id, correctionRequests.decidedBy))
    .where(where)
    .orderBy(desc(correctionRequests.createdAt), desc(correctionRequests.id));
  const rows = limit ? await q.limit(limit) : await q;
  const labels = new Map((await armOptions(tx, { all: true })).map((a) => [a.id, a.label]));
  return rows.map((r) => ({
    id: r.c.id,
    at: r.c.createdAt.getTime(),
    studentId: r.student.id,
    studentName: fullName(r.student),
    armLabel: labels.get(r.student.classArmId) ?? "",
    by: r.by ?? r.guardianName,
    changes: r.c.changes as CorrectionRow["changes"],
    note: r.c.note,
    status: r.c.status,
    decided: r.c.decidedAt ? { by: r.decidedBy ?? "A former staff member", at: r.c.decidedAt.getTime(), reason: r.c.declineReason } : null,
  }));
}

/** A child's latest five requests, for the parent's home. */
export async function correctionsForChildren(tx: Tx, studentIds: string[]): Promise<Map<string, CorrectionRow[]>> {
  const out = new Map<string, CorrectionRow[]>();
  if (!studentIds.length) return out;
  for (const row of await correctionRows(tx, inArray(correctionRequests.studentId, studentIds))) {
    const mine = out.get(row.studentId) ?? [];
    if (mine.length < 5) out.set(row.studentId, [...mine, row]);
  }
  return out;
}

correctionRoutes.openapi(
  createRoute({
    method: "post",
    path: "/v1/me/children/{studentId}/corrections",
    tags: ["corrections"],
    summary: "A parent asks the school to correct their child's details (or their own phone or email)",
    request: {
      params: z.object({ studentId: z.string().uuid("Invalid id") }),
      body: { content: { "application/json": { schema: correctionRequestSchema } }, required: true },
    },
    responses: {
      201: ok("Asked", z.object({ id: z.string().uuid() })),
      422: problemContent("A value needs fixing (#/changes/1/value), or nothing would change (#/changes)"),
      ...errors,
      404: problemContent("Not one of this parent's children"),
    },
  }),
  async (c) => {
    const { studentId } = c.req.valid("param");
    const input = c.req.valid("json");
    const data = await schoolRoute(c, { roles: ["parent"] }, async ({ tx, school, auth, audit }) => {
      const mine = (await childrenOfParent(tx, auth.user.id)).get(studentId);
      if (!mine) throw new ApiError("not_found", "You can ask about your own children only.");
      // Only what would actually change.
      const changes: CorrectionChange[] = input.changes.map((ch) => ({ field: ch.field, from: current(mine.student, mine.guardian, ch.field), to: ch.value })).filter((ch) => ch.from !== ch.to);
      if (!changes.length) throw field("#/changes", "That’s what the record already says.");
      const [row] = await tx
        .insert(correctionRequests)
        .values({ schoolId: school.id, studentId, guardianId: mine.guardian.id, requestedBy: auth.user.id, changes, note: input.note, createdBy: auth.user.id, updatedBy: auth.user.id })
        .returning({ id: correctionRequests.id });
      audit({
        action: "correction.requested",
        entity: "student",
        entityId: studentId,
        changes: { fields: changes.map((ch) => ch.field) },
        summary: `Asked to correct ${fullName(mine.student)}’s ${changes.map((ch) => CORRECTION_LABEL_FOR_SCHOOL[ch.field as CorrectableField].toLowerCase()).join(", ")}`,
      });
      return { id: row!.id };
    });
    return c.json(data, 201);
  },
);

const CorrectionsPageSchema = z.object({ open: z.array(CorrectionRowSchema).openapi({ description: "Waiting, newest first" }), answered: z.array(CorrectionRowSchema).openapi({ description: "The latest 20 answered" }) }).openapi("CorrectionsPage");

correctionRoutes.openapi(
  createRoute({ method: "get", path: "/v1/corrections", tags: ["corrections"], summary: "Correction requests: those waiting, then the latest 20 answered", responses: { 200: ok("Requests", CorrectionsPageSchema), ...errors } }),
  async (c) => {
    const data = await schoolRoute(c, { roles: ADMINS }, async ({ tx }) => ({
      open: await correctionRows(tx, eq(correctionRequests.status, "open")),
      answered: await correctionRows(tx, ne(correctionRequests.status, "open"), 20),
    }));
    return c.json(data, 200);
  },
);

correctionRoutes.openapi(
  createRoute({ method: "get", path: "/v1/corrections/count", tags: ["corrections"], summary: "How many correction requests are waiting (the More tab's count)", responses: { 200: ok("Count", z.object({ open: z.number().int() })), ...errors } }),
  async (c) => {
    const data = await schoolRoute(c, { roles: ADMINS }, async ({ tx }) => {
      const rows = await tx.select({ id: correctionRequests.id }).from(correctionRequests).where(eq(correctionRequests.status, "open"));
      return { open: rows.length };
    });
    return c.json(data, 200);
  },
);

correctionRoutes.openapi(
  createRoute({
    method: "post",
    path: "/v1/corrections/{id}/resolve",
    tags: ["corrections"],
    summary: "Approve (the record changes, in the student's change history) or decline with a reason the parent sees",
    request: { params: z.object({ id: z.string().uuid("Invalid id") }), body: { content: { "application/json": { schema: declineSchema.openapi("ResolveCorrection") } }, required: true } },
    responses: { 204: { description: "Answered" }, 409: problemContent("Already answered, or the student has left"), 422: problemContent("A reason is needed to decline (#/reason)"), ...errors, 404: problemContent("No such request") },
  }),
  async (c) => {
    const { id } = c.req.valid("param");
    const input = c.req.valid("json");
    const reason = input.reason?.trim() ?? "";
    if (!input.approve && reason.length < 3) throw field("#/reason", "Say why, briefly");
    await schoolRoute(c, { roles: ADMINS }, async ({ tx, auth, audit }) => {
      const [req] = await tx.select().from(correctionRequests).where(eq(correctionRequests.id, id)).limit(1).for("update");
      if (!req) throw new ApiError("not_found", "There’s no such request.");
      if (req.status !== "open") throw new ApiError("conflict", "This request has already been answered.");
      const [s] = await tx.select().from(students).where(and(eq(students.id, req.studentId), isNull(students.deletedAt))).limit(1);
      if (!s) throw new ApiError("conflict", "That student isn’t here any more.");
      const [g] = await tx.select().from(guardians).where(eq(guardians.id, req.guardianId)).limit(1);
      const [asker] = req.requestedBy ? await tx.select({ name: users.fullName }).from(users).where(eq(users.id, req.requestedBy)) : [];
      const by = asker?.name ?? g?.fullName ?? "a parent";
      const changes = req.changes as { field: CorrectableField; from: string; to: string }[];
      const now = new Date();

      if (input.approve) {
        const studentSet: Partial<typeof students.$inferInsert> = {};
        const guardianSet: Partial<typeof guardians.$inferInsert> = {};
        for (const ch of changes) {
          if (ch.field === "guardianPhone") guardianSet.phone = ch.to;
          else if (ch.field === "guardianEmail") guardianSet.email = ch.to || null;
          else if (ch.field === "dateOfBirth") studentSet.dateOfBirth = ch.to || null;
          else if (ch.field === "gender") studentSet.gender = ch.to as Student["gender"];
          else studentSet[ch.field] = ch.to;
        }
        if (Object.keys(studentSet).length) await tx.update(students).set({ ...studentSet, updatedBy: auth.user.id, updatedAt: now }).where(eq(students.id, s.id));
        if (Object.keys(guardianSet).length) {
          if (!g) throw new ApiError("conflict", `${fullName(s)} has no guardian on record. Add one from Edit first.`);
          await tx.update(guardians).set({ ...guardianSet, updatedBy: auth.user.id, updatedAt: now }).where(eq(guardians.id, g.id));
        }
      }
      await tx
        .update(correctionRequests)
        .set({ status: input.approve ? "approved" : "declined", decidedBy: auth.user.id, decidedAt: now, declineReason: input.approve ? null : reason, updatedBy: auth.user.id, updatedAt: now })
        .where(eq(correctionRequests.id, id));
      const name = fullName(input.approve ? { ...s, ...Object.fromEntries(changes.filter((ch) => ch.field.endsWith("Name") || ch.field === "otherNames").map((ch) => [ch.field, ch.to])) } : s);
      audit({
        action: input.approve ? "correction.approved" : "correction.declined",
        entity: "student",
        entityId: s.id,
        changes: input.approve ? { changes } : { reason },
        summary: input.approve
          ? `Corrected ${name}’s ${changes.map((ch) => CORRECTION_LABEL_FOR_SCHOOL[ch.field].toLowerCase()).join(", ")}, as ${by} asked`
          : `Declined ${by}’s correction to ${name}’s details`,
      });
    });
    return c.body(null, 204);
  },
);
