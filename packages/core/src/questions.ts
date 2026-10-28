// From the front end's packages/core/src/questions.ts (28 Oct 2026): the question shape shared by
// the question bank, the AI generator, CBT and marking. Its Zod schemas (questionSchema,
// generateRequestSchema) live in apps/api/src/lib/questions.ts with the same rules, since this
// package has no dependencies. Keep both in step with the front end.

export const QUESTION_TYPES = ["objective", "trueFalse", "fillGap", "theory"] as const;
export type QuestionType = (typeof QUESTION_TYPES)[number];
export const QUESTION_TYPE_LABEL: Record<QuestionType, string> = {
  objective: "Objective",
  trueFalse: "True or false",
  fillGap: "Fill in the gap",
  theory: "Theory",
};

export const DIFFICULTIES = ["easy", "medium", "hard"] as const;
export type Difficulty = (typeof DIFFICULTIES)[number];

type Common = { text: string; marks: number; topic: string; difficulty: Difficulty };
export type Question =
  | (Common & { type: "objective"; options: string[]; /** The right option, by position. */ answer: number })
  | (Common & { type: "trueFalse"; answer: boolean })
  | (Common & { type: "fillGap"; /** Every answer accepted; case and spacing don't matter. */ answers: string[] })
  | (Common & { type: "theory"; /** What a full answer includes, for the teacher marking it. */ guide: string });

/** Option letters: A, B, C, D, E. */
export const optionLetter = (i: number) => String.fromCharCode(65 + i);

const tidy = (s: string) => s.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ").replace(/[.]$/, "");

/** A student's response to one question: an option, true/false, words, or an essay. */
export type Response = { option: number } | { value: boolean } | { text: string };

/**
 * Marks for an answer, or null when a teacher must mark it (theory). Objective, true/false and
 * fill-in-the-gap are all or nothing; no answer scores 0.
 */
export function markAnswer(q: Question, response: Response | null): number | null {
  if (q.type === "theory") return null;
  if (!response) return 0;
  if (q.type === "objective") return "option" in response && response.option === q.answer ? q.marks : 0;
  if (q.type === "trueFalse") return "value" in response && response.value === q.answer ? q.marks : 0;
  return "text" in response && q.answers.some((a) => tidy(a) === tidy(response.text)) ? q.marks : 0;
}

/** Total marks of a set of questions. */
export const totalMarks = (qs: Pick<Question, "marks">[]) => qs.reduce((n, q) => n + q.marks, 0);

/**
 * The same order every time for the same seed (a student and a test), different between students:
 * so a refresh doesn't reshuffle, and neighbours don't see the same order.
 */
export function seededOrder(length: number, seed: string): number[] {
  let h = 2166136261;
  for (const ch of seed) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  const next = () => {
    h ^= h << 13;
    h ^= h >>> 17;
    h ^= h << 5;
    return (h >>> 0) / 4294967296;
  };
  const order = Array.from({ length }, (_, i) => i);
  for (let i = length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [order[i], order[j]] = [order[j]!, order[i]!];
  }
  return order;
}

// ——— Asking for questions (the AI generator) ———

export const PURPOSES = ["test", "assignment", "exam"] as const;
export type Purpose = (typeof PURPOSES)[number];

/** A school's AI allowance each month (the front end's docs/ai-integration.md, Step 8). */
export const MONTHLY_GENERATIONS = 300;
