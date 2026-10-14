/**
 * Classes and arms (plan: "The class ladder", "Arms", "Editing after setup"), on the school's own
 * address. Owners and admins. Shapes and rules follow the frontend's data layer
 * (src/data/fake/classes.ts and packages/core/src/classes.ts in BrilliandaWeb), so a screen built
 * on the fake works unchanged against this.
 *
 *   GET    /v1/classes                      levels, arm names, arms (level × arm name), levels offered
 *   POST   /v1/classes/setup                quick setup, only while the school has no classes
 *   POST   /v1/class-levels                 add a class after setup (goes at the end of its section)
 *   PATCH  /v1/class-levels/{id}            rename and/or archive / bring back
 *   DELETE /v1/class-levels/{id}            remove (refused while any of its arms has students)
 *   POST   /v1/class-levels/{id}/arms       add an arm to one class: an existing arm name, or a new one
 *   PATCH  /v1/arm-names/{id}               rename an arm name: renames it in every class
 *   PATCH  /v1/arms/{id}                    department (senior classes) and/or archive
 *   DELETE /v1/arms/{id}                    remove one class's arm (not with students, not its last)
 *   PUT    /v1/arms/layout                  every arm at once (Classes › Edit arms), all or nothing
 *
 * Naming: the plan's tables are class_levels, arms (the names) and class_arms (level × arm). The
 * API uses the frontend's words: armNames for the names, arms for level × arm.
 */
import {
  and,
  arms,
  asc,
  classArms,
  classLevels,
  count,
  eq,
  gte,
  inArray,
  isNull,
  lt,
  ne,
  schools,
  enrolments,
  sql,
  students,
  type Tx,
} from "@brillianda/db";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { AppEnv } from "../context.js";
import { ApiError, problemContent } from "../lib/errors.js";
import { schoolRoute } from "../school-route.js";

export const classRoutes = new OpenAPIHono<AppEnv>();

// ── Rules (mirroring the frontend's packages/core/src/classes.ts) ───────────────────────────────

const SECTIONS = ["preschool", "primary", "junior", "senior"] as const;
type Section = (typeof SECTIONS)[number];
const SECTION_LABEL: Record<Section, string> = { preschool: "Pre-school", primary: "Primary", junior: "Junior secondary", senior: "Senior secondary" };
const DEPARTMENTS = ["science", "arts", "commercial"] as const;
const DEPARTMENT_LABEL: Record<(typeof DEPARTMENTS)[number], string> = { science: "Science", arts: "Arts", commercial: "Commercial" };
const MAX_ARMS = 10;

const LevelName = z.string().trim().min(1, "Give the class a name").max(40, "Use at most 40 characters");
const ShortName = z.string().trim().min(1, "Give it a short name").max(8, "Use at most 8 characters");
const ArmNameText = z.string().trim().min(1, "Give the arm a name").max(30, "Use at most 30 characters");
const ArmCode = z.string().trim().min(1, "Give it a code").max(4, "Use at most 4 characters").transform((c) => c.toUpperCase());
const Id = z.string().uuid("Invalid id");

const LevelDraft = z.object({ key: z.string().max(20).nullable(), name: LevelName, short: ShortName, section: z.enum(SECTIONS) });

const ClassSetupSchema = z
  .object({
    levels: z.array(LevelDraft).min(1, "Add at least one class").max(30, "That’s more classes than a school has"),
    arms: z.array(z.object({ name: ArmNameText, code: ArmCode })).min(1, "Every class needs at least one arm").max(MAX_ARMS, `At most ${MAX_ARMS} arms`),
    armsByLevel: z
      .array(z.array(z.number().int().min(0)).min(1, "Every class needs at least one arm"))
      .openapi({ description: "For each level (same order), the arms it has, as indexes into `arms`" }),
  })
  .superRefine((setup, ctx) => {
    if (setup.armsByLevel.length !== setup.levels.length) ctx.addIssue({ code: "custom", path: ["armsByLevel"], message: "Every class needs its arms" });
    repeated(setup.levels.map((l) => l.name.toLowerCase())).forEach((i) => ctx.addIssue({ code: "custom", path: ["levels", i, "name"], message: "Two classes can’t share a name" }));
    repeated(setup.arms.map((a) => a.name.toLowerCase())).forEach((i) => ctx.addIssue({ code: "custom", path: ["arms", i, "name"], message: "Two arms can’t share a name" }));
    repeated(setup.arms.map((a) => a.code)).forEach((i) => ctx.addIssue({ code: "custom", path: ["arms", i, "code"], message: "Two arms can’t share a code" }));
    setup.armsByLevel.forEach((list, i) => {
      if (list.some((index) => index >= setup.arms.length)) ctx.addIssue({ code: "custom", path: ["armsByLevel", i], message: "That arm doesn’t exist" });
      if (new Set(list).size !== list.length) ctx.addIssue({ code: "custom", path: ["armsByLevel", i], message: "An arm is listed twice" });
    });
  })
  .openapi("ClassSetup");

