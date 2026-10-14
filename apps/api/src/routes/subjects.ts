/**
 * Subjects (plan: "Subjects"), on the school's own address. Owners and admins. Shapes and rules
 * follow the frontend's batch 7 (src/data/fake/subjects.ts, packages/core/src/subjects.ts).
 *
 *   GET    /v1/subjects                              subjects, links, levels, the catalogue, bands
 *   POST   /v1/subjects                              add from the catalogue (linked to default levels) and/or own ones
 *   PATCH  /v1/subjects/{id}                         rename (stays linked to its catalogue entry)
 *   DELETE /v1/subjects/{id}                         remove, with its links
 *   PUT    /v1/subjects/{id}/levels/{levelId}        { kind: compulsory | elective | null }
 *   PUT    /v1/subjects/{id}/department              { department } for its senior electives
 */
import { bandOf, CATALOGUE, defaultLinks, type Band } from "@brillianda/core";
import { and, asc, classLevels, classLevelSubjects, eq, inArray, isNull, ne, schoolSubjects, sql, type Tx } from "@brillianda/db";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { AppEnv } from "../context.js";
import { ApiError, problemContent } from "../lib/errors.js";
import { schoolRoute } from "../school-route.js";

export const subjectRoutes = new OpenAPIHono<AppEnv>();

const DEPARTMENTS = ["science", "arts", "commercial"] as const;
const DEPARTMENT_LABEL = { science: "Science", arts: "Arts", commercial: "Commercial" } as const;
const BANDS = ["lowerPrimary", "upperPrimary", "junior", "senior"] as const;
const CATALOGUE_BY_ID = new Map(CATALOGUE.map((e) => [e.id, e]));

const SubjectName = z.string().trim().min(1, "Give the subject a name").max(60, "Use at most 60 characters");
const SubjectCode = z
  .string()
  .trim()
  .min(1, "Give it a code")
  .max(5, "Use at most 5 characters")
  .regex(/^[A-Za-z0-9]+$/, "Letters and numbers only")
  .transform((c) => c.toUpperCase());
const Id = z.string().uuid("Invalid id");

const AddSubjectsSchema = z
  .object({
    catalogueIds: z.array(z.string().max(64)).max(100),
    custom: z.array(z.object({ name: SubjectName, code: SubjectCode })).max(50),
  })
  .superRefine((input, ctx) => {
    if (!input.catalogueIds.length && !input.custom.length) ctx.addIssue({ code: "custom", path: ["catalogueIds"], message: "Pick at least one subject" });
    input.catalogueIds.forEach((id, i) => {
      if (!CATALOGUE_BY_ID.has(id)) ctx.addIssue({ code: "custom", path: ["catalogueIds", i], message: "Not in the catalogue" });
    });
    const codes = input.custom.map((c) => c.code);
    codes.forEach((c, i) => {
      if (codes.indexOf(c) !== i) ctx.addIssue({ code: "custom", path: ["custom", i, "code"], message: "Two subjects can’t share a code" });
    });
  })
  .openapi("AddSubjects");

const SubjectSchema = z
  .object({
    id: z.string().uuid(),
    catalogueId: z.string().nullable(),
    name: z.string(),
    code: z.string(),
    tag: z.enum(["nerdc2025", "legacy", "custom"]),
    catalogueName: z.string().nullable().openapi({ description: "The catalogue's name when the school renamed it, else null" }),
  })
  .openapi("Subject");
const SubjectLinkSchema = z
  .object({ subjectId: z.string().uuid(), levelId: z.string().uuid(), kind: z.enum(["compulsory", "elective"]), department: z.enum(DEPARTMENTS).nullable() })
  .openapi("SubjectLink");
const CatalogueEntrySchema = z
  .object({
    id: z.string(),
    name: z.string(),
    code: z.string(),
    tag: z.enum(["nerdc2025", "legacy"]),
    offers: z.array(z.object({ band: z.enum(BANDS), role: z.enum(["core", "choice", "optional", "science", "humanities", "business"]) })),
    set: z.string().optional(),
  })
  .openapi("CatalogueEntry");
