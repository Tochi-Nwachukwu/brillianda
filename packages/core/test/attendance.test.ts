// Copied from the front end's packages/core/src/attendance.test.ts (minus the Zod schema test,
// which lives with the API's route tests).
import { describe, expect, it } from "vitest";
import { attendanceSummary, isSchoolDay, latestSchoolDay, registerDayProblem, schoolDaysSoFar } from "../src/attendance.js";

const terms = [
  { name: "First Term", startsOn: "2026-09-14", endsOn: "2026-12-18" },
  { name: "Second Term", startsOn: "2027-01-11", endsOn: "2027-04-09" },
];

describe("school days", () => {
  it("are weekdays inside a term", () => {
    expect(isSchoolDay("2026-10-14", terms)).toBe(true); // Wednesday
    expect(isSchoolDay("2026-10-17", terms)).toBe(false); // Saturday
    expect(isSchoolDay("2026-12-28", terms)).toBe(false); // the break
  });
  it("finds the latest one, skipping a weekend", () => {
    expect(latestSchoolDay("2026-10-18", terms)).toBe("2026-10-16");
    expect(latestSchoolDay("2026-10-14", terms)).toBe("2026-10-14");
  });
  it("lists a term's days so far, newest first", () => {
    const days = schoolDaysSoFar(terms[0]!, "2026-09-21");
    expect(days[0]).toBe("2026-09-21");
    expect(days.at(-1)).toBe("2026-09-14");
    expect(days).toHaveLength(6);
  });
});

describe("registerDayProblem", () => {
  const today = "2026-10-14";
  it("allows any school day this term up to today", () => {
    expect(registerDayProblem("2026-10-14", today, terms)).toBeNull();
    expect(registerDayProblem("2026-09-14", today, terms)).toBeNull();
  });
  it("explains the rest", () => {
    expect(registerDayProblem("2026-10-15", today, terms)).toMatch(/hasn’t come/);
    expect(registerDayProblem("2026-10-10", today, terms)).toMatch(/weekend/);
    expect(registerDayProblem("2026-08-03", today, terms)).toMatch(/isn’t in a term/);
  });
});

describe("the summary", () => {
  it("counts late as present", () => {
    expect(attendanceSummary(["present", "late", "absent", "present"])).toEqual({ days: 4, present: 3, late: 1, absent: 1 });
  });
});
