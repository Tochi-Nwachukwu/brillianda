// Copied from the front end's packages/core/src/questions.test.ts (28 Oct 2026); its schema tests are in apps/api/test/questions.test.ts.
import { describe, expect, it } from "vitest";
import { markAnswer, seededOrder, totalMarks, type Question } from "../src/questions.js";

const base = { marks: 1, topic: "Plants", difficulty: "easy" as const };
const objective: Question = { type: "objective", text: "Plants make food by…", options: ["respiration", "photosynthesis", "digestion"], answer: 1, ...base };
const gap: Question = { type: "fillGap", text: "Green plants contain ____.", answers: ["chlorophyll"], ...base, marks: 2 };
const essay: Question = { type: "theory", text: "Explain photosynthesis.", guide: "Light, water, carbon dioxide", ...base, marks: 10 };

describe("questions", () => {
  it("marks objective, true/false and gaps; leaves theory for the teacher", () => {
    expect(markAnswer(objective, { option: 1 })).toBe(1);
    expect(markAnswer(objective, { option: 0 })).toBe(0);
    expect(markAnswer(objective, null)).toBe(0);
    expect(markAnswer({ type: "trueFalse", text: "The sun is a star.", answer: true, ...base }, { value: true })).toBe(1);
    expect(markAnswer(gap, { text: "  Chlorophyll. " })).toBe(2);
    expect(markAnswer(gap, { text: "chloroplast" })).toBe(0);
    expect(markAnswer(essay, { text: "Plants use light…" })).toBeNull();
    expect(totalMarks([objective, gap, essay])).toBe(13);
  });

  it("shuffles the same way for the same seed, and differently for another", () => {
    const a = seededOrder(10, "test1:st1");
    expect(seededOrder(10, "test1:st1")).toEqual(a);
    expect([...a].sort((x, y) => x - y)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(seededOrder(10, "test1:st2")).not.toEqual(a);
  });

});
