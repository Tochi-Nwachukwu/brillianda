// Copied from the front end's packages/core/src/grading.test.ts (21 Oct 2026).
import { describe, expect, it } from "vitest";
import {
  UngradedScoreError,
  computeSubjectTotal,
  formatScore,
  ordinal,
  parseScoreInput,
  rankScores,
  resolveGrade,
  roundScore,
  type GradeBand,
} from "../src/grading.js";

const SCALE: GradeBand[] = [
  { minScore: 70, grade: "A", remark: "Excellent", isPass: true },
  { minScore: 60, grade: "B", remark: "Very Good", isPass: true },
  { minScore: 50, grade: "C", remark: "Good", isPass: true },
  { minScore: 45, grade: "D", remark: "Fair", isPass: true },
  { minScore: 40, grade: "E", remark: "Pass", isPass: true },
  { minScore: 0, grade: "F", remark: "Fail", isPass: false },
];

const CA_EXAM = [
  { id: "ca1", weight: 20, maxScore: 20 },
  { id: "ca2", weight: 20, maxScore: 20 },
  { id: "exam", weight: 60, maxScore: 60 },
];

const score = (value: number) => ({ value, isAbsent: false });
const absent = { value: 0, isAbsent: true };

describe("computeSubjectTotal", () => {
  it("adds components whose maximum equals their weight", () => {
    expect(computeSubjectTotal(CA_EXAM, { ca1: score(15), ca2: score(18), exam: score(50) })).toEqual({
      total: 83,
      complete: true,
    });
  });

  it("scales components marked out of a different maximum than their weight", () => {
    const uneven = [
      { id: "ca", weight: 40, maxScore: 50 },
      { id: "exam", weight: 60, maxScore: 100 },
    ];
    // 35/50 × 40 = 28, 72/100 × 60 = 43.2
    expect(computeSubjectTotal(uneven, { ca: score(35), exam: score(72) })).toEqual({ total: 71.2, complete: true });
  });

  it("gives a running total, marked incomplete, while components are missing", () => {
    expect(computeSubjectTotal(CA_EXAM, { ca1: score(15), exam: null })).toEqual({ total: 15, complete: false });
    expect(computeSubjectTotal(CA_EXAM, {})).toEqual({ total: 0, complete: false });
  });

  it("counts an absent student as zero for that component, and as complete", () => {
    expect(computeSubjectTotal(CA_EXAM, { ca1: absent, ca2: score(18), exam: score(50) })).toEqual({
      total: 68,
      complete: true,
    });
  });

  it("rounds to 2 decimal places without float noise", () => {
    expect(computeSubjectTotal([{ id: "a", weight: 100, maxScore: 3 }], { a: score(2) }).total).toBe(66.67);
    const tenths = [
      { id: "a", weight: 30, maxScore: 10 },
      { id: "b", weight: 70, maxScore: 10 },
    ];
    expect(computeSubjectTotal(tenths, { a: score(7), b: score(7) }).total).toBe(70);
  });
});

describe("roundScore", () => {
  it("rounds half up, including values stored just below the half", () => {
    expect(roundScore(69.995)).toBe(70);
    expect(roundScore(1.005)).toBe(1.01);
    expect(roundScore(82.444)).toBe(82.44);
    expect(roundScore(0)).toBe(0);
  });
});

describe("resolveGrade", () => {
  it("gives the higher grade to a total exactly on a boundary", () => {
    expect(resolveGrade(70, SCALE).grade).toBe("A");
    expect(resolveGrade(45, SCALE).grade).toBe("D");
  });

  it("has no gap between bands", () => {
    expect(resolveGrade(69.99, SCALE).grade).toBe("B");
    expect(resolveGrade(69.5, SCALE).grade).toBe("B");
  });

  it("covers both ends of the scale", () => {
    expect(resolveGrade(0, SCALE)).toMatchObject({ grade: "F", isPass: false });
    expect(resolveGrade(100, SCALE)).toMatchObject({ grade: "A", remark: "Excellent" });
  });

  it("does not depend on the order bands are stored in", () => {
    expect(resolveGrade(62, [...SCALE].reverse()).grade).toBe("B");
  });

  it("fails loudly when the scale doesn't start at 0", () => {
    const noFloor = SCALE.filter((band) => band.minScore > 0);
    expect(() => resolveGrade(12, noFloor)).toThrow(UngradedScoreError);
  });
});

