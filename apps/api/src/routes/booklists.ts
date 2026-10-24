/**
 * Books and things needed (B3 in the front end's backend-requirements.md; rules in
 * packages/core/src/booklists.ts, flow from its src/data/fake/booklists.ts). Owners and admins.
 *
 *   GET /v1/book-lists?session=2027                    every class level's list for this session or the next
 *   PUT /v1/book-lists/{session}/{levelId}             { items }: replaces the list
 *   PUT /v1/book-lists/{session}/{levelId}/shared      { shared }: 409 for an empty list
 *
 * `session` is the session's start year. A parent sees, for each child, the shared list for the
 * class level they move into next session (none in the final class), then this session's list
 * for their class level (bookListsFor, on GET /v1/me/children).
 */
import { randomUUID } from "node:crypto";
import { BOOK_CATEGORIES, sessionName } from "@brillianda/core";
import { and, asc, bookLists, classLevels, eq, isNull, users, type BookListItem, type Tx } from "@brillianda/db";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { AppEnv } from "../context.js";
import { ApiError, problemContent } from "../lib/errors.js";
import { schoolRoute, type Role } from "../school-route.js";
import { currentSession } from "./calendar.js";

export const bookListRoutes = new OpenAPIHono<AppEnv>();

const ADMINS: readonly Role[] = ["owner", "admin"];
const ok = <T extends z.ZodTypeAny>(description: string, schema: T) => ({ description, content: { "application/json": { schema } } });
const errors = {
  401: problemContent("Not signed in to this school"),
  403: problemContent("Only owners and admins"),
  404: problemContent("No active school here, or no such class level"),
} as const;

// The front end's bookItemSchema and bookListSchema, with the same rules (plus the item's id).
const bookItemSchema = z.object({
  id: z.string().trim().max(64).optional().openapi({ description: "Kept when given; new items get one" }),
  category: z.enum(BOOK_CATEGORIES, { message: "Choose a kind" }),
  name: z.string({ message: "Name the item" }).trim().min(2, "Name the item").max(120, "Use at most 120 characters"),
  detail: z.string().trim().max(160, "Use at most 160 characters").default(""),
  quantity: z.coerce.number({ message: "A whole number" }).int("A whole number").min(1, "At least 1").max(99, "At most 99"),
  price: z.union([z.null(), z.coerce.number({ message: "Whole naira" }).int("Whole naira").min(0, "Can’t be below 0").max(10_000_000, "That’s too high")]),
});
const bookListSchema = z.object({ items: z.array(bookItemSchema).max(80, "Use at most 80 items") });

const ItemSchema = z.object({ id: z.string(), category: z.enum(BOOK_CATEGORIES), name: z.string(), detail: z.string(), quantity: z.number().int(), price: z.number().int().nullable() });
export const BookListSchema = z
  .object({
    levelId: z.string().uuid(),
    levelName: z.string(),
    startYear: z.number().int(),
    session: z.string(),
    items: z.array(ItemSchema),
    shared: z.boolean(),
    updated: z.object({ by: z.string(), at: z.number().int() }).nullable().openapi({ description: "Who changed it last and when (ms); null until saved" }),
  })
  .openapi("BookList");
type BookList = z.infer<typeof BookListSchema>;

const levelsOf = (tx: Tx) => tx.select({ id: classLevels.id, name: classLevels.name, position: classLevels.position }).from(classLevels).where(isNull(classLevels.archivedAt)).orderBy(asc(classLevels.position));

async function listsFor(tx: Tx, startYear: number, levels: { id: string; name: string }[]): Promise<BookList[]> {
  const saved = await tx
    .select({ list: bookLists, by: users.fullName })
    .from(bookLists)
    .leftJoin(users, eq(users.id, bookLists.updatedBy))
    .where(eq(bookLists.startYear, startYear));
  const byLevel = new Map(saved.map((r) => [r.list.classLevelId, r]));
  return levels.map((l) => {
    const row = byLevel.get(l.id);
    return {
      levelId: l.id,
      levelName: l.name,
      startYear,
      session: sessionName(startYear),
      items: row?.list.items ?? [],
      shared: row?.list.shared ?? false,
      updated: row ? { by: row.by ?? "A former staff member", at: row.list.updatedAt.getTime() } : null,
    };
  });
}

/** For the parent app: the shared lists for the class level a child moves into next session, then this session's. */
export async function bookListsFor(tx: Tx, levelId: string | null): Promise<{ label: string; list: BookList }[]> {
  if (!levelId) return [];
  const { startYear } = await currentSession(tx);
  const levels = await levelsOf(tx);
  const here = levels.findIndex((l) => l.id === levelId);
  const next = here >= 0 ? levels[here + 1] : undefined;
  const out: { label: string; list: BookList }[] = [];
  if (next) {
    const [list] = await listsFor(tx, startYear + 1, [next]);
    if (list!.shared && list!.items.length) out.push({ label: `For next session: ${list!.levelName}, ${list!.session}`, list: list! });
  }
  const current = levels.find((l) => l.id === levelId);
  if (current) {
    const [list] = await listsFor(tx, startYear, [current]);
    if (list!.shared && list!.items.length) out.push({ label: `This session: ${list!.levelName}, ${list!.session}`, list: list! });
  }
  return out;
}

/** The level, and that the year is this session or the next. */
async function check(tx: Tx, startYear: number, levelId: string) {
  const [level] = await tx.select({ id: classLevels.id, name: classLevels.name }).from(classLevels).where(and(eq(classLevels.id, levelId), isNull(classLevels.archivedAt))).limit(1);
  if (!level) throw new ApiError("not_found", "That class isn’t here any more.");
  const { startYear: now } = await currentSession(tx);
  if (startYear !== now && startYear !== now + 1) throw new ApiError("conflict", "Lists are for this session or the next.");
  return level;
}

