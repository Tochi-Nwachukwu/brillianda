/**
 * School tables. Every one of them:
 *   - has school_id NOT NULL, leading its main indexes
 *   - has unique (school_id, id) so children can use composite foreign keys
 *   - carries the school_isolation policy, with RLS enabled AND forced (migration 0002)
 *   - carries backup_read, so the nightly backup can read it (and nobody else gains anything)
 *   - is covered by test/isolation.test.ts and test/rls-coverage.test.ts
 *
 * Checklist for a new school table: see .claude/skills/brillianda-tenancy/SKILL.md.
 */
import { sql } from "drizzle-orm";
import { foreignKey, index, jsonb, pgEnum, pgTable, text, timestamp, unique, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { backupRead, createdAt, id, platformAccess, schoolIsolation, updatedAt } from "./columns.js";
import { schools, users } from "./platform.js";

const schoolId = () =>
  uuid()
    .notNull()
    .references(() => schools.id, { onDelete: "cascade" });

export const memberRole = pgEnum("member_role", ["owner", "admin"]);
export const memberStatus = pgEnum("member_status", ["active", "suspended"]);

export const schoolMembers = pgTable(
  "school_members",
  {
    id: id(),
    schoolId: schoolId(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: memberRole().notNull(),
    status: memberStatus().notNull().default("active"),
    invitedBy: uuid().references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    createdBy: uuid(),
    updatedBy: uuid(),
  },
  (t) => [
    unique("school_members_school_id_id_key").on(t.schoolId, t.id),
    unique("school_members_school_user_key").on(t.schoolId, t.userId),
    // One owner per school.
    uniqueIndex("school_members_one_owner_idx").on(t.schoolId).where(sql`${t.role} = 'owner'`),
    index("school_members_user_idx").on(t.userId),
    schoolIsolation(t.schoolId),
    backupRead(),
    platformAccess("select"),
  ],
).enableRLS();

/**
 * A session belongs to a user IN a school. A token minted on surebloom.brillianda.com
 * is invisible when presented to any other school, because the lookup runs under RLS.
 */
export const sessions = pgTable(
  "sessions",
  {
    id: id(),
    schoolId: schoolId(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** HMAC-SHA256 of the cookie token. The token itself is never stored. */
    tokenHash: text().notNull().unique(),
    createdAt: createdAt(),
    lastSeenAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    /** Sliding expiry, pushed forward on use. */
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    /** Hard cap regardless of activity. */
    absoluteExpiresAt: timestamp({ withTimezone: true }).notNull(),
    ip: text(),
    userAgent: text(),
  },
  (t) => [
    unique("sessions_school_id_id_key").on(t.schoolId, t.id),
    foreignKey({
      name: "sessions_membership_fk",
      columns: [t.schoolId, t.userId],
      foreignColumns: [schoolMembers.schoolId, schoolMembers.userId],
    }).onDelete("cascade"),
    index("sessions_school_user_idx").on(t.schoolId, t.userId),
    index("sessions_expires_idx").on(t.expiresAt),
    schoolIsolation(t.schoolId),
    backupRead(),
    platformAccess("select"),
    platformAccess("delete"),
  ],
).enableRLS();

/** Append-only: the app role may INSERT and SELECT, nothing more (migration 0002). */
export const auditLog = pgTable(
  "audit_log",
  {
    id: id(),
    schoolId: schoolId(),
    actorUserId: uuid(),
    action: text().notNull(),
    entity: text().notNull(),
    entityId: uuid(),
    changes: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    ip: text(),
    userAgent: text(),
    createdAt: createdAt(),
  },
  (t) => [
    unique("audit_log_school_id_id_key").on(t.schoolId, t.id),
    index("audit_log_school_created_idx").on(t.schoolId, t.createdAt.desc()),
    index("audit_log_school_entity_idx").on(t.schoolId, t.entity, t.entityId),
    schoolIsolation(t.schoolId),
    backupRead(),
  ],
).enableRLS();
