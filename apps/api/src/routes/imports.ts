/**
 * Importing a student list (plan: "How an import runs"), on the school's own address. Owners and
 * admins. The browser reads the file (Excel, CSV, Word) and maps the columns; the API only gets
 * rows, and checks every one again with the same rules (packages/core/src/studentImport.ts, copied
 * from the frontend). Follows the frontend's batch 9 (src/data/fake/imports.ts).
 *
 *   GET  /v1/imports/setup        classes and arms to match, existing students, saved mapping, last 5 imports
 *   POST /v1/imports/check        the server's check of every row (up to 5,000)
 *   PUT  /v1/imports/mapping      remember the column mapping for next time
 *   POST /v1/imports              write the ready rows under one batch; update or skip duplicates
 *   POST /v1/imports/{id}/undo    remove a batch's new students, within 24 hours, if none of their records was changed since
 */
import {
  checkRows,
  formatAdmissionNo,
  fullName,
  IMPORT_CHUNK,
  IMPORT_COLUMNS,
  MAX_IMPORT_ROWS,
  UNDO_HOURS,
  type CheckedRow,
  type ImportContext,
  type RawRow,
} from "@brillianda/core";
import {
  and,
  arms,
  asc,
  auditLog,
  classArms,
  classLevels,
  desc,
  enrolments,
  eq,
  gt,
  guardians,
  importBatches,
  inArray,
  isNull,
  schools,
  sql,
  studentGuardians,
  students,
  users,
  type Tx,
} from "@brillianda/db";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { AppEnv } from "../context.js";
import { ApiError, problemContent } from "../lib/errors.js";
import type { ResolvedSchool } from "../lib/school-directory.js";
import { schoolRoute } from "../school-route.js";
import { currentSession } from "./calendar.js";
import { admissionFormat, lagosToday } from "./students.js";

export const importRoutes = new OpenAPIHono<AppEnv>();

const COLUMN_IDS = IMPORT_COLUMNS.map((c) => c.id) as [string, ...string[]];
const Cell = z.string().max(500);

/** The student form's length limits, which the shared row check doesn't apply. */
const LIMITS: Record<string, number> = { firstName: 60, lastName: 60, otherNames: 60, admissionNo: 30, guardianName: 120, address: 200 };
function withLimits(rows: CheckedRow[]): CheckedRow[] {
  for (const row of rows) {
    if (!row.student) continue;
    for (const [field, max] of Object.entries(LIMITS)) {
      const value = (row.student as Record<string, string>)[field] ?? "";
      if (value.length > max) {
        row.problems.push({ column: field as CheckedRow["problems"][number]["column"], message: `Use at most ${max} characters`, blocking: true });
        row.status = "fix";
      }
    }
    if (row.status === "fix") row.student = undefined;
  }
  return rows;
}
const RawRowSchema = z.partialRecord(z.enum(COLUMN_IDS), Cell).openapi("ImportRawRow", { description: "Cells by column id (firstName, lastName, gender, className, …), as mapped in the browser" });
const Rows = z.array(RawRowSchema).max(MAX_IMPORT_ROWS, `At most ${MAX_IMPORT_ROWS} rows at a time`);
const ArmId = z.string().uuid().nullable().openapi({ description: "Importing from a class page: every row goes to this class" });

const ProblemSchema = z.object({ column: z.string(), message: z.string(), suggestion: z.string().optional(), blocking: z.boolean() });
const CheckedRowSchema = z
  .object({
    index: z.number().int(),
    status: z.enum(["ready", "fix", "duplicate"]),
    problems: z.array(ProblemSchema),
    existingId: z.string().optional(),
    student: z.record(z.string(), z.string()).optional(),
  })
  .openapi("CheckedRow");
const BatchSummarySchema = z
  .object({
    id: z.string().uuid(),
    at: z.string(),
    by: z.string(),
    fileName: z.string(),
    created: z.number().int(),
    updated: z.number().int(),
    undoable: z.boolean(),
    undone: z.boolean(),
  })
  .openapi("ImportBatchSummary");

const errors = {
  401: problemContent("Not signed in to this school"),
  403: problemContent("Not allowed"),
  404: problemContent("No such import here"),
} as const;
const json = <T extends z.ZodTypeAny>(schema: T) => ({ content: { "application/json": { schema } }, required: true });
const ok = <T extends z.ZodTypeAny>(description: string, schema: T) => ({ description, content: { "application/json": { schema } } });

// ── Context ─────────────────────────────────────────────────────────────────────────────────────

