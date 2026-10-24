/**
 * Parents (C2 in the front end's backend-requirements.md; shapes and rules follow its
 * src/data/fake/parents.ts). A parent's account follows a guardian record (parent_links), and every
 * parent read is limited to that guardian's children.
 *
 * Owners and admins:
 *   GET    /v1/parents                     guardians with children here, contacts, parent-app access
 *   POST   /v1/guardians/{id}/invite       invite one guardian, by the email on their record
 *   POST   /v1/parents/invite-all          every guardian with an email who isn't invited yet
 *   DELETE /v1/guardians/{id}/access       end their access, or cancel their invite (records stay)
 * Parents:
 *   GET    /v1/me/children                 the parent's home
 *
 * Invitations made here carry role "parent" and the guardian; accepting one links the account
 * (routes/invitations.ts). The student page shows attendance and parent access (routes/students.ts).
 */
import { fullName, latestSchoolDay, schoolDaysSoFar, termOf } from "@brillianda/core";
import { generateToken } from "@brillianda/auth";
import {
  and,
  armFormTeachers,
  asc,
  eq,
  gt,
  gte,
  guardians,
  inArray,
  invitations,
  isNull,
  lte,
  parentLinks,
  registerMarks,
  registers,
  schoolMembers,
  studentGuardians,
  students,
  users,
  type Tx,
} from "@brillianda/db";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import type { AppEnv } from "../context.js";
import { emails } from "../emails.js";
import { attendanceOf, lagosToday, parentAccessOf, termsOf } from "../lib/attendance.js";
import { ApiError, problemContent } from "../lib/errors.js";
import { RATE_RULES } from "../lib/rate-limit.js";
import type { ResolvedSchool } from "../lib/school-directory.js";
import { schoolUrl } from "../lib/urls.js";
import { schoolRoute, type Role } from "../school-route.js";
import { birthdayFor, birthdaySettingsOf } from "./birthdays.js";
import { BookListSchema, bookListsFor } from "./booklists.js";
import { armOptions } from "./classes.js";
import { buildReportCard, computeClass, publishedFor, ReportCardSchema, reportTermsOf } from "./reports.js";
import { resultsTermOf, type ResultsTerm } from "./results.js";

export const parentRoutes = new OpenAPIHono<AppEnv>();

const ADMINS: readonly Role[] = ["owner", "admin"];
const INVITE_TTL_MS = 7 * 86_400_000;
/** Invite-all sends at most this many emails per call; the answer says how many are left. */
const INVITE_ALL_BATCH = 50;
const Id = z.string().uuid("Invalid id");
const ok = <T extends z.ZodTypeAny>(description: string, schema: T) => ({ description, content: { "application/json": { schema } } });
const errors = {
  401: problemContent("Not signed in to this school"),
  403: problemContent("This role can't do this"),
  404: problemContent("No such guardian here"),
} as const;

const AccessEnum = z.enum(["none", "invited", "active"]);
const AttendanceSchema = z
  .object({ term: z.string(), days: z.number().int(), present: z.number().int(), late: z.number().int(), absent: z.number().int() })
  .nullable()
  .openapi("AttendanceSummary", { description: "This term's register marks (late counts as present); null outside a term" });

/** Guardians (by id) that have at least one student on record here, with those students. */
async function childrenByGuardian(tx: Tx, guardianIds?: string[]) {
  const rows = await tx
    .select({ guardianId: studentGuardians.guardianId, student: students })
    .from(studentGuardians)
    .innerJoin(students, and(eq(students.schoolId, studentGuardians.schoolId), eq(students.id, studentGuardians.studentId)))
    .where(and(isNull(students.deletedAt), ...(guardianIds ? [inArray(studentGuardians.guardianId, guardianIds)] : [])))
    .orderBy(asc(students.lastName), asc(students.firstName));
  const out = new Map<string, (typeof rows)[number]["student"][]>();
  for (const r of rows) out.set(r.guardianId, [...(out.get(r.guardianId) ?? []), r.student]);
  return out;
}

const inviteHash = (c: Context<AppEnv>, token: string) => c.get("deps").secret.hash("invite", token);

type InviteOutcome = { kind: "invited"; email: string; name: string; token: string; resent: boolean } | { kind: "linked"; name: string };

/**
 * Invites one guardian (the email on their record), inside the caller's transaction. A parent
 * already signed up here through another family record is linked straight away instead.
 * Throws an ApiError with the reason it can't.
 */
