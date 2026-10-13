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
import { boolean, check, date, foreignKey, index, integer, jsonb, pgEnum, pgTable, smallint, text, timestamp, unique, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { citext } from "./columns.js";
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
    /**
     * One sentence for people ("Set the 2026/2027 calendar"), shown on Home and in the change
     * history. Null for entries that are not changes to the school's records (sign-ins).
     */
    summary: text(),
    ip: text(),
    userAgent: text(),
    createdAt: createdAt(),
  },
  (t) => [
    unique("audit_log_school_id_id_key").on(t.schoolId, t.id),
    index("audit_log_school_created_idx").on(t.schoolId, t.createdAt.desc()),
    index("audit_log_school_entity_idx").on(t.schoolId, t.entity, t.entityId),
    index("audit_log_school_changes_idx").on(t.schoolId, t.createdAt.desc()).where(sql`${t.summary} IS NOT NULL`),
    schoolIsolation(t.schoolId),
    backupRead(),
  ],
).enableRLS();

/**
 * Admin invitations (owner-only). The emailed link carries a random token; only its HMAC is
 * stored. Lookup happens on the school's own host, inside withSchool, so a token can only ever
 * be redeemed at the school that issued it.
 */
export const invitations = pgTable(
  "invitations",
  {
    id: id(),
    schoolId: schoolId(),
    email: citext().notNull(),
    role: memberRole().notNull(),
    tokenHash: text().notNull().unique(),
    invitedBy: uuid().references(() => users.id, { onDelete: "set null" }),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    acceptedAt: timestamp({ withTimezone: true }),
    acceptedUserId: uuid().references(() => users.id, { onDelete: "set null" }),
    revokedAt: timestamp({ withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    createdBy: uuid(),
    updatedBy: uuid(),
  },
  (t) => [
    unique("invitations_school_id_id_key").on(t.schoolId, t.id),
    // At most one open invitation per email per school.
    uniqueIndex("invitations_one_open_idx")
      .on(t.schoolId, t.email)
      .where(sql`${t.acceptedAt} IS NULL AND ${t.revokedAt} IS NULL`),
    index("invitations_school_created_idx").on(t.schoolId, t.createdAt.desc()),
    schoolIsolation(t.schoolId),
    backupRead(),
  ],
).enableRLS();

/**
 * A school year, e.g. 2026/2027 (plan: "Academic calendar"). Signup creates the first one with
 * suggested dates and confirmedAt null; the setup checklist's calendar step is done once an owner
 * or admin saves it. One current session per school.
 */
export const academicSessions = pgTable(
  "academic_sessions",
  {
    id: id(),
    schoolId: schoolId(),
    /** The year it starts in: 2026 for 2026/2027. */
    startYear: integer().notNull(),
    name: text().notNull(),
    startsOn: date({ mode: "string" }).notNull(),
    endsOn: date({ mode: "string" }).notNull(),
    isCurrent: boolean().notNull().default(false),
    /** Null while the dates are only suggestions. */
    confirmedAt: timestamp({ withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    createdBy: uuid(),
    updatedBy: uuid(),
  },
  (t) => [
    unique("academic_sessions_school_id_id_key").on(t.schoolId, t.id),
    unique("academic_sessions_school_year_key").on(t.schoolId, t.startYear),
    uniqueIndex("academic_sessions_one_current_idx").on(t.schoolId).where(sql`${t.isCurrent}`),
    check("academic_sessions_dates_check", sql`${t.endsOn} > ${t.startsOn}`),
    schoolIsolation(t.schoolId),
    backupRead(),
  ],
).enableRLS();

/** Two or three terms per session, in order. Renamed freely (First Term, Autumn Term, ...). */
export const terms = pgTable(
  "terms",
  {
    id: id(),
    schoolId: schoolId(),
    sessionId: uuid().notNull(),
    name: text().notNull(),
    /** 1, 2 or 3. */
    position: smallint().notNull(),
    startsOn: date({ mode: "string" }).notNull(),
    endsOn: date({ mode: "string" }).notNull(),
    isCurrent: boolean().notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    createdBy: uuid(),
    updatedBy: uuid(),
  },
  (t) => [
    unique("terms_school_id_id_key").on(t.schoolId, t.id),
    unique("terms_session_position_key").on(t.schoolId, t.sessionId, t.position),
    foreignKey({
      name: "terms_session_fk",
      columns: [t.schoolId, t.sessionId],
      foreignColumns: [academicSessions.schoolId, academicSessions.id],
    }).onDelete("cascade"),
    uniqueIndex("terms_one_current_idx").on(t.schoolId).where(sql`${t.isCurrent}`),
    check("terms_position_check", sql`${t.position} between 1 and 3`),
    check("terms_dates_check", sql`${t.endsOn} > ${t.startsOn}`),
    schoolIsolation(t.schoolId),
    backupRead(),
  ],
).enableRLS();

export const classSection = pgEnum("class_section", ["preschool", "primary", "junior", "senior"]);
export const department = pgEnum("department", ["science", "arts", "commercial"]);

/**
 * The school's ladder of class levels, youngest first (plan: "The class ladder"). Position orders
 * the ladder so promotion later knows JSS 3 leads to SS 1. `key` is the ladder place
 * ("jss1") for generated levels, null for ones the school added (Year 13, Pre-JSS).
 */
export const classLevels = pgTable(
  "class_levels",
  {
    id: id(),
    schoolId: schoolId(),
    key: text(),
    name: text().notNull(),
    shortName: text().notNull(),
    section: classSection().notNull(),
    position: integer().notNull(),
    /** Other spellings for import matching (JSS1, JS1, Year 7). Filled by the import phase. */
    aliases: text().array().notNull().default(sql`'{}'::text[]`),
    archivedAt: timestamp({ withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    createdBy: uuid(),
    updatedBy: uuid(),
  },
  (t) => [
    unique("class_levels_school_id_id_key").on(t.schoolId, t.id),
    unique("class_levels_school_position_key").on(t.schoolId, t.position),
    uniqueIndex("class_levels_school_name_idx").on(t.schoolId, sql`lower(${t.name})`),
    schoolIsolation(t.schoolId),
    backupRead(),
  ],
).enableRLS();

/** Arm names, kept once per school, so renaming Daisy renames it in every class (plan: "Arms"). */
export const arms = pgTable(
  "arms",
  {
    id: id(),
    schoolId: schoolId(),
    name: text().notNull(),
    /** Short code for tight screens: Anthurium → ANT. */
    code: text().notNull(),
    position: integer().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    createdBy: uuid(),
    updatedBy: uuid(),
  },
  (t) => [
    unique("arms_school_id_id_key").on(t.schoolId, t.id),
    uniqueIndex("arms_school_name_idx").on(t.schoolId, sql`lower(${t.name})`),
    unique("arms_school_code_key").on(t.schoolId, t.code),
    schoolIsolation(t.schoolId),
    backupRead(),
  ],
).enableRLS();

/** One class: a level and an arm (JSS 1 Gold). Students will sit in these. */
export const classArms = pgTable(
  "class_arms",
  {
    id: id(),
    schoolId: schoolId(),
    classLevelId: uuid().notNull(),
    armId: uuid().notNull(),
    /** Senior classes only: subject defaults follow the arm's department. */
    department: department(),
    archivedAt: timestamp({ withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    createdBy: uuid(),
    updatedBy: uuid(),
  },
  (t) => [
    unique("class_arms_school_id_id_key").on(t.schoolId, t.id),
    unique("class_arms_level_arm_key").on(t.schoolId, t.classLevelId, t.armId),
    foreignKey({ name: "class_arms_level_fk", columns: [t.schoolId, t.classLevelId], foreignColumns: [classLevels.schoolId, classLevels.id] }),
    foreignKey({ name: "class_arms_arm_fk", columns: [t.schoolId, t.armId], foreignColumns: [arms.schoolId, arms.id] }),
    index("class_arms_school_arm_idx").on(t.schoolId, t.armId),
    schoolIsolation(t.schoolId),
    backupRead(),
  ],
).enableRLS();