async function importContext(tx: Tx, armId: string | null): Promise<ImportContext> {
  const levels = await tx.select().from(classLevels).where(isNull(classLevels.archivedAt)).orderBy(asc(classLevels.position));
  const rows = await tx
    .select({ id: classArms.id, levelId: classArms.classLevelId, name: arms.name, code: arms.code })
    .from(classArms)
    .innerJoin(arms, and(eq(arms.schoolId, classArms.schoolId), eq(arms.id, classArms.armId)))
    .where(isNull(classArms.archivedAt))
    .orderBy(asc(arms.position));
  const live = new Set(levels.map((l) => l.id));
  const existing = await tx
    .select({ id: students.id, admissionNo: students.admissionNumber, firstName: students.firstName, otherNames: students.otherNames, lastName: students.lastName, dateOfBirth: students.dateOfBirth })
    .from(students)
    .where(isNull(students.deletedAt));
  const armsInUse = rows.filter((a) => live.has(a.levelId));
  if (armId && !armsInUse.some((a) => a.id === armId)) throw new ApiError("conflict", "That class isn’t open any more.");
  return {
    levels: levels.map((l) => ({ id: l.id, name: l.name, short: l.shortName, aliases: l.aliases })),
    arms: armsInUse,
    existing: existing.map((s) => ({ id: s.id, admissionNo: s.admissionNo, fullName: fullName(s), dateOfBirth: s.dateOfBirth ?? "" })),
    armId,
  };
}

const UNDO_MS = UNDO_HOURS * 3_600_000;

async function batchSummaries(tx: Tx, limit = 5) {
  const batches = await tx
    .select({ batch: importBatches, by: users.fullName })
    .from(importBatches)
    .leftJoin(users, eq(users.id, importBatches.createdBy))
    .orderBy(desc(importBatches.createdAt))
    .limit(limit);
  const out = [];
  for (const { batch, by } of batches) {
    const edited = await editedSince(tx, batch.id, batch.createdAt);
    out.push({
      id: batch.id,
      at: batch.createdAt.toISOString(),
      by: by ?? "Someone",
      fileName: batch.fileName,
      created: batch.createdCount,
      updated: batch.updatedCount,
      undone: batch.undoneAt !== null,
      undoable: batch.undoneAt === null && Date.now() < batch.createdAt.getTime() + UNDO_MS && !edited && batch.createdCount > 0,
    });
  }
  return out;
}

/** Has anyone changed one of this batch's new students since it was written? */
async function editedSince(tx: Tx, batchId: string, at: Date): Promise<boolean> {
  const [hit] = await tx
    .select({ id: students.id })
    .from(students)
    .where(and(eq(students.importBatchId, batchId), gt(students.updatedAt, new Date(at.getTime() + 1000))))
    .limit(1);
  return !!hit;
}

// ── Routes ──────────────────────────────────────────────────────────────────────────────────────

importRoutes.openapi(
  createRoute({
    method: "get",
    path: "/v1/imports/setup",
    tags: ["imports"],
    summary: "What the import page needs: classes and arms to match, existing students, the saved mapping and the last 5 imports",
    responses: {
      200: ok(
        "Setup",
        z
          .object({
            schoolName: z.string(),
            levels: z.array(z.object({ id: z.string().uuid(), name: z.string(), short: z.string(), aliases: z.array(z.string()) })),
            arms: z.array(z.object({ id: z.string().uuid(), levelId: z.string().uuid(), name: z.string(), code: z.string() })),
            existing: z.array(z.object({ id: z.string().uuid(), admissionNo: z.string(), fullName: z.string(), dateOfBirth: z.string() })),
            savedMapping: z.record(z.string(), z.string()),
            batches: z.array(BatchSummarySchema),
          })
          .openapi("ImportSetup"),
      ),
      ...errors,
    },
  }),
  async (c) => {
    const data = await schoolRoute(c, {}, async ({ tx, school }) => {
      const ctx = await importContext(tx, null);
      const [row] = await tx.select({ settings: schools.settings }).from(schools).where(eq(schools.id, school.id));
      return {
        schoolName: school.name,
        levels: ctx.levels.map((l) => ({ ...l, aliases: l.aliases ?? [] })),
        arms: ctx.arms,
        existing: ctx.existing,
        savedMapping: (row?.settings?.importMapping as Record<string, string> | undefined) ?? {},
        batches: await batchSummaries(tx),
      };
    });
    return c.json(data, 200);
  },
);

