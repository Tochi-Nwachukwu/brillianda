/**
 * The academic calendar (plan: "Academic calendar"). Kept identical to the frontend's
 * packages/core/src/calendar.ts so a suggestion made in the browser and one made here agree.
 *
 * A session starts in September by default and has three terms, as in Lagos State's 2026/2027
 * calendar: First (September to December), Second (January to April), Third (May to July).
 * Names are editable and a session has two or three terms. Dates are ISO days ("2026-09-14"),
 * worked out in UTC so time zones never shift them.
 */

export type Term = { name: string; startsOn: string; endsOn: string };

export const TERM_NAME_PRESETS = {
  nigerian: { label: "First, Second, Third", names: ["First Term", "Second Term", "Third Term"] },
  british: { label: "Autumn, Spring, Summer", names: ["Autumn Term", "Spring Term", "Summer Term"] },
} as const;
export type TermNamePreset = keyof typeof TERM_NAME_PRESETS;

const iso = (d: Date) => d.toISOString().slice(0, 10);
const utc = (year: number, month: number, day: number) => new Date(Date.UTC(year, month - 1, day));

/** The first Monday on or after a day. */
function mondayFrom(year: number, month: number, day: number): string {
  const d = utc(year, month, day);
  d.setUTCDate(d.getUTCDate() + ((8 - d.getUTCDay()) % 7));
  return iso(d);
}

/** The last Friday on or before a day. */
function fridayUntil(year: number, month: number, day: number): string {
  const d = utc(year, month, day);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 2) % 7));
  return iso(d);
}

/** "2026/2027" for a session that starts in 2026. */
export function sessionName(startYear: number): string {
  return `${startYear}/${startYear + 1}`;
}

/**
 * Suggested terms for a session starting in `startYear`. Three terms: the second week of
 * September to mid-December, early January to Easter, early May to late July. Two terms split
 * the year at the end of January.
 */
export function defaultTerms(startYear: number, count: 2 | 3 = 3, preset: TermNamePreset = "nigerian"): Term[] {
  const names = TERM_NAME_PRESETS[preset].names;
  const next = startYear + 1;
  if (count === 2) {
    return [
      { name: names[0], startsOn: mondayFrom(startYear, 9, 8), endsOn: fridayUntil(next, 1, 30) },
      { name: names[1], startsOn: mondayFrom(next, 2, 9), endsOn: fridayUntil(next, 7, 24) },
    ];
  }
  return [
    { name: names[0], startsOn: mondayFrom(startYear, 9, 8), endsOn: fridayUntil(startYear, 12, 18) },
    { name: names[1], startsOn: mondayFrom(next, 1, 4), endsOn: fridayUntil(next, 4, 10) },
    { name: names[2], startsOn: mondayFrom(next, 5, 1), endsOn: fridayUntil(next, 7, 24) },
  ];
}

/**
 * When a school signing up today most likely started its current session: September of this
 * year from August on, otherwise last September. Used when signup did not say.
 */
export function defaultSessionStart(today: Date): { month: number; year: number } {
  const year = today.getUTCMonth() >= 7 ? today.getUTCFullYear() : today.getUTCFullYear() - 1;
  return { month: 9, year };
}

/**
 * Problems with a session's terms, keyed by JSON path ("terms/1/startsOn"), or none.
 * Same rules as the frontend's sessionSchema: 2 or 3 terms, each ends after it starts, each starts
 * after the one before ends, the first starts in the session's start year (or the next), and no
 * two terms share a name.
 */
export function sessionProblems(startYear: number, terms: Term[]): { path: (string | number)[]; message: string }[] {
  const out: { path: (string | number)[]; message: string }[] = [];
  if (terms.length < 2 || terms.length > 3) out.push({ path: ["terms"], message: "A session has two or three terms" });
  terms.forEach((term, i) => {
    if (term.endsOn <= term.startsOn) out.push({ path: ["terms", i, "endsOn"], message: "Ends after it starts" });
    const before = terms[i - 1];
    if (before && term.startsOn <= before.endsOn) {
      out.push({ path: ["terms", i, "startsOn"], message: `Starts after ${before.name || "the term before"} ends` });
    }
  });
  const first = terms[0];
  if (first && !first.startsOn.startsWith(String(startYear)) && !first.startsOn.startsWith(String(startYear + 1))) {
    out.push({ path: ["terms", 0, "startsOn"], message: `The ${sessionName(startYear)} session starts in ${startYear}` });
  }
  const names = terms.map((t) => t.name.trim().toLowerCase());
  names.forEach((name, i) => {
    if (name && names.indexOf(name) !== i) out.push({ path: ["terms", i, "name"], message: "Two terms can’t share a name" });
  });
  return out;
}
