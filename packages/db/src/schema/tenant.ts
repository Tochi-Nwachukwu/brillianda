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
import { boolean, check, date, foreignKey, index, integer, jsonb, numeric, pgEnum, pgTable, smallint, text, timestamp, unique, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { bytea, citext } from "./columns.js";
import { backupRead, createdAt, id, platformAccess, schoolIsolation, updatedAt } from "./columns.js";
import { schools, users } from "./platform.js";

const schoolId = () =>
  uuid()
    .notNull()
    .references(() => schools.id, { onDelete: "cascade" });

/**
 * owner and admin run the school; teacher takes registers and (later) enters scores (C1); parent
 * follows their own children, through a guardian record (C2, parent_links).
 */
export const memberRole = pgEnum("member_role", ["owner", "admin", "teacher", "parent"]);
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
    /** For actors who aren't school users: the Brillianda team ("Ada Okoro (Brillianda)"). */
    actorName: text(),
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
    /** The invitee's name as the inviter typed it (optional); greets them and labels the open invite. */
    fullName: text(),
    role: memberRole().notNull(),
    /** Parent invitations only: the guardian record the account will follow. */
    guardianId: uuid(),
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
    index("invitations_school_guardian_idx").on(t.schoolId, t.guardianId),
    // role::text: the new enum value can't be used in the migration that adds it (one transaction).
    check("invitations_parent_guardian_check", sql`(${t.role}::text = 'parent') = (${t.guardianId} IS NOT NULL)`),
    schoolIsolation(t.schoolId),
    backupRead(),
    platformAccess("select"),
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
    platformAccess("select"),
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
    platformAccess("select"),
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
    platformAccess("select"),
  ],
).enableRLS();

export const subjectLinkKind = pgEnum("subject_link_kind", ["compulsory", "elective"]);

/**
 * The subjects a school teaches (plan: "How a school sets subjects"): from the national catalogue
 * (catalogueId, kept through renames) or its own (catalogueId null). The catalogue itself lives in
 * packages/core (docs/decisions.md #5).
 */
export const schoolSubjects = pgTable(
  "school_subjects",
  {
    id: id(),
    schoolId: schoolId(),
    catalogueId: text(),
    name: text().notNull(),
    code: text().notNull(),
    position: integer().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    createdBy: uuid(),
    updatedBy: uuid(),
  },
  (t) => [
    unique("school_subjects_school_id_id_key").on(t.schoolId, t.id),
    uniqueIndex("school_subjects_school_name_idx").on(t.schoolId, sql`lower(${t.name})`),
    unique("school_subjects_school_code_key").on(t.schoolId, t.code),
    uniqueIndex("school_subjects_school_catalogue_idx").on(t.schoolId, t.catalogueId).where(sql`${t.catalogueId} IS NOT NULL`),
    schoolIsolation(t.schoolId),
    backupRead(),
    platformAccess("select"),
  ],
).enableRLS();