const ArmLayoutSchema = z
  .object({
    names: z
      .array(z.object({ key: z.string().min(1).max(64).openapi({ description: "An arm name's id, or any new key such as \"new-1\"" }), name: ArmNameText, code: ArmCode }))
      .min(1, "Keep at least one arm")
      .max(26, "Use at most 26 arms"),
    levels: z
      .array(z.object({ levelId: Id, arms: z.array(z.string()) }))
      .openapi({ description: "Every class in use (not archived), each with the keys of the arms it should have" }),
  })
  .superRefine((layout, ctx) => {
    repeated(layout.names.map((n) => n.name.toLowerCase())).forEach((i) => ctx.addIssue({ code: "custom", path: ["names", i, "name"], message: "Two arms can’t share a name" }));
    repeated(layout.names.map((n) => n.code)).forEach((i) => ctx.addIssue({ code: "custom", path: ["names", i, "code"], message: "Two arms can’t share a code" }));
    repeated(layout.names.map((n) => n.key)).forEach((i) => ctx.addIssue({ code: "custom", path: ["names", i, "key"], message: "Listed twice" }));
    const keys = new Set(layout.names.map((n) => n.key));
    layout.levels.forEach((level, i) => {
      if (!level.arms.length) ctx.addIssue({ code: "custom", path: ["levels", i, "arms"], message: "Every class needs at least one arm" });
      if (level.arms.some((key) => !keys.has(key))) ctx.addIssue({ code: "custom", path: ["levels", i, "arms"], message: "That arm isn’t in the list" });
    });
  })
  .openapi("ArmLayout");

/** Indexes of entries that repeat an earlier one. */
function repeated(values: string[]): number[] {
  const seen = new Set<string>();
  return values.flatMap((v, i) => {
    const hit = seen.has(v);
    seen.add(v);
    return hit ? [i] : [];
  });
}

const fieldError = (pointer: string, detail: string, message = detail) =>
  new ApiError("validation_failed", message, { extensions: { errors: [{ pointer, detail, code: "taken" }] } });
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// ── Response shapes ─────────────────────────────────────────────────────────────────────────────

const ClassLevelSchema = z
  .object({
    id: z.string().uuid(),
    key: z.string().nullable().openapi({ description: "Ladder place (\"jss1\"), or null for a class the school added" }),
    name: z.string(),
    short: z.string(),
    section: z.enum(SECTIONS),
    position: z.number().int(),
    archived: z.boolean(),
  })
  .openapi("ClassLevel");
const ArmNameSchema = z.object({ id: z.string().uuid(), name: z.string(), code: z.string() }).openapi("ArmName");
const ClassArmSchema = z
  .object({
    id: z.string().uuid(),
    levelId: z.string().uuid(),
    armNameId: z.string().uuid(),
    department: z.enum(DEPARTMENTS).nullable(),
    archived: z.boolean(),
    studentCount: z.number().int(),
  })
  .openapi("ClassArm");
const ClassStructureSchema = z
  .object({
    levels: z.array(ClassLevelSchema).openapi({ description: "Youngest first" }),
    armNames: z.array(ArmNameSchema).openapi({ description: "In the school's order" }),
    arms: z.array(ClassArmSchema),
    levelsOffered: z.array(z.string()).openapi({ description: "From signup, lowercase: nursery, primary, secondary" }),
  })
  .openapi("ClassStructure");

const errors = {
  401: problemContent("Not signed in to this school"),
  403: problemContent("Not allowed"),
  404: problemContent("No such class or arm here"),
} as const;
const json = <T extends z.ZodTypeAny>(schema: T) => ({ content: { "application/json": { schema } }, required: true });
const ok = <T extends z.ZodTypeAny>(description: string, schema: T) => ({ description, content: { "application/json": { schema } } });
const IdParam = z.object({ id: Id });

// ── Reads ───────────────────────────────────────────────────────────────────────────────────────

/** Students (not deleted) in each class arm: removal rules refuse while a class has any. */
export async function studentCounts(tx: Tx, classArmIds: string[]): Promise<Map<string, number>> {
  if (!classArmIds.length) return new Map();
  const rows = await tx
    .select({ classArmId: students.classArmId, n: count() })
    .from(students)
    .where(and(inArray(students.classArmId, classArmIds), isNull(students.deletedAt)))
    .groupBy(students.classArmId);
  return new Map(rows.map((r) => [r.classArmId, r.n]));
}

/**
 * Class arms that have ever held a student: current students (soft-deleted ones too) or a class
 * history entry. Those can't be deleted, only archived, so past records keep their class.
 */
export async function classArmsWithHistory(tx: Tx, classArmIds: string[]): Promise<Set<string>> {
  if (!classArmIds.length) return new Set();
  const now = await tx.selectDistinct({ id: students.classArmId }).from(students).where(inArray(students.classArmId, classArmIds));
  const past = await tx.selectDistinct({ id: enrolments.classArmId }).from(enrolments).where(inArray(enrolments.classArmId, classArmIds));
  return new Set([...now, ...past].map((r) => r.id));
}