const SubjectsSetupSchema = z
  .object({
    subjects: z.array(SubjectSchema),
    links: z.array(SubjectLinkSchema),
    levels: z.array(
      z.object({
        id: z.string().uuid(),
        key: z.string().nullable(),
        name: z.string(),
        short: z.string(),
        section: z.enum(["preschool", "primary", "junior", "senior"]),
        position: z.number().int(),
        archived: z.boolean(),
      }),
    ),
    catalogue: z.array(CatalogueEntrySchema),
    bands: z.array(z.enum(BANDS)).openapi({ description: "The NERDC bands the school's classes fall in" }),
  })
  .openapi("SubjectsSetup");

const errors = {
  401: problemContent("Not signed in to this school"),
  403: problemContent("Not allowed"),
  404: problemContent("No such subject or class here"),
} as const;
const json = <T extends z.ZodTypeAny>(schema: T) => ({ content: { "application/json": { schema } }, required: true });
const fieldError = (pointer: string, detail: string, message: string) =>
  new ApiError("validation_failed", message, { extensions: { errors: [{ pointer, detail, code: "taken" }] } });

async function liveLevels(tx: Tx) {
  return tx.select().from(classLevels).where(isNull(classLevels.archivedAt)).orderBy(asc(classLevels.position));
}

async function subjectOr404(tx: Tx, id: string) {
  const [subject] = await tx.select().from(schoolSubjects).where(eq(schoolSubjects.id, id)).limit(1);
  if (!subject) throw new ApiError("not_found", "That subject isn’t here any more.");
  return subject;
}

/** For Home and the checklist. */
export async function subjectCounts(tx: Tx): Promise<{ subjects: number; links: number }> {
  const [s] = await tx.select({ n: sql<number>`count(*)::int` }).from(schoolSubjects);
  const [l] = await tx.select({ n: sql<number>`count(*)::int` }).from(classLevelSubjects);
  return { subjects: s?.n ?? 0, links: l?.n ?? 0 };
}

subjectRoutes.openapi(
  createRoute({
    method: "get",
    path: "/v1/subjects",
    tags: ["subjects"],
    summary: "The school's subjects, which classes take them, its levels, the catalogue and the bands it runs",
    responses: { 200: { description: "Subjects", content: { "application/json": { schema: SubjectsSetupSchema } } }, ...errors },
  }),
  async (c) => {
    const data = await schoolRoute(c, {}, async ({ tx }) => {
      const levels = await liveLevels(tx);
      const subjects = await tx.select().from(schoolSubjects).orderBy(asc(schoolSubjects.position), asc(schoolSubjects.createdAt));
      const links = await tx.select().from(classLevelSubjects);
      const bands = [...new Set(levels.map((l) => bandOf(l.key, l.section)).filter((b): b is Band => !!b))];
      return {
        subjects: subjects.map((s) => {
          const entry = s.catalogueId ? CATALOGUE_BY_ID.get(s.catalogueId) : undefined;
          return { id: s.id, catalogueId: s.catalogueId, name: s.name, code: s.code, tag: entry?.tag ?? ("custom" as const), catalogueName: entry && entry.name !== s.name ? entry.name : null };
        }),
        links: links.map((l) => ({ subjectId: l.schoolSubjectId, levelId: l.classLevelId, kind: l.kind, department: l.department })),
        levels: levels.map((l) => ({ id: l.id, key: l.key, name: l.name, short: l.shortName, section: l.section, position: l.position, archived: false })),
        catalogue: CATALOGUE,
        bands,
      };
    });
    return c.json(data, 200);
  },
);