importRoutes.openapi(
  createRoute({
    method: "post",
    path: "/v1/imports/check",
    tags: ["imports"],
    summary: "Check every row with the same rules as the browser (never trusting the browser's own check)",
    request: { body: json(z.object({ rows: Rows, armId: ArmId.default(null) }).openapi("ImportCheck")) },
    responses: { 200: ok("Each row: ready, fix or duplicate, with problems", z.object({ rows: z.array(CheckedRowSchema) })), 409: problemContent("That class isn't open"), ...errors },
  }),
  async (c) => {
    const { rows, armId } = c.req.valid("json");
    const checked = await schoolRoute(c, {}, async ({ tx }) => withLimits(checkRows(rows as RawRow[], await importContext(tx, armId))));
    return c.json({ rows: checked as z.infer<typeof CheckedRowSchema>[] }, 200);
  },
);

importRoutes.openapi(
  createRoute({
    method: "put",
    path: "/v1/imports/mapping",
    tags: ["imports"],
    summary: "Remember which column each heading (lower case) was, to offer it first next time",
    request: { body: json(z.object({ mapping: z.record(z.string().max(120), z.enum(COLUMN_IDS)).refine((m) => Object.keys(m).length <= 100, "Too many headings") }).openapi("ImportMapping")) },
    responses: { 204: { description: "Saved" }, ...errors },
  }),
  async (c) => {
    const { mapping } = c.req.valid("json");
    await schoolRoute(c, {}, async ({ tx, school }) => {
      await tx
        .update(schools)
        .set({ settings: sql`${schools.settings} || jsonb_build_object('importMapping', ${JSON.stringify(mapping)}::jsonb)` })
        .where(eq(schools.id, school.id));
    });
    return c.body(null, 204);
  },
);

type Ready = CheckedRow & { student: NonNullable<CheckedRow["student"]> };

/** Takes `n` admission numbers at once from the school's counter, skipping any already used. */
async function takeAdmissionNumbers(tx: Tx, school: ResolvedSchool, n: number, used: Set<string>): Promise<string[]> {
  if (!n) return [];
  const format = await admissionFormat(tx, school);
  const year = (await currentSession(tx)).startYear;
  const out: string[] = [];
  while (out.length < n) {
    const want = n - out.length;
    const result = await tx.execute<{ first: number }>(sql`
      insert into counters (id, school_id, name, next_value) values (gen_random_uuid(), ${school.id}, 'admission', ${want + 1})
      on conflict (school_id, name) do update set next_value = counters.next_value + ${want}, updated_at = now()
      returning next_value - ${want} as first`);
    const first = Number(result.rows[0]!.first);
    for (let i = 0; i < want; i++) {
      const candidate = formatAdmissionNo(format, year, first + i);
      if (!used.has(candidate.toLowerCase())) {
        used.add(candidate.toLowerCase());
        out.push(candidate);
      }
    }
  }
  return out;
}