/** "JSS 1 Anthurium", or just "JSS 1" when the class has one arm (frontend's armLabel). */
export const armLabel = (levelName: string, armName: string, armsInLevel: number) => (armsInLevel > 1 ? `${levelName} ${armName}` : levelName);
/** The phone chip: "JSS1 ANT", or "JSS1" (frontend's armChip). */
export const armChip = (levelShort: string, code: string, armsInLevel: number) => (armsInLevel > 1 ? `${levelShort} ${code}` : levelShort);

export interface ArmOption {
  id: string;
  label: string;
  chip: string;
  levelId: string;
  levelName: string;
  levelPosition: number;
}

/**
 * Classes a student can sit in (open levels and arms), youngest first, labelled for pickers.
 * With `all`, archived ones too (for labelling a student's past classes).
 */
export async function armOptions(tx: Tx, opts: { all?: boolean } = {}): Promise<ArmOption[]> {
  const rows = await tx
    .select({ arm: classArms, level: classLevels, name: arms })
    .from(classArms)
    .innerJoin(classLevels, and(eq(classLevels.schoolId, classArms.schoolId), eq(classLevels.id, classArms.classLevelId)))
    .innerJoin(arms, and(eq(arms.schoolId, classArms.schoolId), eq(arms.id, classArms.armId)))
    .orderBy(asc(classLevels.position), asc(arms.position));
  const open = rows.filter((r) => opts.all || (r.arm.archivedAt === null && r.level.archivedAt === null));
  const perLevel = new Map<string, number>();
  for (const r of open) perLevel.set(r.level.id, (perLevel.get(r.level.id) ?? 0) + 1);
  return open.map((r) => {
    const n = perLevel.get(r.level.id) ?? 1;
    return {
      id: r.arm.id,
      label: armLabel(r.level.name, r.name.name, n),
      chip: armChip(r.level.shortName, r.name.code, n),
      levelId: r.level.id,
      levelName: r.level.name,
      levelPosition: r.level.position,
    };
  });
}

export async function classStructure(tx: Tx, schoolId: string): Promise<z.infer<typeof ClassStructureSchema>> {
  const [school] = await tx.select({ levelsOffered: schools.levelsOffered }).from(schools).where(eq(schools.id, schoolId));
  const levels = await tx.select().from(classLevels).orderBy(asc(classLevels.position));
  const names = await tx.select().from(arms).orderBy(asc(arms.position), asc(arms.createdAt));
  const rows = await tx.select().from(classArms).orderBy(asc(classArms.createdAt));
  const students = await studentCounts(tx, rows.map((r) => r.id));
  return {
    levels: levels.map((l) => ({ id: l.id, key: l.key, name: l.name, short: l.shortName, section: l.section, position: l.position, archived: l.archivedAt !== null })),
    armNames: names.map((a) => ({ id: a.id, name: a.name, code: a.code })),
    arms: rows.map((r) => ({
      id: r.id,
      levelId: r.classLevelId,
      armNameId: r.armId,
      department: r.department,
      archived: r.archivedAt !== null,
      studentCount: students.get(r.id) ?? 0,
    })),
    levelsOffered: school?.levelsOffered ?? [],
  };
}

/** For Home and the checklist. */
export async function classCounts(tx: Tx): Promise<{ levels: number; classes: number; armNames: number }> {
  const [levels] = await tx.select({ n: count() }).from(classLevels);
  const [classes] = await tx
    .select({ n: count() })
    .from(classArms)
    .innerJoin(classLevels, and(eq(classLevels.schoolId, classArms.schoolId), eq(classLevels.id, classArms.classLevelId)))
    .where(and(isNull(classArms.archivedAt), isNull(classLevels.archivedAt)));
  const [names] = await tx.select({ n: count() }).from(arms);
  return { levels: levels?.n ?? 0, classes: classes?.n ?? 0, armNames: names?.n ?? 0 };
}

async function levelOr404(tx: Tx, id: string) {
  const [level] = await tx.select().from(classLevels).where(eq(classLevels.id, id)).limit(1);
  if (!level) throw new ApiError("not_found", "That class isn’t here any more.");
  return level;
}

async function classArmOr404(tx: Tx, id: string) {
  const [row] = await tx
    .select({ arm: classArms, level: classLevels, name: arms })
    .from(classArms)
    .innerJoin(classLevels, and(eq(classLevels.schoolId, classArms.schoolId), eq(classLevels.id, classArms.classLevelId)))
    .innerJoin(arms, and(eq(arms.schoolId, classArms.schoolId), eq(arms.id, classArms.armId)))
    .where(eq(classArms.id, id))
    .limit(1);
  if (!row) throw new ApiError("not_found", "That class isn’t here any more.");
  return row;
}

