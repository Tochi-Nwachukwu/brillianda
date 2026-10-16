import { describe, expect, it } from "vitest";
import { NIGERIAN_STATES, normaliseNigerianPhone } from "../src/nigeria.js";

describe("normaliseNigerianPhone", () => {
  it.each([
    ["0803 000 0001", "+2348030000001"],
    ["08030000001", "+2348030000001"],
    ["+234 803-000-0001", "+2348030000001"],
    ["2348030000001", "+2348030000001"],
    ["+234 0803 000 0001", "+2348030000001"],
    ["(0703) 123 4567", "+2347031234567"],
    ["0901 234 5678", "+2349012345678"],
    ["01 234 5678", "+23412345678"],
  ])("%s → %s", (input, expected) => {
    expect(normaliseNigerianPhone(input)).toBe(expected);
  });

  it.each(["", "abc", "0803", "+44 7700 900123", "0603 000 0001", "080300000011234", "+234"])("rejects %j", (input) => {
    expect(normaliseNigerianPhone(input)).toBeNull();
  });
});

describe("NIGERIAN_STATES", () => {
  it("has 36 states and the FCT", () => {
    expect(NIGERIAN_STATES).toHaveLength(37);
    expect(new Set(NIGERIAN_STATES).size).toBe(37);
  });
});
