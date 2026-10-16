// Admission numbers in each school's own format. Copied from the frontend's
// packages/core/src/admission.ts, so the number previewed on a form is the number the student gets.

/** `{YEAR}` is the session's first year; `{NUMBER}` the school's running count, zero-padded. */
export type AdmissionNumberFormat = { pattern: string; digits: number };

export const ADMISSION_TOKENS = { year: "{YEAR}", number: "{NUMBER}" } as const;

/** Problems with a pattern, in plain words; empty when it can be used. */
export function admissionPatternProblems(format: AdmissionNumberFormat): string[] {
  const problems: string[] = [];
  const pattern = format.pattern.trim();
  if (!pattern.includes(ADMISSION_TOKENS.number)) problems.push("Include {NUMBER}, so every student gets a different number.");
  if (pattern.split(ADMISSION_TOKENS.number).length > 2) problems.push("Use {NUMBER} only once.");
  if (pattern.replace(/\{YEAR\}|\{NUMBER\}/g, "").includes("{")) problems.push("Only {YEAR} and {NUMBER} can go in braces.");
  if (pattern.length > 30) problems.push("Keep it to 30 characters or fewer.");
  if (!Number.isInteger(format.digits) || format.digits < 1 || format.digits > 6) problems.push("Digits must be from 1 to 6.");
  return problems;
}

export function formatAdmissionNo(format: AdmissionNumberFormat, year: number, number: number): string {
  return format.pattern
    .trim()
    .replace(ADMISSION_TOKENS.year, String(year))
    .replace(ADMISSION_TOKENS.number, String(number).padStart(format.digits, "0"));
}

/** A starting pattern from the school's name: "Sunrise Academy" gives "SA/{YEAR}/{NUMBER}". */
export function defaultAdmissionPattern(schoolName: string): string {
  const initials = schoolName.split(/\s+/).filter(Boolean).map((w) => w[0]!.toUpperCase()).join("").slice(0, 4) || "ADM";
  return `${initials}/${ADMISSION_TOKENS.year}/${ADMISSION_TOKENS.number}`;
}

/** Admission numbers are compared without case or surrounding spaces. */
export const sameAdmissionNo = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