async function levelNameTaken(tx: Tx, name: string, exceptId?: string): Promise<boolean> {
  const [hit] = await tx
    .select({ id: classLevels.id })
    .from(classLevels)
    .where(and(sql`lower(${classLevels.name}) = lower(${name})`, exceptId ? ne(classLevels.id, exceptId) : undefined))
    .limit(1);
  return !!hit;
}

async function armClash(tx: Tx, name: string, code: string, exceptId?: string): Promise<"name" | "code" | null> {
  const others = await tx
    .select({ name: arms.name, code: arms.code })
    .from(arms)
    .where(exceptId ? ne(arms.id, exceptId) : undefined);
  if (others.some((a) => a.name.toLowerCase() === name.toLowerCase())) return "name";
  if (others.some((a) => a.code === code)) return "code";
  return null;
}

classRoutes.openapi(
  createRoute({
    method: "get",
    path: "/v1/classes",
    tags: ["classes"],
    summary: "The school's class levels, arm names and arms, with student counts",
    responses: { 200: ok("Class structure", ClassStructureSchema), ...errors },
  }),
  async (c) => {
    const data = await schoolRoute(c, {}, ({ tx, school }) => classStructure(tx, school.id));
    return c.json(data, 200);
  },
);

// ── Quick setup ─────────────────────────────────────────────────────────────────────────────────

classRoutes.openapi(
  createRoute({
    method: "post",
    path: "/v1/classes/setup",
    tags: ["classes"],
    summary: "Quick setup: every class level and arm at once. Only while the school has no classes",
    request: { body: json(ClassSetupSchema) },
    responses: {
      201: ok("Created", ClassStructureSchema),
      409: problemContent("Classes are already set up"),
      422: problemContent("A field needs fixing"),
      ...errors,
    },
  }),
  async (c) => {
    const input = c.req.valid("json");
    const data = await schoolRoute(c, {}, async ({ tx, school, auth, audit }) => {
      const [existing] = await tx.select({ n: count() }).from(classLevels);
      if ((existing?.n ?? 0) > 0) throw new ApiError("conflict", "Your classes are already set up. Change them here instead.");

      const by = { createdBy: auth.user.id, updatedBy: auth.user.id };
      const levelRows = await tx
        .insert(classLevels)
        .values(input.levels.map((l, i) => ({ schoolId: school.id, key: l.key, name: l.name, shortName: l.short, section: l.section, position: i, ...by })))
        .returning({ id: classLevels.id });
      const nameRows = await tx
        .insert(arms)
        .values(input.arms.map((a, i) => ({ schoolId: school.id, name: a.name, code: a.code, position: i, ...by })))
        .returning({ id: arms.id });
      const pairs = input.armsByLevel.flatMap((list, i) =>
        list.map((index) => ({ schoolId: school.id, classLevelId: levelRows[i]!.id, armId: nameRows[index]!.id, ...by })),
      );
      await tx.insert(classArms).values(pairs);

      audit({
        action: "classes.set_up",
        entity: "school",
        entityId: school.id,
        changes: { levels: input.levels.map((l) => l.name), arms: input.arms.map((a) => a.name), classes: pairs.length },
        summary: `Set up ${plural(pairs.length, "class", "classes")}, ${input.levels[0]!.name} to ${input.levels.at(-1)!.name}`,
      });
      return classStructure(tx, school.id);
    });
    return c.json(data, 201);
  },
);

// ── Class levels ────────────────────────────────────────────────────────────────────────────────

const SECTION_RANK = Object.fromEntries(SECTIONS.map((s, i) => [s, i])) as Record<Section, number>;

classRoutes.openapi(
  createRoute({
    method: "post",
    path: "/v1/class-levels",
    tags: ["classes"],
    summary: "Add a class after setup (Year 13, Pre-JSS). It goes at the end of its section, with the school's first arm",
    request: { body: json(z.object({ name: LevelName, short: ShortName, section: z.enum(SECTIONS) }).openapi("NewClassLevel")) },
    responses: {
      201: ok("Added", z.object({ id: z.string().uuid() })),
      409: problemContent("No classes set up yet"),
      422: problemContent("Another class has this name"),
      ...errors,
    },
  }),
  async (c) => {
    const input = c.req.valid("json");
    const id = await schoolRoute(c, {}, async ({ tx, school, auth, audit }) => {
      if (await levelNameTaken(tx, input.name)) throw fieldError("#/name", "Another class has this name", "Two classes can’t share a name.");
      const [firstArm] = await tx.select({ id: arms.id }).from(arms).orderBy(asc(arms.position), asc(arms.createdAt)).limit(1);
      if (!firstArm) throw new ApiError("conflict", "Set up your classes first.");

      const levels = await tx.select({ position: classLevels.position, section: classLevels.section }).from(classLevels).orderBy(asc(classLevels.position));
      const after = levels.filter((l) => SECTION_RANK[l.section] <= SECTION_RANK[input.section]).at(-1);
      const position = after ? after.position + 1 : 0;
      // Make room. Positions are unique, so move the tail out of the way (negative) and back.
      await tx.update(classLevels).set({ position: sql`-(${classLevels.position} + 1)` }).where(gte(classLevels.position, position));
      await tx.update(classLevels).set({ position: sql`-${classLevels.position}` }).where(lt(classLevels.position, 0));

      const by = { createdBy: auth.user.id, updatedBy: auth.user.id };
      const [level] = await tx
        .insert(classLevels)
        .values({ schoolId: school.id, key: null, name: input.name, shortName: input.short, section: input.section, position, ...by })
        .returning({ id: classLevels.id });
      await tx.insert(classArms).values({ schoolId: school.id, classLevelId: level!.id, armId: firstArm.id, ...by });
      audit({ action: "class_level.added", entity: "class_level", entityId: level!.id, changes: input, summary: `Added ${input.name} to ${SECTION_LABEL[input.section].toLowerCase()}` });
      return level!.id;
    });
    return c.json({ id }, 201);
  },
);

