/**
 * Shared reads for registers and parents (C1, C2, B3): today in Lagos, the calendar's terms, a
 * student's attendance this term, and whether a guardian uses the parent app.
 */
import { attendanceSummary, termOf, type Mark, type Term } from "@brillianda/core";
import { and, eq, gt, gte, inArray, invitations, isNull, lte, parentLinks, registerMarks, registers, schoolMembers, type Tx } from "@brillianda/db";
import { currentSession } from "../routes/calendar.js";

/** Today's date in Lagos (UTC+1, no daylight saving), as YYYY-MM-DD. */
export const lagosToday = () => new Date(Date.now() + 3_600_000).toISOString().slice(0, 10);

/** The calendar's terms: the saved ones, or this year's suggestions until the school saves its own. */
export async function termsOf(tx: Tx): Promise<Term[]> {
  return (await currentSession(tx)).terms;
}

export type AttendanceSummary = { term: string; days: number; present: number; late: number; absent: number } | null;

/** This term's register marks per student, up to today (late counts as present); null outside a term. */
export async function attendanceOf(tx: Tx, studentIds: string[], terms: Term[], today: string): Promise<Map<string, AttendanceSummary>> {
  const term = termOf(today, terms);
  const out = new Map<string, AttendanceSummary>();
  if (!term) {
    for (const id of studentIds) out.set(id, null);
    return out;
  }
  const marks = new Map<string, Mark[]>(studentIds.map((id) => [id, []]));
  if (studentIds.length) {
    const rows = await tx
      .select({ studentId: registerMarks.studentId, mark: registerMarks.mark })
      .from(registerMarks)
      .innerJoin(registers, and(eq(registers.schoolId, registerMarks.schoolId), eq(registers.id, registerMarks.registerId)))
      .where(and(inArray(registerMarks.studentId, studentIds), gte(registers.day, term.startsOn), lte(registers.day, today)));
    for (const r of rows) marks.get(r.studentId)?.push(r.mark);
  }
  for (const [id, list] of marks) out.set(id, { term: term.name, ...attendanceSummary(list) });
  return out;
}

export type ParentAccess = "none" | "invited" | "active";

/** Does each guardian use the parent app: signed up (active), invited, or neither? */
export async function parentAccessOf(tx: Tx, guardianIds: string[]): Promise<Map<string, ParentAccess>> {
  const out = new Map<string, ParentAccess>(guardianIds.map((id) => [id, "none"]));
  if (!guardianIds.length) return out;
  const invited = await tx
    .select({ guardianId: invitations.guardianId })
    .from(invitations)
    .where(and(inArray(invitations.guardianId, guardianIds), eq(invitations.role, "parent"), isNull(invitations.acceptedAt), isNull(invitations.revokedAt), gt(invitations.expiresAt, new Date())));
  for (const r of invited) if (r.guardianId) out.set(r.guardianId, "invited");
  const linked = await tx
    .select({ guardianId: parentLinks.guardianId })
    .from(parentLinks)
    .innerJoin(schoolMembers, and(eq(schoolMembers.schoolId, parentLinks.schoolId), eq(schoolMembers.userId, parentLinks.userId)))
    .where(and(inArray(parentLinks.guardianId, guardianIds), eq(schoolMembers.role, "parent"), eq(schoolMembers.status, "active")));
  for (const r of linked) out.set(r.guardianId, "active");
  return out;
}