importRoutes.openapi(
  createRoute({
    method: "post",
    path: "/v1/imports",
    tags: ["imports"],
    summary: "Write the ready rows (checked again here) under one batch, in chunks of 500. Duplicates listed in `update` are updated, the rest skipped",
    request: {
      body: json(
        z
          .object({
            rows: Rows,
            armId: ArmId.default(null),
            update: z.array(z.number().int().min(0)).max(MAX_IMPORT_ROWS).default([]).openapi({ description: "Indexes of duplicate rows to update instead of skip" }),
            fileName: z.string().trim().min(1).max(200),
          })
          .openapi("ImportCommit"),
      ),
    },
    responses: {
      201: ok(
        "Imported",
        z
          .object({
            batchId: z.string().uuid(),
            created: z.number().int(),
            updated: z.number().int(),
            skipped: z.number().int(),
            notImported: z.number().int().openapi({ description: "Rows that still need fixing" }),
            newStudents: z.array(z.object({ id: z.string().uuid(), fullName: z.string(), armLabel: z.string() })),
          })
          .openapi("ImportResult"),
      ),
      409: problemContent("That class isn't open"),
      ...errors,
    },
  }),
  async (c) => {
    const { rows, armId, update, fileName } = c.req.valid("json");
    const result = await schoolRoute(c, {}, async ({ tx, school, auth, audit }) => {
      const checked = withLimits(checkRows(rows as RawRow[], await importContext(tx, armId)));
      const by = { createdBy: auth.user.id, updatedBy: auth.user.id };
      const today = lagosToday();
      const ready = checked.filter((r): r is Ready => !!r.student && (r.status === "ready" || r.status === "duplicate"));
      const toCreate = ready.filter((r) => r.status === "ready");
      const toUpdate = ready.filter((r) => r.status === "duplicate" && update.includes(r.index));
      const skipped = ready.length - toCreate.length - toUpdate.length;

      const [batch] = await tx.insert(importBatches).values({ schoolId: school.id, fileName, rowCount: rows.length, ...by }).returning({ id: importBatches.id, createdAt: importBatches.createdAt });

      // Guardians: siblings share one, matched by phone, in the file and on record.
      const phones = [...new Set(ready.map((r) => r.student.guardianPhone).filter(Boolean))];
      const byPhone = new Map<string, string>();
      for (let i = 0; i < phones.length; i += IMPORT_CHUNK) {
        const found = await tx.select({ id: guardians.id, phone: guardians.phone }).from(guardians).where(inArray(guardians.phone, phones.slice(i, i + IMPORT_CHUNK))).orderBy(asc(guardians.createdAt));
        for (const g of found) if (g.phone && !byPhone.has(g.phone)) byPhone.set(g.phone, g.id);
      }
      const newGuardians = new Map<string, { fullName: string; phone: string | null; email: string | null }>();
      const guardianKey = (r: Ready) => {
        const s = r.student;
        if (s.guardianPhone && byPhone.has(s.guardianPhone)) return `id:${byPhone.get(s.guardianPhone)}`;
        if (!s.guardianName) return null;
        // Without a phone there is nothing to match siblings on: each row gets its own guardian.
        const key = s.guardianPhone ? `phone:${s.guardianPhone}` : `row:${r.index}`;
        if (!newGuardians.has(key)) newGuardians.set(key, { fullName: s.guardianName, phone: s.guardianPhone || null, email: s.guardianEmail || null });
        return key;
      };
      const keys = new Map(ready.map((r) => [r.index, guardianKey(r)]));
      const guardianIds = new Map<string, string>();
      for (const id of byPhone.values()) guardianIds.set(`id:${id}`, id);
      const pending = [...newGuardians.entries()];
      for (let i = 0; i < pending.length; i += IMPORT_CHUNK) {
        const chunk = pending.slice(i, i + IMPORT_CHUNK);
        const inserted = await tx.insert(guardians).values(chunk.map(([, g]) => ({ schoolId: school.id, ...g, ...by }))).returning({ id: guardians.id });
        chunk.forEach(([key], j) => guardianIds.set(key, inserted[j]!.id));
      }
      const guardianOf = (r: Ready) => {
        const key = keys.get(r.index);
        return key ? (guardianIds.get(key) ?? null) : null;
      };

      // New students, numbered from the school's counter where the file left the number blank.
      const used = new Set((await importContext(tx, armId)).existing.map((e) => e.admissionNo.toLowerCase()));
      for (const r of toCreate) if (r.student.admissionNo) used.add(r.student.admissionNo.toLowerCase());
      const numbers = await takeAdmissionNumbers(tx, school, toCreate.filter((r) => !r.student.admissionNo).length, used);
      const labels = new Map(ready.map((r) => [r.student.armId, r.student.armLabel]));
      const created: { id: string; fullName: string; armLabel: string }[] = [];
      for (let i = 0; i < toCreate.length; i += IMPORT_CHUNK) {
        const chunk = toCreate.slice(i, i + IMPORT_CHUNK);
        const inserted = await tx
          .insert(students)
          .values(
            chunk.map((r) => {
              const s = r.student;
              return {
                schoolId: school.id,
                admissionNumber: s.admissionNo || numbers.shift()!,
                firstName: s.firstName,
                lastName: s.lastName,
                otherNames: s.otherNames,
                gender: s.gender,
                dateOfBirth: s.dateOfBirth || null,
                admissionDate: s.admissionDate || today,
                classArmId: s.armId,
                address: s.address,
                stateOfOrigin: s.stateOfOrigin,
                importBatchId: batch!.id,
                ...by,
              };
            }),
          )
          .returning();
        await tx.insert(enrolments).values(inserted.map((s) => ({ schoolId: school.id, studentId: s.id, classArmId: s.classArmId, startedOn: s.admissionDate, ...by })));
        const links = chunk.flatMap((r, j) => {
          const guardianId = guardianOf(r);
          return guardianId ? [{ schoolId: school.id, studentId: inserted[j]!.id, guardianId, primaryContact: true, ...by }] : [];
        });
        if (links.length) await tx.insert(studentGuardians).values(links);
        for (const s of inserted) created.push({ id: s.id, fullName: fullName(s), armLabel: labels.get(s.classArmId) ?? "" });
      }

      // Duplicates the admin chose to update: details from the file, keeping what it leaves blank.
      const changes: (typeof auditLog.$inferInsert)[] = [];
      for (const r of toUpdate) {
        const s = r.student;
        const [existing] = await tx.select().from(students).where(and(eq(students.id, r.existingId!), isNull(students.deletedAt))).limit(1);
        if (!existing) continue;
        await tx
          .update(students)
          .set({
            firstName: s.firstName,
            lastName: s.lastName,
            otherNames: s.otherNames,
            gender: s.gender,
            dateOfBirth: s.dateOfBirth || existing.dateOfBirth,
            address: s.address || existing.address,
            stateOfOrigin: s.stateOfOrigin || existing.stateOfOrigin,
            classArmId: s.armId,
            updatedBy: auth.user.id,
          })
          .where(eq(students.id, existing.id));
        const guardianId = guardianOf(r);
        if (guardianId) {
          await tx.delete(studentGuardians).where(eq(studentGuardians.studentId, existing.id));
          await tx.insert(studentGuardians).values({ schoolId: school.id, studentId: existing.id, guardianId, primaryContact: true, ...by });
        }
        if (existing.classArmId !== s.armId) {
          await tx.update(enrolments).set({ endedOn: today, updatedBy: auth.user.id }).where(and(eq(enrolments.studentId, existing.id), isNull(enrolments.endedOn)));
          await tx.insert(enrolments).values({ schoolId: school.id, studentId: existing.id, classArmId: s.armId, startedOn: today, ...by });
        }
        changes.push({
          schoolId: school.id,
          actorUserId: auth.user.id,
          action: "student.updated",
          entity: "student",
          entityId: existing.id,
          changes: { importBatchId: batch!.id },
          summary: `Updated ${fullName(s)} from an import`,
          ip: c.get("clientIp"),
          userAgent: c.get("userAgent"),
        });
      }
      for (let i = 0; i < changes.length; i += IMPORT_CHUNK) await tx.insert(auditLog).values(changes.slice(i, i + IMPORT_CHUNK));

      const updated = changes.length;
      await tx.update(importBatches).set({ createdCount: created.length, updatedCount: updated, skippedCount: skipped }).where(eq(importBatches.id, batch!.id));
      audit({
        action: "students.imported",
        entity: "import_batch",
        entityId: batch!.id,
        changes: { fileName, created: created.length, updated, skipped },
        summary: `Imported ${created.length} ${created.length === 1 ? "student" : "students"} from ${fileName}${updated ? `, updated ${updated}` : ""}`,
      });
      return {
        batchId: batch!.id,
        created: created.length,
        updated,
        skipped,
        notImported: checked.filter((r) => r.status === "fix").length,
        newStudents: created,
      };
    });
    return c.json(result, 201);
  },
);

