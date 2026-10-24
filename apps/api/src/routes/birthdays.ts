/**
 * Birthday messages (B2 in the front end's backend-requirements.md; rules in
 * packages/core/src/birthdays.ts, flow from its src/data/fake/birthdays.ts).
 *
 *   GET  /v1/birthdays                  owner, admin: settings, the next 30 days, the latest 20 texts
 *   GET  /v1/birthdays?days=7           owner, admin: on or off, and the next N days (Home's card)
 *   PUT  /v1/birthdays/settings         owner, admin: { enabled, message }
 *   GET  /internal/cron/birthdays       Vercel Cron, daily at 06:00 UTC (7:00 am Lagos): today's texts
 *
 * Each active student whose birthday is today gets one text to their guardian (the primary
 * contact first), once: a row per student per day is claimed before sending. No phone: logged,
 * not sent. 29 February is celebrated on 28 February in other years.
 */
import { timingSafeEqual } from "node:crypto";
import { ageOn, birthdayMessage, DEFAULT_BIRTHDAY_MESSAGE, fullName, isBirthday, normaliseNigerianPhone, upcomingBirthdays, type BirthdaySettings } from "@brillianda/core";
import {
  and,
  asc,
  birthdaySchools,
  birthdaySettings,
  birthdayTexts,
  desc,
  eq,
  guardians,
  inArray,
  isNotNull,
  isNull,
  lt,
  sql,
  studentGuardians,
  students,
  withSchool,
  type Tx,
} from "@brillianda/db";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { AppDeps, AppEnv } from "../context.js";
import { lagosToday } from "../lib/attendance.js";
import { ApiError, problemContent } from "../lib/errors.js";
import { schoolRoute, type Role } from "../school-route.js";
import { armOptions } from "./classes.js";

export const birthdayRoutes = new OpenAPIHono<AppEnv>();

const ADMINS: readonly Role[] = ["owner", "admin"];
const ok = <T extends z.ZodTypeAny>(description: string, schema: T) => ({ description, content: { "application/json": { schema } } });
const errors = {
  401: problemContent("Not signed in to this school"),
  403: problemContent("Only owners and admins"),
  404: problemContent("No active school here"),
} as const;

// The front end's birthdaySettingsSchema, with the same rules.
const birthdaySettingsSchema = z.object({
  enabled: z.boolean({ message: "Choose on or off" }),
  message: z
    .string({ message: "Write a short message" })
    .trim()
    .min(10, "Write a short message")
    .max(300, "Use at most 300 characters")
    .refine((m) => m.includes("{name}"), "Include {name}, so each child gets their own message"),
});

export async function birthdaySettingsOf(tx: Tx): Promise<BirthdaySettings> {
  const [row] = await tx.select({ enabled: birthdaySettings.enabled, message: birthdaySettings.message }).from(birthdaySettings).limit(1);
  return row ?? { enabled: false, message: DEFAULT_BIRTHDAY_MESSAGE };
}

/** Each student's guardian phone: the primary contact's if they have one, else any guardian's. */
async function guardianPhones(tx: Tx, studentIds: string[]): Promise<Map<string, string>> {
  if (!studentIds.length) return new Map();
  const rows = await tx
    .select({ studentId: studentGuardians.studentId, phone: guardians.phone })
    .from(studentGuardians)
    .innerJoin(guardians, and(eq(guardians.schoolId, studentGuardians.schoolId), eq(guardians.id, studentGuardians.guardianId)))
    .where(and(inArray(studentGuardians.studentId, studentIds), isNotNull(guardians.phone)))
    .orderBy(desc(studentGuardians.primaryContact), asc(studentGuardians.createdAt));
  const out = new Map<string, string>();
  for (const r of rows) if (r.phone && !out.has(r.studentId)) out.set(r.studentId, normaliseNigerianPhone(r.phone) ?? r.phone);
  return out;
}

async function activeWithBirthdays(tx: Tx) {
  return (
    await tx
      .select({ id: students.id, firstName: students.firstName, otherNames: students.otherNames, lastName: students.lastName, dateOfBirth: students.dateOfBirth, armId: students.classArmId })
      .from(students)
      .where(and(eq(students.status, "active"), isNull(students.deletedAt), isNotNull(students.dateOfBirth)))
  ).map((s) => ({ ...s, dateOfBirth: s.dateOfBirth! }));
}

const BirthdayRowSchema = z
  .object({
    studentId: z.string().uuid(),
    fullName: z.string(),
    armLabel: z.string(),
    on: z.string(),
    inDays: z.number().int(),
    turns: z.number().int(),
    guardianPhone: z.string().nullable(),
  })
  .openapi("BirthdayRow");

