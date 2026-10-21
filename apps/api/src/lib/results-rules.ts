/**
 * The Zod halves of the front end's packages/core/src/results.ts (21 Oct 2026), copied with the
 * same rules and messages: our core package has no dependencies, so they live here.
 */
import { z } from "zod";

export const resultsSettingsSchema = z
  .object({
    components: z
      .array(
        z.object({
          id: z.string().min(1).max(40),
          name: z.string().trim().min(1, "Name this part").max(20, "Use at most 20 characters"),
          maxScore: z.coerce.number().int("Use a whole number").min(1, "At least 1").max(100, "At most 100"),
        }),
      )
      .min(1, "Keep at least one part")
      .max(8, "Use at most 8 parts"),
    scale: z
      .array(
        z.object({
          minScore: z.coerce.number().min(0, "0 or more").max(100, "100 or less"),
          grade: z.string().trim().min(1, "Give a grade").max(4, "Use at most 4 characters"),
          remark: z.string().trim().max(30, "Use at most 30 characters"),
          isPass: z.boolean(),
        }),
      )
      .min(2, "Use at least two grades")
      .max(12, "Use at most 12 grades"),
    showPositions: z.boolean(),
  })
  .superRefine((s, ctx) => {
    const total = s.components.reduce((n, c) => n + c.maxScore, 0);
    if (total !== 100) ctx.addIssue({ code: "custom", path: ["components"], message: `The parts add up to ${total}. Make them add up to 100.` });
    const names = new Set<string>();
    const ids = new Set<string>();
    s.components.forEach((c, i) => {
      const key = c.name.toLowerCase();
      if (names.has(key)) ctx.addIssue({ code: "custom", path: ["components", i, "name"], message: "Two parts can’t share a name" });
      if (ids.has(c.id)) ctx.addIssue({ code: "custom", path: ["components", i, "id"], message: "Two parts can’t share an id" });
      names.add(key);
      ids.add(c.id);
    });
    if (!s.scale.some((b) => b.minScore === 0)) ctx.addIssue({ code: "custom", path: ["scale"], message: "Add a grade that starts at 0, so every score gets one." });
    const mins = new Set<number>();
    const grades = new Set<string>();
    s.scale.forEach((b, i) => {
      if (mins.has(b.minScore)) ctx.addIssue({ code: "custom", path: ["scale", i, "minScore"], message: "Two grades can’t start at the same score" });
      if (grades.has(b.grade.toUpperCase())) ctx.addIssue({ code: "custom", path: ["scale", i, "grade"], message: "Two bands can’t share a grade" });
      mins.add(b.minScore);
      grades.add(b.grade.toUpperCase());
    });
  });
export type ResultsSettings = z.infer<typeof resultsSettingsSchema>;

export const unlockRequestSchema = z.object({ reason: z.string().trim().min(5, "Say what needs changing").max(200, "Use at most 200 characters") });

export const ratingSettingsSchema = z
  .object({
    enabled: z.boolean(),
    traits: z.array(z.string().trim().min(1, "Name this trait").max(30, "Use at most 30 characters")).max(12, "Use at most 12 traits"),
  })
  .superRefine((s, ctx) => {
    if (s.enabled && s.traits.length === 0) ctx.addIssue({ code: "custom", path: ["traits"], message: "Add at least one trait, or turn ratings off" });
    const seen = new Set<string>();
    s.traits.forEach((t, i) => {
      if (seen.has(t.toLowerCase())) ctx.addIssue({ code: "custom", path: ["traits", i], message: "Two traits can’t share a name" });
      seen.add(t.toLowerCase());
    });
  });
export type RatingSettings = z.infer<typeof ratingSettingsSchema>;

export const remarkSchema = z.object({ text: z.string().trim().max(300, "Use at most 300 characters") });
export const ratingSchema = z.object({ trait: z.string().min(1), value: z.number().int().min(1).max(5).nullable() });
