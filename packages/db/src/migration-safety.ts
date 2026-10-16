/**
 * Migration guard. Flags SQL that can lose data, break a running deploy, or weaken tenant
 * isolation, so it never reaches Neon by accident.
 *
 * A flagged statement is allowed only when a comment right above it (or inside it) says so:
 *
 *   -- safety: allow drop-column because legacy_x was copied to y in 0012 and unused since v1.4
 *   ALTER TABLE students DROP COLUMN legacy_x;
 *
 * The reason is mandatory and shows up in code review. See docs/safety.md (expand/contract).
 */

export type SafetyRule =
  | "drop-table"
  | "drop-column"
  | "drop-schema"
  | "drop-type"
  | "drop-function"
  | "truncate"
  | "delete-rows"
  | "update-without-where"
  | "change-column-type"
  | "rename"
  | "set-not-null"
  | "disable-rls"
  | "drop-policy"
  | "role-privilege"
  | "security-definer";

export interface SafetyIssue {
  rule: SafetyRule;
  /** 1-based index of the statement in the file. */
  statement: number;
  sql: string;
  why: string;
}

interface Rule {
  rule: SafetyRule;
  pattern: RegExp;
  why: string;
}

const RULES: Rule[] = [
  { rule: "drop-table", pattern: /\bdrop\s+table\b/, why: "Deletes a table and all its rows." },
  { rule: "drop-column", pattern: /\balter\s+table\b[\s\S]*\bdrop\s+(column\b|(?!constraint\b)(?!default\b)(?!not\b)(?!identity\b)(?!expression\b)"?\w)/, why: "Deletes a column and its data. Old code still reading it will break." },
  { rule: "drop-schema", pattern: /\bdrop\s+(schema|database|owned)\b/, why: "Deletes many objects at once." },
  { rule: "drop-type", pattern: /\bdrop\s+type\b|\balter\s+type\b[\s\S]*\b(drop|rename)\s+value\b/, why: "Removes a type or enum value existing rows may use." },
  { rule: "drop-function", pattern: /\bdrop\s+function\b/, why: "Policies or the app may depend on this function." },
  { rule: "truncate", pattern: /^\s*truncate\b/, why: "Deletes every row in a table." },
  { rule: "delete-rows", pattern: /\bdelete\s+from\b/, why: "Deletes rows. Data changes belong in a reviewed, reversible backfill." },
  { rule: "update-without-where", pattern: /\bupdate\s+"?\w+"?(\."?\w+"?)?\s+set\b(?![\s\S]*\bwhere\b)/, why: "Rewrites every row in a table." },
  { rule: "change-column-type", pattern: /\balter\s+column\b[\s\S]*\b(set\s+data\s+)?type\b/, why: "Can truncate or fail on existing data and rewrites the table under a lock." },
  { rule: "rename", pattern: /\brename\s+(column\b|to\b|"?\w+"?\s+to\b)/, why: "The running app still uses the old name until the deploy finishes." },
  { rule: "set-not-null", pattern: /\bset\s+not\s+null\b/, why: "Fails if any row is null, and scans the whole table under a lock." },
  { rule: "disable-rls", pattern: /\b(disable|no\s+force)\s+row\s+level\s+security\b/, why: "Turns off tenant isolation for this table." },
  { rule: "drop-policy", pattern: /\b(drop|alter)\s+policy\b/, why: "Changes who can see which school's rows." },
  { rule: "security-definer", pattern: /\bsecurity\s+definer\b/, why: "Runs with its owner's powers, around row-level security. Must pin search_path and return the minimum." },
  { rule: "role-privilege", pattern: /\b(bypassrls|superuser)\b|\balter\s+role\b|\bgrant\s+\w+\s+to\s+brillianda_app\b|\bset\s+role\b/, why: "Changes database role powers. Tenant isolation depends on the app role staying weak." },
];

const ALLOW = /--\s*safety:\s*allow\s+([a-z-]+(?:\s*,\s*[a-z-]+)*)\s+because\s+\S.{9,}/i;

/** Splits on drizzle's breakpoints when present, otherwise on semicolons outside $$ bodies. */
export function splitStatements(sql: string): string[] {
  if (sql.includes("--> statement-breakpoint")) {
    return sql.split("--> statement-breakpoint").map((s) => s.trim()).filter(Boolean);
  }
  const out: string[] = [];
  let buf = "";
  let inDollar = false;
  for (const line of sql.split("\n")) {
    const dollars = (line.match(/\$\$/g) ?? []).length;
    if (dollars % 2 === 1) inDollar = !inDollar;
    buf += line + "\n";
    if (!inDollar && /;\s*(--.*)?$/.test(line)) {
      out.push(buf.trim());
      buf = "";
    }
  }
  if (buf.trim()) out.push(buf.trim());
  return out.filter(Boolean);
}

/** Lowercased SQL with comments, string literals and function bodies removed, for matching. */
function codeOnly(statement: string): string {
  return statement
    .replace(/\$\$[\s\S]*?\$\$/g, " $$ ")
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .toLowerCase();
}

function allowedRules(statement: string, previous: string | undefined): Set<string> {
  const allowed = new Set<string>();
  // A marker anywhere in this statement, or in the comment lines that END the previous chunk
  // (drizzle puts "--> statement-breakpoint" after the marker). Comment lines that come before
  // the previous chunk's own SQL belong to that statement, not this one.
  const tailLines: string[] = [];
  for (const line of (previous ?? "").split("\n").reverse()) {
    const t = line.trim();
    if (t === "" || t.startsWith("--")) tailLines.push(line);
    else break;
  }
  const tail = tailLines.reverse().join("\n");
  for (const text of [statement, tail]) {
    for (const line of text.split("\n")) {
      const m = ALLOW.exec(line);
      if (m) for (const r of m[1]!.split(",")) allowed.add(r.trim().toLowerCase());
    }
  }
  return allowed;
}

/**
 * Statements are checked separately. A function body ($$ ... $$) is skipped: its contents run
 * later and are reviewed as code. A SECURITY DEFINER function itself is flagged, because it
 * runs with its owner's powers.
 */
export function checkMigrationSql(sql: string): SafetyIssue[] {
  const statements = splitStatements(sql);
  const issues: SafetyIssue[] = [];
  statements.forEach((statement, i) => {
    const code = codeOnly(statement);
    if (!code.trim()) return;
    const allowed = allowedRules(statement, statements[i - 1]);
    for (const r of RULES) {
      if (r.pattern.test(code) && !allowed.has(r.rule)) {
        issues.push({ rule: r.rule, statement: i + 1, sql: firstLine(statement), why: r.why });
      }
    }
  });
  return issues;
}

function firstLine(statement: string): string {
  const line = statement.split("\n").find((l) => l.trim() && !l.trim().startsWith("--")) ?? statement;
  return line.trim().slice(0, 160);
}
