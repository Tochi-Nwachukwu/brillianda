import { describe, expect, it } from "vitest";
import { defaultSessionStart, defaultTerms, sessionName, sessionProblems } from "../src/calendar.js";

describe("calendar", () => {
  it("names a session by its two years", () => {
    expect(sessionName(2026)).toBe("2026/2027");
  });

  it("suggests three Lagos-style terms on weekdays", () => {
    // Same output as the frontend's defaultTerms(2026).
    expect(defaultTerms(2026)).toEqual([
      { name: "First Term", startsOn: "2026-09-14", endsOn: "2026-12-18" },
      { name: "Second Term", startsOn: "2027-01-04", endsOn: "2027-04-09" },
      { name: "Third Term", startsOn: "2027-05-03", endsOn: "2027-07-23" },
    ]);
    for (const t of defaultTerms(2027)) {
      expect(new Date(t.startsOn).getUTCDay()).toBe(1); // Monday
      expect(new Date(t.endsOn).getUTCDay()).toBe(5); // Friday
    }
  });

  it("offers two terms and British names", () => {
    const two = defaultTerms(2026, 2, "british");
    expect(two.map((t) => t.name)).toEqual(["Autumn Term", "Spring Term"]);
    expect(sessionProblems(2026, two)).toEqual([]);
  });

  it("defaults the session start from today", () => {
    expect(defaultSessionStart(new Date("2026-10-13T12:00:00Z"))).toEqual({ month: 9, year: 2026 });
    expect(defaultSessionStart(new Date("2027-03-01T12:00:00Z"))).toEqual({ month: 9, year: 2026 });
  });

  it("accepts its own suggestions and reports the frontend's rules by path", () => {
    expect(sessionProblems(2026, defaultTerms(2026))).toEqual([]);
    const bad = [
      { name: "First", startsOn: "2025-09-01", endsOn: "2025-08-01" },
      { name: "first", startsOn: "2025-07-15", endsOn: "2025-12-01" },
    ];
    expect(sessionProblems(2026, bad).map((p) => p.path.join("/")).sort()).toEqual(
      ["terms/0/endsOn", "terms/0/startsOn", "terms/1/name", "terms/1/startsOn"].sort(),
    );
    expect(sessionProblems(2026, defaultTerms(2026).slice(0, 1))[0]!.path).toEqual(["terms"]);
  });
});