importRoutes.openapi(
  createRoute({
    method: "post",
    path: "/v1/imports/{id}/undo",
    tags: ["imports"],
    summary: `Remove a batch's new students (soft delete), within ${UNDO_HOURS} hours, if nobody has edited them since`,
    request: { params: z.object({ id: z.string().uuid() }) },
    responses: { 200: ok("Undone", z.object({ removed: z.number().int() })), 409: problemContent("Already undone, too old, or edited since"), ...errors },
  }),
  async (c) => {
    const { id } = c.req.valid("param");
    const removed = await schoolRoute(c, {}, async ({ tx, auth, audit }) => {
      const [batch] = await tx.select().from(importBatches).where(eq(importBatches.id, id)).for("update").limit(1);
      if (!batch) throw new ApiError("not_found", "That import isn’t here.");
      if (batch.undoneAt) throw new ApiError("conflict", "That import was already undone.");
      if (Date.now() >= batch.createdAt.getTime() + UNDO_MS) throw new ApiError("conflict", `Imports can be undone for ${UNDO_HOURS} hours. This one is older.`);
      if (await editedSince(tx, batch.id, batch.createdAt)) {
        throw new ApiError("conflict", "Someone has edited students from this import since, so it can’t be undone as a whole. Delete or change them one by one.");
      }
      const gone = await tx
        .update(students)
        .set({ deletedAt: new Date() })
        .where(and(eq(students.importBatchId, batch.id), isNull(students.deletedAt)))
        .returning({ id: students.id });
      await tx.update(importBatches).set({ status: "undone", undoneAt: new Date(), updatedBy: auth.user.id }).where(eq(importBatches.id, batch.id));
      audit({
        action: "import.undone",
        entity: "import_batch",
        entityId: batch.id,
        changes: { removed: gone.length },
        summary: `Undid the import of ${batch.createdCount} students from ${batch.fileName}`,
      });
      return gone.length;
    });
    return c.json({ removed }, 200);
  },
);
