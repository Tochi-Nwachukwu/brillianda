// Copied from the frontend's packages/core/src/studentImport.ts so the server's check matches the
// browser's exactly. One change: genders come out lowercase (male, female), like the rest of the API.
//
// Importing a school's student list (plan: "The templates", "How an import runs", "Validation
// rules"). The browser reads the file and maps the columns; the server checks every row again with
// these same rules before anything is written.
import { fullName, searchKey, type StudentGender } from "./students.js";
import { NIGERIAN_STATES, normaliseNigerianPhone } from "./nigeria.js";

export const MAX_IMPORT_ROWS = 5000;
export const IMPORT_CHUNK = 500;
export const UNDO_HOURS = 24;

/** The template's columns, in order (plan: "The templates"). */
export const IMPORT_COLUMNS = [
  { id: "firstName", label: "First name", aliases: ["first name", "firstname", "given name", "forename", "first"] },
  { id: "lastName", label: "Last name", aliases: ["last name", "lastname", "surname", "family name"] },
  { id: "otherNames", label: "Other names", aliases: ["other names", "other name", "middle name", "middle names", "othernames"] },
  { id: "gender", label: "Gender", aliases: ["gender", "sex", "m/f"] },
  { id: "dateOfBirth", label: "Date of birth", aliases: ["date of birth", "dob", "d.o.b", "birth date", "birthday"] },
  { id: "className", label: "Class", aliases: ["class", "class name", "level", "form", "current class"] },
  { id: "armName", label: "Arm", aliases: ["arm", "arm name", "stream", "section"] },
  { id: "admissionNo", label: "Admission number", aliases: ["admission number", "admission no", "adm no", "admno", "reg no", "registration number", "student id"] },
  { id: "admissionDate", label: "Admission date", aliases: ["admission date", "date of admission", "date admitted", "admitted"] },
  { id: "guardianName", label: "Guardian name", aliases: ["guardian name", "guardian", "parent name", "parent's name", "parent", "parent/guardian"] },
  { id: "guardianPhone", label: "Guardian phone", aliases: ["guardian phone", "parent phone", "parent's phone", "phone", "phone number", "mobile", "gsm", "telephone"] },
  { id: "guardianEmail", label: "Guardian email", aliases: ["guardian email", "parent email", "parent's email", "email", "e-mail", "email address"] },
  { id: "address", label: "Address", aliases: ["address", "home address", "residential address"] },
  { id: "stateOfOrigin", label: "State of origin", aliases: ["state of origin", "state", "origin"] },
  // Not in the template, but common in schools' own lists: split into first, other and last names.
  { id: "fullName", label: "Full name (split for you)", aliases: ["full name", "name", "student name", "names", "name of student", "pupil name", "student"] },
] as const;
export type ImportColumnId = (typeof IMPORT_COLUMNS)[number]["id"];
export type ImportMapping = Record<number, ImportColumnId | null>;

