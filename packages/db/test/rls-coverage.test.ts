/**
 * Phase 0 gate, part two: a school table without RLS, FORCE or the isolation policy fails CI.
 * Reads the live catalog after migrations, so it catches a table added without its policy.
 */
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "../src/testing.js";

let t: TestDatabase;
let client: pg.Client;

beforeAll(async () => {
  t = await createTestDatabase();
  client = new pg.Client({ connectionString: t.ownerUrl });
  await client.connect();
});

afterAll(async () => {
  await client?.end();
  await t?.close();
});

interface TableSecurity {
  table: string;
  rls: boolean;
  force: boolean;
  isolationPolicy: boolean;
  compositeKey: boolean;
}

async function schoolTableSecurity(): Promise<TableSecurity[]> {
  const res = await client.query<TableSecurity>(`
    select c.relname as "table",
           c.relrowsecurity as rls,
           c.relforcerowsecurity as force,
           exists (
             select 1 from pg_policies p
             where p.schemaname = 'public' and p.tablename = c.relname
               and p.policyname = 'school_isolation'
               and p.cmd = 'ALL'
               and 'brillianda_app' = any (p.roles)
               and p.qual like '%app_current_school_id()%'
               and p.with_check like '%app_current_school_id()%'
           ) as "isolationPolicy",
           exists (
             select 1 from pg_constraint k
             where k.conrelid = c.oid and k.contype in ('u', 'p')
               and (select array_agg(a.attname::text order by a.attname)
                    from unnest(k.conkey) as col(n)
                    join pg_attribute a on a.attrelid = c.oid and a.attnum = col.n) = array['id', 'school_id']
           ) as "compositeKey"
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r'
      and exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'school_id' and not a.attisdropped)
    order by c.relname`);
  return res.rows;
}

describe("row-level security coverage", () => {
  it("finds the school tables", async () => {
    expect((await schoolTableSecurity()).length).toBeGreaterThanOrEqual(3);
  });

  it("every table with a school_id has RLS enabled, FORCED, the isolation policy and unique (school_id, id)", async () => {
    const problems = (await schoolTableSecurity()).flatMap((t) => [
      ...(t.rls ? [] : [`${t.table}: RLS not enabled`]),
      ...(t.force ? [] : [`${t.table}: RLS not forced`]),
      ...(t.isolationPolicy ? [] : [`${t.table}: missing school_isolation policy`]),
      ...(t.compositeKey ? [] : [`${t.table}: missing unique (school_id, id)`]),
    ]);
    expect(problems).toEqual([]);
  });

  it("every school_id is NOT NULL", async () => {
    const res = await client.query(`
      select table_name from information_schema.columns
      where table_schema = 'public' and column_name = 'school_id' and is_nullable = 'YES'`);
    expect(res.rows).toEqual([]);
  });

  it("the app role is not a superuser, cannot bypass RLS and owns nothing", async () => {
    const role = await client.query(
      `select rolsuper, rolbypassrls, rolcreaterole, rolcreatedb from pg_roles where rolname = 'brillianda_app'`,
    );
    expect(role.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false, rolcreaterole: false, rolcreatedb: false });
    const owned = await client.query(`
      select c.relname from pg_class c join pg_roles r on r.oid = c.relowner
      join pg_namespace n on n.oid = c.relnamespace
      where r.rolname = 'brillianda_app' and n.nspname = 'public'`);
    expect(owned.rows).toEqual([]);
  });

  it("SECURITY DEFINER functions pin their search_path and are owned by the platform role", async () => {
    const res = await client.query<{ name: string; owner: string; config: string[] | null }>(`
      select p.proname as name, r.rolname as owner, p.proconfig as config
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      join pg_roles r on r.oid = p.proowner
      where n.nspname = 'public' and p.prosecdef`);
    expect(res.rows.length).toBeGreaterThan(0);
    for (const fn of res.rows) {
      expect(fn.owner, fn.name).toBe("brillianda_platform");
      expect(fn.config?.some((c) => c.startsWith("search_path=")), fn.name).toBe(true);
    }
  });
});
