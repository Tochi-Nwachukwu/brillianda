import { sql } from "drizzle-orm";
import { customType, pgPolicy, pgRole, timestamp, uuid } from "drizzle-orm/pg-core";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { uuidv7 } from "uuidv7";

/** Role names. Created by scripts/bootstrap.ts; drizzle-kit never creates or alters them. */
export const ROLE_OWNER = "brillianda_owner";
export const ROLE_APP = "brillianda_app";
export const ROLE_PLATFORM = "brillianda_platform";
export const ROLE_BACKUP = "brillianda_backup";

/** The API's login role: not a superuser, no BYPASSRLS, owns no table. */
export const appRole = pgRole(ROLE_APP).existing();
/** NOLOGIN role that owns the few SECURITY DEFINER functions which must read across schools. */
export const platformRole = pgRole(ROLE_PLATFORM).existing();

/** Case-insensitive text (emails, subdomains). Requires the citext extension (migration 0000). */
export const citext = customType<{ data: string }>({
  dataType: () => "citext",
});

/** UUIDv7 primary key generated in the app: sorts by creation time, reveals no counts. */
export const id = () =>
  uuid()
    .primaryKey()
    .$defaultFn(() => uuidv7());

export const createdAt = () => timestamp({ withTimezone: true }).notNull().defaultNow();
export const updatedAt = () =>
  timestamp({ withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());

/**
 * The tenant policy every school table carries. The setting is transaction-local
 * (see withSchool). An unset or wrong school matches no rows and refuses writes.
 */
export const schoolIsolation = (schoolId: AnyPgColumn) =>
  pgPolicy("school_isolation", {
    as: "permissive",
    for: "all",
    to: appRole,
    using: sql`${schoolId} = app_current_school_id()`,
    withCheck: sql`${schoolId} = app_current_school_id()`,
  });

/**
 * Lets the nightly backup (pg_dump --enable-row-security, connected as brillianda_backup) read
 * every school's rows. Read-only: the role has SELECT and nothing else. Same current_user
 * pattern as platformAccess, for the same reason.
 */
export const backupRead = () =>
  pgPolicy("backup_read", {
    as: "permissive",
    for: "select",
    to: "public",
    using: sql`current_user = ${sql.raw(`'${ROLE_BACKUP}'`)}`,
  });

/**
 * Lets the platform SECURITY DEFINER functions read (and for sessions, delete) across schools.
 *
 * Deliberately checks current_user instead of `TO brillianda_platform`: a `TO role` policy also
 * applies to every MEMBER of that role, and the owner role must be a member (to hand function
 * ownership over in migrations). Inside a SECURITY DEFINER function current_user is the
 * function's owner, so only those functions match.
 */
export const platformAccess = (forCommand: "select" | "delete") =>
  pgPolicy(`platform_${forCommand}`, {
    as: "permissive",
    for: forCommand,
    to: "public",
    using: sql`current_user = ${sql.raw(`'${ROLE_PLATFORM}'`)}`,
  });