async function inviteGuardian(tx: Tx, c: Context<AppEnv>, school: ResolvedSchool, actorId: string, guardianId: string): Promise<InviteOutcome> {
  const [g] = await tx.select({ id: guardians.id, name: guardians.fullName, email: guardians.email }).from(guardians).where(eq(guardians.id, guardianId)).limit(1);
  if (!g) throw new ApiError("not_found", "That guardian isn’t here any more.");
  if (!g.email) throw new ApiError("validation_failed", `${g.name} has no email on file. Add one from their child’s page first.`, { extensions: { errors: [{ pointer: "#/email", detail: "No email on file", code: "required" }] } });
  if ((await parentAccessOf(tx, [g.id])).get(g.id) === "active") throw new ApiError("conflict", `${g.name} already uses the parent app.`);

  const [member] = await tx
    .select({ userId: schoolMembers.userId, role: schoolMembers.role })
    .from(schoolMembers)
    .innerJoin(users, eq(users.id, schoolMembers.userId))
    .where(eq(users.email, g.email))
    .limit(1);
  if (member && member.role !== "parent") {
    throw new ApiError("conflict", `${g.email} belongs to someone on the staff here. Staff can’t use the parent app with the same email yet.`);
  }
  if (member) {
    // Already a parent here (another family record with the same email): link this one too.
    await tx.insert(parentLinks).values({ schoolId: school.id, guardianId: g.id, userId: member.userId, createdBy: actorId, updatedBy: actorId }).onConflictDoNothing();
    return { kind: "linked", name: g.name };
  }

  const [open] = await tx
    .select({ role: invitations.role, guardianId: invitations.guardianId })
    .from(invitations)
    .where(and(eq(invitations.email, g.email), isNull(invitations.acceptedAt), isNull(invitations.revokedAt), gt(invitations.expiresAt, new Date())))
    .limit(1);
  if (open && (open.role !== "parent" || open.guardianId !== g.id)) {
    throw new ApiError("conflict", `${g.email} already has an open invitation${open.role === "parent" ? " for another family" : ` as ${open.role === "admin" ? "an admin" : "a teacher"}`}.`);
  }
  // A re-invite replaces the old link (one open invitation per email).
  await tx
    .update(invitations)
    .set({ revokedAt: new Date(), updatedBy: actorId })
    .where(and(eq(invitations.email, g.email), isNull(invitations.acceptedAt), isNull(invitations.revokedAt)));
  const token = generateToken();
  await tx.insert(invitations).values({
    schoolId: school.id,
    email: g.email,
    fullName: g.name,
    role: "parent",
    guardianId: g.id,
    tokenHash: inviteHash(c, token),
    invitedBy: actorId,
    expiresAt: new Date(Date.now() + INVITE_TTL_MS),
    createdBy: actorId,
    updatedBy: actorId,
  });
  return { kind: "invited", email: g.email, name: g.name, token, resent: !!open };
}

async function sendInvites(c: Context<AppEnv>, school: ResolvedSchool, inviter: string, sent: Extract<InviteOutcome, { kind: "invited" }>[]) {
  const { mailer, config } = c.get("deps");
  for (const s of sent) {
    await mailer.send(emails.invitation(s.email, school.name, inviter, "parent", schoolUrl(config, school.subdomain, `/invite?token=${s.token}`), s.name));
  }
}

// ——— More › Parents ———

const ParentsPageSchema = z
  .object({
    guardians: z.array(
      z.object({
        id: z.string().uuid(),
        name: z.string(),
        email: z.string().nullable(),
        phone: z.string().nullable(),
        children: z.array(z.object({ id: z.string().uuid(), fullName: z.string(), armLabel: z.string() })),
        access: AccessEnum,
      }),
    ),
  })
  .openapi("ParentsPage");

parentRoutes.openapi(
  createRoute({
    method: "get",
    path: "/v1/parents",
    tags: ["parents"],
    summary: "The Parents page: guardians with children here, their email and phone, and parent-app access",
    responses: { 200: ok("Parents", ParentsPageSchema), ...errors },
  }),
  async (c) => {
    const data = await schoolRoute(c, { roles: ADMINS }, async ({ tx }) => {
      const kids = await childrenByGuardian(tx);
      const ids = [...kids.keys()];
      const rows = ids.length ? await tx.select().from(guardians).where(inArray(guardians.id, ids)).orderBy(asc(guardians.fullName)) : [];
      const access = await parentAccessOf(tx, ids);
      const labels = new Map((await armOptions(tx, { all: true })).map((a) => [a.id, a.label]));
      return {
        guardians: rows.map((g) => ({
          id: g.id,
          name: g.fullName,
          email: g.email,
          phone: g.phone,
          children: (kids.get(g.id) ?? []).map((s) => ({ id: s.id, fullName: fullName(s), armLabel: labels.get(s.classArmId) ?? "No class" })),
          access: access.get(g.id) ?? "none",
        })),
      };
    });
    return c.json(data, 200);
  },
);

