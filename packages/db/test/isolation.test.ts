/**
 * Phase 0 gate: the two-school isolation suite.
 *
 * Seeds school A and school B with a row in every school table, then proves that a
 * transaction scoped to A can neither see, change, nor create B's data, and that nothing
 * is visible at all outside withSchool().
 */
import { eq, sql } from "drizzle-orm";
import pg from "pg";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, type Database } from "../src/client.js";
import { listUserSchools, revokeUserSessions } from "../src/platform.js";
import { auditLog, schoolMembers, schools, sessions, users } from "../src/schema/index.js";
import { createTestDatabase, type TestDatabase } from "../src/testing.js";
import { InvalidSchoolIdError, withSchool } from "../src/with-school.js";
import { pgError, seedSchool, type SeededSchool } from "./fixtures.js";

let t: TestDatabase;
let db: Database;
let A: SeededSchool;
let B: SeededSchool;
let schoolTables: string[];

beforeAll(async () => {
  t = await createTestDatabase();
  db = t.db;
  A = await seedSchool(db, "alpha");
  B = await seedSchool(db, "bravo");
  const res = await db.execute<{ table_name: string }>(sql`
    select table_name from information_schema.columns
    where table_schema = 'public' and column_name = 'school_id'
    order by table_name`);
  schoolTables = res.rows.map((r) => r.table_name);
});

afterAll(async () => {
  await t?.close();
});

const countBySchool = async (tx: Parameters<Parameters<typeof withSchool>[2]>[0] | Database, table: string) => {
  const res = await tx.execute<{ school_id: string; n: string }>(
    sql`select school_id, count(*)::text as n from ${sql.identifier(table)} group by school_id`,
  );
  return Object.fromEntries(res.rows.map((r) => [r.school_id, Number(r.n)]));
};

describe("tenant isolation", () => {
  it("discovers every school table", () => {
    expect(schoolTables).toEqual(expect.arrayContaining(["audit_log", "school_members", "sessions"]));
  });

  it("shows each school only its own rows, in every school table", async () => {
    for (const table of schoolTables) {
      const asA = await withSchool(db, A.schoolId, (tx) => countBySchool(tx, table));
      const asB = await withSchool(db, B.schoolId, (tx) => countBySchool(tx, table));
      expect(Object.keys(asA), `${table} as A`).toEqual([A.schoolId]);
      expect(Object.keys(asB), `${table} as B`).toEqual([B.schoolId]);
    }
  });

  it("shows nothing outside withSchool()", async () => {
    for (const table of schoolTables) {
      expect(await countBySchool(db, table), table).toEqual({});
    }
  });

  it("refuses to insert a row for another school", async () => {
    expect(await pgError(withSchool(db, A.schoolId, (tx) =>
        tx.insert(auditLog).values({ schoolId: B.schoolId, action: "x", entity: "y" }),
      ),)).toMatch(/row-level security/);
  });

  it("cannot update or delete another school's rows", async () => {
    const result = await withSchool(db, A.schoolId, async (tx) => {
      const updated = await tx
        .update(schoolMembers)
        .set({ status: "suspended" })
        .where(eq(schoolMembers.schoolId, B.schoolId))
        .returning();
      const deleted = await tx.delete(sessions).where(eq(sessions.id, B.sessionId)).returning();
      return { updated: updated.length, deleted: deleted.length };
    });
    expect(result).toEqual({ updated: 0, deleted: 0 });
    const stillThere = await withSchool(db, B.schoolId, (tx) => tx.select().from(sessions).where(eq(sessions.id, B.sessionId)));
    expect(stillThere).toHaveLength(1);
  });

  it("cannot move its own row into another school", async () => {
    expect(await pgError(withSchool(db, A.schoolId, (tx) =>
        tx.update(sessions).set({ schoolId: B.schoolId }).where(eq(sessions.id, A.sessionId)),
      ),)).toMatch(/row-level security/);
  });

  it("does not leak the school setting to the next transaction on the same connection", async () => {
    const single = createDatabase(t.appUrl, { max: 1 });
    try {
      await withSchool(single, A.schoolId, (tx) => tx.select().from(sessions));
      const after = await single.select().from(sessions);
      expect(after).toHaveLength(0);
      const setting = await single.execute<{ v: string | null }>(sql`select current_setting('app.school_id', true) as v`);
      expect(setting.rows[0]?.v ?? "").toBe("");
    } finally {
      await single.$client.end();
    }
  });

  it("rejects a malformed school id before touching the database", async () => {
    await expect(withSchool(db, "alpha", async () => 1)).rejects.toBeInstanceOf(InvalidSchoolIdError);
    await expect(withSchool(db, "' or 1=1 --", async () => 1)).rejects.toBeInstanceOf(InvalidSchoolIdError);
  });

  it("will not create a session for someone who is not a member of that school", async () => {
    expect(await pgError(
      withSchool(db, A.schoolId, (tx) =>
        tx.insert(sessions).values({
          schoolId: A.schoolId,
          userId: B.ownerId,
          tokenHash: `cross-${uuidv7()}`,
          expiresAt: new Date(Date.now() + 1000),
          absoluteExpiresAt: new Date(Date.now() + 1000),
        }),
      ),)).toMatch(/sessions_membership_fk/);
  });
});

