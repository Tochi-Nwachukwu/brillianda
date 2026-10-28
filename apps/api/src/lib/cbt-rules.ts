/**
 * The front end's testSettingsSchema (its packages/core/src/cbt.ts), with the same rules, and the
 * shape of one answer a student sends.
 */
import { WHERE } from "@brillianda/core";
import { z } from "@hono/zod-openapi";

export const testSettingsSchema = z
  .object({
    title: z.string({ message: "Give the test a title" }).trim().min(3, "Give the test a title").max(80, "Use at most 80 characters"),
    instructions: z.string().trim().max(500, "Use at most 500 characters").default(""),
    armIds: z.array(z.string().uuid("Choose a class")).min(1, "Choose at least one class"),
    questionIds: z.array(z.string().uuid("Choose a question")).min(1, "Add at least one question").max(100, "Use at most 100 questions"),
    durationMinutes: z.coerce.number({ message: "Whole minutes" }).int("Whole minutes").min(5, "At least 5 minutes").max(240, "At most 4 hours"),
    /** ISO date-times (the browser sends Lagos local times converted to UTC). */
    opensAt: z.string({ message: "Choose when it opens" }).min(1, "Choose when it opens"),
    closesAt: z.string({ message: "Choose when it closes" }).min(1, "Choose when it closes"),
    where: z.enum(WHERE, { message: "Choose anywhere or in school only" }),
    shuffle: z.boolean(),
    showScore: z.boolean(),
    componentId: z.string({ message: "Choose where the scores go" }).min(1, "Choose where the scores go"),
  })
  .superRefine((t, ctx) => {
    const opens = Date.parse(t.opensAt);
    const closes = Date.parse(t.closesAt);
    if (Number.isNaN(opens)) ctx.addIssue({ code: "custom", path: ["opensAt"], message: "Choose when it opens" });
    if (Number.isNaN(closes)) ctx.addIssue({ code: "custom", path: ["closesAt"], message: "Choose when it closes" });
    else if (closes <= opens) ctx.addIssue({ code: "custom", path: ["closesAt"], message: "It closes after it opens" });
    else if (closes - opens < t.durationMinutes * 60_000) ctx.addIssue({ code: "custom", path: ["closesAt"], message: "Leave at least the test’s length between opening and closing" });
  })
  .openapi("TestSettings");

/** One answer: an option (by its position in the question), true or false, or words. */
export const responseSchema = z
  .union([
    z.object({ option: z.number().int().min(0).max(4) }).strict(),
    z.object({ value: z.boolean() }).strict(),
    z.object({ text: z.string().max(5000, "Use at most 5,000 characters") }).strict(),
  ])
  .openapi("TestResponse");