describe("parseScoreInput", () => {
  it("treats blank as an empty cell", () => {
    expect(parseScoreInput("", 20)).toEqual({ ok: true, cell: null });
    expect(parseScoreInput("   ", 20)).toEqual({ ok: true, cell: null });
  });

  it("accepts whole and 2-decimal numbers up to the maximum", () => {
    expect(parseScoreInput(" 15 ", 20)).toEqual({ ok: true, cell: score(15) });
    expect(parseScoreInput("12.5", 20)).toEqual({ ok: true, cell: score(12.5) });
    expect(parseScoreInput("20", 20)).toEqual({ ok: true, cell: score(20) });
    expect(parseScoreInput("0", 20)).toEqual({ ok: true, cell: score(0) });
  });

  it("accepts ABS in any case for an absent student", () => {
    for (const text of ["ABS", "abs", "Absent"]) {
      expect(parseScoreInput(text, 20)).toEqual({ ok: true, cell: absent });
    }
  });

  it("rejects scores above the maximum", () => {
    expect(parseScoreInput("21", 20)).toEqual({ ok: false, error: "Must be 20 or less" });
  });

  it("rejects anything that isn't a plain score", () => {
    for (const text of ["-3", "abc", "12.555", "1e2", "15/20", "."]) {
      expect(parseScoreInput(text, 100)).toEqual({ ok: false, error: "Enter a number, or ABS if absent" });
    }
  });
});

describe("rankScores", () => {
  const totals = [
    { id: "ada", total: 88 },
    { id: "bayo", total: 85 },
    { id: "chidi", total: 85 },
    { id: "dayo", total: 80 },
  ];

  it("skips a rank after a tie by default: 1, 2, 2, 4 (D-2)", () => {
    expect([...rankScores(totals)]).toEqual([
      ["ada", 1],
      ["bayo", 2],
      ["chidi", 2],
      ["dayo", 4],
    ]);
  });

  it("takes the next number after a tie in dense mode: 1, 2, 2, 3", () => {
    expect(rankScores(totals, "DENSE").get("dayo")).toBe(3);
  });

  it("doesn't depend on the order it was given", () => {
    const shuffled = [totals[3]!, totals[1]!, totals[0]!, totals[2]!];
    expect([...rankScores(shuffled)].sort()).toEqual([...rankScores(totals)].sort());
  });

  it("handles an empty class, one student, and everyone tied", () => {
    expect(rankScores([]).size).toBe(0);
    expect(rankScores([{ id: "solo", total: 40 }]).get("solo")).toBe(1);
    const allTied = rankScores([
      { id: "a", total: 50 },
      { id: "b", total: 50 },
      { id: "c", total: 50 },
    ]);
    expect([...allTied.values()]).toEqual([1, 1, 1]);
  });
});

describe("ordinal", () => {
  it("names positions the way a report card does", () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 34, 101].map(ordinal)).toEqual([
      "1st",
      "2nd",
      "3rd",
      "4th",
      "11th",
      "12th",
      "13th",
      "21st",
      "22nd",
      "34th",
      "101st",
    ]);
  });
});

describe("formatScore", () => {
  it("shows empty, absent and numeric cells the way a teacher types them", () => {
    expect(formatScore(null)).toBe("");
    expect(formatScore(absent)).toBe("ABS");
    expect(formatScore(score(12.5))).toBe("12.5");
  });
});
