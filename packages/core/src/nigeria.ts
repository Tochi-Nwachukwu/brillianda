/** Nigerian reference data and normalisers used by signup and (later) student records. */

export const NIGERIAN_STATES = [
  "Abia", "Adamawa", "Akwa Ibom", "Anambra", "Bauchi", "Bayelsa", "Benue", "Borno", "Cross River",
  "Delta", "Ebonyi", "Edo", "Ekiti", "Enugu", "FCT", "Gombe", "Imo", "Jigawa", "Kaduna", "Kano",
  "Katsina", "Kebbi", "Kogi", "Kwara", "Lagos", "Nasarawa", "Niger", "Ogun", "Ondo", "Osun", "Oyo",
  "Plateau", "Rivers", "Sokoto", "Taraba", "Yobe", "Zamfara",
] as const;
export type NigerianState = (typeof NIGERIAN_STATES)[number];

export const SCHOOL_LEVELS = ["nursery", "primary", "secondary"] as const;
export type SchoolLevel = (typeof SCHOOL_LEVELS)[number];

/**
 * "0803 000 0001", "+234 803-000-0001", "2348030000001" → "+2348030000001" (E.164).
 * Returns null when it cannot be a Nigerian number. Mobile numbers have a 10-digit national
 * number; landlines 8–9. (libphonenumber-js can replace this when other countries are needed.)
 */
export function normaliseNigerianPhone(input: string): string | null {
  const compact = input.trim().replace(/[\s\-().]/g, "");
  if (!/^\+?\d+$/.test(compact)) return null;
  let national: string;
  if (compact.startsWith("+234")) national = compact.slice(4);
  else if (compact.startsWith("234") && compact.length >= 11) national = compact.slice(3);
  else if (compact.startsWith("0")) national = compact.slice(1);
  else return null;
  if (national.startsWith("0")) national = national.slice(1); // "+234 0803..." typed with the trunk 0
  if (!/^[1-9]\d{7,9}$/.test(national)) return null;
  if (national.length === 10 && !/^[789]/.test(national)) return null;
  return `+234${national}`;
}
