/**
 * pnpm db:check — the migration safety gate (runs in CI on every pull request).
 *
 *   1. Every migration passes the guard (no unmarked destructive or security-weakening SQL).
 *   2. The journal and the .sql files agree (nothing orphaned, nothing missing).
 *   3. With BASE_REF set (CI: origin/main), no existing migration was edited, renamed or deleted.
 *      Once a migration has shipped it is history: fix forward with a new migration. Changes to
 *      whole-line comments only (e.g. a `-- safety: allow` note) are accepted: they can't change
 *      what a database ran.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { relative } from "node:path";
import { MIGRATIONS_FOLDER } from "../src/admin.js";
import { checkMigrationSql } from "../src/migration-safety.js";

const problems: string[] = [];

// 1. Guard
const files = readdirSync(MIGRATIONS_FOLDER).filter((f) => f.endsWith(".sql")).sort();
for (const file of files) {
  for (const issue of checkMigrationSql(readFileSync(`${MIGRATIONS_FOLDER}/${file}`, "utf8"))) {
    problems.push(
      `${file} statement ${issue.statement} [${issue.rule}]\n    ${issue.sql}\n    ${issue.why}\n` +
        `    If this is intended, put above it: -- safety: allow ${issue.rule} because <why it is safe>`,
    );
  }
}

// 2. Journal ↔ files
const journal = JSON.parse(readFileSync(`${MIGRATIONS_FOLDER}/meta/_journal.json`, "utf8")) as {
  entries: { idx: number; tag: string; when: number }[];
};
const tags = new Set(journal.entries.map((e) => `${e.tag}.sql`));
for (const f of files) if (!tags.has(f)) problems.push(`${f} is not in meta/_journal.json (was it written by hand?)`);
for (const t of tags) if (!files.includes(t)) problems.push(`meta/_journal.json lists ${t} but the file is missing`);
const whens = journal.entries.map((e) => e.when);
if (whens.some((w, i) => i > 0 && w <= whens[i - 1]!)) {
  problems.push("meta/_journal.json timestamps are not increasing; drizzle would skip a migration");
}

/** True when the file differs from the base only in whole-line `--` comments and blank lines. */
function commentsOnlyChanged(mergeBase: string, path: string): boolean {
  const code = (sql: string) =>
    sql
      .split("\n")
      .filter((l) => !/^\s*--(?!>)/.test(l) && l.trim() !== "")
      .map((l) => l.trimEnd())
      .join("\n");
  const before = execFileSync("git", ["show", `${mergeBase}:${path}`], { encoding: "utf8" });
  const after = execFileSync("git", ["show", `HEAD:${path}`], { encoding: "utf8" });
  return code(before) === code(after);
}

// 3. History is append-only
const base = process.env.BASE_REF;
if (base) {
  const folder = relative(process.cwd(), MIGRATIONS_FOLDER);
  const diff = execFileSync("git", ["diff", "--name-status", "--find-renames", `${base}...HEAD`, "--", folder], {
    encoding: "utf8",
  });
  const mergeBase = execFileSync("git", ["merge-base", base, "HEAD"], { encoding: "utf8" }).trim();
  for (const line of diff.split("\n").filter(Boolean)) {
    const [status, ...paths] = line.split("\t");
    const path = paths.at(-1) ?? "";
    if (!path.endsWith(".sql")) continue;
    if (status === "M" && commentsOnlyChanged(mergeBase, path)) {
      console.log(`${path}: only comments changed since ${base}, accepted.`);
      continue;
    }
    if (status !== "A") {
      problems.push(`${path} was ${status === "D" ? "deleted" : status?.startsWith("R") ? "renamed" : "edited"} after it shipped. Add a new migration instead.`);
    }
  }
} else if (process.env.CI) {
  problems.push("BASE_REF is not set in CI, so edits to shipped migrations cannot be detected.");
}

if (!existsSync(MIGRATIONS_FOLDER)) problems.push(`No migrations folder at ${MIGRATIONS_FOLDER}`);

if (problems.length) {
  console.error(`Migration safety check failed (${problems.length}):\n`);
  for (const p of problems) console.error(`  ✗ ${p}\n`);
  process.exit(1);
}
console.log(`Migration safety check passed: ${files.length} migrations${base ? `, none edited since ${base}` : ""}.`);
