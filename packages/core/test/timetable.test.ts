// Copied from the front end's packages/core/src/timetable.test.ts (25 Oct 2026); its bell-schedule test is in apps/api/test/timetable.test.ts.
import { describe, expect, it } from "vitest";
import { clashes, DEFAULT_PERIODS, groupFor, groupName, matchSubject, readTimetableGrid } from "../src/timetable.js";

const SUBJECTS = [
  { id: "m", name: "Mathematics", code: "MTH" },
  { id: "e", name: "English Studies", code: "ENG" },
  { id: "b", name: "Basic Science", code: "BSC" },
  { id: "bt", name: "Basic Technology", code: "BTE" },
];

describe("timetable", () => {
  it("matches subjects by name, code, short form or a unique start", () => {
    expect(matchSubject("Maths", SUBJECTS)).toBe("m");
    expect(matchSubject("eng", SUBJECTS)).toBe("e");
    expect(matchSubject("MTH", SUBJECTS)).toBe("m");
    expect(matchSubject("english studies", SUBJECTS)).toBe("e");
    // "Basic" could be either: no guess.
    expect(matchSubject("Basic", SUBJECTS)).toBeNull();
    expect(matchSubject("Basic Sci", SUBJECTS)).toBe("b");
  });

  it("reads days down the side, periods across the top, by name or time", () => {
    const rows = [
      ["JSS 1 Blue"],
      ["Day", "Period 1", "8:40", "Period 3", "Break", "Period 4"],
      ["Monday", "Maths", "English", "", "", "Free"],
      ["Tue", "Basic Science", "Football", "MTH", "", ""],
    ];
    const result = readTimetableGrid(rows, DEFAULT_PERIODS, SUBJECTS);
    expect(result.ok && result.lessons).toEqual([
      { day: 1, periodId: "p1", subjectId: "m" },
      { day: 1, periodId: "p2", subjectId: "e" },
      { day: 2, periodId: "p1", subjectId: "b" },
      { day: 2, periodId: "p3", subjectId: "m" },
    ]);
    expect(result.ok && result.problems).toEqual([{ day: 2, periodId: "p2", text: "Football", message: "“Football” isn’t one of the school’s subjects" }]);
  });

  it("reads the template’s headings, and tells Period 1 from Period 10", () => {
    const periods = [...DEFAULT_PERIODS, { id: "p10", label: "Period 10", start: "15:00", end: "15:40", kind: "lesson" as const }];
    const rows = [
      ["Day", "Period 1 (8:00–8:40)", "Break (10:00–10:20)", "Period 10 (15:00–15:40)"],
      ["Monday", "Maths", "Break", "English"],
    ];
    const result = readTimetableGrid(rows, periods, SUBJECTS);
    expect(result.ok && result.lessons).toEqual([
      { day: 1, periodId: "p1", subjectId: "m" },
      { day: 1, periodId: "p10", subjectId: "e" },
    ]);
  });

  it("reads days across the top too", () => {
    const rows = [
      ["", "Mon", "Tue", "Wed", "Thu", "Fri"],
      ["08:00 - 08:40", "Maths", "", "", "", "English"],
    ];
    const result = readTimetableGrid(rows, DEFAULT_PERIODS, SUBJECTS);
    expect(result.ok && result.lessons).toEqual([
      { day: 1, periodId: "p1", subjectId: "m" },
      { day: 5, periodId: "p1", subjectId: "e" },
    ]);
  });

  it("says plainly when it can't find a timetable", () => {
    expect(readTimetableGrid([["Name", "Class"], ["Ada", "JSS 1"]], DEFAULT_PERIODS, SUBJECTS).ok).toBe(false);
  });

  it("finds a teacher in two classes at once", () => {
    const teacherOf = (_arm: string, subject: string) => (subject === "m" ? "bisi" : null);
    expect(
      clashes(
        [
          { armId: "a", day: 1, periodId: "p1", subjectId: "m" },
          { armId: "b", day: 1, periodId: "p1", subjectId: "m" },
          { armId: "b", day: 1, periodId: "p2", subjectId: "m" },
        ],
        teacherOf,
      ),
    ).toEqual([{ teacherId: "bisi", day: 1, periodId: "p1", armIds: ["a", "b"] }]);
  });

});

describe("timetable groups (30 Oct 2026)", () => {
  it("names a group by its sections, and finds a class's group", () => {
    expect(groupName(["junior", "senior"])).toBe("JSS and SSS");
    expect(groupName(["primary", "junior", "senior"], ["primary", "junior", "senior"])).toBe("Whole school");
    const groups = [{ id: "a", sections: ["primary" as const] }, { id: "b", sections: ["junior" as const, "senior" as const] }];
    expect(groupFor(groups, "senior").id).toBe("b");
    expect(groupFor(groups, null).id).toBe("a");
    expect(groupFor(groups, "preschool").id).toBe("a");
  });

  it("finds clashes by overlapping times when bell schedules differ", () => {
    const teacherOf = () => "t1";
    const times: Record<string, Record<string, { start: string; end: string }>> = {
      pri: { p1: { start: "08:00", end: "08:35" }, p2: { start: "08:35", end: "09:10" } },
      jss: { p1: { start: "08:00", end: "08:40" }, p2: { start: "08:40", end: "09:20" } },
    };
    const timeOf = (armId: string, periodId: string) => times[armId]?.[periodId] ?? null;
    // Primary's p2 (8:35) overlaps JSS's p1 (to 8:40); same ids at different times don't clash by id.
    const found = clashes(
      [
        { armId: "pri", day: 1, periodId: "p2", subjectId: "m" },
        { armId: "jss", day: 1, periodId: "p1", subjectId: "m" },
      ],
      teacherOf,
      timeOf,
    );
    expect(found).toEqual([{ teacherId: "t1", day: 1, periodId: "p1", armIds: ["jss", "pri"] }]);
    expect(clashes([{ armId: "pri", day: 1, periodId: "p1", subjectId: "m" }, { armId: "jss", day: 1, periodId: "p2", subjectId: "m" }], teacherOf, timeOf)).toEqual([]);
  });
});
