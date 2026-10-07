/**
 * The production migration path (pnpm db:migrate). Wraps drizzle's migrator with:
 *
 *   - a plan: which migrations are pending, printed before anything runs (--plan stops there)
 *   - the safety guard on every pending file, again, right before it runs
 *   - a snapshot: on any non-local database, an instant Neon branch of the current state is
 *     created first, so a bad migration is undone by restoring that branch
 *   - one migrator at a time (advisory lock), and lock_timeout so a migration waiting on a busy
 *     table gives up instead of freezing every request behind it
 */
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { readFileSync } from "node:fs";
import pg from "pg";
import { MIGRATIONS_FOLDER } from "./admin.js";
import { checkMigrationSql } from "./migration-safety.js";
import { ROLE_APP, ROLE_BACKUP, ROLE_PLATFORM } from "./schema/columns.js";

export interface JournalEntry {
  idx: number;
  tag: string;
  when: number;
}

export function readJournal(folder = MIGRATIONS_FOLDER): JournalEntry[] {
  const journal = JSON.parse(readFileSync(`${folder}/meta/_journal.json`, "utf8")) as { entries: JournalEntry[] };
  return journal.entries;
}

/** Same rule drizzle uses: a migration is pending if its folder timestamp is newer than the last applied one. */
export async function pendingMigrations(client: pg.Client, folder = MIGRATIONS_FOLDER): Promise<JournalEntry[]> {
  const table = await client.query(`select to_regclass('drizzle.__drizzle_migrations') as t`);
  const entries = readJournal(folder);
  if (!table.rows[0]?.t) return entries;
  const last = await client.query<{ created_at: string }>(
    `select created_at from drizzle.__drizzle_migrations order by created_at desc limit 1`,
  );
  const lastWhen = Number(last.rows[0]?.created_at ?? 0);
  return entries.filter((e) => e.when > lastWhen);
}

export function isLocalDatabase(url: string): boolean {
  const host = new URL(url).hostname;
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host.endsWith(".localhost");
}

export interface SnapshotConfig {
  apiKey: string;
  projectId: string;
  /** The branch this database lives on. Defaults to the project's default branch. */
  branchId?: string;
  /** How long to keep the snapshot. */
  keepDays: number;
}

