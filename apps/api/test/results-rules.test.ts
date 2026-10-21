// The Zod tests from the front end's packages/core/src/results.test.ts (21 Oct 2026).
import { DEFAULT_COMPONENTS, DEFAULT_SCALE, DEFAULT_TRAITS, WAEC_SCALE } from "@brillianda/core";
import { describe, expect, it } from "vitest";
import { ratingSettingsSchema, resultsSettingsSchema } from "../src/lib/results-rules.js";

const settings = { components: DEFAULT_COMPONENTS, scale: DEFAULT_SCALE, showPositions: true };

describe("resultsSettingsSchema", () => {
  it("accepts the defaults and WAEC", () => {
    expect(resultsSettingsSchema.safeParse(settings).success).toBe(true);
    expect(resultsSettingsSchema.safeParse({ ...settings, scale: WAEC_SCALE }).success).toBe(true);
  });
  it("needs parts that add up to 100", () => {
    const result = resultsSettingsSchema.safeParse({ ...settings, components: [{ id: "a", name: "CA", maxScore: 30 }, { id: "b", name: "Exam", maxScore: 60 }] });
    expect(result.error?.issues[0]?.message).toBe("The parts add up to 90. Make them add up to 100.");
  });
  it("needs a grade from 0, and no repeats", () => {
    expect(resultsSettingsSchema.safeParse({ ...settings, scale: DEFAULT_SCALE.slice(0, -1) }).success).toBe(false);
    const repeated = resultsSettingsSchema.safeParse({ ...settings, scale: [...DEFAULT_SCALE, { minScore: 80, grade: "a", remark: "", isPass: true }] });
    expect(repeated.error?.issues.map((i) => i.message)).toContain("Two bands can’t share a grade");
  });
});

describe("rating settings", () => {
  it("needs traits when on, and no repeats", () => {
    expect(ratingSettingsSchema.safeParse({ enabled: true, traits: DEFAULT_TRAITS }).success).toBe(true);
    expect(ratingSettingsSchema.safeParse({ enabled: true, traits: [] }).success).toBe(false);
    expect(ratingSettingsSchema.safeParse({ enabled: false, traits: [] }).success).toBe(true);
    expect(ratingSettingsSchema.safeParse({ enabled: true, traits: ["Neatness", "neatness"] }).success).toBe(false);
  });
});