const BookListsPageSchema = z
  .object({
    startYear: z.number().int(),
    session: z.string(),
    sessions: z.array(z.object({ startYear: z.number().int(), name: z.string(), label: z.string() })).openapi({ description: "Next session first, then this one" }),
    lists: z.array(BookListSchema).openapi({ description: "Every class level, in the school's order" }),
  })
  .openapi("BookListsPage");

bookListRoutes.openapi(
  createRoute({
    method: "get",
    path: "/v1/book-lists",
    tags: ["book lists"],
    summary: "Every class level's book list for a session: this one or the next (the default)",
    request: { query: z.object({ session: z.coerce.number().int().optional().openapi({ description: "The session's start year" }) }) },
    responses: { 200: ok("Book lists", BookListsPageSchema), ...errors },
  }),
  async (c) => {
    const { session } = c.req.valid("query");
    const data = await schoolRoute(c, { roles: ADMINS }, async ({ tx }) => {
      const { startYear: now } = await currentSession(tx);
      const year = session === now ? now : now + 1;
      return {
        startYear: year,
        session: sessionName(year),
        sessions: [
          { startYear: now + 1, name: sessionName(now + 1), label: "Next session" },
          { startYear: now, name: sessionName(now), label: "This session" },
        ],
        lists: await listsFor(tx, year, await levelsOf(tx)),
      };
    });
    return c.json(data, 200);
  },
);

const Params = z.object({ session: z.coerce.number().int("A start year"), levelId: z.string().uuid("Invalid id") });

bookListRoutes.openapi(
  createRoute({
    method: "put",
    path: "/v1/book-lists/{session}/{levelId}",
    tags: ["book lists"],
    summary: "Replace a class level's list for a session (up to 80 items). Sharing stays as it was; emptying a shared list stops sharing it",
    request: { params: Params, body: { content: { "application/json": { schema: bookListSchema.openapi("SaveBookList") } }, required: true } },
    responses: { 204: { description: "Saved" }, 409: problemContent("Not this session or the next"), 422: problemContent("An item needs fixing; errors[] points at it, e.g. #/items/2/name"), ...errors },
  }),
  async (c) => {
    const { session, levelId } = c.req.valid("param");
    const { items: input } = c.req.valid("json");
    await schoolRoute(c, { roles: ADMINS }, async ({ tx, school, auth, audit }) => {
      const level = await check(tx, session, levelId);
      const seen = new Set<string>();
      const items: BookListItem[] = input.map(({ id, ...rest }) => {
        const keep = id && !seen.has(id) ? id : randomUUID();
        seen.add(keep);
        return { id: keep, ...rest };
      });
      const [before] = await tx.select({ shared: bookLists.shared }).from(bookLists).where(and(eq(bookLists.classLevelId, levelId), eq(bookLists.startYear, session))).limit(1);
      const stopSharing = !items.length && before?.shared;
      await tx
        .insert(bookLists)
        .values({ schoolId: school.id, classLevelId: levelId, startYear: session, items, createdBy: auth.user.id, updatedBy: auth.user.id })
        .onConflictDoUpdate({
          target: [bookLists.schoolId, bookLists.classLevelId, bookLists.startYear],
          set: { items, ...(stopSharing ? { shared: false } : {}), updatedBy: auth.user.id, updatedAt: new Date() },
        });
      audit({
        action: "book_list.saved",
        entity: "class_level",
        entityId: levelId,
        changes: { session: sessionName(session), items: items.length, ...(stopSharing ? { shared: false } : {}) },
        summary: `Updated the ${level.name} book list for ${sessionName(session)} (${items.length} ${items.length === 1 ? "item" : "items"})`,
      });
    });
    return c.body(null, 204);
  },
);

bookListRoutes.openapi(
  createRoute({
    method: "put",
    path: "/v1/book-lists/{session}/{levelId}/shared",
    tags: ["book lists"],
    summary: "Share a class level's list with its parents, or stop sharing it",
    request: { params: Params, body: { content: { "application/json": { schema: z.object({ shared: z.boolean({ message: "Choose shared or not" }) }).openapi("ShareBookList") } }, required: true } },
    responses: { 204: { description: "Saved" }, 409: problemContent("An empty list, or not this session or the next"), ...errors },
  }),
  async (c) => {
    const { session, levelId } = c.req.valid("param");
    const { shared } = c.req.valid("json");
    await schoolRoute(c, { roles: ADMINS }, async ({ tx, school, auth, audit }) => {
      const level = await check(tx, session, levelId);
      const [row] = await tx.select({ items: bookLists.items, shared: bookLists.shared }).from(bookLists).where(and(eq(bookLists.classLevelId, levelId), eq(bookLists.startYear, session))).limit(1);
      if (shared && !row?.items.length) throw new ApiError("conflict", "Add something to the list before sharing it.");
      if ((row?.shared ?? false) === shared) return;
      await tx
        .update(bookLists)
        .set({ shared, updatedBy: auth.user.id, updatedAt: new Date() })
        .where(and(eq(bookLists.schoolId, school.id), eq(bookLists.classLevelId, levelId), eq(bookLists.startYear, session)));
      audit({
        action: shared ? "book_list.shared" : "book_list.unshared",
        entity: "class_level",
        entityId: levelId,
        changes: { session: sessionName(session), shared },
        summary: `${shared ? "Shared" : "Stopped sharing"} the ${level.name} book list for ${sessionName(session)}`,
      });
    });
    return c.body(null, 204);
  },
);
