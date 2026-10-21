// Copied from the front end's packages/core/src/results.ts (21 Oct 2026), without its Zod schemas
// (resultsSettingsSchema, unlockRequestSchema, ratingSettingsSchema, remarkSchema, ratingSchema):
// this package has no dependencies, so those live in apps/api/src/lib/results-rules.ts with the
// same rules. Keep both in step with the front end.
// Results (after v1, group 2): the school's score parts, its grading scale, and how a class's
// averages and positions are worked out. Builds on grading.ts (totals, grades, ranks), which came
// from the first app with its decisions (D-1 to D-3, F-1, F-32).
import { computeSubjectTotal, rankScores, roundScore, type CellValue, type GradeBand, type RankMode, type WeightedComponent } from "./grading.js";

/** One part of a score sheet: CA1, CA2, Exam. Its weight is its maximum, and the parts add up to 100. */
export type ScoreComponent = { id: string; name: string; maxScore: number };

/** User decision (14 Oct 2026): CA1 20, CA2 20, Exam 60 by default; each school can change it. */
export const DEFAULT_COMPONENTS: ScoreComponent[] = [
  { id: "ca1", name: "CA1", maxScore: 20 },
  { id: "ca2", name: "CA2", maxScore: 20 },
  { id: "exam", name: "Exam", maxScore: 60 },
];

/** User decision (14 Oct 2026): A to F by default. Thresholds, not ranges (F-1): a band at 0 is required. */
export const DEFAULT_SCALE: GradeBand[] = [
  { minScore: 70, grade: "A", remark: "Excellent", isPass: true },
  { minScore: 60, grade: "B", remark: "Very good", isPass: true },
  { minScore: 50, grade: "C", remark: "Good", isPass: true },
  { minScore: 45, grade: "D", remark: "Fair", isPass: true },
  { minScore: 40, grade: "E", remark: "Pass", isPass: true },
  { minScore: 0, grade: "F", remark: "Fail", isPass: false },
];

/** WAEC style, offered as a preset in Results settings. */
export const WAEC_SCALE: GradeBand[] = [
  { minScore: 75, grade: "A1", remark: "Excellent", isPass: true },
  { minScore: 70, grade: "B2", remark: "Very good", isPass: true },
  { minScore: 65, grade: "B3", remark: "Good", isPass: true },
  { minScore: 60, grade: "C4", remark: "Credit", isPass: true },
  { minScore: 55, grade: "C5", remark: "Credit", isPass: true },
  { minScore: 50, grade: "C6", remark: "Credit", isPass: true },
  { minScore: 45, grade: "D7", remark: "Pass", isPass: true },
  { minScore: 40, grade: "E8", remark: "Pass", isPass: true },
  { minScore: 0, grade: "F9", remark: "Fail", isPass: false },
];

export const asWeighted = (components: ScoreComponent[]): WeightedComponent[] => components.map((c) => ({ id: c.id, weight: c.maxScore, maxScore: c.maxScore }));



/** One student's row on a sheet. `excluded` is an elective the student doesn't take. */
export type SheetRow = { studentId: string; excluded: boolean; scores: Partial<Record<string, CellValue>> };

/** How far a sheet has got: rows with every part entered, out of the students who take the subject. */
export function sheetProgress(rows: SheetRow[], components: ScoreComponent[]): { complete: number; of: number } {
  const taking = rows.filter((r) => !r.excluded);
  const complete = taking.filter((r) => components.every((c) => r.scores[c.id])).length;
  return { complete, of: taking.length };
}

/** A student's total on one sheet, or null while any part is empty. */
export function rowTotal(row: SheetRow, components: ScoreComponent[]): number | null {
  const { total, complete } = computeSubjectTotal(asWeighted(components), row.scores);
  return complete ? total : null;
}

/**
 * A class's results: each student's average over the subjects they take (complete totals only)
 * and their position in the arm (D-1), ties ranked 1, 2, 2, 4 by default (D-2).
 */
export function classResults(
  students: string[],
  totals: { studentId: string; subjectId: string; total: number }[],
  mode: RankMode = "COMPETITION",
): Map<string, { average: number | null; subjects: number; position: number | null }> {
  const out = new Map<string, { average: number | null; subjects: number; position: number | null }>();
  const ranked: { id: string; total: number }[] = [];
  for (const id of students) {
    const mine = totals.filter((t) => t.studentId === id);
    const average = mine.length ? roundScore(mine.reduce((n, t) => n + t.total, 0) / mine.length) : null;
    out.set(id, { average, subjects: mine.length, position: null });
    if (average !== null) ranked.push({ id, total: average });
  }
  for (const [id, position] of rankScores(ranked, mode)) out.get(id)!.position = position;
  return out;
}

// ——— Batch 15: remarks, behaviour ratings ———

/** User decision (5 Oct 2026): ratings are optional, and each school chooses its traits. */
export const DEFAULT_TRAITS = ["Punctuality", "Neatness", "Attentiveness", "Politeness", "Teamwork"];
export const RATING_LABELS = ["Poor", "Fair", "Good", "Very good", "Excellent"] as const;