async function upcoming(tx: Tx, today: string, days: number): Promise<z.infer<typeof BirthdayRowSchema>[]> {
  const coming = upcomingBirthdays(await activeWithBirthdays(tx), today, days);
  const labels = new Map((await armOptions(tx, { all: true })).map((a) => [a.id, a.label]));
  const phones = await guardianPhones(tx, [...new Set(coming.map((s) => s.id))]);
  return coming.map((s) => ({ studentId: s.id, fullName: fullName(s), armLabel: labels.get(s.armId) ?? "No class", on: s.on, inDays: s.inDays, turns: s.turns, guardianPhone: phones.get(s.id) ?? null }));
}

const BirthdaysPageSchema = z
  .object({
    settings: z.object({ enabled: z.boolean(), message: z.string() }),
    schoolName: z.string(),
    today: z.string(),
    upcoming: z.array(BirthdayRowSchema).openapi({ description: "The next 30 days, today first" }),
    sent: z
      .array(z.object({ id: z.string().uuid(), date: z.string(), fullName: z.string(), armLabel: z.string(), to: z.string().nullable(), text: z.string() }))
      .openapi({ description: "The latest 20 texts, newest first. `to` is null when the guardian has no phone" }),
  })
  .openapi("BirthdaysPage");
const BirthdaysThisWeekSchema = z.object({ enabled: z.boolean(), rows: z.array(BirthdayRowSchema) }).openapi("BirthdaysThisWeek");

birthdayRoutes.openapi(
  createRoute({
    method: "get",
    path: "/v1/birthdays",
    tags: ["birthdays"],
    summary: "The birthday page (settings, the next 30 days, texts sent); with ?days=N, on or off and the next N days (Home's card)",
    request: { query: z.object({ days: z.coerce.number().int("Whole days").min(1, "At least 1 day").max(31, "At most 31 days").optional() }) },
    responses: { 200: ok("Birthdays", z.union([BirthdaysPageSchema, BirthdaysThisWeekSchema])), ...errors },
  }),
  async (c) => {
    const { days } = c.req.valid("query");
    const data = await schoolRoute(c, { roles: ADMINS }, async ({ tx, school }) => {
      const settings = await birthdaySettingsOf(tx);
      const today = lagosToday();
      if (days) return { enabled: settings.enabled, rows: await upcoming(tx, today, days) };
      const sent = await tx
        .select({ id: birthdayTexts.id, date: birthdayTexts.day, to: birthdayTexts.phone, text: birthdayTexts.text, student: students })
        .from(birthdayTexts)
        .innerJoin(students, and(eq(students.schoolId, birthdayTexts.schoolId), eq(students.id, birthdayTexts.studentId)))
        .where(inArray(birthdayTexts.status, ["sent", "no_phone"]))
        .orderBy(desc(birthdayTexts.createdAt))
        .limit(20);
      const labels = new Map((await armOptions(tx, { all: true })).map((a) => [a.id, a.label]));
      return {
        settings,
        schoolName: school.name,
        today,
        upcoming: await upcoming(tx, today, 30),
        sent: sent.map((r) => ({ id: r.id, date: r.date, fullName: fullName(r.student), armLabel: labels.get(r.student.classArmId) ?? "", to: r.to, text: r.text })),
      };
    });
    return c.json(data, 200);
  },
);

birthdayRoutes.openapi(
  createRoute({
    method: "put",
    path: "/v1/birthdays/settings",
    tags: ["birthdays"],
    summary: "Turn birthday texts on or off and set the message ({name} required; {age}, {school} optional; up to 300 characters)",
    request: { body: { content: { "application/json": { schema: birthdaySettingsSchema.openapi("BirthdaySettings") } }, required: true } },
    responses: { 204: { description: "Saved" }, 422: problemContent("The message needs fixing"), ...errors },
  }),
  async (c) => {
    const input = c.req.valid("json");
    await schoolRoute(c, { roles: ADMINS }, async ({ tx, school, auth, audit }) => {
      const before = await birthdaySettingsOf(tx);
      await tx
        .insert(birthdaySettings)
        .values({ schoolId: school.id, ...input, createdBy: auth.user.id, updatedBy: auth.user.id })
        .onConflictDoUpdate({ target: birthdaySettings.schoolId, set: { ...input, updatedBy: auth.user.id, updatedAt: new Date() } });
      if (before.enabled === input.enabled && before.message === input.message) return;
      const summary = before.enabled !== input.enabled ? (input.enabled ? "Turned birthday messages on" : "Turned birthday messages off") : "Changed the birthday message";
      audit({ action: "birthdays.settings_saved", entity: "school", entityId: school.id, changes: { enabled: input.enabled, message: input.message }, summary });
    });
    return c.body(null, 204);
  },
);

