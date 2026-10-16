// Copied from the frontend's packages/core/src/subjects.ts (BrilliandaWeb) so both sides apply the
// same rules: bands, pre-ticks and default links. Keep in step with that file.
// Subjects (plan: "Subjects"). Schools pick from a national catalogue (NERDC 2025 and the Legacy
// subjects it replaced), add their own, then attach them to class levels as compulsory or elective.
// The catalogue itself is platform data the backend serves; these are the rules around it.
export type Section = "preschool" | "primary" | "junior" | "senior";
export type Department = "science" | "arts" | "commercial";
type LadderKey = string;

/** Where a subject sits in the 2025 lists. NERDC splits primary into 1 to 3 and 4 to 6. */
export type Band = "lowerPrimary" | "upperPrimary" | "junior" | "senior";
export const BAND_LABEL: Record<Band, string> = { lowerPrimary: "Primary 1 to 3", upperPrimary: "Primary 4 to 6", junior: "JSS 1 to 3", senior: "SS 1 to 3" };

/**
 * A subject's part in a band: core (everyone takes it); choice (one of a set: a Nigerian language,
 * CRS or Islamic Studies, a trade); optional (French, Arabic); or a senior elective group.
 */
export type Role = "core" | "choice" | "optional" | "science" | "humanities" | "business";
export const SUBJECT_ROLE_LABEL: Record<Role, string> = {
  core: "Core",
  choice: "One of a set",
  optional: "Optional",
  science: "Science elective",
  humanities: "Humanities elective",
  business: "Business elective",
};

export type CatalogueEntry = {
  id: string;
  name: string;
  code: string;
  tag: "nerdc2025" | "legacy";
  offers: { band: Band; role: Role }[];
  /** e.g. "Nigerian language", "Religion", "Trade": the set a "choice" subject belongs to. */
  set?: string;
};

/** The band a ladder place belongs to; pre-school and custom levels have none. */
export function bandOf(key: LadderKey | string | null, section: Section): Band | null {
  if (key) {
    const primary = /^primary(\d)$/.exec(key);
    if (primary) return Number(primary[1]) <= 3 ? "lowerPrimary" : "upperPrimary";
    if (key.startsWith("jss")) return "junior";
    if (key.startsWith("ss")) return "senior";
    return null;
  }
  return section === "junior" ? "junior" : section === "senior" ? "senior" : null;
}

/**
 * What the Subjects step pre-ticks (plan: "pre-ticks the 2025 list for each section the school
 * runs"): every NERDC 2025 subject offered in those bands, except the optional ones.
 */
export function preTicked(catalogue: CatalogueEntry[], bands: Band[]): string[] {
  return catalogue
    .filter((entry) => entry.tag === "nerdc2025" && entry.offers.some((o) => bands.includes(o.band) && o.role !== "optional"))
    .map((entry) => entry.id);
}

export type LinkKind = "compulsory" | "elective";

const DEPARTMENT_OF: Partial<Record<Role, Department>> = { science: "science", humanities: "arts", business: "commercial" };

/** How a subject attaches to a level by default: core is compulsory, everything else elective. */
export function defaultLink(entry: Pick<CatalogueEntry, "offers">, band: Band): { kind: LinkKind; department: Department | null } | null {
  const offer = entry.offers.find((o) => o.band === band);
  if (!offer) return null;
  return { kind: offer.role === "core" ? "compulsory" : "elective", department: band === "senior" ? (DEPARTMENT_OF[offer.role] ?? null) : null };
}

/** Every default attachment for a set of subjects across a school's levels. Custom subjects attach nowhere. */
export function defaultLinks(
  entries: Pick<CatalogueEntry, "id" | "offers">[],
  levels: { id: string; key: string | null; section: Section }[],
): { entryId: string; levelId: string; kind: LinkKind; department: Department | null }[] {
  return entries.flatMap((entry) =>
    levels.flatMap((level) => {
      const band = bandOf(level.key, level.section);
      const link = band && defaultLink(entry, band);
      return link ? [{ entryId: entry.id, levelId: level.id, ...link }] : [];
    }),
  );
}

/** A short code from a name, for custom subjects: Phonics → PHO, Verbal Reasoning → VR. */
export function subjectCode(name: string, taken: string[] = []): string {
  const words = name.normalize("NFKD").replace(/[^A-Za-z0-9 ]/g, "").trim().toUpperCase().split(/\s+/).filter(Boolean);
  const base = words.length > 1 ? words.map((w) => w[0]).join("").slice(0, 4) : (words[0] ?? "SUB").slice(0, 3);
  let code = base;
  for (let n = 2; taken.includes(code); n++) code = `${base.slice(0, 3)}${n}`;
  return code;
}

