export * from "./client.js";
export * from "./with-school.js";
export * from "./platform.js";
export * as schema from "./schema/index.js";
export {
  users,
  schools,
  verificationTokens,
  schoolMembers,
  sessions,
  auditLog,
  signupDrafts,
  invitations,
  academicSessions,
  terms,
  classLevels,
  arms,
  classArms,
  schoolSubjects,
  classLevelSubjects,
  importBatches,
  guardians,
  students,
  studentGuardians,
  enrolments,
  counters,
  schoolLogos,
  trialRequests,
  emailOutbox,
} from "./schema/index.js";
// Re-export the query helpers feature code needs, so nothing imports drizzle internals ad hoc.
export { and, asc, count, desc, eq, gt, gte, inArray, isNull, isNotNull, lt, lte, ne, or, sql } from "drizzle-orm";
