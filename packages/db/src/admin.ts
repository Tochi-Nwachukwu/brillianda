/**
 * Cluster-level setup and migrations. Used by scripts/ and by the test harness.
 * Never imported by the API at runtime.
 */
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { ROLE_APP, ROLE_BACKUP, ROLE_OWNER, ROLE_PLATFORM } from "./schema/columns.js";

export const MIGRATIONS_FOLDER = fileURLToPath(new URL("../migrations", import.meta.url));

const IDENT = /^[a-z_][a-z0-9_]{0,62}$/;

export interface BootstrapOptions {
  adminUrl: string;
  dbName: string;
  ownerPassword: string;
  appPassword: string;
  /** When set, brillianda_backup can log in (for the nightly pg_dump). Otherwise it stays NOLOGIN. */
  backupPassword?: string;
}

/** Builds a connection URL for another role/database on the same server as `baseUrl`. */
export function deriveUrl(baseUrl: string, user: string, password: string, dbName: string): string {
  const url = new URL(baseUrl);
  url.username = encodeURIComponent(user);
  url.password = encodeURIComponent(password);
  url.pathname = `/${dbName}`;
  return url.toString();
}

async function withClient<T>(url: string, run: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await run(client);
  } finally {
    await client.end();
  }
}

/**
 * Creates (or updates) the three roles and the database. Idempotent.
 *
 *   brillianda_owner     LOGIN. Owns the database and every table. Runs migrations. Never used by the API.
 *   brillianda_app       LOGIN. What the API connects as. No SUPERUSER, no BYPASSRLS, owns nothing.
 *   brillianda_platform  NOLOGIN. Owns the SECURITY DEFINER functions that read across schools.
 *   brillianda_backup    Read-only. LOGIN only when a backup password is given. Used by pg_dump.
 */
export async function bootstrapCluster(opts: BootstrapOptions): Promise<void> {
  if (!IDENT.test(opts.dbName)) throw new Error(`Invalid database name: ${opts.dbName}`);

  await withClient(opts.adminUrl, async (client) => {
    // Role changes are cluster-wide. Parallel test files (or two deploys) bootstrapping at once
    // would race on the same pg_authid rows ("tuple concurrently updated"), so take turns.
    // Session-level lock: released explicitly below, or by Postgres when the connection closes.
    await client.query("select pg_advisory_lock(hashtext('brillianda:bootstrap'))");
    try {
      await bootstrapLocked(client, opts);
    } finally {
      await client.query("select pg_advisory_unlock(hashtext('brillianda:bootstrap'))");
    }
  });
}

async function bootstrapLocked(client: pg.Client, opts: BootstrapOptions): Promise<void> {
  {
    const lit = (v: string) => client.escapeLiteral(v);
    const versionRow = await client.query<{ v: number }>("select current_setting('server_version_num')::int as v");
    const version = versionRow.rows[0]?.v ?? 0;
    if (version < 150000) throw new Error(`Postgres 15+ required (found ${version}); 16+ recommended`);

    // Attributes are set on CREATE only. On a re-run only the password is updated: a
    // non-superuser admin (managed Postgres) may not touch BYPASSRLS/REPLICATION at all,
    // not even to restate NO.
    const ensureRole = async (name: string, attrs: string, password?: string) => {
      const exists = await client.query("select 1 from pg_roles where rolname = $1", [name]);
      const pw = password === undefined ? "" : ` PASSWORD ${lit(password)}`;
      if (!exists.rowCount) {
        await client.query(`CREATE ROLE ${name} WITH ${attrs}${pw}`);
      } else if (pw) {
        await client.query(`ALTER ROLE ${name} WITH${pw}`);
      }
    };

    const safe = "NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS";
    await ensureRole(ROLE_OWNER, `LOGIN NOINHERIT ${safe}`, opts.ownerPassword);
    await ensureRole(ROLE_APP, `LOGIN NOINHERIT ${safe}`, opts.appPassword);
    await ensureRole(ROLE_PLATFORM, `NOLOGIN ${safe}`);
    await ensureRole(ROLE_BACKUP, `NOLOGIN NOINHERIT ${safe}`);
    if (opts.backupPassword) {
      await client.query(`ALTER ROLE ${ROLE_BACKUP} WITH LOGIN PASSWORD ${lit(opts.backupPassword)}`);
    }

    // The owner must be able to hand function ownership to the platform role (ALTER FUNCTION
    // ... OWNER TO), but must NOT inherit its cross-school read policies.
    if (version >= 160000) {
      await client.query(`GRANT ${ROLE_PLATFORM} TO ${ROLE_OWNER} WITH INHERIT FALSE, SET TRUE`);
    } else {
      await client.query(`GRANT ${ROLE_PLATFORM} TO ${ROLE_OWNER}`);
      await client.query(`ALTER ROLE ${ROLE_OWNER} NOINHERIT`);
    }

    // Managed Postgres (Neon, RDS, Supabase) gives you a CREATEROLE admin, not a superuser.
    // Since PG16 such an admin can manage the roles it created but not ACT as them, and
    // CREATE DATABASE ... OWNER needs to. Grant the admin SET (not INHERIT) on the owner role:
    // it can switch to it deliberately, but never silently gains the owner's privileges.
    const su = await client.query<{ rolsuper: boolean }>("select rolsuper from pg_roles where rolname = current_user");
    const isSuperuser = su.rows[0]?.rolsuper === true;
    if (!isSuperuser) {
      await client.query(
        version >= 160000
          ? `GRANT ${ROLE_OWNER} TO CURRENT_USER WITH INHERIT FALSE, SET TRUE`
          : `GRANT ${ROLE_OWNER} TO CURRENT_USER`,
      );
    }

    const db = await client.query("select 1 from pg_database where datname = $1", [opts.dbName]);
    if (!db.rowCount) {
      await client.query(`CREATE DATABASE ${opts.dbName} OWNER ${ROLE_OWNER}`);
    }
    // Database-level grants belong to its owner, so make them as the owner.
    await client.query(`SET ROLE ${ROLE_OWNER}`);
    try {
      await client.query(`REVOKE ALL ON DATABASE ${opts.dbName} FROM PUBLIC`);
      await client.query(`GRANT CONNECT ON DATABASE ${opts.dbName} TO ${ROLE_APP}, ${ROLE_BACKUP}`);
    } finally {
      await client.query("RESET ROLE");
    }
  }
}

export async function dropDatabase(adminUrl: string, dbName: string): Promise<void> {
  if (!IDENT.test(dbName)) throw new Error(`Invalid database name: ${dbName}`);
  await withClient(adminUrl, async (client) => {
    await client.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  });
}

/** Applies every migration in packages/db/migrations, connected as the owner role. */
export async function runMigrations(ownerUrl: string): Promise<void> {
  const pool = new pg.Pool({ connectionString: ownerUrl, max: 1 });
  try {
    await migrate(drizzle({ client: pool }), { migrationsFolder: MIGRATIONS_FOLDER });
  } finally {
    await pool.end();
  }
}
