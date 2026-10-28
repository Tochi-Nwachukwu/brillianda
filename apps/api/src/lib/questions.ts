/**
 * The front end's questionSchema and generateRequestSchema (its packages/core/src/questions.ts),
 * with the same rules. One shape for the bank, the AI generator, CBT and marking.
 */
import { DIFFICULTIES, PURPOSES, type Question } from "@brillianda/core";
import { z } from "@hono/zod-openapi";

const text = (max: number, empty: string) => z.string({ message: empty }).trim().min(1, empty).max(max, `Use at most ${max} characters`);
const common = {
  text: text(1000, "Write the question"),
  marks: z.coerce.number({ message: "Give it marks" }).min(0.5, "At least half a mark").max(50, "At most 50 marks"),
  topic: z.string().trim().max(80, "Use at most 80 characters").default(""),
  difficulty: z.enum(DIFFICULTIES, { message: "Choose easy, medium or hard" }),
};

export const questionSchema = z
  .discriminatedUnion("type", [
    z.object({
      type: z.literal("objective"),
      ...common,
      options: z.array(text(300, "Fill in this option")).min(2, "At least two options").max(5, "At most five options"),
      answer: z.coerce.number().int().min(0, "Choose the right option"),
    }),
    z.object({ type: z.literal("trueFalse"), ...common, answer: z.boolean({ message: "Choose true or false" }) }),
    z.object({
      type: z.literal("fillGap"),
      ...common,
      answers: z.array(text(120, "Write an accepted answer")).min(1, "At least one accepted answer").max(5),
    }),
    z.object({ type: z.literal("theory"), ...common, guide: z.string().trim().max(2000, "Use at most 2,000 characters").default("") }),
  ])
  .superRefine((q, ctx) => {
    if (q.type === "objective" && q.answer >= q.options.length) ctx.addIssue({ code: "custom", path: ["answer"], message: "Choose the right option" });
  })
  .openapi("Question", { description: "objective (2 to 5 options and the right one, by position), trueFalse, fillGap (accepted answers) or theory (a marking guide)" });

/** What the parsed schema gives is exactly core's Question. */
export const asQuestion = (q: z.infer<typeof questionSchema>): Question => q as Question;

export const generateRequestSchema = z
  .object({
    purpose: z.enum(PURPOSES, { message: "Choose test, assignment or exam" }),
    subjectId: z.string({ message: "Choose a subject" }).uuid("Choose a subject"),
    levelId: z.string({ message: "Choose a class" }).uuid("Choose a class"),
    topics: z.array(z.string().trim().min(2, "At least 2 characters").max(80, "Use at most 80 characters")).min(1, "Add at least one topic").max(10, "Use at most 10 topics"),
    notes: z.string().trim().max(500, "Use at most 500 characters").default(""),
    counts: z.object({
      objective: z.coerce.number().int().min(0).max(50),
      trueFalse: z.coerce.number().int().min(0).max(20),
      fillGap: z.coerce.number().int().min(0).max(20),
      theory: z.coerce.number().int().min(0).max(10),
    }),
    difficulty: z.enum(["easy", "medium", "hard", "mixed"], { message: "Choose a difficulty" }),
  })
  .superRefine((r, ctx) => {
    const n = r.counts.objective + r.counts.trueFalse + r.counts.fillGap + r.counts.theory;
    if (n < 1) ctx.addIssue({ code: "custom", path: ["counts"], message: "Ask for at least one question" });
    if (n > 60) ctx.addIssue({ code: "custom", path: ["counts"], message: "Ask for at most 60 questions at a time" });
  })
  .openapi("GenerateRequest");
export type GenerateRequest = z.infer<typeof generateRequestSchema>;