const simplify = (text: string) => text.toLowerCase().replace(/[_.]+/g, " ").replace(/[^a-z0-9/' ]+/g, "").replace(/\s+/g, " ").trim();

/** What a heading most likely means (plan: Surname, Sex and Adm No map automatically), or null. */
export function guessColumn(heading: string): ImportColumnId | null {
  const h = simplify(heading);
  if (!h) return null;
  for (const column of IMPORT_COLUMNS) if ((column.aliases as readonly string[]).includes(h)) return column.id;
  if (/phone|mobile|gsm/.test(h)) return "guardianPhone";
  if (/mail/.test(h)) return "guardianEmail";
  if (/parent|guardian|father|mother/.test(h)) return "guardianName";
  if (/birth|dob/.test(h.replace(/ /g, ""))) return "dateOfBirth";
  if (/admission date|admitted/.test(h)) return "admissionDate";
  if (/adm|reg/.test(h)) return "admissionNo";
  if (/surname|last/.test(h)) return "lastName";
  if (/first/.test(h)) return "firstName";
  if (/other|middle/.test(h)) return "otherNames";
  if (/^arm/.test(h)) return "armName";
  if (/class/.test(h)) return "className";
  if (/sex|gender/.test(h)) return "gender";
  if (/name/.test(h)) return "fullName";
  return null;
}

/** Each heading's guess, with each column used at most once (the first heading wins). */
export function guessMapping(headings: string[]): ImportMapping {
  const used = new Set<ImportColumnId>();
  return Object.fromEntries(
    headings.map((heading, i) => {
      const guess = guessColumn(heading);
      if (!guess || used.has(guess)) return [i, null];
      used.add(guess);
      return [i, guess];
    }),
  );
}

/** What the mapping still needs before rows can be checked. */
export function mappingProblems(mapping: ImportMapping, perClass: boolean): string[] {
  const has = (id: ImportColumnId) => Object.values(mapping).includes(id);
  const problems: string[] = [];
  if (!has("fullName") && !(has("firstName") && has("lastName"))) problems.push("Choose the columns with first and last names (or one full-name column).");
  if (!has("gender")) problems.push("Choose the Gender column.");
  if (!perClass && !has("className")) problems.push("Choose the Class column, or import from a class page instead.");
  return problems;
}

// ——— Reading cells ———

export function readGenderCell(cell: string): StudentGender | null | undefined {
  const c = cell.trim().toLowerCase();
  if (!c) return null;
  if (["m", "male", "boy", "b"].includes(c)) return "male";
  if (["f", "female", "girl", "g"].includes(c)) return "female";
  return undefined;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const validDate = (y: number, m: number, d: number) => {
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
};
const iso = (y: number, m: number, d: number) => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

/**
 * A date read day first (plan): 14/03/2014, 14-3-14, 14 March 2014, 2014-03-14, or an Excel date.
 * A date that only works month first, like 03/14/2014, is flagged with a suggestion, never guessed.
 */
export function readDateCell(cell: string): { ok: true; value: string | null } | { ok: false; message: string } {
  const c = cell.trim();
  if (!c) return { ok: true, value: null };
  let m: RegExpMatchArray | null;
  if ((m = c.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ].*)?$/))) {
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    return validDate(y, mo, d) ? { ok: true, value: iso(y, mo, d) } : { ok: false, message: `${c} isn’t a date` };
  }
  if ((m = c.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/))) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    let y = Number(m[3]);
    if (y < 100) y += y > 50 ? 1900 : 2000;
    if (validDate(y, b, a)) return { ok: true, value: iso(y, b, a) };
    if (validDate(y, a, b)) return { ok: false, message: `Dates are read day first. Did you mean ${String(b).padStart(2, "0")}/${String(a).padStart(2, "0")}/${y}?` };
    return { ok: false, message: `${c} isn’t a date` };
  }
  if ((m = c.match(/^(\d{1,2})(?:st|nd|rd|th)?[\s-]+([a-z]+)[\s,-]+(\d{4})$/i))) {
    const month = MONTHS.indexOf(m[2]!.slice(0, 3).toLowerCase()) + 1;
    const [d, y] = [Number(m[1]), Number(m[3])];
    if (month && validDate(y, month, d)) return { ok: true, value: iso(y, month, d) };
  }
  return { ok: false, message: `${c} isn’t a date. Write it day first, like 14/03/2014` };
}

/** "Chidera Ngozi Okafor" → first Chidera, other Ngozi, last Okafor. */
export function splitFullName(name: string): { firstName: string; otherNames: string; lastName: string } {
  const words = name.normalize("NFC").trim().split(/\s+/).filter(Boolean);
  if (words.length < 2) return { firstName: words[0] ?? "", otherNames: "", lastName: "" };
  return { firstName: words[0]!, otherNames: words.slice(1, -1).join(" "), lastName: words.at(-1)! };
}

// ——— Matching classes and arms ———

export type ImportLevel = { id: string; name: string; short: string; aliases?: string[] };
export type ImportArm = { id: string; levelId: string; name: string; code: string };