parentRoutes.openapi(
  createRoute({
    method: "post",
    path: "/v1/guardians/{id}/invite",
    tags: ["parents"],
    summary: "Invite one guardian to the parent app, by the email on their record (a re-invite sends a new link)",
    request: { params: z.object({ id: Id }) },
    responses: {
      201: ok("Invited (or linked straight away when they already use the parent app for another family)", z.object({ access: z.enum(["invited", "active"]), resent: z.boolean() }).openapi("ParentInvited")),
      409: problemContent("Already uses the parent app, belongs to the staff, or has another open invitation"),
      422: problemContent("No email on file"),
      ...errors,
    },
  }),
  async (c) => {
    const { id } = c.req.valid("param");
    const { outcome, school, inviter } = await schoolRoute(c, { roles: ADMINS, userRateLimit: RATE_RULES.invitePerUser }, async ({ tx, school, auth, audit }) => {
      const outcome = await inviteGuardian(tx, c, school, auth.user.id, id);
      audit({
        action: outcome.kind === "linked" ? "parent.linked" : "parent.invited",
        entity: "guardian",
        entityId: id,
        summary: outcome.kind === "linked" ? `Gave ${outcome.name} parent app access` : `Invited ${outcome.name} to the parent app`,
      });
      return { outcome, school, inviter: auth.user.fullName };
    });
    if (outcome.kind === "invited") await sendInvites(c, school, inviter, [outcome]);
    return c.json({ access: outcome.kind === "linked" ? ("active" as const) : ("invited" as const), resent: outcome.kind === "invited" && outcome.resent }, 201);
  },
);

parentRoutes.openapi(
  createRoute({
    method: "post",
    path: "/v1/parents/invite-all",
    tags: ["parents"],
    summary: `Invite every guardian with an email who isn't invited yet (up to ${INVITE_ALL_BATCH} per call; call again while remaining > 0)`,
    responses: {
      200: ok(
        "Done",
        z
          .object({
            invited: z.number().int(),
            withoutEmail: z.number().int().openapi({ description: "Guardians not invited because their record has no email" }),
            skipped: z.number().int().openapi({ description: "Not invited: their email belongs to the staff, or another family shares it" }),
            remaining: z.number().int().openapi({ description: "Still to invite; call again" }),
          })
          .openapi("ParentsInvited"),
      ),
      ...errors,
    },
  }),
  async (c) => {
    const result = await schoolRoute(c, { roles: ADMINS, userRateLimit: RATE_RULES.invitePerUser }, async ({ tx, school, auth, audit }) => {
      const kids = await childrenByGuardian(tx);
      const ids = [...kids.keys()];
      const access = await parentAccessOf(tx, ids);
      const rows = ids.length ? await tx.select({ id: guardians.id, email: guardians.email }).from(guardians).where(inArray(guardians.id, ids)).orderBy(asc(guardians.fullName)) : [];
      const waiting = rows.filter((g) => access.get(g.id) === "none");
      const withEmail = waiting.filter((g) => g.email);
      const sent: Extract<InviteOutcome, { kind: "invited" }>[] = [];
      let linked = 0;
      let skipped = 0;
      for (const g of withEmail.slice(0, INVITE_ALL_BATCH)) {
        try {
          const outcome = await tx.transaction((sp) => inviteGuardian(sp, c, school, auth.user.id, g.id));
          if (outcome.kind === "invited") sent.push(outcome);
          else linked++;
        } catch (err) {
          if (!(err instanceof ApiError)) throw err;
          skipped++;
        }
      }
      const done = sent.length + linked;
      if (done) audit({ action: "parents.invited", entity: "school", entityId: school.id, changes: { invited: sent.length, linked, skipped }, summary: `Invited ${done} ${done === 1 ? "parent" : "parents"} to the parent app` });
      return {
        sent,
        school,
        inviter: auth.user.fullName,
        body: { invited: done, withoutEmail: waiting.length - withEmail.length, skipped, remaining: Math.max(0, withEmail.length - INVITE_ALL_BATCH) },
      };
    });
    await sendInvites(c, result.school, result.inviter, result.sent);
    return c.json(result.body, 200);
  },
);