classRoutes.openapi(
  createRoute({
    method: "patch",
    path: "/v1/class-levels/{id}",
    tags: ["classes"],
    summary: "Rename a class (name and short name) and/or archive it or bring it back",
    request: {
      params: IdParam,
      body: json(
        z
          .object({ name: LevelName.optional(), short: ShortName.optional(), archived: z.boolean().optional() })
          .refine((b) => b.name !== undefined || b.short !== undefined || b.archived !== undefined, "Nothing to change")
          .openapi("ClassLevelChange"),
      ),
    },
    responses: { 204: { description: "Saved" }, 422: problemContent("Another class has this name"), ...errors },
  }),
  async (c) => {
    const { id } = c.req.valid("param");
    const input = c.req.valid("json");
    await schoolRoute(c, {}, async ({ tx, auth, audit }) => {
      const level = await levelOr404(tx, id);
      if (input.name !== undefined && (await levelNameTaken(tx, input.name, id))) {
        throw fieldError("#/name", "Another class has this name", "Two classes can’t share a name.");
      }
      const archivedAt = input.archived === undefined ? undefined : input.archived ? (level.archivedAt ?? new Date()) : null;
      await tx
        .update(classLevels)
        .set({ name: input.name, shortName: input.short, archivedAt, updatedBy: auth.user.id })
        .where(eq(classLevels.id, id));
      if (input.name !== undefined && input.name !== level.name) {
        audit({ action: "class_level.renamed", entity: "class_level", entityId: id, changes: { from: level.name, to: input.name }, summary: `Renamed ${level.name} to ${input.name}` });
      } else if (input.short !== undefined && input.short !== level.shortName) {
        audit({ action: "class_level.renamed", entity: "class_level", entityId: id, changes: { short: input.short } });
      }
      if (input.archived !== undefined && input.archived !== (level.archivedAt !== null)) {
        const name = input.name ?? level.name;
        audit({
          action: input.archived ? "class_level.archived" : "class_level.restored",
          entity: "class_level",
          entityId: id,
          summary: `${input.archived ? "Archived" : "Brought back"} ${name}`,
        });
      }
    });
    return c.body(null, 204);
  },
);

classRoutes.openapi(
  createRoute({
    method: "delete",
    path: "/v1/class-levels/{id}",
    tags: ["classes"],
    summary: "Remove a class and its arms. Refused while any of its arms has students: archive it instead",
    request: { params: IdParam },
    responses: { 204: { description: "Removed" }, 409: problemContent("The class has students"), ...errors },
  }),
  async (c) => {
    const { id } = c.req.valid("param");
    await schoolRoute(c, {}, async ({ tx, audit }) => {
      const level = await levelOr404(tx, id);
      const rows = await tx.select({ id: classArms.id }).from(classArms).where(eq(classArms.classLevelId, id));
      const counts = await studentCounts(tx, rows.map((r) => r.id));
      const students = [...counts.values()].reduce((a, b) => a + b, 0);
      if (students) throw new ApiError("conflict", `${level.name} has ${plural(students, "student")}. Move them first, or archive the class instead.`);
      if ((await classArmsWithHistory(tx, rows.map((r) => r.id))).size) {
        throw new ApiError("conflict", `Students have been in ${level.name} before, so it keeps their history. Archive it instead.`);
      }
      await tx.delete(classArms).where(eq(classArms.classLevelId, id));
      await tx.delete(classLevels).where(eq(classLevels.id, id));
      audit({ action: "class_level.removed", entity: "class_level", entityId: id, changes: { name: level.name }, summary: `Removed ${level.name}` });
    });
    return c.body(null, 204);
  },
);

// ── Arms ────────────────────────────────────────────────────────────────────────────────────────