/** Case, spaces and dots ignored, plus the common spellings: JS1 and Jss 1 are JSS 1; SSS 2 is SS 2. */
export function levelKey(text: string): string {
  const k = text.toLowerCase().replace(/[^a-z0-9]/g, "");
  return k.replace(/^js(?=\d)/, "jss").replace(/^sss(?=\d)/, "ss").replace(/^pry(?=\d)/, "primary").replace(/^pri(?=\d)/, "primary").replace(/^p(?=\d)/, "primary").replace(/^n(?=\d)/, "nursery");
}

function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const temp = row[j]!;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = temp;
    }
  }
  return row[b.length]!;
}

function findLevel(levels: ImportLevel[], text: string): ImportLevel | undefined {
  const t = text.trim();
  return (
    levels.find((l) => l.name === t) ?? // exact
    levels.find((l) => levelKey(l.name) === levelKey(t) || levelKey(l.short) === levelKey(t)) ?? // normalised
    levels.find((l) => (l.aliases ?? []).some((a) => levelKey(a) === levelKey(t))) // aliases
  );
}

function findArm(arms: ImportArm[], text: string): ImportArm | undefined {
  const t = text.trim();
  const k = t.toLowerCase().replace(/\s+/g, "");
  return arms.find((a) => a.name === t) ?? arms.find((a) => a.name.toLowerCase().replace(/\s+/g, "") === k || a.code.toLowerCase() === k);
}

export type ClassMatch = { ok: true; armId: string; label: string } | { ok: false; column: "className" | "armName"; message: string; suggestion?: string };

/**
 * The arm a row belongs in: exact, then normalised, then aliases (plan). A combined value such as
 * "JSS 1A" or "JSS1 Gold" splits into class and arm. A near match is only a suggestion.
 */
export function matchClass(levels: ImportLevel[], arms: ImportArm[], classCell: string, armCell: string): ClassMatch {
  let classText = classCell.trim();
  let armText = armCell.trim();
  if (!classText) return { ok: false, column: "className", message: "Add the class" };

  let level = findLevel(levels, classText);
  if (!level && !armText) {
    // "JSS 1A", "JSS1 Gold": try every split into a class and an arm.
    for (let cut = classText.length - 1; cut > 0 && !level; cut--) {
      const head = classText.slice(0, cut).trim();
      const tail = classText.slice(cut).trim();
      const candidate = findLevel(levels, head);
      if (candidate && findArm(arms.filter((a) => a.levelId === candidate.id), tail)) {
        level = candidate;
        classText = head;
        armText = tail;
      }
    }
  }
  if (!level) {
    const nearest = [...levels].sort((a, b) => distance(levelKey(classText), levelKey(a.name)) - distance(levelKey(classText), levelKey(b.name)))[0];
    const close = nearest && distance(levelKey(classText), levelKey(nearest.name)) <= 2;
    return { ok: false, column: "className", message: `Class ${classText} not found.${close ? ` Did you mean ${nearest.name}?` : ""}`, suggestion: close ? nearest.name : undefined };
  }

  const inLevel = arms.filter((a) => a.levelId === level.id);
  if (!armText) {
    if (inLevel.length === 1) return { ok: true, armId: inLevel[0]!.id, label: level.name };
    return { ok: false, column: "armName", message: `${level.name} has ${inLevel.length} arms. Add the arm: ${inLevel.map((a) => a.name).join(", ")}` };
  }
  const arm = findArm(inLevel, armText);
  if (!arm) {
    const nearest = [...inLevel].sort((a, b) => distance(armText.toLowerCase(), a.name.toLowerCase()) - distance(armText.toLowerCase(), b.name.toLowerCase()))[0];
    const close = nearest && distance(armText.toLowerCase(), nearest.name.toLowerCase()) <= 2;
    return { ok: false, column: "armName", message: `${level.name} has no arm called ${armText}.${close ? ` Did you mean ${nearest.name}?` : ""}`, suggestion: close ? nearest.name : undefined };
  }
  return { ok: true, armId: arm.id, label: inLevel.length > 1 ? `${level.name} ${arm.name}` : level.name };
}

