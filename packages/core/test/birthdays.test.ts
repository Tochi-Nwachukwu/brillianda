// Copied from the front end's packages/core/src/birthdays.test.ts (24 Oct 2026); its settings-schema test is in apps/api/test/birthdays.test.ts.
import { describe, expect, it } from "vitest";
import { ageOn, birthdayMessage, DEFAULT_BIRTHDAY_MESSAGE, isBirthday, smsCount, upcomingBirthdays } from "../src/birthdays.js";

describe("birthdays", () => {
  it("fills in the child's first name, age and school", () => {
    expect(birthdayMessage(DEFAULT_BIRTHDAY_MESSAGE, { firstName: "Ada", age: 12 }, "Greenfield College")).toBe(
      "Happy 12th birthday, Ada! Everyone at Greenfield College wishes you a wonderful year ahead.",
    );
    expect(birthdayMessage("{name} turns {age}", { firstName: "Tunde", age: 11 }, "X")).toBe("Tunde turns 11th");
  });

  it("knows the age on a day, before and after the birthday", () => {
    expect(ageOn("2014-10-15", "2026-10-15")).toBe(12);
    expect(ageOn("2014-10-16", "2026-10-15")).toBe(11);
  });

  it("keeps a 29 February birthday on 28 February in other years", () => {
    expect(isBirthday("2012-02-29", "2026-02-28")).toBe(true);
    expect(isBirthday("2012-02-29", "2028-02-29")).toBe(true);
    expect(isBirthday("2012-02-29", "2028-02-28")).toBe(false);
    expect(ageOn("2012-02-29", "2026-02-28")).toBe(14);
  });

  it("lists the coming birthdays, soonest first, and skips students without a date of birth", () => {
    const students = [
      { id: "a", dateOfBirth: "2013-10-17" },
      { id: "b", dateOfBirth: "2014-10-15" },
      { id: "c", dateOfBirth: "" },
      { id: "d", dateOfBirth: "2012-11-30" },
    ];
    expect(upcomingBirthdays(students, "2026-10-15", 7).map((s) => [s.id, s.inDays, s.turns])).toEqual([
      ["b", 0, 12],
      ["a", 2, 13],
    ]);
  });

  it("counts texts, in plain or Unicode", () => {
    expect(smsCount("a".repeat(160))).toEqual({ characters: 160, texts: 1, unicode: false });
    expect(smsCount("a".repeat(161)).texts).toBe(2);
    // A Yoruba name makes the whole text Unicode: 70 characters a text.
    expect(smsCount(`Happy birthday, Ọlá! ${"a".repeat(60)}`)).toMatchObject({ texts: 2, unicode: true });
  });
});
