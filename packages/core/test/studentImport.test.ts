import { describe, expect, it } from "vitest";
import { checkRows, guessColumn, guessMapping, mappingProblems, matchClass, readDateCell, splitFullName, type ImportContext } from "../src/studentImport.js";

const levels = [
  { id: "j1", name: "JSS 1", short: "JSS1" },
  { id: "j2", name: "JSS 2", short: "JSS2" },
  { id: "s1", name: "SS 1", short: "SS1" },
];
const arms = [
  { id: "j1a", levelId: "j1", name: "A", code: "A" },
  { id: "j1b", levelId: "j1", name: "B", code: "B" },
  { id: "j2g", levelId: "j2", name: "Gold", code: "GOL" },
  { id: "j2b", levelId: "j2", name: "Blue", code: "BLU" },
  { id: "s1x", levelId: "s1", name: "A", code: "A" },
];
const ctx: ImportContext = { levels, arms, existing: [{ id: "old", admissionNo: "SBS/2026/0042", fullName: "Ọlá Adéṣínà", dateOfBirth: "2013-05-01" }] };

describe("columns", () => {
  it("maps the plan's variants: Surname, Sex and Adm No", () => {
    expect(guessColumn("Surname")).toBe("lastName");
    expect(guessColumn("Sex")).toBe("gender");
    expect(guessColumn("Adm No")).toBe("admissionNo");
    expect(guessColumn("Student's Full Name")).toBe("fullName");
    expect(guessColumn("Father's Phone No")).toBe("guardianPhone");
    expect(guessColumn("Arm")).toBe("armName");
    expect(guessColumn("Favourite colour")).toBeNull();
  });

  it("uses each column once and says what is still missing", () => {
    const mapping = guessMapping(["Surname", "First name", "Sex", "Class", "Phone", "Phone"]);
    expect(mapping).toEqual({ 0: "lastName", 1: "firstName", 2: "gender", 3: "className", 4: "guardianPhone", 5: null });
    expect(mappingProblems(mapping, false)).toEqual([]);
    expect(mappingProblems({ 0: "firstName" }, false)).toHaveLength(3);
    expect(mappingProblems({ 0: "fullName", 1: "gender" }, true)).toEqual([]);
  });
});

describe("readDateCell", () => {
  it("reads day first in the common ways", () => {
    expect(readDateCell("14/03/2014")).toEqual({ ok: true, value: "2014-03-14" });
    expect(readDateCell("14-3-14")).toEqual({ ok: true, value: "2014-03-14" });
    expect(readDateCell("14 March 2014")).toEqual({ ok: true, value: "2014-03-14" });
    expect(readDateCell("2014-03-14")).toEqual({ ok: true, value: "2014-03-14" });
    expect(readDateCell("")).toEqual({ ok: true, value: null });
  });

  it("flags a month-first date instead of guessing (plan: 03/14/2014)", () => {
    expect(readDateCell("03/14/2014")).toEqual({ ok: false, message: "Dates are read day first. Did you mean 14/03/2014?" });
    expect(readDateCell("31/02/2014").ok).toBe(false);
  });
});

describe("matchClass", () => {
  it("matches exact, normalised and the common spellings", () => {
    expect(matchClass(levels, arms, "JSS 2", "Gold")).toMatchObject({ ok: true, armId: "j2g", label: "JSS 2 Gold" });
    expect(matchClass(levels, arms, "jss2", "gold")).toMatchObject({ ok: true, armId: "j2g" });
    expect(matchClass(levels, arms, "Jss 2", "GOL")).toMatchObject({ ok: true, armId: "j2g" });
    expect(matchClass(levels, arms, "SSS 1", "")).toMatchObject({ ok: true, armId: "s1x", label: "SS 1" });
  });

  it("splits a combined value such as JSS 1A (plan)", () => {
    expect(matchClass(levels, arms, "JSS 1A", "")).toMatchObject({ ok: true, armId: "j1a", label: "JSS 1 A" });
    expect(matchClass(levels, arms, "JSS2 Blue", "")).toMatchObject({ ok: true, armId: "j2b" });
  });

  it("only suggests a near match: Class JS 7 not found", () => {
    expect(matchClass(levels, arms, "JSS 3", "")).toMatchObject({ ok: false, column: "className", suggestion: "JSS 1" });
    expect(matchClass(levels, arms, "Primary 4", "")).toMatchObject({ ok: false, column: "className", message: "Class Primary 4 not found." });
  });

  it("asks for the arm when the class has more than one", () => {
    expect(matchClass(levels, arms, "JSS 2", "")).toMatchObject({ ok: false, column: "armName" });
    expect(matchClass(levels, arms, "JSS 2", "Golf")).toMatchObject({ ok: false, column: "armName", suggestion: "Gold" });
  });
});

