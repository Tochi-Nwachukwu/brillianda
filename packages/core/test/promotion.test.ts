// Copied from the front end's packages/core/src/promotion.test.ts (24 Oct 2026).
import { describe, expect, it } from "vitest";
import { defaultPassMark, nextArm, suggestDecision, yearlyAverage } from "../src/promotion.js";
import { DEFAULT_SCALE, WAEC_SCALE } from "../src/results.js";

describe("yearlyAverage", () => {
  it("averages the terms that have results", () => {
    expect(yearlyAverage([60, 70, null])).toBe(65);
    expect(yearlyAverage([null, null])).toBeNull();
  });
});

describe("suggestDecision", () => {
  it("graduates the final class, and otherwise follows the pass mark", () => {
    expect(suggestDecision(30, 40, true)).toBe("graduate");
    expect(suggestDecision(40, 40, false)).toBe("promote");
    expect(suggestDecision(39.99, 40, false)).toBe("repeat");
    expect(suggestDecision(null, 40, false)).toBe("promote");
  });
  it("takes the pass mark from the lowest passing grade", () => {
    expect(defaultPassMark(DEFAULT_SCALE)).toBe(40);
    expect(defaultPassMark(WAEC_SCALE)).toBe(40);
  });
});

describe("nextArm", () => {
  const levels = [
    { id: "jss1", position: 0 },
    { id: "jss2", position: 1 },
    { id: "jss3", position: 2 },
  ];
  const arms = [
    { id: "1b", levelId: "jss1", armNameId: "blue" },
    { id: "1g", levelId: "jss1", armNameId: "gold" },
    { id: "2b", levelId: "jss2", armNameId: "blue" },
    { id: "3b", levelId: "jss3", armNameId: "blue" },
  ];
  it("keeps the arm name where the next class has it, else its first arm", () => {
    expect(nextArm(levels, arms, arms[0]!)?.id).toBe("2b");
    expect(nextArm(levels, arms, arms[1]!)?.id).toBe("2b");
  });
  it("is null after the last class", () => {
    expect(nextArm(levels, arms, arms[3]!)).toBeNull();
  });
});
