/**
 * Checks a database restored from a backup before anyone trusts it:
 * the data is there, the migrations ledger says which version it is, and tenant isolation
 * survived the round trip (RLS enabled + forced + policies, and the app role really is walled off).
 *
 * Connect as a superuser or the database owner's admin; the check uses SET ROLE to look
 * through the app role's eyes.
 */
import pg from "pg";
import { readJournal } from "./migrate-safely.js";

export interface RestoreReport {
  ok: boolean;
  problems: string[];
  migrationsApplied: number;
  migrationsInCode: number;
  rowCounts: Record<string, number>;
  schools: number;
}

export async function verifyRestoredDatabase(url: string): Promise<RestoreReport> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  const problems: string[] = [];
  try {
    // 1. Version
    const ledger = await c.query(`select to_regclass('drizzle.__drizzle_migrations') as t`);
    const migrationsApplied = ledger.rows[0].t
      ? (await c.query(`select count(*)::int as n from drizzle.__drizzle_migrations`)).rows[0].n
      : 0;
    const migrationsInCode = readJournal().length;
    if (migrationsApplied === 0) problems.push("No migrations ledger: this is not a Brillianda database, or the restore is incomplete.");
    if (migrationsApplied > migrationsInCode) {
      problems.push(`Backup has ${migrationsApplied} migrations but this code knows ${migrationsInCode}: restore with newer code.`);
    }

    // 2. Data
    const tables = (
      await c.query<{ t: string }>(`select tablename as t from pg_tables where schemaname = 'public' order by tablename`)
    ).rows.map((r) => r.t);
    const rowCounts: Record<string, number> = {};
    for (const t of tables) {
      rowCounts[t] = (await c.query(`select count(*)::int as n from ${c.escapeIdentifier(t)}`)).rows[0].n;
    }
    for (const required of ["schools", "users", "school_members"]) {
      if (!(required in rowCounts)) problems.push(`Table ${required} is missing.`);
    }
    const schools = rowCounts.schools ?? 0;
    if (schools > 0 && (rowCounts.school_members ?? 0) === 0) {
      problems.push("There are schools but no school_members: school rows were not restored (RLS hid them at dump time?).");
    }

    // 3. Isolation survived
    const security = await c.query<{ t: string; rls: boolean; force: boolean; iso: boolean; backup: boolean }>(`
      select c.relname as t, c.relrowsecurity as rls, c.relforcerowsecurity as force,
             exists (select 1 from pg_policies p where p.tablename = c.relname and p.policyname = 'school_isolation') as iso,
             exists (select 1 from pg_policies p where p.tablename = c.relname and p.policyname = 'backup_read') as backup
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r'
        and exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'school_id' and not a.attisdropped)`);
    for (const r of security.rows) {
      if (!r.rls || !r.force) problems.push(`${r.t}: row-level security is not enabled and forced after restore.`);
      if (!r.iso) problems.push(`${r.t}: school_isolation policy missing after restore.`);
      if (!r.backup) problems.push(`${r.t}: backup_read policy missing; the next backup would be empty.`);
    }

    // 4. Look through the app's eyes
    const roles = await c.query(`select 1 from pg_roles where rolname = 'brillianda_app'`);
    if (!roles.rowCount) {
      problems.push("Role brillianda_app does not exist. Run pnpm db:bootstrap against this server before restoring.");
    } else {
      await c.query("begin");
      try {
        await c.query("set local role brillianda_app");
        for (const r of security.rows) {
          const n = (await c.query(`select count(*)::int as n from ${c.escapeIdentifier(r.t)}`)).rows[0].n;
          if (n !== 0) problems.push(`${r.t}: the app role sees ${n} rows with no school selected (isolation broken).`);
        }
      } finally {
        await c.query("rollback");
      }
      const firstSchool = (await c.query<{ id: string }>(`select id from schools order by id limit 1`)).rows[0]?.id;
      if (firstSchool) {
        await c.query("begin");
        try {
          await c.query(`select set_config('app.school_id', $1, true)`, [firstSchool]);
          await c.query("set local role brillianda_app");
          for (const r of security.rows) {
            const foreign = (
              await c.query(`select count(*)::int as n from ${c.escapeIdentifier(r.t)} where school_id <> $1`, [firstSchool])
            ).rows[0].n;
            if (foreign !== 0) problems.push(`${r.t}: scoped to one school, the app role still sees ${foreign} rows of others.`);
          }
        } finally {
          await c.query("rollback");
        }
      }
    }

    return { ok: problems.length === 0, problems, migrationsApplied, migrationsInCode, rowCounts, schools };
  } finally {
    await c.end();
  }
}