classRoutes.openapi(
  createRoute({
    method: "post",
    path: "/v1/class-levels/{id}/arms",
    tags: ["classes"],
    summary: "Add an arm to one class: one of the school's arm names, or a new name made for the whole school",
    request: {
      params: IdParam,
      body: json(
        z
          .union([z.object({ armNameId: Id }), z.object({ name: ArmNameText, code: ArmCode })])
          .openapi("NewClassArm", { description: "{ armNameId } for an existing arm name, or { name, code } for a new one" }),
      ),
    },
    responses: {
      201: ok("Added", z.object({ id: z.string().uuid() })),
      409: problemContent("The class already has this arm"),
      422: problemContent("A new arm's name or code is already used"),
      ...errors,
    },
  }),
  async (c) => {
    const { id: levelId } = c.req.valid("param");
    const input = c.req.valid("json");
    const id = await schoolRoute(c, {}, async ({ tx, school, auth, audit }) => {
      const level = await levelOr404(tx, levelId);
      const by = { createdBy: auth.user.id, updatedBy: auth.user.id };
      let armName: { id: string; name: string };
      if ("armNameId" in input) {
        const [found] = await tx.select({ id: arms.id, name: arms.name }).from(arms).where(eq(arms.id, input.armNameId)).limit(1);
        if (!found) throw new ApiError("not_found", "That arm isn’t here any more.");
        armName = found;
      } else {
        const clash = await armClash(tx, input.name, input.code);
        if (clash === "name") throw fieldError("#/name", "Already one of your arms", "You already have an arm with this name. Pick it from the list.");
        if (clash === "code") throw fieldError("#/code", "Another arm uses this code", "Another arm uses this code.");
        const [{ n } = { n: 0 }] = await tx.select({ n: count() }).from(arms);
        const [created] = await tx
          .insert(arms)
          .values({ schoolId: school.id, name: input.name, code: input.code, position: n, ...by })
          .returning({ id: arms.id, name: arms.name });
        armName = created!;
      }
      const [dup] = await tx
        .select({ id: classArms.id })
        .from(classArms)
        .where(and(eq(classArms.classLevelId, levelId), eq(classArms.armId, armName.id)))
        .limit(1);
      if (dup) throw new ApiError("conflict", `${level.name} already has ${armName.name}.`);
      const [row] = await tx.insert(classArms).values({ schoolId: school.id, classLevelId: levelId, armId: armName.id, ...by }).returning({ id: classArms.id });
      audit({ action: "class_arm.added", entity: "class_arm", entityId: row!.id, changes: { level: level.name, arm: armName.name }, summary: `Added ${level.name} ${armName.name}` });
      return row!.id;
    });
    return c.json({ id }, 201);
  },
);

classRoutes.openapi(
  createRoute({
    method: "patch",
    path: "/v1/arm-names/{id}",
    tags: ["classes"],
    summary: "Rename an arm name and its code. It changes in every class",
    request: { params: IdParam, body: json(z.object({ name: ArmNameText, code: ArmCode }).openapi("ArmNameChange")) },
    responses: { 204: { description: "Saved" }, 422: problemContent("Another arm has this name or code"), ...errors },
  }),
  async (c) => {
    const { id } = c.req.valid("param");
    const input = c.req.valid("json");
    await schoolRoute(c, {}, async ({ tx, auth, audit }) => {
      const [armName] = await tx.select().from(arms).where(eq(arms.id, id)).limit(1);
      if (!armName) throw new ApiError("not_found", "That arm isn’t here any more.");
      const clash = await armClash(tx, input.name, input.code, id);
      if (clash === "name") throw fieldError("#/name", "Another arm has this name", "Two arms can’t share a name.");
      if (clash === "code") throw fieldError("#/code", "Another arm uses this code", "Two arms can’t share a code.");
      await tx.update(arms).set({ name: input.name, code: input.code, updatedBy: auth.user.id }).where(eq(arms.id, id));
      if (armName.name !== input.name) {
        audit({ action: "arm.renamed", entity: "arm", entityId: id, changes: { from: armName.name, to: input.name, code: input.code }, summary: `Renamed the ${armName.name} arm to ${input.name} in every class` });
      } else if (armName.code !== input.code) {
        audit({ action: "arm.renamed", entity: "arm", entityId: id, changes: { code: input.code } });
      }
    });
    return c.body(null, 204);
  },
);