subjectRoutes.openapi(
  createRoute({
    method: "post",
    path: "/v1/subjects",
    tags: ["subjects"],
    summary: "Add subjects: catalogue ones (attached to their default classes) and the school's own (attached nowhere)",
    request: { body: json(AddSubjectsSchema) },
    responses: {
      201: { description: "Added", content: { "application/json": { schema: z.object({ added: z.number().int() }) } } },
      409: problemContent("A code or name is already used by one of the school's subjects"),
      422: problemContent("A field needs fixing"),
      ...errors,
    },
  }),
  async (c) => {
    const input = c.req.valid("json");
    const added = await schoolRoute(c, {}, async ({ tx, school, auth, audit }) => {
      const mine = await tx.select().from(schoolSubjects);
      const have = new Set(mine.map((s) => s.catalogueId).filter(Boolean));
      const entries = [...new Set(input.catalogueIds)].filter((id) => !have.has(id)).map((id) => CATALOGUE_BY_ID.get(id)!);
      const codes = new Set(mine.map((s) => s.code));
      const clash = [...entries.map((e) => e.code), ...input.custom.map((x) => x.code)].find((code) => codes.has(code));
      if (clash) throw new ApiError("conflict", `Another of your subjects already uses the code ${clash}. Rename it first.`);
      for (const e of entries) {
        if (mine.some((s) => s.name.toLowerCase() === e.name.toLowerCase())) throw new ApiError("conflict", `You already have a subject called ${e.name}. Rename it first.`);
      }
      for (const x of input.custom) {
        if (mine.some((s) => s.name.toLowerCase() === x.name.toLowerCase()) || entries.some((e) => e.name.toLowerCase() === x.name.toLowerCase())) {
          throw new ApiError("conflict", `You already have ${x.name}.`);
        }
      }
      const total = entries.length + input.custom.length;
      if (!total) return 0;

      const by = { createdBy: auth.user.id, updatedBy: auth.user.id };
      let position = mine.length;
      const rows = await tx
        .insert(schoolSubjects)
        .values([
          ...entries.map((e) => ({ schoolId: school.id, catalogueId: e.id, name: e.name, code: e.code, position: position++, ...by })),
          ...input.custom.map((x) => ({ schoolId: school.id, catalogueId: null, name: x.name, code: x.code, position: position++, ...by })),
        ])
        .returning({ id: schoolSubjects.id, catalogueId: schoolSubjects.catalogueId });
      const idOf = new Map(rows.filter((r) => r.catalogueId).map((r) => [r.catalogueId!, r.id]));
      const links = defaultLinks(entries, await liveLevels(tx));
      if (links.length) {
        await tx.insert(classLevelSubjects).values(
          links.map((l) => ({ schoolId: school.id, classLevelId: l.levelId, schoolSubjectId: idOf.get(l.entryId)!, kind: l.kind, department: l.department, ...by })),
        );
      }
      audit({
        action: "subjects.added",
        entity: "school",
        entityId: school.id,
        changes: { catalogue: entries.map((e) => e.id), custom: input.custom.map((x) => x.name) },
        summary: `Added ${total} ${total === 1 ? "subject" : "subjects"}`,
      });
      return total;
    });
    return c.json({ added }, 201);
  },
);

subjectRoutes.openapi(
  createRoute({
    method: "patch",
    path: "/v1/subjects/{id}",
    tags: ["subjects"],
    summary: "Rename a subject and its code. A catalogue subject stays linked to its entry",
    request: { params: z.object({ id: Id }), body: json(z.object({ name: SubjectName, code: SubjectCode }).openapi("SubjectChange")) },
    responses: { 204: { description: "Saved" }, 422: problemContent("Another subject has this name or code"), ...errors },
  }),
  async (c) => {
    const { id } = c.req.valid("param");
    const input = c.req.valid("json");
    await schoolRoute(c, {}, async ({ tx, auth, audit }) => {
      const subject = await subjectOr404(tx, id);
      const others = await tx.select({ name: schoolSubjects.name, code: schoolSubjects.code }).from(schoolSubjects).where(ne(schoolSubjects.id, id));
      if (others.some((s) => s.name.toLowerCase() === input.name.toLowerCase())) throw fieldError("#/name", "Another subject has this name", "Two subjects can’t share a name.");
      if (others.some((s) => s.code === input.code)) throw fieldError("#/code", "Another subject uses this code", "Two subjects can’t share a code.");
      await tx.update(schoolSubjects).set({ name: input.name, code: input.code, updatedBy: auth.user.id }).where(eq(schoolSubjects.id, id));
      if (subject.name !== input.name) {
        audit({ action: "subject.renamed", entity: "subject", entityId: id, changes: { from: subject.name, to: input.name, code: input.code }, summary: `Renamed ${subject.name} to ${input.name}` });
      } else if (subject.code !== input.code) {
        audit({ action: "subject.renamed", entity: "subject", entityId: id, changes: { code: input.code } });
      }
    });
    return c.body(null, 204);
  },
);