parentRoutes.openapi(
  createRoute({
    method: "delete",
    path: "/v1/guardians/{id}/access",
    tags: ["parents"],
    summary: "End a guardian's parent-app access, or cancel their invite. Their records and their children's stay",
    request: { params: z.object({ id: Id }) },
    responses: { 204: { description: "Ended" }, ...errors },
  }),
  async (c) => {
    const { id } = c.req.valid("param");
    await schoolRoute(c, { roles: ADMINS }, async ({ tx, auth, audit }) => {
      const [g] = await tx.select({ id: guardians.id, name: guardians.fullName }).from(guardians).where(eq(guardians.id, id)).limit(1);
      if (!g) throw new ApiError("not_found", "That guardian isn’t here any more.");
      await tx
        .update(invitations)
        .set({ revokedAt: new Date(), updatedBy: auth.user.id })
        .where(and(eq(invitations.guardianId, id), eq(invitations.role, "parent"), isNull(invitations.acceptedAt), isNull(invitations.revokedAt)));
      const links = await tx.delete(parentLinks).where(eq(parentLinks.guardianId, id)).returning({ userId: parentLinks.userId });
      for (const { userId } of links) {
        // Still a parent here through another family record? Keep the account; else it leaves the
        // school (its sessions here end with the membership).
        const [other] = await tx.select({ id: parentLinks.id }).from(parentLinks).where(eq(parentLinks.userId, userId)).limit(1);
        if (!other) await tx.delete(schoolMembers).where(and(eq(schoolMembers.userId, userId), eq(schoolMembers.role, "parent")));
      }
      audit({ action: "parent.access_ended", entity: "guardian", entityId: id, changes: { accounts: links.length }, summary: `Ended ${g.name}’s parent app access` });
    });
    return c.body(null, 204);
  },
);

// ——— What parents see ———

type ChildResults = { term: string; published: false } | { term: string; published: true; average: number | null; position: number | null; of: number } | null;

/** This term's results for a parent: nothing but the term's name until the class is published. */
async function childResults(tx: Tx, studentId: string, armId: string, term: ResultsTerm): Promise<ChildResults> {
  const label = `${term.name}, ${term.session}`;
  if (!(await publishedFor(tx, term.key, armId))) return { term: label, published: false };
  const { settings, pupils, results } = await computeClass(tx, term.key, armId, term.key);
  const mine = results.get(studentId);
  return { term: label, published: true, average: mine?.average ?? null, position: settings.showPositions ? (mine?.position ?? null) : null, of: pupils.length };
}

/** The parent's own children (through their family records), active or not. */
async function myChildIds(tx: Tx, userId: string): Promise<Set<string>> {
  const mine = (await tx.select({ guardianId: parentLinks.guardianId }).from(parentLinks).where(eq(parentLinks.userId, userId))).map((l) => l.guardianId);
  if (!mine.length) return new Set();
  return new Set([...(await childrenByGuardian(tx, mine)).values()].flat().map((s) => s.id));
}

const ParentHomeSchema = z
  .object({
    fullName: z.string(),
    schoolDay: z.boolean().openapi({ description: "Today is a school day" }),
    children: z.array(
      z.object({
        id: z.string().uuid(),
        fullName: z.string(),
        armLabel: z.string(),
        admissionNo: z.string(),
        formTeacher: z.string().nullable(),
        attendance: AttendanceSchema,
        recent: z.array(z.object({ date: z.string(), mark: z.enum(["present", "late", "absent"]).nullable() })).openapi({ description: "The latest ten school days this term, newest first (no notes)" }),
        results: z
          .union([
            z.object({ term: z.string(), published: z.literal(false) }),
            z.object({ term: z.string(), published: z.literal(true), average: z.number().nullable(), position: z.number().int().nullable(), of: z.number().int() }),
          ])
          .nullable()
          .openapi({ description: "This term's name, and once the class is published the average, position (when shown) and class size; null before a term opens" }),
        pastTerms: z.array(z.object({ key: z.string(), label: z.string() })).openapi({ description: "Closed terms whose results were published, newest first" }),
        bookLists: z.array(z.object({ label: z.string(), list: BookListSchema })).openapi({ description: "Shared lists: the class level they move into next session (none in the final class), then this session's" }),
        birthday: z.string().nullable().openapi({ description: "On the child's birthday, when the school sends birthday messages: the school's message; otherwise null" }),
      }),
    ),
  })
  .openapi("ParentHome");