classRoutes.openapi(
  createRoute({
    method: "patch",
    path: "/v1/arms/{id}",
    tags: ["classes"],
    summary: "Set one class's department (senior classes only) and/or archive it or bring it back",
    request: {
      params: IdParam,
      body: json(
        z
          .object({ department: z.enum(DEPARTMENTS).nullable().optional(), archived: z.boolean().optional() })
          .refine((b) => b.department !== undefined || b.archived !== undefined, "Nothing to change")
          .openapi("ClassArmChange"),
      ),
    },
    responses: { 204: { description: "Saved" }, 409: problemContent("Departments are for senior classes"), ...errors },
  }),
  async (c) => {
    const { id } = c.req.valid("param");
    const input = c.req.valid("json");
    await schoolRoute(c, {}, async ({ tx, auth, audit }) => {
      const { arm, level, name } = await classArmOr404(tx, id);
      if (input.department !== undefined && level.section !== "senior") throw new ApiError("conflict", "Departments are for senior classes.");
      const archivedAt = input.archived === undefined ? undefined : input.archived ? (arm.archivedAt ?? new Date()) : null;
      await tx.update(classArms).set({ department: input.department, archivedAt, updatedBy: auth.user.id }).where(eq(classArms.id, id));
      const label = `${level.name} ${name.name}`;
      if (input.department !== undefined && input.department !== arm.department) {
        audit({
          action: "class_arm.department_set",
          entity: "class_arm",
          entityId: id,
          changes: { department: input.department },
          summary: `Set ${label} to ${input.department ? DEPARTMENT_LABEL[input.department] : "no department"}`,
        });
      }
      if (input.archived !== undefined && input.archived !== (arm.archivedAt !== null)) {
        audit({ action: input.archived ? "class_arm.archived" : "class_arm.restored", entity: "class_arm", entityId: id, summary: `${input.archived ? "Archived" : "Brought back"} ${label}` });
      }
    });
    return c.body(null, 204);
  },
);

classRoutes.openapi(
  createRoute({
    method: "delete",
    path: "/v1/arms/{id}",
    tags: ["classes"],
    summary: "Remove one class's arm. Refused while it has students, or if it's the class's only arm",
    request: { params: IdParam },
    responses: { 204: { description: "Removed" }, 409: problemContent("Has students, or is the class's only arm"), ...errors },
  }),
  async (c) => {
    const { id } = c.req.valid("param");
    await schoolRoute(c, {}, async ({ tx, audit }) => {
      const { level, name } = await classArmOr404(tx, id);
      const label = `${level.name} ${name.name}`;
      const students = (await studentCounts(tx, [id])).get(id) ?? 0;
      if (students) throw new ApiError("conflict", `${label} has ${plural(students, "student")}. Move them first, or archive it instead.`);
      const [{ n } = { n: 0 }] = await tx.select({ n: count() }).from(classArms).where(eq(classArms.classLevelId, level.id));
      if (n <= 1) throw new ApiError("conflict", `Every class needs at least one arm. Remove ${level.name} instead.`);
      if ((await classArmsWithHistory(tx, [id])).size) throw new ApiError("conflict", `Students have been in ${label} before, so it keeps their history. Archive it instead.`);
      await tx.delete(classArms).where(eq(classArms.id, id));
      audit({ action: "class_arm.removed", entity: "class_arm", entityId: id, changes: { level: level.name, arm: name.name }, summary: `Removed ${label}` });
    });
    return c.body(null, 204);
  },
);

// ── Every arm at once ───────────────────────────────────────────────────────────────────────────

