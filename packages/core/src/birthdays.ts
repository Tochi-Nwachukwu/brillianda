// Copied from the front end's packages/core/src/birthdays.ts (24 Oct 2026), without its Zod schema
// (birthdaySettingsSchema), which lives in apps/api/src/routes/birthdays.ts with the same rules.
// Birthday messages (user request, 15 Oct 2026): on a student's birthday their guardian gets a text,
// and the parent app shows a card. The school writes the message; these are the rules for it.
import { ordinal } from "./grading.js";

/** The words a school's message can use, filled in for each child. */
export const BIRTHDAY_FIELDS = ["{name}", "{age}", "{school}"] as const;

export const DEFAULT_BIRTHDAY_MESSAGE = "Happy {age} birthday, {name}! Everyone at {school} wishes you a wonderful year ahead.";

/** When the day's texts go out, Lagos time. */
export const BIRTHDAY_SEND_TIME = "7:00 am";

export type BirthdaySettings = { enabled: boolean; message: string };

/** The message for one child: "{age}" becomes "12th", "{name}" their first name. */
export function birthdayMessage(template: string, child: { firstName: string; age: number }, school: string): string {
  return template.replaceAll("{name}", child.firstName).replaceAll("{age}", ordinal(child.age)).replaceAll("{school}", school);
}

/** Month and day of a YYYY-MM-DD date; 29 February is kept on 28 February in other years. */
function monthDay(date: string, year: number): string {
  const md = date.slice(5, 10);
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  return md === "02-29" && !leap ? "02-28" : md;
}

/** How old someone born on `dob` is on `day` (both YYYY-MM-DD). */
export function ageOn(dob: string, day: string): number {
  const years = Number(day.slice(0, 4)) - Number(dob.slice(0, 4));
  return day.slice(5, 10) >= monthDay(dob, Number(day.slice(0, 4))) ? years : years - 1;
}

export function isBirthday(dob: string, day: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(dob) && monthDay(dob, Number(day.slice(0, 4))) === day.slice(5, 10);
}

const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/**
 * Birthdays from `today` for the next `days` days (today counts as 0), soonest first, with the age
 * each child turns. Students without a date of birth are left out.
 */
export function upcomingBirthdays<S extends { dateOfBirth: string }>(students: S[], today: string, days: number): (S & { on: string; inDays: number; turns: number })[] {
  const out: (S & { on: string; inDays: number; turns: number })[] = [];
  for (let i = 0; i < days; i++) {
    const day = addDays(today, i);
    for (const s of students) if (s.dateOfBirth && isBirthday(s.dateOfBirth, day)) out.push({ ...s, on: day, inDays: i, turns: ageOn(s.dateOfBirth, day) });
  }
  return out;
}

/** GSM-7 covers plain English text; anything else (ọ, ẹ, curly quotes, emoji) makes a text Unicode. */
const GSM = /^[A-Za-z0-9 \n\r@£$¥èéùìòÇØøÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ!"#¤%&'()*+,\-./:;<=>?¡ÄÖÑÜ§¿äöñüà^{}\\[~\]|€]*$/;

/** How many texts a message takes: 160 characters (153 when split), or 70 (67) in Unicode. */
export function smsCount(text: string): { characters: number; texts: number; unicode: boolean } {
  const unicode = !GSM.test(text);
  const characters = [...text].length;
  const [single, part] = unicode ? [70, 67] : [160, 153];
  return { characters, texts: characters <= single ? 1 : Math.ceil(characters / part), unicode };
}
