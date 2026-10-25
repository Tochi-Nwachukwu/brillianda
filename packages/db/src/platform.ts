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
  role: "owner" | "admin" | "teacher" | "parent" | "student";
}

/** For the login school picker and the Find my school email: names and subdomains only. */
export async function listUserSchools(db: Executor, userId: string): Promise<UserSchool[]> {
  const result = await db.execute<{ school_id: string; name: string; subdomain: string; role: "owner" | "admin" | "teacher" | "parent" | "student" }>(
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

export interface ConsoleSchoolRow {
  schoolId: string;
  subdomain: string;
  name: string;
  status: "active" | "suspended" | "archived";
  createdAt: Date;
  state: string | null;
  phone: string | null;
  levelsOffered: string[];
  ownerName: string | null;
  ownerEmail: string | null;
  students: number;
  classes: number;
  subjects: number;
  admins: number;
  teachers: number;
  parents: number;
  setup: { calendar: boolean; classes: boolean; arms: boolean; subjects: boolean; students: boolean; admins: boolean; branding: boolean };
}

/**
 * Every school's counts, contacts and setup flags, for the Brillianda team console only
 * (SECURITY DEFINER, migration 0026). Never a student's own record.
 */
export async function consoleSchools(db: Executor): Promise<ConsoleSchoolRow[]> {
  const result = await db.execute<Record<string, unknown>>(sql`select * from app_console_schools()`);
  return result.rows.map((r) => ({
    schoolId: r.school_id as string,
    subdomain: r.subdomain as string,
    name: r.name as string,
    status: r.status as ConsoleSchoolRow["status"],
    createdAt: new Date(r.created_at as string),
    state: (r.state as string | null) ?? null,
    phone: (r.phone as string | null) ?? null,
    levelsOffered: (r.levels_offered as string[] | null) ?? [],
    ownerName: (r.owner_name as string | null) ?? null,
    ownerEmail: (r.owner_email as string | null) ?? null,
    students: Number(r.students),
    classes: Number(r.classes),
    subjects: Number(r.subjects),
    admins: Number(r.admins),
    teachers: Number(r.teachers),
    parents: Number(r.parents),
    setup: {
      calendar: !!r.calendar_done,
      classes: !!r.classes_done,
      arms: !!r.arms_done,
      subjects: !!r.subjects_done,
      students: !!r.students_done,
      admins: !!r.admins_done,
      branding: !!r.branding_done,
    },
  }));
}

/** Schools that send birthday texts, for the daily job (SECURITY DEFINER, migration 0035). */
export async function birthdaySchools(db: Executor): Promise<{ schoolId: string; subdomain: string; name: string }[]> {
  const result = await db.execute<Record<string, unknown>>(sql`select * from app_birthday_schools()`);
  return result.rows.map((r) => ({ schoolId: r.school_id as string, subdomain: r.subdomain as string, name: r.name as string }));
}
