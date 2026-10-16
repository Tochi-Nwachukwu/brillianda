// Students: shared rules copied from the frontend's packages/core/src/students.ts (names, search,
// formula-safe CSV). The input schema itself lives in the API route, in zod, with the same rules.

/** Letters (any script, with marks such as Ọ and ṣ), spaces, hyphens and apostrophes. */
export const PERSON_NAME = /^[\p{L}\p{M}][\p{L}\p{M}' ’-]*$/u;

export const STUDENT_STATUSES = ["active", "suspended", "withdrawn", "transferred", "graduated"] as const;
export type StudentStatus = (typeof STUDENT_STATUSES)[number];
export const STATUS_LABEL: Record<StudentStatus, string> = {
  active: "Active",
  suspended: "Suspended",
  withdrawn: "Withdrawn",
  transferred: "Transferred",
  graduated: "Graduated",
};
/** What each status means, for the picker. Real departures change the status so the record survives. */
export const STATUS_DETAIL: Record<StudentStatus, string> = {
  active: "In school and in their class.",
  suspended: "Still on the roll, but not attending for now.",
  withdrawn: "Left the school, for a reason other than the two below.",
  transferred: "Moved to another school.",
  graduated: "Finished their final class.",
};

/** Lowercase here, like every enum in the API; the frontend uses MALE / FEMALE. */
export const GENDERS = ["male", "female"] as const;
export type StudentGender = (typeof GENDERS)[number];

/** "Chiamaka Adaeze Okafor": first, other names, last. */
export function fullName(s: { firstName: string; otherNames?: string | null; lastName: string }): string {
  return [s.firstName, s.otherNames, s.lastName].filter(Boolean).join(" ");
}

/** Lower case with accents and marks removed, so typing Ola finds Ọlá (plan: search ignores accents). */
export function searchKey(text: string): string {
  return text.normalize("NFKD").replace(/[̀-ͯ᷀-᷿]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
}

/** Does a student match a search? Every word must appear in the name or the admission number. */
export function matchesSearch(student: { fullName: string; admissionNo: string }, query: string): boolean {
  const haystack = searchKey(`${student.fullName} ${student.admissionNo}`);
  return searchKey(query)
    .split(" ")
    .filter(Boolean)
    .every((word) => haystack.includes(word));
}

/**
 * One CSV cell. Cells starting with =, +, - or @ get a leading apostrophe so a spreadsheet shows
 * them as text instead of running them as formulas (plan: exports are formula-safe).
 */
export function csvCell(value: string | number | null | undefined): string {
  let text = value === null || value === undefined ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** A CSV file from a header row and rows, with Windows line endings Excel expects. */
export function toCsv(header: string[], rows: (string | number | null | undefined)[][]): string {
  return [header, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

