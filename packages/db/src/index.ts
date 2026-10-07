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
} from "./schema/index.js";
// Re-export the query helpers feature code needs, so nothing imports drizzle internals ad hoc.
export { and, asc, desc, eq, gt, gte, inArray, isNull, isNotNull, lt, lte, ne, or, sql } from "drizzle-orm";