classRoutes.openapi(
  createRoute({
    method: "put",
    path: "/v1/arms/layout",
    tags: ["classes"],
    summary: "Classes › Edit arms: the arm names in order and which classes have each. Checked as a whole; a refused save changes nothing",
    request: { body: json(ArmLayoutSchema) },
    responses: {
      200: ok("Saved", z.object({ summary: z.string().openapi({ example: "new arm Emerald; 3 classes added" }) }).openapi("ArmLayoutResult")),
      409: problemContent("Something changed while editing, or an arm with students would be removed"),
      422: problemContent("A field needs fixing"),
      ...errors,
    },
  }),
  async (c) => {
    const layout = c.req.valid("json");
    const summary = await schoolRoute(c, {}, async ({ tx, school, auth, audit }) => {
      const names = await tx.select().from(arms);
      const levels = await tx.select().from(classLevels);
      const rows = await tx.select().from(classArms);
      const students = await studentCounts(tx, rows.map((r) => r.id));
      const studentsIn = (classArmId: string) => students.get(classArmId) ?? 0;
      const levelById = new Map(levels.map((l) => [l.id, l]));
      const nameById = new Map(names.map((n) => [n.id, n]));
      const labelOf = (r: (typeof rows)[number]) => `${levelById.get(r.classLevelId)?.name ?? ""} ${nameById.get(r.armId)?.name ?? ""}`.trim();

      const live = levels.filter((l) => l.archivedAt === null);
      const sent = new Set(layout.levels.map((l) => l.levelId));
      if (live.some((l) => !sent.has(l.id)) || layout.levels.some((x) => !live.some((l) => l.id === x.levelId)) || sent.size !== layout.levels.length) {
        throw new ApiError("conflict", "Your classes changed while you were editing. Reload the page and try again.");
      }
      if (layout.names.some((n) => !n.key.startsWith("new-") && !nameById.has(n.key))) {
        throw new ApiError("conflict", "An arm was changed while you were editing. Reload the page and try again.");
      }

      // Arm names dropped from the list.
      const kept = new Set(layout.names.map((n) => n.key));
      const dropped = names.filter((n) => !kept.has(n.id));
      for (const name of dropped) {
        const used = rows.filter((r) => r.armId === name.id);
        const full = used.find((r) => studentsIn(r.id) > 0);
        if (full) throw new ApiError("conflict", `${labelOf(full)} has ${plural(studentsIn(full.id), "student")}. Move them before deleting ${name.name}.`);
        const archivedLevel = used.map((r) => levelById.get(r.classLevelId)).find((l) => l?.archivedAt);
        if (archivedLevel) throw new ApiError("conflict", `${name.name} is still used by ${archivedLevel.name}, which is archived. Bring the class back to change its arms.`);
      }

      // Per class: arms taken out, archived ones ticked again, and new ones.
      const removals: typeof rows = [];
      const comebacks: typeof rows = [];
      const additions: { levelId: string; key: string }[] = [];
      for (const { levelId, arms: wanted } of layout.levels) {
        for (const r of rows.filter((x) => x.classLevelId === levelId)) {
          const keep = wanted.includes(r.armId);
          if (!keep && r.archivedAt === null) {
            if (studentsIn(r.id)) throw new ApiError("conflict", `${labelOf(r)} has ${plural(studentsIn(r.id), "student")}. Move them first, or archive it from the class instead.`);
            removals.push(r);
          }
          if (keep && r.archivedAt !== null) comebacks.push(r);
        }
        for (const key of new Set(wanted)) {
          if (!rows.some((r) => r.classLevelId === levelId && r.armId === key)) additions.push({ levelId, key });
        }
      }

      const leaving = [...removals, ...rows.filter((r) => dropped.some((d) => d.id === r.armId))];
      const history = await classArmsWithHistory(tx, leaving.map((r) => r.id));
      const withHistory = leaving.find((r) => history.has(r.id));
      if (withHistory) throw new ApiError("conflict", `Students have been in ${labelOf(withHistory)} before, so it keeps their history. Archive it from the class instead.`);

      // Everything checks out: apply it. Dropped and removed ones go first, so their names and
      // codes are free; kept names then move aside (names and codes are unique, and a save may
      // swap two) before taking their final values.
      const by = { updatedBy: auth.user.id };
      const droppedIds = dropped.map((d) => d.id);
      const removedIds = removals.map((r) => r.id);
      if (droppedIds.length) await tx.delete(classArms).where(inArray(classArms.armId, droppedIds));
      if (removedIds.length) await tx.delete(classArms).where(inArray(classArms.id, removedIds));
      if (droppedIds.length) await tx.delete(arms).where(inArray(arms.id, droppedIds));

      for (const n of layout.names) {
        if (nameById.has(n.key)) await tx.update(arms).set({ name: `~${n.key}`, code: `~${n.key}` }).where(eq(arms.id, n.key));
      }
      const ids = new Map<string, string>();
      const renamed: string[] = [];
      const created: string[] = [];
      for (const [position, entry] of layout.names.entries()) {
        const before = nameById.get(entry.key);
        if (before) {
          if (before.name !== entry.name) renamed.push(`${before.name} to ${entry.name}`);
          await tx.update(arms).set({ name: entry.name, code: entry.code, position, ...by }).where(eq(arms.id, before.id));
          ids.set(entry.key, before.id);
        } else {
          const [row] = await tx
            .insert(arms)
            .values({ schoolId: school.id, name: entry.name, code: entry.code, position, createdBy: auth.user.id, ...by })
            .returning({ id: arms.id });
          ids.set(entry.key, row!.id);
          created.push(entry.name);
        }
      }
      if (comebacks.length) await tx.update(classArms).set({ archivedAt: null, ...by }).where(inArray(classArms.id, comebacks.map((r) => r.id)));
      if (additions.length) {
        await tx.insert(classArms).values(additions.map((a) => ({ schoolId: school.id, classLevelId: a.levelId, armId: ids.get(a.key)!, createdBy: auth.user.id, ...by })));
      }

      const parts = [
        created.length && `new ${created.length === 1 ? "arm" : "arms"} ${created.join(", ")}`,
        renamed.length && `renamed ${renamed.join(", ")}`,
        dropped.length && `deleted ${dropped.map((d) => d.name).join(", ")}`,
        additions.length + comebacks.length && `${plural(additions.length + comebacks.length, "class", "classes")} added`,
        removals.length && `${plural(removals.length, "class", "classes")} removed`,
      ].filter(Boolean) as string[];
      const text = parts.length ? parts.join("; ") : "no changes";
      if (parts.length) {
        audit({
          action: "arms.edited",
          entity: "school",
          entityId: school.id,
          changes: { created, renamed, deleted: dropped.map((d) => d.name), added: additions.length + comebacks.length, removed: removals.length },
          summary: `Edited the arms: ${text}`,
        });
      }
      return text;
    });
    return c.json({ summary }, 200);
  },
);