describe("grants", () => {
  it("keeps audit_log append-only for the app", async () => {
    expect(await pgError(withSchool(db, A.schoolId, (tx) => tx.update(auditLog).set({ action: "tampered" })),)).toMatch(/permission denied/);
    expect(await pgError(withSchool(db, A.schoolId, (tx) => tx.delete(auditLog)))).toMatch(/permission denied/);
  });

  it("does not let the app delete schools or users", async () => {
    expect(await pgError(db.delete(schools).where(eq(schools.id, A.schoolId)))).toMatch(/permission denied/);
    expect(await pgError(db.delete(users).where(eq(users.id, A.ownerId)))).toMatch(/permission denied/);
  });

  it("does not let the app become the platform role or turn off RLS", async () => {
    expect(await pgError(db.execute(sql`set role brillianda_platform`))).toMatch(/permission denied/);
    expect(await pgError(db.execute(sql`alter table sessions disable row level security`))).toMatch(/must be owner/);
  });

  it("subjects the owner role to the policies too (FORCE), so it sees no school rows", async () => {
    const owner = new pg.Client({ connectionString: t.ownerUrl });
    await owner.connect();
    try {
      for (const table of schoolTables) {
        const res = await owner.query(`select count(*)::int as n from ${table}`);
        expect(res.rows[0].n, table).toBe(0);
      }
    } finally {
      await owner.end();
    }
  });
});

describe("platform functions", () => {
  it("lists only the user's active schools", async () => {
    const mine = await listUserSchools(db, A.ownerId);
    expect(mine).toEqual([{ schoolId: A.schoolId, name: "School alpha", subdomain: "alpha", role: "owner" }]);

    // Same email working at a second school (two-campus proprietor).
    await withSchool(db, B.schoolId, (tx) => tx.insert(schoolMembers).values({ schoolId: B.schoolId, userId: A.ownerId, role: "admin" }));
    expect((await listUserSchools(db, A.ownerId)).map((s) => s.subdomain)).toEqual(["alpha", "bravo"]);

    await db.update(schools).set({ status: "suspended" }).where(eq(schools.id, B.schoolId));
    expect((await listUserSchools(db, A.ownerId)).map((s) => s.subdomain)).toEqual(["alpha"]);
    await db.update(schools).set({ status: "active" }).where(eq(schools.id, B.schoolId));
  });

  it("signs a user out of every school except the current session", async () => {
    const keep = A.sessionId;
    const extra = uuidv7();
    await withSchool(db, A.schoolId, (tx) =>
      tx.insert(sessions).values({
        id: extra,
        schoolId: A.schoolId,
        userId: A.ownerId,
        tokenHash: `extra-${extra}`,
        expiresAt: new Date(Date.now() + 60_000),
        absoluteExpiresAt: new Date(Date.now() + 60_000),
      }),
    );
    const revoked = await revokeUserSessions(db, A.ownerId, keep);
    expect(revoked).toBe(1);
    const left = await withSchool(db, A.schoolId, (tx) => tx.select({ id: sessions.id }).from(sessions));
    expect(left.map((s) => s.id)).toEqual([keep]);
    // B's sessions untouched.
    const bLeft = await withSchool(db, B.schoolId, (tx) => tx.select({ id: sessions.id }).from(sessions));
    expect(bLeft.map((s) => s.id)).toEqual([B.sessionId]);
  });
});