/** For the parent app: the school's message for a child on their birthday, when the school sends them. */
export function birthdayFor(settings: BirthdaySettings, schoolName: string, child: { firstName: string; dateOfBirth: string | null }, today: string): string | null {
  if (!settings.enabled || !child.dateOfBirth || !isBirthday(child.dateOfBirth, today)) return null;
  return birthdayMessage(settings.message, { firstName: child.firstName, age: ageOn(child.dateOfBirth, today) }, schoolName);
}

// ——— The daily job ———

export type BirthdayRun = { day: string; schools: number; sent: number; noPhone: number; failed: number };

/**
 * Sends today's birthday texts for every school that has them on. Safe to run again: a student
 * gets one row a day, claimed before sending, so a second run sends nothing new. A row left
 * `pending` for 15 minutes (a run that stopped half-way) is tried again.
 */
export async function runBirthdayTexts(deps: AppDeps, day: string = lagosToday()): Promise<BirthdayRun> {
  const run: BirthdayRun = { day, schools: 0, sent: 0, noPhone: 0, failed: 0 };
  for (const school of await birthdaySchools(deps.db)) {
    run.schools++;
    try {
      const claimed = await withSchool(deps.db, school.schoolId, async (tx) => {
        const settings = await birthdaySettingsOf(tx);
        if (!settings.enabled) return [];
        const today = (await activeWithBirthdays(tx)).filter((s) => isBirthday(s.dateOfBirth, day));
        const phones = await guardianPhones(tx, today.map((s) => s.id));
        const rows = today.map((s) => {
          const phone = phones.get(s.id) ?? null;
          return {
            schoolId: school.schoolId,
            studentId: s.id,
            day,
            phone,
            text: birthdayMessage(settings.message, { firstName: s.firstName, age: ageOn(s.dateOfBirth, day) }, school.name),
            status: phone ? ("pending" as const) : ("no_phone" as const),
          };
        });
        const inserted = rows.length
          ? await tx.insert(birthdayTexts).values(rows).onConflictDoNothing().returning({ id: birthdayTexts.id, phone: birthdayTexts.phone, text: birthdayTexts.text, status: birthdayTexts.status })
          : [];
        const stuck = await tx
          .select({ id: birthdayTexts.id, phone: birthdayTexts.phone, text: birthdayTexts.text, status: birthdayTexts.status })
          .from(birthdayTexts)
          .where(and(eq(birthdayTexts.day, day), eq(birthdayTexts.status, "pending"), lt(birthdayTexts.updatedAt, sql`now() - interval '15 minutes'`)));
        if (stuck.length) await tx.update(birthdayTexts).set({ updatedAt: new Date() }).where(inArray(birthdayTexts.id, stuck.map((s) => s.id)));
        return [...inserted, ...stuck];
      });
      for (const row of claimed) {
        if (row.status === "no_phone" || !row.phone) {
          run.noPhone++;
          continue;
        }
        let result: { status: "sent" | "failed"; providerRef: string | null; error: string | null };
        try {
          const { ref } = await deps.sms.send({ to: row.phone, text: row.text, tag: "birthday" });
          result = { status: "sent", providerRef: ref, error: null };
          run.sent++;
        } catch (err) {
          result = { status: "failed", providerRef: null, error: (err as Error).message.slice(0, 500) };
          run.failed++;
        }
        await withSchool(deps.db, school.schoolId, (tx) => tx.update(birthdayTexts).set({ ...result, updatedAt: new Date() }).where(eq(birthdayTexts.id, row.id)));
      }
    } catch (err) {
      // One school's trouble doesn't stop the others.
      deps.logger.error("birthday texts failed for a school", { school: school.subdomain, err });
    }
  }
  deps.logger.info("birthday texts", run);
  return run;
}

const sameSecret = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** Vercel Cron calls this with "Authorization: Bearer <CRON_SECRET>". Without the secret set, it isn't there. */
birthdayRoutes.get("/internal/cron/birthdays", async (c) => {
  const deps = c.get("deps");
  const secret = deps.config.cronSecret;
  const sent = (c.req.header("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!secret || !sameSecret(sent, secret)) throw new ApiError("not_found", "No endpoint at this path.");
  return c.json(await runBirthdayTexts(deps), 200);
});
