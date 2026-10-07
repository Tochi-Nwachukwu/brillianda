/**
 * The only cross-school reads the API may do. Each wraps a SECURITY DEFINER function
 * (migration 0002) that returns the minimum needed and nothing else.
 */
import { sql } from "drizzle-orm";
import type { Executor } from "./client.js";

export interface UserSchool {
  schoolId: string;
  name: string;
  subdomain: string;
  role: "owner" | "admin";
}

/** For the login school picker and the Find my school email: names and subdomains only. */
export async function listUserSchools(db: Executor, userId: string): Promise<UserSchool[]> {
  const result = await db.execute<{ school_id: string; name: string; subdomain: string; role: "owner" | "admin" }>(
    sql`select school_id, name, subdomain, role from app_user_schools(${userId}::uuid)`,
  );
  return result.rows.map((r) => ({ schoolId: r.school_id, name: r.name, subdomain: r.subdomain, role: r.role }));
}

/**
 * Ends a user's sessions in every school (password change, account disable).
 * Pass `exceptSessionId` to keep the session that made the change.
 */
export async function revokeUserSessions(db: Executor, userId: string, exceptSessionId?: string): Promise<number> {
  const result = await db.execute<{ revoked: number }>(
    sql`select app_revoke_user_sessions(${userId}::uuid, ${exceptSessionId ?? null}::uuid) as revoked`,
  );
  return Number(result.rows[0]?.revoked ?? 0);
}
