// Copied verbatim from the front end's packages/core/src/grading.ts (21 Oct 2026): totals, grades
// and positions must never depend on which side worked them out. Keep in step with that file.
// Score maths shared by the score-entry grid (live totals) and the API (stored results), so the
// two can never disagree (DECISIONS.md F-32). Pure functions only.

export type GradeBand = { minScore: number; grade: string; remark: string; isPass: boolean };

/** Where a subject's score sheet stands for one class arm and term. */
export const ENTRY_STATES = ["NOT_STARTED", "IN_PROGRESS", "COMPLETE", "LOCKED"] as const;
export type EntryState = (typeof ENTRY_STATES)[number];

export type WeightedComponent = { id: string; weight: number; maxScore: number };

/** One entered score. An absent student counts as 0 (DECISIONS.md D-3). */
export type CellValue = { value: number; isAbsent: boolean };

/**
 * Rounds half up to 2 decimal places. Going through 12 significant digits first strips binary
 * float noise, so 69.995 (stored as 69.99499999…) becomes 70, not 69.99.
 */
export function roundScore(value: number): number {
  return Math.round(Number((value * 100).toPrecision(12))) / 100;
}

export type SubjectTotal = { total: number; complete: boolean };

/**
 * Weighted subject total (Build Guide §8): the sum of (value ÷ maxScore) × weight over the
 * components entered so far, rounded to 2 dp. `complete` stays false while any component is
 * empty; only complete totals get a grade.
 */
export function computeSubjectTotal(
  components: WeightedComponent[],
  cells: Partial<Record<string, CellValue | null>>,
): SubjectTotal {
  let total = 0;
  let complete = true;
  for (const component of components) {
    const cell = cells[component.id];
    if (!cell) {
      complete = false;
      continue;
    }
    if (!cell.isAbsent) total += (cell.value / component.maxScore) * component.weight;
  }
  return { total: roundScore(total), complete };
}

export class UngradedScoreError extends Error {
  readonly total: number;

  constructor(total: number) {
    super(`The grading scale has no band for a total of ${total}`);
    this.name = "UngradedScoreError";
    this.total = total;
  }
}

/**
 * The band with the highest minScore that the total reaches (DECISIONS.md F-1). A scale with no
 * band at or below the total is a configuration error and must surface loudly.
 */
export function resolveGrade(total: number, scale: GradeBand[]): GradeBand {
  let match: GradeBand | undefined;
  for (const band of scale) {
    if (total >= band.minScore && (!match || band.minScore > match.minScore)) match = band;
  }
  if (!match) throw new UngradedScoreError(total);
  return match;
}

/** COMPETITION ranks ties 1, 2, 2, 4; DENSE ranks them 1, 2, 2, 3 (DECISIONS.md D-2). */
export type RankMode = "COMPETITION" | "DENSE";

/**
 * Class positions from totals, highest first. This is the single ranking implementation
 * (Build Guide §8): the score grid, the marketing demo and the API all call it, so a position
 * never depends on where it was worked out.
 */
export function rankScores(
  entries: { id: string; total: number }[],
  mode: RankMode = "COMPETITION",
): Map<string, number> {
  const ranks = new Map<string, number>();
  let previousTotal: number | null = null;
  let competitionRank = 0;
  let denseRank = 0;

  [...entries]
    .sort((a, b) => b.total - a.total)
    .forEach((entry, index) => {
      if (previousTotal === null || entry.total !== previousTotal) {
        competitionRank = index + 1;
        denseRank += 1;
        previousTotal = entry.total;
      }
      ranks.set(entry.id, mode === "DENSE" ? denseRank : competitionRank);
    });

  return ranks;
}

/** 1st, 2nd, 3rd, 4th… for report cards and the portal. */
export function ordinal(position: number): string {
  const lastTwo = position % 100;
  const suffix = lastTwo >= 11 && lastTwo <= 13 ? "th" : ["th", "st", "nd", "rd"][position % 10] ?? "th";
  return `${position}${suffix}`;
}

export type ParsedScore = { ok: true; cell: CellValue | null } | { ok: false; error: string };

/**
 * Reads what a teacher typed: blank clears the cell, "ABS" marks the student absent, otherwise a
 * number from 0 to maxScore with at most 2 decimals. The same rules apply to CSV uploads (FR-12.6).
 */
export function parseScoreInput(raw: string, maxScore: number): ParsedScore {
  const text = raw.trim();
  if (text === "") return { ok: true, cell: null };
  if (/^abs(ent)?$/i.test(text)) return { ok: true, cell: { value: 0, isAbsent: true } };
  if (!/^\d+(\.\d{1,2})?$/.test(text)) return { ok: false, error: "Enter a number, or ABS if absent" };
  const value = Number(text);
  if (value > maxScore) return { ok: false, error: `Must be ${maxScore} or less` };
  return { ok: true, cell: { value, isAbsent: false } };
}

/** How a cell reads back: "" when empty, "ABS" when absent, otherwise the number. */
export function formatScore(cell: CellValue | null | undefined): string {
  if (!cell) return "";
  return cell.isAbsent ? "ABS" : String(cell.value);
}
