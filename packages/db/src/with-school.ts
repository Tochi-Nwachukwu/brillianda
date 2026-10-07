import { isUuid } from "@brillianda/core";
import { sql } from "drizzle-orm";
import type { Database, Tx } from "./client.js";

export class InvalidSchoolIdError extends Error {
  constructor() {
    super("withSchool() needs a valid school id");
    this.name = "InvalidSchoolIdError";
  }
}

/**
 * Runs `run` inside a transaction scoped to one school.
 *
 * `set_config(..., true)` makes the setting TRANSACTION-local, so a pooled connection never
 * carries one school's id into the next request. This holds under transaction-mode pooling
 * (PgBouncer, Neon's pooler). Never change the third argument to false.
 *
 * Every row-level-security policy compares school_id to app_current_school_id(), which reads
 * this setting. Outside withSchool() the setting is empty and school tables return nothing.
 */
export async function withSchool<T>(db: Database, schoolId: string, run: (tx: Tx) => Promise<T>): Promise<T> {
  if (!isUuid(schoolId)) throw new InvalidSchoolIdError();
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.school_id', ${schoolId}, true)`);
    return run(tx);
  });
}
