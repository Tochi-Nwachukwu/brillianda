import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MIGRATIONS_FOLDER } from "../src/admin.js";
import { checkMigrationSql, splitStatements } from "../src/migration-safety.js";

const rules = (sql: string) => checkMigrationSql(sql).map((i) => i.rule);

describe("migration guard flags", () => {
  it.each([
    ["drop-table", `DROP TABLE "students";`],
    ["drop-table", `drop table if exists guardians cascade;`],
    ["drop-column", `ALTER TABLE "students" DROP COLUMN "middle_name";`],
    ["drop-column", `alter table students drop middle_name;`],
    ["drop-schema", `DROP SCHEMA public CASCADE;`],
    ["drop-schema", `DROP OWNED BY brillianda_app;`],
    ["drop-type", `DROP TYPE "member_role";`],
    ["drop-type", `ALTER TYPE member_role RENAME VALUE 'admin' TO 'staff';`],
    ["drop-function", `DROP FUNCTION app_current_school_id();`],
    ["truncate", `TRUNCATE audit_log;`],
    ["delete-rows", `DELETE FROM sessions WHERE expires_at < now();`],
    ["update-without-where", `UPDATE students SET status = 'active';`],
    ["change-column-type", `ALTER TABLE students ALTER COLUMN phone SET DATA TYPE integer;`],
    ["change-column-type", `ALTER TABLE "students" ALTER COLUMN "phone" TYPE varchar(11);`],
    ["rename", `ALTER TABLE students RENAME COLUMN surname TO last_name;`],
    ["rename", `ALTER TABLE students RENAME TO pupils;`],
    ["set-not-null", `ALTER TABLE students ALTER COLUMN date_of_birth SET NOT NULL;`],
    ["disable-rls", `ALTER TABLE students DISABLE ROW LEVEL SECURITY;`],
    ["disable-rls", `ALTER TABLE students NO FORCE ROW LEVEL SECURITY;`],
    ["drop-policy", `DROP POLICY school_isolation ON students;`],
    ["drop-policy", `ALTER POLICY school_isolation ON students USING (true);`],
    ["role-privilege", `ALTER ROLE brillianda_app BYPASSRLS;`],
    ["role-privilege", `GRANT brillianda_owner TO brillianda_app;`],
    ["security-definer", `CREATE FUNCTION f() RETURNS int LANGUAGE sql SECURITY DEFINER AS $$ select 1 $$;`],
  ])("%s: %s", (rule, sql) => {
    expect(rules(sql)).toContain(rule);
  });
});

describe("migration guard allows", () => {
  it.each([
    `CREATE TABLE students (id uuid primary key);`,
    `ALTER TABLE "students" ADD COLUMN "nickname" text;`,
    `ALTER TABLE students ALTER COLUMN nickname DROP DEFAULT;`,
    `ALTER TABLE students ALTER COLUMN nickname DROP NOT NULL;`,
    `ALTER TABLE students DROP CONSTRAINT students_old_check;`,
    `DROP INDEX IF EXISTS students_name_idx;`,
    `UPDATE students SET status = 'active' WHERE status IS NULL AND id IN (select id from x limit 500);`,
    `ALTER TABLE students FORCE ROW LEVEL SECURITY;`,
    `CREATE POLICY school_isolation ON students USING (school_id = app_current_school_id());`,
    `GRANT EXECUTE ON FUNCTION app_user_schools(uuid) TO brillianda_app;`,
    `COMMENT ON COLUMN students.notes IS 'never drop table here';`,
    `-- DROP TABLE students; (just a comment)\nSELECT 1;`,
  ])("%s", (sql) => {
    expect(rules(sql)).toEqual([]);
  });

  it("ignores what happens inside function bodies", () => {
    const sql = `CREATE FUNCTION purge() RETURNS void LANGUAGE plpgsql AS $$ BEGIN DELETE FROM x; END $$;`;
    expect(rules(sql)).toEqual([]);
  });
});

describe("allow markers", () => {
  it("permits a flagged statement with a named rule and a real reason", () => {
    const sql = `-- safety: allow drop-column because nickname was moved to profiles in 0012 and unused since\nALTER TABLE students DROP COLUMN nickname;`;
    expect(rules(sql)).toEqual([]);
  });

  it("works across drizzle statement breakpoints", () => {
    const sql = `SELECT 1;\n-- safety: allow truncate because this table only holds a disposable cache\n--> statement-breakpoint\nTRUNCATE cache;`;
    expect(rules(sql)).toEqual([]);
  });

  it("only allows the rule it names", () => {
    const sql = `-- safety: allow drop-column because nickname was moved to profiles in 0012\nDROP TABLE students;`;
    expect(rules(sql)).toEqual(["drop-table"]);
  });

  it("requires a reason", () => {
    expect(rules(`-- safety: allow drop-table\nDROP TABLE students;`)).toEqual(["drop-table"]);
    expect(rules(`-- safety: allow drop-table because x\nDROP TABLE students;`)).toEqual(["drop-table"]);
  });

  it("does not let one statement's marker cover the next", () => {
    const sql = `-- safety: allow truncate because disposable cache table only\nTRUNCATE cache;\nTRUNCATE students;`;
    expect(rules(sql)).toEqual(["truncate"]);
  });
});

describe("splitStatements", () => {
  it("keeps $$ function bodies whole", () => {
    const sql = `CREATE FUNCTION f() RETURNS int AS $$\nBEGIN\n  RETURN 1;\nEND\n$$ LANGUAGE plpgsql;\nSELECT 2;`;
    expect(splitStatements(sql)).toHaveLength(2);
  });
});

describe("the repo's own migrations", () => {
  it("all pass the guard", () => {
    const files = readdirSync(MIGRATIONS_FOLDER).filter((f) => f.endsWith(".sql")).sort();
    expect(files.length).toBeGreaterThan(0);
    const problems = files.flatMap((f) =>
      checkMigrationSql(readFileSync(`${MIGRATIONS_FOLDER}/${f}`, "utf8")).map((i) => `${f} #${i.statement} ${i.rule}: ${i.sql}`),
    );
    expect(problems).toEqual([]);
  });
});
