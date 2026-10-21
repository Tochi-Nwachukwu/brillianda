// Copied from the front end's packages/core/src/results.test.ts (21 Oct 2026), minus the Zod
// schema tests, which live with the API (apps/api/test/results-rules.test.ts).
import { describe, expect, it } from "vitest";
import { resolveGrade } from "../src/grading.js";
import { classResults, DEFAULT_COMPONENTS, DEFAULT_SCALE, rowTotal, sheetProgress } from "../src/results.js";

describe("defaults", () => {
  it("give every score a grade", () => {
    expect(resolveGrade(69.99, DEFAULT_SCALE).grade).toBe("B");
    expect(resolveGrade(0, DEFAULT_SCALE).grade).toBe("F");
  });
});

describe("sheets and class results", () => {
  const full = { studentId: "s1", excluded: false, scores: { ca1: { value: 15, isAbsent: false }, ca2: { value: 18, isAbsent: false }, exam: { value: 42, isAbsent: false } } };
  const partial = { studentId: "s2", excluded: false, scores: { ca1: { value: 10, isAbsent: false } } };
  const elective = { studentId: "s3", excluded: true, scores: {} };

  it("counts only students who take the subject", () => {
    expect(sheetProgress([full, partial, elective], DEFAULT_COMPONENTS)).toEqual({ complete: 1, of: 2 });
  });
  it("totals a complete row, and nothing for a partial one", () => {
    expect(rowTotal(full, DEFAULT_COMPONENTS)).toBe(75);
    expect(rowTotal(partial, DEFAULT_COMPONENTS)).toBeNull();
  });
  it("averages over each student's subjects and ranks within the arm, ties shared", () => {
    const results = classResults(
      ["a", "b", "c", "d"],
      [
        { studentId: "a", subjectId: "m", total: 80 },
        { studentId: "a", subjectId: "e", total: 60 },
        { studentId: "b", subjectId: "m", total: 70 },
        { studentId: "c", subjectId: "m", total: 70 },
      ],
    );
    expect(results.get("a")).toEqual({ average: 70, subjects: 2, position: 1 });
    expect(results.get("b")?.position).toBe(1);
    expect(results.get("c")?.position).toBe(1);
    expect(results.get("d")).toEqual({ average: null, subjects: 0, position: null });
  });
});