// ——— Checking rows ———

export type RawRow = Partial<Record<ImportColumnId, string>>;
export type Problem = { column: ImportColumnId; message: string; suggestion?: string; blocking: boolean };
export type CheckedRow = {
  index: number;
  status: "ready" | "fix" | "duplicate";
  problems: Problem[];
  /** For a duplicate admission number: the existing student it matches. */
  existingId?: string;
  student?: {
    firstName: string;
    lastName: string;
    otherNames: string;
    gender: StudentGender;
    armId: string;
    armLabel: string;
    dateOfBirth: string;
    admissionNo: string;
    admissionDate: string;
    guardianName: string;
    guardianPhone: string;
    guardianEmail: string;
    address: string;
    stateOfOrigin: string;
  };
};

export type ImportContext = {
  levels: ImportLevel[];
  arms: ImportArm[];
  /** Existing students, for duplicate checks. */
  existing: { id: string; admissionNo: string; fullName: string; dateOfBirth: string }[];
  /** Importing from a class page: every row goes to this arm (no Class or Arm columns). */
  armId?: string | null;
};

const NAME = /^[\p{L}\p{M}][\p{L}\p{M}' ’-]*$/u;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const tidy = (v?: string) => (v ?? "").normalize("NFC").trim().replace(/\s+/g, " ");

/** Checks one row: what is wrong (blocking) or worth a look (not blocking), and the clean values. */
export function checkRow(raw: RawRow, index: number, ctx: ImportContext): CheckedRow {
  const problems: Problem[] = [];
  const block = (column: ImportColumnId, message: string, suggestion?: string) => problems.push({ column, message, suggestion, blocking: true });
  const warn = (column: ImportColumnId, message: string) => problems.push({ column, message, blocking: false });

  const split = raw.fullName && !raw.firstName && !raw.lastName ? splitFullName(raw.fullName) : null;
  const firstName = tidy(raw.firstName ?? split?.firstName);
  const lastName = tidy(raw.lastName ?? split?.lastName);
  const otherNames = tidy(raw.otherNames ?? split?.otherNames);
  const nameColumn = (c: ImportColumnId): ImportColumnId => (split ? "fullName" : c);
  if (!firstName) block(nameColumn("firstName"), "Add the first name");
  else if (!NAME.test(firstName)) block(nameColumn("firstName"), "Names use letters, spaces, hyphens and apostrophes");
  if (!lastName) block(nameColumn("lastName"), split ? "Add the last name: this cell has one name" : "Add the last name");
  else if (!NAME.test(lastName)) block(nameColumn("lastName"), "Names use letters, spaces, hyphens and apostrophes");
  if (otherNames && !NAME.test(otherNames)) block(nameColumn("otherNames"), "Names use letters, spaces, hyphens and apostrophes");

  const gender = readGenderCell(raw.gender ?? "");
  if (gender === null) block("gender", "Add the gender: Male or Female");
  else if (gender === undefined) block("gender", `${tidy(raw.gender)} isn’t a gender. Use Male or Female (M and F work too)`);

  let armId = ctx.armId ?? "";
  let armLabel = "";
  if (ctx.armId) {
    const arm = ctx.arms.find((a) => a.id === ctx.armId);
    const level = arm && ctx.levels.find((l) => l.id === arm.levelId);
    armLabel = level ? `${level.name}${ctx.arms.filter((a) => a.levelId === level.id).length > 1 ? ` ${arm.name}` : ""}` : "";
  } else {
    const match = matchClass(ctx.levels, ctx.arms, raw.className ?? "", raw.armName ?? "");
    if (match.ok) [armId, armLabel] = [match.armId, match.label];
    else block(match.column, match.message, match.suggestion);
  }

  const dates: Record<"dateOfBirth" | "admissionDate", string> = { dateOfBirth: "", admissionDate: "" };
  for (const column of ["dateOfBirth", "admissionDate"] as const) {
    const read = readDateCell(raw[column] ?? "");
    if (read.ok) dates[column] = read.value ?? "";
    else block(column, read.message);
  }
  if (dates.dateOfBirth && dates.dateOfBirth > new Date().toISOString().slice(0, 10)) block("dateOfBirth", "A birth date can’t be in the future");

  // A bad guardian phone or email is flagged but doesn't block the row (plan).
  let guardianPhone = "";
  if (tidy(raw.guardianPhone)) {
    guardianPhone = normaliseNigerianPhone(tidy(raw.guardianPhone)) ?? "";
    if (!guardianPhone) warn("guardianPhone", `${tidy(raw.guardianPhone)} isn’t a Nigerian number, so it’s left out`);
  }
  let guardianEmail = tidy(raw.guardianEmail).toLowerCase();
  if (guardianEmail && !EMAIL.test(guardianEmail)) {
    warn("guardianEmail", `${guardianEmail} doesn’t look like an email, so it’s left out`);
    guardianEmail = "";
  }
  let stateOfOrigin = tidy(raw.stateOfOrigin);
  if (stateOfOrigin) {
    const found = NIGERIAN_STATES.find((s) => s.toLowerCase() === stateOfOrigin.toLowerCase().replace(/ state$/, ""));
    if (found) stateOfOrigin = found;
    else {
      warn("stateOfOrigin", `${stateOfOrigin} isn’t a Nigerian state, so it’s left out`);
      stateOfOrigin = "";
    }
  }

  const admissionNo = tidy(raw.admissionNo);
  const name = fullName({ firstName, otherNames, lastName });
  let existingId: string | undefined;
  if (admissionNo) {
    const same = ctx.existing.find((e) => e.admissionNo.trim().toLowerCase() === admissionNo.toLowerCase());
    if (same) existingId = same.id;
  }
  if (!existingId && dates.dateOfBirth && ctx.existing.some((e) => searchKey(e.fullName) === searchKey(name) && e.dateOfBirth === dates.dateOfBirth)) {
    warn("fullName", `A student called ${name} with the same birth date is already here`);
  }

  const blocking = problems.some((p) => p.blocking);
  return {
    index,
    status: blocking ? "fix" : existingId ? "duplicate" : "ready",
    problems,
    existingId,
    student: blocking
      ? undefined
      : {
          firstName,
          lastName,
          otherNames,
          gender: gender as StudentGender,
          armId,
          armLabel,
          dateOfBirth: dates.dateOfBirth,
          admissionNo,
          admissionDate: dates.admissionDate,
          guardianName: tidy(raw.guardianName),
          guardianPhone,
          guardianEmail,
          address: tidy(raw.address),
          stateOfOrigin,
        },
  };
}

/** Checks every row, then the duplicates inside the file: the same admission number, or the same name and birth date. */
export function checkRows(rows: RawRow[], ctx: ImportContext): CheckedRow[] {
  const checked = rows.map((row, i) => checkRow(row, i, ctx));
  const seenAdmission = new Map<string, number>();
  const seenPerson = new Map<string, number>();
  for (const row of checked) {
    const s = row.student;
    if (!s) continue;
    if (s.admissionNo) {
      const key = s.admissionNo.toLowerCase();
      const first = seenAdmission.get(key);
      if (first !== undefined) {
        row.problems.push({ column: "admissionNo", message: `Row ${first + 2} has the same admission number`, blocking: true });
        row.status = "fix";
      } else seenAdmission.set(key, row.index);
    }
    if (s.dateOfBirth) {
      const key = `${searchKey(fullName(s))}|${s.dateOfBirth}`;
      const first = seenPerson.get(key);
      if (first !== undefined) {
        row.problems.push({ column: "fullName", message: `Row ${first + 2} has the same name and birth date`, blocking: true });
        row.status = "fix";
      } else seenPerson.set(key, row.index);
    }
    if (row.status === "fix") row.student = undefined;
  }
  return checked;
}