/** Creates an instant copy-on-write Neon branch of the current state. Returns its name. */
export async function createNeonSnapshot(cfg: SnapshotConfig, label: string): Promise<string> {
  const api = `https://console.neon.tech/api/v2/projects/${encodeURIComponent(cfg.projectId)}`;
  const headers = { Accept: "application/json", "Content-Type": "application/json", Authorization: `Bearer ${cfg.apiKey}` };

  let parentId = cfg.branchId;
  if (!parentId) {
    const res = await fetch(`${api}/branches`, { headers });
    if (!res.ok) throw new Error(`Neon: listing branches failed (${res.status}) ${await res.text()}`);
    const body = (await res.json()) as { branches: { id: string; default?: boolean; primary?: boolean }[] };
    parentId = body.branches.find((b) => b.default ?? b.primary)?.id;
    if (!parentId) throw new Error("Neon: no default branch found; set NEON_BRANCH_ID");
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const name = `pre-migrate-${stamp}-${label}`.slice(0, 120);
  const created = await fetch(`${api}/branches`, {
    method: "POST",
    headers,
    body: JSON.stringify({ branch: { parent_id: parentId, name } }),
  });
  if (!created.ok) throw new Error(`Neon: creating snapshot branch failed (${created.status}) ${await created.text()}`);
  const { branch } = (await created.json()) as { branch: { id: string } };

  const expiresAt = new Date(Date.now() + cfg.keepDays * 86_400_000).toISOString();
  const patched = await fetch(`${api}/branches/${branch.id}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ branch: { expires_at: expiresAt } }),
  });
  if (!patched.ok) {
    // Not fatal: the snapshot exists, it just will not clean itself up.
    console.warn(`Neon: could not set expiry on ${name} (${patched.status}); delete it by hand later.`);
  }
  return name;
}

export interface MigrateOptions {
  ownerUrl: string;
  planOnly?: boolean;
  snapshot?: SnapshotConfig;
  /** Explicit, logged reason to run against a non-local database without a snapshot. */
  skipSnapshotReason?: string;
  log?: (line: string) => void;
  /** Tests only. */
  migrationsFolder?: string;
  /** Tests only: override local/remote detection. */
  location?: "local" | "remote";
}

export async function migrateSafely(opts: MigrateOptions): Promise<{ applied: string[]; snapshot?: string }> {
  const log = opts.log ?? console.log;
  const folder = opts.migrationsFolder ?? MIGRATIONS_FOLDER;
  const local = opts.location ? opts.location === "local" : isLocalDatabase(opts.ownerUrl);
  const client = new pg.Client({ connectionString: opts.ownerUrl });
  await client.connect();
  try {
    // One migrator at a time, cluster-wide. Waits, so a second deploy simply queues.
    await client.query("select pg_advisory_lock(hashtext('brillianda:migrate'))");

    // Migrations grant to roles that only bootstrap can create (it needs CREATEROLE).
    const roles = await client.query<{ rolname: string }>(
      `select rolname from pg_roles where rolname = any($1::text[])`,
      [[ROLE_APP, ROLE_PLATFORM, ROLE_BACKUP]],
    );
    const missingRoles = [ROLE_APP, ROLE_PLATFORM, ROLE_BACKUP].filter((r) => !roles.rows.some((x) => x.rolname === r));
    if (missingRoles.length) {
      throw new Error(`Missing database roles: ${missingRoles.join(", ")}. Run pnpm db:bootstrap against this server first.`);
    }

    const pending = await pendingMigrations(client, folder);
    const db = new URL(opts.ownerUrl);
    log(`Database: ${db.hostname}${db.pathname} (${local ? "local" : "REMOTE"})`);
    if (!pending.length) {
      log("Nothing to migrate: the database is up to date.");
      return { applied: [] };
    }
    log(`Pending (${pending.length}):`);
    for (const m of pending) log(`  • ${m.tag}`);

    const blocked = pending.flatMap((m) =>
      checkMigrationSql(readFileSync(`${folder}/${m.tag}.sql`, "utf8")).map((i) => `${m.tag} [${i.rule}] ${i.sql}`),
    );
    if (blocked.length) {
      throw new Error(`Refusing to migrate: unmarked unsafe statements.\n  ${blocked.join("\n  ")}\nRun pnpm db:check for details.`);
    }

    if (opts.planOnly) {
      log("Plan only (--plan): nothing was applied.");
      return { applied: [] };
    }

    let snapshot: string | undefined;
    if (!local) {
      if (opts.snapshot) {
        log("Taking a Neon snapshot branch before migrating...");
        snapshot = await createNeonSnapshot(opts.snapshot, pending.at(-1)!.tag.replace(/^\d+_/, ""));
        log(`Snapshot: ${snapshot} (kept ${opts.snapshot.keepDays} days). To undo, restore the database from this branch.`);
      } else if (opts.skipSnapshotReason) {
        log(`WARNING: migrating a remote database WITHOUT a snapshot. Reason given: ${opts.skipSnapshotReason}`);
      } else {
        throw new Error(
          "Refusing to migrate a remote database without a snapshot.\n" +
            "Set NEON_API_KEY and NEON_PROJECT_ID (and NEON_BRANCH_ID if not the default branch),\n" +
            'or, for a throwaway database only, pass --no-snapshot="<reason>".',
        );
      }
    }

    // Fail fast instead of queueing every request behind a migration waiting on a lock.
    await client.query("set lock_timeout = '5s'");
    await client.query("set statement_timeout = '10min'");
    const pool = new pg.Pool({
      connectionString: opts.ownerUrl,
      max: 1,
      options: "-c lock_timeout=5s -c statement_timeout=10min",
    });
    try {
      await migrate(drizzle({ client: pool }), { migrationsFolder: folder });
    } finally {
      await pool.end();
    }

    const still = await pendingMigrations(client, folder);
    if (still.length) throw new Error(`Migrations ran but ${still.length} still look pending: ${still.map((m) => m.tag).join(", ")}`);
    log(`Applied ${pending.length} migration(s).`);
    return { applied: pending.map((m) => m.tag), ...(snapshot ? { snapshot } : {}) };
  } finally {
    await client.query("select pg_advisory_unlock_all()").catch(() => {});
    await client.end();
  }
}
