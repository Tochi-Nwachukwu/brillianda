// Copied from the front end's packages/core/src/cbt.ts (28 Oct 2026), without its Zod schema
// (testSettingsSchema), which lives in apps/api/src/lib/cbt-rules.ts with the same rules.
// Computer-based tests (batch 25): a teacher sets a test from the question bank for classes, in a
// time window; students take it with a timer; objective answers mark themselves, the teacher marks
// theory, then sends the scores into a score-sheet column (user decisions, 15 Oct 2026).
import { markAnswer, type Question, type Response } from "./questions.js";

export const WHERE = ["anywhere", "school"] as const;
export type Where = (typeof WHERE)[number];
export const WHERE_LABEL: Record<Where, string> = { anywhere: "Anywhere (at home too)", school: "In school only, with a code" };

/** A test's settings, as the editor sends them (the API checks them with the front end's testSettingsSchema). */
export type TestSettings = {
  title: string;
  instructions: string;
  armIds: string[];
  questionIds: string[];
  durationMinutes: number;
  /** ISO date-times. */
  opensAt: string;
  closesAt: string;
  where: Where;
  shuffle: boolean;
  /** Show students their objective score as soon as they submit. */
  showScore: boolean;
  /** The score-sheet part the scores go into (CA1, CA2, Exam). */
  componentId: string;
};

/** A six-character code the invigilator shows in the room (no 0/O or 1/I, which look alike). */
export function newAccessCode(random: () => number = Math.random): string {
  const letters = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from({ length: 6 }, () => letters[Math.floor(random() * letters.length)]).join("");
}

export type Window = { opensAt: string; closesAt: string };

/** Whether a student may start now: before, open, or after the window. */
export function windowState(w: Window, now: number): "before" | "open" | "closed" {
  if (now < Date.parse(w.opensAt)) return "before";
  return now >= Date.parse(w.closesAt) ? "closed" : "open";
}

/** When an attempt must end: its length after starting, or the window's close, whichever is first. */
export function deadlineOf(startedAt: number, durationMinutes: number, w: Window): number {
  return Math.min(startedAt + durationMinutes * 60_000, Date.parse(w.closesAt));
}

/** Answers saved a little after the deadline still count (a slow connection); then nothing does. */
export const GRACE_MS = 30_000;

export type Scored = { auto: number; theory: number; total: number; max: number; toMark: number };

/**
 * An attempt's score: objective, true/false and gap answers marked automatically; theory from the
 * teacher's marks. `toMark` counts theory answers still waiting for a mark.
 */
export function scoreAttempt(questions: Question[], responses: Record<number, Response | undefined>, theoryMarks: Record<number, number | undefined>): Scored {
  let auto = 0;
  let theory = 0;
  let toMark = 0;
  let max = 0;
  questions.forEach((q, i) => {
    max += q.marks;
    const m = markAnswer(q, responses[i] ?? null);
    if (m !== null) auto += m;
    else if (theoryMarks[i] !== undefined) theory += theoryMarks[i]!;
    else if (responses[i]) toMark++;
  });
  const round = (n: number) => Math.round(n * 100) / 100;
  return { auto: round(auto), theory: round(theory), total: round(auto + theory), max: round(max), toMark };
}

/** A test score in a score-sheet column: 18 of 25 into CA1 (out of 20) is 14.4. Two decimals, as sheets allow. */
export function scaleTo(score: number, max: number, columnMax: number): number {
  if (max <= 0) return 0;
  return Math.round((score / max) * columnMax * 100) / 100;
}