subjectRoutes.openapi(
  createRoute({
    method: "delete",
    path: "/v1/subjects/{id}",
    tags: ["subjects"],
    summary: "Remove a subject and its links to classes",
    request: { params: z.object({ id: Id }) },
    responses: { 204: { description: "Removed" }, ...errors },
  }),
  async (c) => {
    const { id } = c.req.valid("param");
    await schoolRoute(c, {}, async ({ tx, audit }) => {
      const subject = await subjectOr404(tx, id);
      await tx.delete(classLevelSubjects).where(eq(classLevelSubjects.schoolSubjectId, id));
      await tx.delete(schoolSubjects).where(eq(schoolSubjects.id, id));
      audit({ action: "subject.removed", entity: "subject", entityId: id, changes: { name: subject.name }, summary: `Removed ${subject.name}` });
    });
    return c.body(null, 204);
  },
);

subjectRoutes.openapi(
  createRoute({
    method: "put",
    path: "/v1/subjects/{id}/levels/{levelId}",
    tags: ["subjects"],
    summary: "Attach a subject to a class as compulsory or elective, or detach it (kind null)",
    request: {
      params: z.object({ id: Id, levelId: Id }),
      body: json(z.object({ kind: z.enum(["compulsory", "elective"]).nullable() }).openapi("SubjectLinkChange")),
    },
    responses: { 204: { description: "Saved" }, ...errors },
  }),
  async (c) => {
    const { id, levelId } = c.req.valid("param");
    const { kind } = c.req.valid("json");
    await schoolRoute(c, {}, async ({ tx, school, auth, audit }) => {
      const subject = await subjectOr404(tx, id);
      const [level] = await tx.select().from(classLevels).where(eq(classLevels.id, levelId)).limit(1);
      if (!level) throw new ApiError("not_found", "That subject or class isn’t here any more.");
      const where = and(eq(classLevelSubjects.schoolSubjectId, id), eq(classLevelSubjects.classLevelId, levelId));
      const [existing] = await tx.select().from(classLevelSubjects).where(where).limit(1);
      if (!kind) {
        if (existing) await tx.delete(classLevelSubjects).where(where);
      } else if (existing) {
        await tx
          .update(classLevelSubjects)
          .set({ kind, department: kind === "compulsory" ? null : existing.department, updatedBy: auth.user.id })
          .where(where);
      } else {
        const entry = subject.catalogueId ? CATALOGUE_BY_ID.get(subject.catalogueId) : undefined;
        const fromCatalogue = entry ? defaultLinks([entry], [level])[0] : undefined;
        await tx.insert(classLevelSubjects).values({
          schoolId: school.id,
          classLevelId: levelId,
          schoolSubjectId: id,
          kind,
          department: kind === "elective" ? (fromCatalogue?.department ?? null) : null,
          createdBy: auth.user.id,
          updatedBy: auth.user.id,
        });
      }
      // Recorded for the audit trail, not shown on Home (the grid saves one tick at a time).
      audit({ action: "subject.link_set", entity: "subject", entityId: id, changes: { level: level.name, kind } });
    });
    return c.body(null, 204);
  },
);

subjectRoutes.openapi(
  createRoute({
    method: "put",
    path: "/v1/subjects/{id}/department",
    tags: ["subjects"],
    summary: "The department a subject's senior electives belong to (null for none)",
    request: { params: z.object({ id: Id }), body: json(z.object({ department: z.enum(DEPARTMENTS).nullable() }).openapi("SubjectDepartment")) },
    responses: { 204: { description: "Saved" }, ...errors },
  }),
  async (c) => {
    const { id } = c.req.valid("param");
    const { department } = c.req.valid("json");
    await schoolRoute(c, {}, async ({ tx, auth, audit }) => {
      const subject = await subjectOr404(tx, id);
      const senior = await tx.select({ id: classLevels.id }).from(classLevels).where(eq(classLevels.section, "senior"));
      if (senior.length) {
        await tx
          .update(classLevelSubjects)
          .set({ department, updatedBy: auth.user.id })
          .where(
            and(
              eq(classLevelSubjects.schoolSubjectId, id),
              eq(classLevelSubjects.kind, "elective"),
              inArray(classLevelSubjects.classLevelId, senior.map((l) => l.id)),
            ),
          );
      }
      audit({
        action: "subject.department_set",
        entity: "subject",
        entityId: id,
        changes: { department },
        summary: `Put ${subject.name} in ${department ? DEPARTMENT_LABEL[department] : "no department"}`,
      });
    });
    return c.body(null, 204);
  },
);