parentRoutes.openapi(
  createRoute({
    method: "get",
    path: "/v1/me/children",
    tags: ["parents"],
    summary: "A parent's home: each of their children with class, form teacher, this term's attendance and the last ten school days",
    responses: { 200: ok("Parent home", ParentHomeSchema), ...errors },
  }),
  async (c) => {
    const data = await schoolRoute(c, { roles: ["parent"] }, async ({ tx, auth, school }) => {
      const mine = (await tx.select({ guardianId: parentLinks.guardianId }).from(parentLinks).where(eq(parentLinks.userId, auth.user.id))).map((l) => l.guardianId);
      const kidsByGuardian = mine.length ? await childrenByGuardian(tx, mine) : new Map();
      const seen = new Set<string>();
      const kids = [...kidsByGuardian.values()].flat().filter((s) => s.status === "active" && !seen.has(s.id) && seen.add(s.id));

      const today = lagosToday();
      const terms = await termsOf(tx);
      const term = termOf(today, terms);
      const days = term ? schoolDaysSoFar(term, today).slice(0, 10) : [];
      const ids = kids.map((s) => s.id);
      const attendance = await attendanceOf(tx, ids, terms, today);
      const marks = new Map<string, string>();
      if (ids.length && days.length) {
        const rows = await tx
          .select({ studentId: registerMarks.studentId, day: registers.day, mark: registerMarks.mark })
          .from(registerMarks)
          .innerJoin(registers, and(eq(registers.schoolId, registerMarks.schoolId), eq(registers.id, registerMarks.registerId)))
          .where(and(inArray(registerMarks.studentId, ids), gte(registers.day, days.at(-1)!), lte(registers.day, days[0]!)));
        for (const r of rows) marks.set(`${r.studentId}|${r.day}`, r.mark);
      }
      const armIds = [...new Set(kids.map((s) => s.classArmId))];
      const formTeachers = new Map(
        armIds.length
          ? (
              await tx
                .select({ armId: armFormTeachers.classArmId, name: users.fullName })
                .from(armFormTeachers)
                .innerJoin(users, eq(users.id, armFormTeachers.userId))
                .where(inArray(armFormTeachers.classArmId, armIds))
            ).map((f) => [f.armId, f.name])
          : [],
      );
      const allArms = await armOptions(tx, { all: true });
      const labels = new Map(allArms.map((a) => [a.id, a.label]));
      const levelOf = new Map(allArms.map((a) => [a.id, a.levelId]));
      const open = await resultsTermOf(tx);
      const birthdays = await birthdaySettingsOf(tx);
      const resultsOf = new Map<string, ChildResults>();
      const pastOf = new Map<string, { key: string; label: string }[]>();
      const listsOf = new Map<string, Awaited<ReturnType<typeof bookListsFor>>>();
      for (const s of kids) {
        listsOf.set(s.id, await bookListsFor(tx, levelOf.get(s.classArmId) ?? null));
        resultsOf.set(s.id, open ? await childResults(tx, s.id, s.classArmId, open) : null);
        pastOf.set(
          s.id,
          (await reportTermsOf(tx, s.id)).filter((t) => t.published && !t.open).map((t) => ({ key: t.key, label: `${t.name}, ${t.session}` })),
        );
      }
      return {
        fullName: auth.user.fullName,
        schoolDay: latestSchoolDay(today, terms) === today,
        children: kids.map((s) => ({
          id: s.id,
          fullName: fullName(s),
          armLabel: labels.get(s.classArmId) ?? "No class",
          admissionNo: s.admissionNumber,
          formTeacher: formTeachers.get(s.classArmId) ?? null,
          attendance: attendance.get(s.id) ?? null,
          recent: days.map((date) => ({ date, mark: (marks.get(`${s.id}|${date}`) as "present" | "late" | "absent" | undefined) ?? null })),
          results: resultsOf.get(s.id) ?? null,
          pastTerms: pastOf.get(s.id) ?? [],
          bookLists: listsOf.get(s.id) ?? [],
          birthday: birthdayFor(birthdays, school.name, s, today),
        })),
      };
    });
    return c.json(data, 200);
  },
);

parentRoutes.openapi(
  createRoute({
    method: "get",
    path: "/v1/me/children/{studentId}/report-card",
    tags: ["parents"],
    summary: "A child's report card for a published term (default: this term). Anything else answers not found",
    request: { params: z.object({ studentId: Id }), query: z.object({ term: z.string().regex(/^\d{4}-[1-3]$/, "Pick a term").optional() }) },
    responses: { 200: ok("Report card", ReportCardSchema), ...errors },
  }),
  async (c) => {
    const { studentId } = c.req.valid("param");
    const { term } = c.req.valid("query");
    const data = await schoolRoute(c, { roles: ["parent"] }, async ({ tx, auth, school }) => {
      const notFound = () => new ApiError("not_found", "There’s no published report card for that term.");
      if (!(await myChildIds(tx, auth.user.id)).has(studentId)) throw notFound();
      const card = await buildReportCard(tx, school, studentId, term);
      if (!card?.published) throw notFound();
      return card;
    });
    return c.json(data, 200);
  },
);
