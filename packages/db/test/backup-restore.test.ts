/**
 * The backup actually restores. Dumps two seeded schools exactly the way the nightly job does
 * (pg_dump --enable-row-security as brillianda_backup), restores into a fresh database, and
 * verifies data and tenant isolation came back.
 *
 * Needs pg_dump/pg_restore at least as new as the server. Skipped locally when they are missing;
 * CI sets REQUIRE_PG_TOOLS=1 so a missing tool fails instead.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "../src/testing.js";
import { verifyRestoredDatabase } from "../src/verify-restore.js";
import { seedSchool } from "./fixtures.js";

const PG_DUMP = process.env.PG_DUMP ?? "pg_dump";
const PG_RESTORE = process.env.PG_RESTORE ?? "pg_restore";
const toolsPresent = spawnSync(PG_DUMP, ["--version"]).status === 0 && spawnSync(PG_RESTORE, ["--version"]).status === 0;
if (!toolsPresent && process.env.REQUIRE_PG_TOOLS) {
  throw new Error(`REQUIRE_PG_TOOLS is set but ${PG_DUMP}/${PG_RESTORE} were not found`);
}

const adminUrl = () => process.env.TEST_DATABASE_ADMIN_URL!;
const withDb = (url: string, db: string) => {
  const u = new URL(url);
  u.pathname = `/${db}`;
  return u.toString();
};

async function countAll(url: string): Promise<Record<string, number>> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    const tables = (await c.query<{ t: string }>(`select tablename as t from pg_tables where schemaname = 'public'`)).rows;
    const out: Record<string, number> = {};
    for (const { t } of tables) out[t] = (await c.query(`select count(*)::int as n from ${c.escapeIdentifier(t)}`)).rows[0].n;
    return out;
  } finally {
    await c.end();
  }
}

async function admin(sql: string) {
  const c = new pg.Client({ connectionString: adminUrl() });
  await c.connect();
  try {
    await c.query(sql);
  } finally {
    await c.end();
  }
}

describe.skipIf(!toolsPresent)("nightly backup round trip", () => {
  let source: TestDatabase;
  let dir: string;
  const target = `brillianda_restore_${Date.now().toString(36)}`;

  beforeAll(async () => {
    source = await createTestDatabase();
    await seedSchool(source.db, "alpha");
    await seedSchool(source.db, "bravo");
    dir = mkdtempSync(join(tmpdir(), "bd-backup-"));
  });

  afterAll(async () => {
    await admin(`drop database if exists ${target} with (force)`).catch(() => {});
    await source?.close();
  });

  it("a plain pg_dump cannot read school rows: forced RLS stops it", () => {
    const owner = spawnSync(PG_DUMP, ["-Fc", "-f", join(dir, "owner.dump"), source.ownerUrl], { encoding: "utf8" });
    expect(owner.status).not.toBe(0);
    expect(owner.stderr).toMatch(/row-level security/);
  });

  it("dumps as brillianda_backup, restores, and verifies", async () => {
    const file = join(dir, "nightly.dump");
    execFileSync(PG_DUMP, ["-Fc", "--enable-row-security", "-f", file, source.backupUrl]);
    // The archive is readable (what the job checks before uploading).
    expect(execFileSync(PG_RESTORE, ["--list", file], { encoding: "utf8" })).toContain("school_members");

    await admin(`create database ${target} owner brillianda_owner`);
    const targetUrl = withDb(adminUrl(), target);
    execFileSync(PG_RESTORE, ["--exit-on-error", "--no-comments", "-d", targetUrl, file], { stdio: "pipe" });

    const [before, after] = await Promise.all([countAll(withDb(adminUrl(), source.dbName)), countAll(targetUrl)]);
    expect(after).toEqual(before);
    expect(after.school_members).toBe(2);
    expect(after.sessions).toBe(2);

    const report = await verifyRestoredDatabase(targetUrl);
    expect(report.problems).toEqual([]);
    expect(report.migrationsApplied).toBe(report.migrationsInCode);
  });

  it("the backup role can read but never write", async () => {
    const c = new pg.Client({ connectionString: source.backupUrl });
    await c.connect();
    try {
      expect((await c.query(`select count(*)::int as n from school_members`)).rows[0].n).toBe(2);
      await expect(c.query(`delete from school_members`)).rejects.toThrow(/permission denied/);
      await expect(c.query(`update users set full_name = 'x'`)).rejects.toThrow(/permission denied/);
      await expect(c.query(`insert into audit_log (id, school_id, action, entity) values (gen_random_uuid(), gen_random_uuid(), 'x', 'y')`)).rejects.toThrow(/permission denied/);
    } finally {
      await c.end();
    }
  });

  it("verification catches a restore that lost its isolation", async () => {
    const targetUrl = withDb(adminUrl(), target);
    const c = new pg.Client({ connectionString: targetUrl });
    await c.connect();
    await c.query(`alter table sessions no force row level security`);
    await c.query(`drop policy school_isolation on audit_log`);
    await c.end();
    const report = await verifyRestoredDatabase(targetUrl);
    expect(report.ok).toBe(false);
    expect(report.problems.join("\n")).toMatch(/sessions: row-level security is not enabled and forced/);
    expect(report.problems.join("\n")).toMatch(/audit_log: school_isolation policy missing/);
  });
});
