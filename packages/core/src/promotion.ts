// Copied from the front end's packages/core/src/promotion.ts (24 Oct 2026), without its Zod schemas
// (passMarkSchema, decisionSchema), which live in apps/api/src/routes/promotion.ts with the same rules.
// Promotion at the end of a session (group 3, batch 18; the first app's F-44). The user's decision
// (5 Oct 2026): automatic from the yearly average, and editable by the school.
import { roundScore } from "./grading.js";

export const DECISIONS = ["promote", "repeat", "graduate"] as const;
export type Decision = (typeof DECISIONS)[number];
export const DECISION_LABEL: Record<Decision, string> = { promote: "Moves up", repeat: "Repeats", graduate: "Graduates" };

/** The average of the session's term averages; terms with no results are skipped. Null when none have any. */
export function yearlyAverage(termAverages: (number | null)[]): number | null {
  const counted = termAverages.filter((a): a is number => a !== null);
  return counted.length ? roundScore(counted.reduce((n, a) => n + a, 0) / counted.length) : null;
}

/**
 * The suggested decision: the final class graduates; everyone else moves up at or above the pass
 * mark, and repeats below it. A student with no results at all is suggested to move up (F-44).
 */
export function suggestDecision(average: number | null, passMark: number, finalClass: boolean): Decision {
  if (finalClass) return "graduate";
  if (average === null) return "promote";
  return average >= passMark ? "promote" : "repeat";
}

/** The pass mark defaults to the grading scale's lowest passing grade. */
export function defaultPassMark(scale: { minScore: number; isPass: boolean }[]): number {
  const passing = scale.filter((b) => b.isPass).map((b) => b.minScore);
  return passing.length ? Math.min(...passing) : 40;
}

/**
 * Where a student goes: the next class level (by the school's order), in the arm with the same
 * name if that level has it, else its first arm. Null when there's no next level (they graduate).
 */
export function nextArm<L extends { id: string; position: number }, A extends { id: string; levelId: string; armNameId: string }>(
  levels: L[],
  arms: A[],
  current: A,
): A | null {
  const ordered = [...levels].sort((a, b) => a.position - b.position);
  const at = ordered.findIndex((l) => l.id === current.levelId);
  const next = ordered[at + 1];
  if (!next) return null;
  const there = arms.filter((a) => a.levelId === next.id);
  return there.find((a) => a.armNameId === current.armNameId) ?? there[0] ?? null;
}
