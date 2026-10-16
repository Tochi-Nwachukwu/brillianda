// Copied from the front end's packages/core/src/attendance.ts (15 Oct 2026): the daily register's
// rules must be the same on both sides. Keep in step with that file. The two Zod schemas there
// (registerSchema, subjectClassesSchema) live in apps/api/src/routes/teachers.ts instead, because
// this package has no dependencies; the rules in them are the same.
// The daily register (batch 11; user decision 5 Oct 2026: once a day, by the form teacher, editable
// afterwards, feeding "times present" on report cards). Pure rules, shared by browser and server.
import type { Term } from "./calendar.js";

export const MARKS = ["present", "late", "absent"] as const;
export type Mark = (typeof MARKS)[number];
export const MARK_LABEL: Record<Mark, string> = { present: "Present", late: "Late", absent: "Absent" };
/** Late still counts as present on a report card: the student was in school. */
export const countsAsPresent = (mark: Mark) => mark !== "absent";

const dayOfWeek = (day: string) => new Date(`${day}T12:00:00Z`).getUTCDay();
const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** The term a day falls in, or null in a break or outside the session. */
export function termOf(day: string, terms: Term[]): Term | null {
  return terms.find((t) => t.startsOn <= day && day <= t.endsOn) ?? null;
}

/** Monday to Friday inside a term. Public holidays come later, with the school's own calendar. */
export function isSchoolDay(day: string, terms: Term[]): boolean {
  const weekday = dayOfWeek(day);
  return weekday >= 1 && weekday <= 5 && termOf(day, terms) !== null;
}

/** Why a register can't be taken or changed on this day, in words; null if it can. */
export function registerDayProblem(day: string, today: string, terms: Term[]): string | null {
  if (day > today) return "That day hasn’t come yet.";
  const weekday = dayOfWeek(day);
  if (weekday === 0 || weekday === 6) return "That’s a weekend.";
  const term = termOf(day, terms);
  if (!term) return "That day isn’t in a term.";
  const current = termOf(today, terms);
  if (!current || current.name !== term.name || current.startsOn !== term.startsOn) return "Only this term’s registers can be changed.";
  return null;
}

/** School days in a term up to and including `today`, newest first. */
export function schoolDaysSoFar(term: Term, today: string): string[] {
  const days: string[] = [];
  const last = today < term.endsOn ? today : term.endsOn;
  for (let d = last; d >= term.startsOn; d = addDays(d, -1)) {
    const w = dayOfWeek(d);
    if (w >= 1 && w <= 5) days.push(d);
  }
  return days;
}

/** The most recent school day on or before `today` (today itself on a weekday in term). */
export function latestSchoolDay(today: string, terms: Term[]): string | null {
  for (let d = today, n = 0; n < 400; d = addDays(d, -1), n++) if (isSchoolDay(d, terms)) return d;
  return null;
}

/** "Present 41 of 45 days": days marked and days present (late counts as present). */
export function attendanceSummary(marks: Mark[]): { days: number; present: number; late: number; absent: number } {
  const late = marks.filter((m) => m === "late").length;
  const absent = marks.filter((m) => m === "absent").length;
  return { days: marks.length, present: marks.length - absent, late, absent };
}

