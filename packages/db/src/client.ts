import { drizzle } from "drizzle-orm/node-postgres";
import type { NodePgDatabase, NodePgTransaction } from "drizzle-orm/node-postgres";
import type { ExtractTablesWithRelations } from "drizzle-orm";
import pg from "pg";
import * as schema from "./schema/index.js";

export type Schema = typeof schema;
export type Database = NodePgDatabase<Schema> & { $client: pg.Pool };
export type Tx = NodePgTransaction<Schema, ExtractTablesWithRelations<Schema>>;
/** Anything a query can run on: the root client or a transaction. */
export type Executor = Database | Tx;

export interface DatabaseOptions {
  /** Pool size per process. Keep small: the pooler (PgBouncer/Neon) multiplexes. */
  max?: number;
  applicationName?: string;
  /** Called when an idle pooled connection dies. Log it; the pool recovers on its own. */
  onIdleError?: (err: Error) => void;
}

/**
 * Creates the API's database handle. Connect as brillianda_app (DATABASE_URL).
 * Uses node-postgres over TCP, which supports the interactive transactions withSchool needs.
 * Do NOT swap in an HTTP driver (e.g. neon-http): it cannot hold a transaction open.
 */
export function createDatabase(url: string, options: DatabaseOptions = {}): Database {
  const pool = new pg.Pool({
    connectionString: url,
    max: options.max ?? 10,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 5_000,
    application_name: options.applicationName ?? "brillianda-api",
    // Hard stops so one slow query cannot pin a pooled connection.
    statement_timeout: 15_000,
    idle_in_transaction_session_timeout: 15_000,
  });
  // An idle client can be killed under us (failover, pooler restart, admin terminate). Without a
  // listener, node-postgres re-emits that as an unhandled 'error' and the process crashes.
  // The pool discards the dead client and the next checkout opens a fresh one.
  pool.on("error", (err) => {
    options.onIdleError?.(err);
  });
  return drizzle({ client: pool, schema, casing: "snake_case" }) as Database;
}

export async function closeDatabase(db: Database): Promise<void> {
  await db.$client.end();
}