describe("splitFullName", () => {
  it("keeps first, middle and last", () => {
    expect(splitFullName("Chidera Ngozi Okafor")).toEqual({ firstName: "Chidera", otherNames: "Ngozi", lastName: "Okafor" });
    expect(splitFullName("Tunde")).toEqual({ firstName: "Tunde", otherNames: "", lastName: "" });
  });
});

describe("checkRows", () => {
  const good = { firstName: "Chiamaka", lastName: "Okafor", gender: "F", className: "JSS 1", armName: "B", dateOfBirth: "14/03/2014" };

  it("makes a clean row ready, with the phone in +234 form", () => {
    const [row] = checkRows([{ ...good, guardianName: "Ngozi Okafor", guardianPhone: "0803 000 0001" }], ctx);
    expect(row!.status).toBe("ready");
    expect(row!.student).toMatchObject({ gender: "female", armId: "j1b", dateOfBirth: "2014-03-14", guardianPhone: "+2348030000001" });
  });

  it("flags a bad phone without blocking the row (plan)", () => {
    const [row] = checkRows([{ ...good, guardianPhone: "12345" }], ctx);
    expect(row!.status).toBe("ready");
    expect(row!.problems).toEqual([expect.objectContaining({ column: "guardianPhone", blocking: false })]);
    expect(row!.student!.guardianPhone).toBe("");
  });

  it("blocks a row with a missing name, unknown gender or class", () => {
    const [row] = checkRows([{ firstName: "Chiamaka", gender: "X", className: "JSS 9" }], ctx);
    expect(row!.status).toBe("fix");
    expect(row!.problems.map((p) => p.column).sort()).toEqual(["className", "gender", "lastName"]);
  });

  it("offers Update or Skip for an admission number already in use", () => {
    const [row] = checkRows([{ ...good, admissionNo: "sbs/2026/0042" }], ctx);
    expect(row).toMatchObject({ status: "duplicate", existingId: "old" });
  });

  it("warns about the same name and birth date, ignoring accents", () => {
    const [row] = checkRows([{ firstName: "Ola", lastName: "Adesina", gender: "M", className: "JSS 1", armName: "A", dateOfBirth: "01/05/2013" }], ctx);
    expect(row!.status).toBe("ready");
    expect(row!.problems[0]).toMatchObject({ blocking: false });
  });

  it("catches duplicates inside the file", () => {
    const rows = checkRows([{ ...good, admissionNo: "X1" }, { ...good, firstName: "Ada", admissionNo: "X1" }, { ...good }], ctx);
    expect(rows.map((r) => r.status)).toEqual(["ready", "fix", "fix"]);
    expect(rows[1]!.problems[0]!.message).toBe("Row 2 has the same admission number");
    expect(rows[2]!.problems[0]!.message).toBe("Row 2 has the same name and birth date");
  });

  it("splits a full-name column and puts every row of a class page in its arm", () => {
    const [row] = checkRows([{ fullName: "Chidera Ngozi Okafor", gender: "Male" }], { ...ctx, armId: "j2g" });
    expect(row!.student).toMatchObject({ firstName: "Chidera", otherNames: "Ngozi", lastName: "Okafor", armId: "j2g", armLabel: "JSS 2 Gold" });
  });
});