/** Which class levels take a subject, compulsory or elective; senior electives may carry a department. */
export const classLevelSubjects = pgTable(
  "class_level_subjects",
  {
    id: id(),
    schoolId: schoolId(),
    classLevelId: uuid().notNull(),
    schoolSubjectId: uuid().notNull(),
    kind: subjectLinkKind().notNull(),
    department: department(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    createdBy: uuid(),
    updatedBy: uuid(),
  },
  (t) => [
    unique("class_level_subjects_school_id_id_key").on(t.schoolId, t.id),
    unique("class_level_subjects_pair_key").on(t.schoolId, t.classLevelId, t.schoolSubjectId),
    foreignKey({ name: "class_level_subjects_level_fk", columns: [t.schoolId, t.classLevelId], foreignColumns: [classLevels.schoolId, classLevels.id] }).onDelete("cascade"),
    foreignKey({ name: "class_level_subjects_subject_fk", columns: [t.schoolId, t.schoolSubjectId], foreignColumns: [schoolSubjects.schoolId, schoolSubjects.id] }).onDelete("cascade"),
    index("class_level_subjects_subject_idx").on(t.schoolId, t.schoolSubjectId),
    schoolIsolation(t.schoolId),
    backupRead(),
    platformAccess("select"),
  ],
).enableRLS();

export const gender = pgEnum("gender", ["male", "female"]);
export const studentStatus = pgEnum("student_status", ["active", "suspended", "withdrawn", "transferred", "graduated"]);
export const importStatus = pgEnum("import_status", ["completed", "undone"]);

/** One upload of students from a spreadsheet (plan: "How an import runs"). Undo within 24 hours. */
export const importBatches = pgTable(
  "import_batches",
  {
    id: id(),
    schoolId: schoolId(),
    fileName: text().notNull(),
    rowCount: integer().notNull(),
    createdCount: integer().notNull().default(0),
    updatedCount: integer().notNull().default(0),
    skippedCount: integer().notNull().default(0),
    /** Heading (lower case) → column id, as used for this file. */
    mapping: jsonb().$type<Record<string, string>>().notNull().default({}),
    status: importStatus().notNull().default("completed"),
    undoneAt: timestamp({ withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    createdBy: uuid(),
    updatedBy: uuid(),
  },
  (t) => [
    unique("import_batches_school_id_id_key").on(t.schoolId, t.id),
    index("import_batches_school_created_idx").on(t.schoolId, t.createdAt.desc()),
    schoolIsolation(t.schoolId),
    backupRead(),
  ],
).enableRLS();

/** A parent or guardian. Siblings share one record, found by phone (plan: "Adding one student"). */
export const guardians = pgTable(
  "guardians",
  {
    id: id(),
    schoolId: schoolId(),
    fullName: text().notNull(),
    /** E.164, e.g. +2348030000001. */
    phone: text(),
    email: citext(),
    address: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    createdBy: uuid(),
    updatedBy: uuid(),
  },
  (t) => [
    unique("guardians_school_id_id_key").on(t.schoolId, t.id),
    index("guardians_school_phone_idx").on(t.schoolId, t.phone),
    schoolIsolation(t.schoolId),
    backupRead(),
  ],
).enableRLS();

/**
 * A student (plan: "Students"). `classArmId` is the class they sit in now; `enrolments` keeps the
 * history. Soft-deleted (deletedAt) for mistakes only; leaving the school is a status.
 */
export const students = pgTable(
  "students",
  {
    id: id(),
    schoolId: schoolId(),
    admissionNumber: text().notNull(),
    firstName: text().notNull(),
    lastName: text().notNull(),
    otherNames: text().notNull().default(""),
    gender: gender().notNull(),
    dateOfBirth: date({ mode: "string" }),
    admissionDate: date({ mode: "string" }).notNull(),
    status: studentStatus().notNull().default("active"),
    classArmId: uuid().notNull(),
    photoKey: text(),
    address: text().notNull().default(""),
    stateOfOrigin: text().notNull().default(""),
    consentRecordedOn: date({ mode: "string" }),
    importBatchId: uuid(),
    deletedAt: timestamp({ withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    createdBy: uuid(),
    updatedBy: uuid(),
  },
  (t) => [
    unique("students_school_id_id_key").on(t.schoolId, t.id),
    uniqueIndex("students_school_admission_idx").on(t.schoolId, sql`lower(${t.admissionNumber})`).where(sql`${t.deletedAt} IS NULL`),
    foreignKey({ name: "students_class_arm_fk", columns: [t.schoolId, t.classArmId], foreignColumns: [classArms.schoolId, classArms.id] }),
    foreignKey({ name: "students_import_batch_fk", columns: [t.schoolId, t.importBatchId], foreignColumns: [importBatches.schoolId, importBatches.id] }),
    index("students_school_class_arm_idx").on(t.schoolId, t.classArmId),
    index("students_school_batch_idx").on(t.schoolId, t.importBatchId),
    index("students_school_name_trgm_idx").using("gin", sql`app_unaccent(${t.firstName} || ' ' || ${t.otherNames} || ' ' || ${t.lastName}) gin_trgm_ops`),
    schoolIsolation(t.schoolId),
    backupRead(),
    platformAccess("select"),
  ],
).enableRLS();

export const studentGuardians = pgTable(
  "student_guardians",
  {
    id: id(),
    schoolId: schoolId(),
    studentId: uuid().notNull(),
    guardianId: uuid().notNull(),
    relationship: text(),
    primaryContact: boolean().notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    createdBy: uuid(),
    updatedBy: uuid(),
  },
  (t) => [
    unique("student_guardians_school_id_id_key").on(t.schoolId, t.id),
    unique("student_guardians_pair_key").on(t.schoolId, t.studentId, t.guardianId),
    foreignKey({ name: "student_guardians_student_fk", columns: [t.schoolId, t.studentId], foreignColumns: [students.schoolId, students.id] }).onDelete("cascade"),
    foreignKey({ name: "student_guardians_guardian_fk", columns: [t.schoolId, t.guardianId], foreignColumns: [guardians.schoolId, guardians.id] }).onDelete("cascade"),
    index("student_guardians_guardian_idx").on(t.schoolId, t.guardianId),
    schoolIsolation(t.schoolId),
    backupRead(),
  ],
).enableRLS();

/** The classes a student has sat in, and from when (the student page's class history). */
export const enrolments = pgTable(
  "enrolments",
  {
    id: id(),
    schoolId: schoolId(),
    studentId: uuid().notNull(),
    classArmId: uuid().notNull(),
    sessionId: uuid(),
    startedOn: date({ mode: "string" }).notNull(),
    endedOn: date({ mode: "string" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    createdBy: uuid(),
    updatedBy: uuid(),
  },
  (t) => [
    unique("enrolments_school_id_id_key").on(t.schoolId, t.id),
    foreignKey({ name: "enrolments_student_fk", columns: [t.schoolId, t.studentId], foreignColumns: [students.schoolId, students.id] }).onDelete("cascade"),
    foreignKey({ name: "enrolments_class_arm_fk", columns: [t.schoolId, t.classArmId], foreignColumns: [classArms.schoolId, classArms.id] }),
    foreignKey({ name: "enrolments_session_fk", columns: [t.schoolId, t.sessionId], foreignColumns: [academicSessions.schoolId, academicSessions.id] }),
    index("enrolments_school_student_idx").on(t.schoolId, t.studentId),
    index("enrolments_school_class_arm_idx").on(t.schoolId, t.classArmId),
    schoolIsolation(t.schoolId),
    backupRead(),
  ],
).enableRLS();

/** Per-school running numbers (admission numbers), taken with UPDATE ... RETURNING inside the insert's transaction. */
export const counters = pgTable(
  "counters",
  {
    id: id(),
    schoolId: schoolId(),
    name: text().notNull(),
    nextValue: integer().notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("counters_school_id_id_key").on(t.schoolId, t.id),
    unique("counters_school_name_key").on(t.schoolId, t.name),
    schoolIsolation(t.schoolId),
    backupRead(),
  ],
).enableRLS();

/**
 * A school's logo, kept in Postgres (docs/decisions.md #6): at most 300 KB, re-encoded by the
 * browser and checked again by the API. Served publicly from the school's own address, because
 * the sign-in page shows it.
 */
export const schoolLogos = pgTable(
  "school_logos",
  {
    id: id(),
    schoolId: schoolId(),
    contentType: text().notNull(),
    bytes: bytea().notNull(),
    /** SHA-256 of the bytes: the version in the logo's URL, so browsers can cache it for good. */
    sha256: text().notNull(),
    width: integer().notNull(),
    height: integer().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    createdBy: uuid(),
    updatedBy: uuid(),
  },
  (t) => [
    unique("school_logos_school_id_id_key").on(t.schoolId, t.id),
    unique("school_logos_one_per_school_key").on(t.schoolId),
    schoolIsolation(t.schoolId),
    backupRead(),
  ],
).enableRLS();

/**
 * An arm's form teacher (C1): one per arm, so setting a new one replaces the old. The composite
 * key to school_members means a teacher removed from the school leaves every arm at once.
 */
export const armFormTeachers = pgTable(
  "arm_form_teachers",
  {
    id: id(),
    schoolId: schoolId(),
    classArmId: uuid().notNull(),
    userId: uuid().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    createdBy: uuid(),
    updatedBy: uuid(),
  },
  (t) => [
    unique("arm_form_teachers_school_id_id_key").on(t.schoolId, t.id),
    unique("arm_form_teachers_one_per_arm_key").on(t.schoolId, t.classArmId),
    foreignKey({ name: "arm_form_teachers_arm_fk", columns: [t.schoolId, t.classArmId], foreignColumns: [classArms.schoolId, classArms.id] }).onDelete("cascade"),
    foreignKey({ name: "arm_form_teachers_member_fk", columns: [t.schoolId, t.userId], foreignColumns: [schoolMembers.schoolId, schoolMembers.userId] }).onDelete("cascade"),
    index("arm_form_teachers_user_idx").on(t.schoolId, t.userId),
    schoolIsolation(t.schoolId),
    backupRead(),
  ],
).enableRLS();

/** Who teaches a subject in an arm (C1): one teacher per subject per arm. */
export const subjectTeachers = pgTable(
  "subject_teachers",
  {
    id: id(),
    schoolId: schoolId(),
    classArmId: uuid().notNull(),
    schoolSubjectId: uuid().notNull(),
    userId: uuid().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    createdBy: uuid(),
    updatedBy: uuid(),
  },
  (t) => [
    unique("subject_teachers_school_id_id_key").on(t.schoolId, t.id),
    unique("subject_teachers_one_per_class_key").on(t.schoolId, t.classArmId, t.schoolSubjectId),
    foreignKey({ name: "subject_teachers_arm_fk", columns: [t.schoolId, t.classArmId], foreignColumns: [classArms.schoolId, classArms.id] }).onDelete("cascade"),
    foreignKey({ name: "subject_teachers_subject_fk", columns: [t.schoolId, t.schoolSubjectId], foreignColumns: [schoolSubjects.schoolId, schoolSubjects.id] }).onDelete("cascade"),
    foreignKey({ name: "subject_teachers_member_fk", columns: [t.schoolId, t.userId], foreignColumns: [schoolMembers.schoolId, schoolMembers.userId] }).onDelete("cascade"),
    index("subject_teachers_user_idx").on(t.schoolId, t.userId),
    schoolIsolation(t.schoolId),
    backupRead(),
  ],
).enableRLS();

export const registerMark = pgEnum("register_mark", ["present", "late", "absent"]);

/**
 * One arm's register for one school day (C1). Who took it and who last changed it point at users,
 * not memberships, so a teacher's name stays on the registers they took after they leave.
 */
export const registers = pgTable(
  "registers",
  {
    id: id(),
    schoolId: schoolId(),
    classArmId: uuid().notNull(),
    day: date({ mode: "string" }).notNull(),
    takenBy: uuid().references(() => users.id, { onDelete: "set null" }),
    takenAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    changedBy: uuid().references(() => users.id, { onDelete: "set null" }),
    changedAt: timestamp({ withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    createdBy: uuid(),
    updatedBy: uuid(),
  },
  (t) => [
    unique("registers_school_id_id_key").on(t.schoolId, t.id),
    unique("registers_arm_day_key").on(t.schoolId, t.classArmId, t.day),
    foreignKey({ name: "registers_arm_fk", columns: [t.schoolId, t.classArmId], foreignColumns: [classArms.schoolId, classArms.id] }),
    index("registers_school_day_idx").on(t.schoolId, t.day),
    schoolIsolation(t.schoolId),
    backupRead(),
  ],
).enableRLS();

/** One student's mark on one register. Notes stay with the school (parents never see them). */
export const registerMarks = pgTable(
  "register_marks",
  {
    id: id(),
    schoolId: schoolId(),
    registerId: uuid().notNull(),
    studentId: uuid().notNull(),
    mark: registerMark().notNull(),
    note: text().notNull().default(""),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    createdBy: uuid(),
    updatedBy: uuid(),
  },
  (t) => [
    unique("register_marks_school_id_id_key").on(t.schoolId, t.id),
    unique("register_marks_one_per_student_key").on(t.schoolId, t.registerId, t.studentId),
    foreignKey({ name: "register_marks_register_fk", columns: [t.schoolId, t.registerId], foreignColumns: [registers.schoolId, registers.id] }).onDelete("cascade"),
    foreignKey({ name: "register_marks_student_fk", columns: [t.schoolId, t.studentId], foreignColumns: [students.schoolId, students.id] }),
    index("register_marks_student_idx").on(t.schoolId, t.studentId),
    check("register_marks_note_length_check", sql`char_length(${t.note}) <= 120`),
    schoolIsolation(t.schoolId),
    backupRead(),
  ],
).enableRLS();

/**
 * A parent's account follows a guardian record (C2): they see that guardian's children and nobody
 * else's. Composite keys mean the link goes when the membership or the guardian does.
 */
export const parentLinks = pgTable(
  "parent_links",
  {
    id: id(),
    schoolId: schoolId(),
    guardianId: uuid().notNull(),
    userId: uuid().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    createdBy: uuid(),
    updatedBy: uuid(),
  },
  (t) => [
    unique("parent_links_school_id_id_key").on(t.schoolId, t.id),
    unique("parent_links_pair_key").on(t.schoolId, t.guardianId, t.userId),
    foreignKey({ name: "parent_links_guardian_fk", columns: [t.schoolId, t.guardianId], foreignColumns: [guardians.schoolId, guardians.id] }).onDelete("cascade"),
    foreignKey({ name: "parent_links_member_fk", columns: [t.schoolId, t.userId], foreignColumns: [schoolMembers.schoolId, schoolMembers.userId] }).onDelete("cascade"),
    index("parent_links_user_idx").on(t.schoolId, t.userId),
    schoolIsolation(t.schoolId),
    backupRead(),
  ],
).enableRLS();

// ——— Results (C2) ———
// A term is keyed "<session start year>-<term number>" (e.g. "2026-1"), as the front end keys it,
// so results don't depend on whether the calendar was saved or later edited.

/** A school's score parts, grading scale and whether positions show. Defaults until saved. */
export const resultsSettings = pgTable(
  "results_settings",
  {
    id: id(),
    schoolId: schoolId(),
    components: jsonb().$type<{ id: string; name: string; maxScore: number }[]>().notNull(),
    scale: jsonb().$type<{ minScore: number; grade: string; remark: string; isPass: boolean }[]>().notNull(),
    showPositions: boolean().notNull().default(true),
    /** Behaviour ratings on report cards (C3): off until the school turns them on. */
    ratingsEnabled: boolean().notNull().default(false),
    ratingTraits: text().array().notNull().default(sql`'{}'::text[]`),
    /** Promotion's pass mark (B1); null means the scale's lowest passing grade. */
    passMark: numeric({ precision: 5, scale: 2, mode: "number" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    createdBy: uuid(),
    updatedBy: uuid(),
  },
  (t) => [unique("results_settings_school_id_id_key").on(t.schoolId, t.id), unique("results_settings_one_per_school_key").on(t.schoolId), schoolIsolation(t.schoolId), backupRead()],
).enableRLS();

/** Terms the school has closed (C5). The open term for results is the session's first not here. */
export const termClosures = pgTable(
  "term_closures",
  {
    id: id(),
    schoolId: schoolId(),
    termKey: text().notNull(),
    /** The term's name and session when it closed ("First Term", "2026/2027"), kept after the calendar moves on. */
    name: text(),
    sessionName: text(),
    closedBy: uuid().references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    createdBy: uuid(),
    updatedBy: uuid(),
  },
  (t) => [
    unique("term_closures_school_id_id_key").on(t.schoolId, t.id),
    unique("term_closures_term_key").on(t.schoolId, t.termKey),
    check("term_closures_key_shape", sql`${t.termKey} ~ '^[0-9]{4}-[1-3]$'`),
    schoolIsolation(t.schoolId),
    backupRead(),
  ],
).enableRLS();

/** One score: a student's mark for one part of one subject, in one class and term. ABS is 0 + absent. */
export const scores = pgTable(
  "scores",
  {
    id: id(),
    schoolId: schoolId(),
    termKey: text().notNull(),
    classArmId: uuid().notNull(),
    schoolSubjectId: uuid().notNull(),
    studentId: uuid().notNull(),
    /** The part's id in results_settings.components (ca1, ca2, exam, …). */
    componentId: text().notNull(),
    value: numeric({ precision: 5, scale: 2, mode: "number" }).notNull(),
    isAbsent: boolean().notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    createdBy: uuid(),
    updatedBy: uuid(),
  },
  (t) => [
    unique("scores_school_id_id_key").on(t.schoolId, t.id),
    unique("scores_cell_key").on(t.schoolId, t.termKey, t.classArmId, t.schoolSubjectId, t.studentId, t.componentId),
    foreignKey({ name: "scores_arm_fk", columns: [t.schoolId, t.classArmId], foreignColumns: [classArms.schoolId, classArms.id] }),
    foreignKey({ name: "scores_subject_fk", columns: [t.schoolId, t.schoolSubjectId], foreignColumns: [schoolSubjects.schoolId, schoolSubjects.id] }),
    foreignKey({ name: "scores_student_fk", columns: [t.schoolId, t.studentId], foreignColumns: [students.schoolId, students.id] }),
    index("scores_student_idx").on(t.schoolId, t.studentId, t.termKey),
    check("scores_value_check", sql`${t.value} >= 0 AND ${t.value} <= 100 AND (NOT ${t.isAbsent} OR ${t.value} = 0)`),
    schoolIsolation(t.schoolId),
    backupRead(),
  ],
).enableRLS();

/** An elective a student doesn't take, for one class and term: off their sheet and their average. */
export const scoreExclusions = pgTable(
  "score_exclusions",
  {
    id: id(),
    schoolId: schoolId(),
    termKey: text().notNull(),
    classArmId: uuid().notNull(),
    schoolSubjectId: uuid().notNull(),
    studentId: uuid().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    createdBy: uuid(),
    updatedBy: uuid(),
  },
  (t) => [
    unique("score_exclusions_school_id_id_key").on(t.schoolId, t.id),
    unique("score_exclusions_row_key").on(t.schoolId, t.termKey, t.classArmId, t.schoolSubjectId, t.studentId),
    foreignKey({ name: "score_exclusions_arm_fk", columns: [t.schoolId, t.classArmId], foreignColumns: [classArms.schoolId, classArms.id] }),
    foreignKey({ name: "score_exclusions_subject_fk", columns: [t.schoolId, t.schoolSubjectId], foreignColumns: [schoolSubjects.schoolId, schoolSubjects.id] }),
    foreignKey({ name: "score_exclusions_student_fk", columns: [t.schoolId, t.studentId], foreignColumns: [students.schoolId, students.id] }),
    schoolIsolation(t.schoolId),
    backupRead(),
  ],
).enableRLS();

/** A sheet (class, subject, term) marked complete: locked for its teacher until an admin unlocks it. */
export const sheetCompletions = pgTable(
  "sheet_completions",
  {
    id: id(),
    schoolId: schoolId(),
    termKey: text().notNull(),
    classArmId: uuid().notNull(),
    schoolSubjectId: uuid().notNull(),
    completedBy: uuid().references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    createdBy: uuid(),
    updatedBy: uuid(),
  },
  (t) => [
    unique("sheet_completions_school_id_id_key").on(t.schoolId, t.id),
    unique("sheet_completions_sheet_key").on(t.schoolId, t.termKey, t.classArmId, t.schoolSubjectId),
    foreignKey({ name: "sheet_completions_arm_fk", columns: [t.schoolId, t.classArmId], foreignColumns: [classArms.schoolId, classArms.id] }),
    foreignKey({ name: "sheet_completions_subject_fk", columns: [t.schoolId, t.schoolSubjectId], foreignColumns: [schoolSubjects.schoolId, schoolSubjects.id] }).onDelete("cascade"),
    schoolIsolation(t.schoolId),
    backupRead(),
  ],
).enableRLS();

export const unlockStatus = pgEnum("unlock_status", ["open", "approved", "declined"]);

/** A teacher asking to reopen a completed sheet, and the admin's answer. One open request per sheet. */
export const unlockRequests = pgTable(
  "unlock_requests",
  {
    id: id(),
    schoolId: schoolId(),
    termKey: text().notNull(),
    classArmId: uuid().notNull(),
    schoolSubjectId: uuid().notNull(),
    requestedBy: uuid().references(() => users.id, { onDelete: "set null" }),
    reason: text().notNull(),
    status: unlockStatus().notNull().default("open"),
    resolvedBy: uuid().references(() => users.id, { onDelete: "set null" }),
    resolvedAt: timestamp({ withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    createdBy: uuid(),
    updatedBy: uuid(),
  },
  (t) => [
    unique("unlock_requests_school_id_id_key").on(t.schoolId, t.id),
    uniqueIndex("unlock_requests_one_open_idx").on(t.schoolId, t.termKey, t.classArmId, t.schoolSubjectId).where(sql`${t.status} = 'open'`),
    foreignKey({ name: "unlock_requests_arm_fk", columns: [t.schoolId, t.classArmId], foreignColumns: [classArms.schoolId, classArms.id] }),
    foreignKey({ name: "unlock_requests_subject_fk", columns: [t.schoolId, t.schoolSubjectId], foreignColumns: [schoolSubjects.schoolId, schoolSubjects.id] }).onDelete("cascade"),
    check("unlock_requests_reason_check", sql`char_length(${t.reason}) BETWEEN 5 AND 200`),
    schoolIsolation(t.schoolId),
    backupRead(),
  ],
).enableRLS();

// ——— Reports (C3) ———

export const remarkKind = pgEnum("remark_kind", ["teacher", "principal"]);

/** The class teacher's or the principal's remark on a student's report card for a term. */
export const reportRemarks = pgTable(
  "report_remarks",
  {
    id: id(),
    schoolId: schoolId(),
    termKey: text().notNull(),
    studentId: uuid().notNull(),
    kind: remarkKind().notNull(),
    text: text().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    createdBy: uuid(),
    updatedBy: uuid(),
  },
  (t) => [
    unique("report_remarks_school_id_id_key").on(t.schoolId, t.id),
    unique("report_remarks_one_key").on(t.schoolId, t.termKey, t.studentId, t.kind),
    foreignKey({ name: "report_remarks_student_fk", columns: [t.schoolId, t.studentId], foreignColumns: [students.schoolId, students.id] }),
    check("report_remarks_text_check", sql`char_length(${t.text}) BETWEEN 1 AND 300`),
    schoolIsolation(t.schoolId),
    backupRead(),
  ],
).enableRLS();

/** A behaviour rating (1 Poor … 5 Excellent) for one trait, student and term. */
export const reportRatings = pgTable(
  "report_ratings",
  {
    id: id(),
    schoolId: schoolId(),
    termKey: text().notNull(),
    studentId: uuid().notNull(),
    trait: text().notNull(),
    value: smallint().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    createdBy: uuid(),
    updatedBy: uuid(),
  },
  (t) => [
    unique("report_ratings_school_id_id_key").on(t.schoolId, t.id),
    unique("report_ratings_one_key").on(t.schoolId, t.termKey, t.studentId, t.trait),
    foreignKey({ name: "report_ratings_student_fk", columns: [t.schoolId, t.studentId], foreignColumns: [students.schoolId, students.id] }),
    check("report_ratings_value_check", sql`${t.value} BETWEEN 1 AND 5`),
    schoolIsolation(t.schoolId),
    backupRead(),
  ],
).enableRLS();

/** A class's results published for a term: parents see them from then on (until taken back). */
export const publishedResults = pgTable(
  "published_results",
  {
    id: id(),
    schoolId: schoolId(),
    termKey: text().notNull(),
    classArmId: uuid().notNull(),
    publishedBy: uuid().references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    createdBy: uuid(),
    updatedBy: uuid(),
  },
  (t) => [
    unique("published_results_school_id_id_key").on(t.schoolId, t.id),
    unique("published_results_class_key").on(t.schoolId, t.termKey, t.classArmId),
    foreignKey({ name: "published_results_arm_fk", columns: [t.schoolId, t.classArmId], foreignColumns: [classArms.schoolId, classArms.id] }),
    schoolIsolation(t.schoolId),
    backupRead(),
  ],
).enableRLS();

// ——— Promotion (B1) ———

export const promotionDecision = pgEnum("promotion_decision", ["promote", "repeat", "graduate"]);

/** A school's change to a student's suggested decision for the session that starts in startYear. No row: the suggestion. */
export const promotionDecisions = pgTable(
  "promotion_decisions",
  {
    id: id(),
    schoolId: schoolId(),
    startYear: integer().notNull(),
    studentId: uuid().notNull(),
    decision: promotionDecision().notNull(),
    reason: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    createdBy: uuid(),
    updatedBy: uuid(),
  },
  (t) => [
    unique("promotion_decisions_school_id_id_key").on(t.schoolId, t.id),
    unique("promotion_decisions_student_key").on(t.schoolId, t.startYear, t.studentId),
    foreignKey({ name: "promotion_decisions_student_fk", columns: [t.schoolId, t.studentId], foreignColumns: [students.schoolId, students.id] }).onDelete("cascade"),
    check("promotion_decisions_reason_length", sql`char_length(${t.reason}) <= 200`),
    schoolIsolation(t.schoolId),
    backupRead(),
  ],
).enableRLS();

// ——— Birthday messages (B2) ———

/** Per school: whether birthday texts go out, and the message ({name}, {age}, {school}). No row: off, the default message. */
export const birthdaySettings = pgTable(
  "birthday_settings",
  {
    id: id(),
    schoolId: schoolId(),
    enabled: boolean().notNull().default(false),
    message: text().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    createdBy: uuid(),
    updatedBy: uuid(),
  },
  (t) => [
    unique("birthday_settings_school_id_id_key").on(t.schoolId, t.id),
    unique("birthday_settings_one_per_school_key").on(t.schoolId),
    check("birthday_settings_message_length", sql`char_length(${t.message}) BETWEEN 10 AND 300`),
    schoolIsolation(t.schoolId),
    backupRead(),
    // The daily job finds the schools that send them (app_birthday_schools).
    platformAccess("select"),
  ],
).enableRLS();

/** pending: claimed by the daily job, being sent. no_phone: the guardian has no phone; logged, not sent. */
export const birthdayTextStatus = pgEnum("birthday_text_status", ["pending", "sent", "no_phone", "failed"]);

/** Each birthday text: one per student per day, which is what stops a second send. */
export const birthdayTexts = pgTable(
  "birthday_texts",
  {
    id: id(),
    schoolId: schoolId(),
    studentId: uuid().notNull(),
    day: date({ mode: "string" }).notNull(),
    /** E.164, or null when the guardian has no phone. */
    phone: text(),
    text: text().notNull(),
    status: birthdayTextStatus().notNull(),
    /** The SMS provider's message id, for support. */
    providerRef: text(),
    error: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    createdBy: uuid(),
    updatedBy: uuid(),
  },
  (t) => [
    unique("birthday_texts_school_id_id_key").on(t.schoolId, t.id),
    unique("birthday_texts_once_key").on(t.schoolId, t.studentId, t.day),
    foreignKey({ name: "birthday_texts_student_fk", columns: [t.schoolId, t.studentId], foreignColumns: [students.schoolId, students.id] }).onDelete("cascade"),
    index("birthday_texts_school_created_idx").on(t.schoolId, t.createdAt),
    schoolIsolation(t.schoolId),
    backupRead(),
  ],
).enableRLS();

// ——— Books and things needed (B3) ———

export type BookListItem = { id: string; category: "textbook" | "stationery" | "uniform" | "other"; name: string; detail: string; quantity: number; price: number | null };

/** One class level's list for one session (startYear), shown to its parents once shared. */
export const bookLists = pgTable(
  "book_lists",
  {
    id: id(),
    schoolId: schoolId(),
    classLevelId: uuid().notNull(),
    startYear: integer().notNull(),
    items: jsonb().$type<BookListItem[]>().notNull().default(sql`'[]'::jsonb`),
    shared: boolean().notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    createdBy: uuid(),
    updatedBy: uuid(),
  },
  (t) => [
    unique("book_lists_school_id_id_key").on(t.schoolId, t.id),
    unique("book_lists_level_year_key").on(t.schoolId, t.classLevelId, t.startYear),
    foreignKey({ name: "book_lists_level_fk", columns: [t.schoolId, t.classLevelId], foreignColumns: [classLevels.schoolId, classLevels.id] }).onDelete("cascade"),
    check("book_lists_at_most_80", sql`jsonb_array_length(${t.items}) <= 80`),
    check("book_lists_shared_not_empty", sql`NOT ${t.shared} OR jsonb_array_length(${t.items}) > 0`),
    schoolIsolation(t.schoolId),
    backupRead(),
  ],
).enableRLS();

// ——— Corrections parents ask for (B4) ———

export const correctionStatus = pgEnum("correction_status", ["open", "approved", "declined"]);
export type CorrectionChange = { field: string; from: string; to: string };

/**
 * A parent's request to correct their child's details. `changes` keeps what the record said when
 * asked (`from`) and what it should say (`to`). The guardian is the family record the parent asked
 * through: phone and email changes go to it.
 */
export const correctionRequests = pgTable(
  "correction_requests",
  {
    id: id(),
    schoolId: schoolId(),
    studentId: uuid().notNull(),
    guardianId: uuid().notNull(),
    requestedBy: uuid().references(() => users.id, { onDelete: "set null" }),
    changes: jsonb().$type<CorrectionChange[]>().notNull(),
    note: text().notNull().default(""),
    status: correctionStatus().notNull().default("open"),
    decidedBy: uuid().references(() => users.id, { onDelete: "set null" }),
    decidedAt: timestamp({ withTimezone: true }),
    declineReason: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    createdBy: uuid(),
    updatedBy: uuid(),
  },
  (t) => [
    unique("correction_requests_school_id_id_key").on(t.schoolId, t.id),
    foreignKey({ name: "correction_requests_student_fk", columns: [t.schoolId, t.studentId], foreignColumns: [students.schoolId, students.id] }).onDelete("cascade"),
    foreignKey({ name: "correction_requests_guardian_fk", columns: [t.schoolId, t.guardianId], foreignColumns: [guardians.schoolId, guardians.id] }).onDelete("cascade"),
    index("correction_requests_school_status_idx").on(t.schoolId, t.status, t.createdAt),
    index("correction_requests_school_student_idx").on(t.schoolId, t.studentId),
    check("correction_requests_note_length", sql`char_length(${t.note}) <= 300`),
    check("correction_requests_reason_length", sql`${t.declineReason} IS NULL OR char_length(${t.declineReason}) BETWEEN 3 AND 200`),
    schoolIsolation(t.schoolId),
    backupRead(),
  ],
).enableRLS();

// ——— Timetable (B5) ———

export type TimetablePeriod = { id: string; label: string; start: string; end: string; kind: "lesson" | "break" };

/** The school's bell schedule (the same for every class, Monday to Friday) and its uploaded document. */
export const timetables = pgTable(
  "timetables",
  {
    id: id(),
    schoolId: schoolId(),
    periods: jsonb().$type<TimetablePeriod[]>().notNull().default(sql`'[]'::jsonb`),
    /** The uploaded timetable document (a PDF up to 2 MB); null when there is none. */
    fileName: text(),
    fileBytes: bytea(),
    fileSha256: text(),
    fileBy: uuid().references(() => users.id, { onDelete: "set null" }),
    fileAt: timestamp({ withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    createdBy: uuid(),
    updatedBy: uuid(),
  },
  (t) => [
    unique("timetables_school_id_id_key").on(t.schoolId, t.id),
    unique("timetables_one_per_school_key").on(t.schoolId),
    check("timetables_file_size", sql`${t.fileBytes} IS NULL OR octet_length(${t.fileBytes}) <= 2097152`),
    schoolIsolation(t.schoolId),
    backupRead(),
  ],
).enableRLS();

/** A class's subject in one lesson period on one day (1 Monday to 5 Friday). Its teacher is the class's teacher for that subject. */
export const timetableLessons = pgTable(
  "timetable_lessons",
  {
    id: id(),
    schoolId: schoolId(),
    classArmId: uuid().notNull(),
    day: smallint().notNull(),
    periodId: text().notNull(),
    schoolSubjectId: uuid().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    createdBy: uuid(),
    updatedBy: uuid(),
  },
  (t) => [
    unique("timetable_lessons_school_id_id_key").on(t.schoolId, t.id),
    unique("timetable_lessons_slot_key").on(t.schoolId, t.classArmId, t.day, t.periodId),
    foreignKey({ name: "timetable_lessons_arm_fk", columns: [t.schoolId, t.classArmId], foreignColumns: [classArms.schoolId, classArms.id] }).onDelete("cascade"),
    foreignKey({ name: "timetable_lessons_subject_fk", columns: [t.schoolId, t.schoolSubjectId], foreignColumns: [schoolSubjects.schoolId, schoolSubjects.id] }).onDelete("cascade"),
    index("timetable_lessons_school_subject_idx").on(t.schoolId, t.schoolSubjectId),
    check("timetable_lessons_day", sql`${t.day} BETWEEN 1 AND 5`),
    schoolIsolation(t.schoolId),
    backupRead(),
  ],
).enableRLS();
