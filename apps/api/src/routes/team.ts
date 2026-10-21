/**
 * The Brillianda team console (C1 in the front end's backend-requirements.md; shapes follow its
 * src/data/fake/console.ts). On the main site only (brillianda.com, staging: the root domain),
 * with team accounts separate from school accounts and their own cookie.
 *
 *   POST  /v1/team/login                        { email, password } → TeamMember
 *   POST  /v1/team/logout
 *   GET   /v1/team/me                           → TeamMember
 *   GET   /v1/team/overview                     → ConsoleOverview
 *   GET   /v1/team/schools                      → ConsoleSchool[]
 *   GET   /v1/team/schools/{subdomain}          → ConsoleSchoolDetail; logged in that school's history
 *   PUT   /v1/team/schools/{subdomain}/status   { status: active | suspended, reason }
 *   GET   /v1/team/trial-requests               → TrialRequestRow[], newest first
 *   PATCH /v1/team/trial-requests/{id}          { status, note }
 *
 * Counts across schools come from one SECURITY DEFINER function (consoleSchools, migration 0026):
 * counts, contacts and setup flags, never a student's own record. The two writes into a school
 * (the "viewed" line and pause/reactivate) go through withSchool for that school, by name, which is
 * the one place a school is chosen by input rather than the host: docs/decisions.md #7.
 */
import { generateToken, verifyPassword } from "@brillianda/auth";
import {
  and,
  auditLog,
  consoleSchools,
  count,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  schools,
  sql,
  teamLog,
  teamMembers,
  teamSessions,
  trialRequests,
  withSchool,
  type ConsoleSchoolRow,
} from "@brillianda/db";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { AppEnv } from "../context.js";
import { EmailSchema } from "../auth-helpers.js";
import { ApiError, problemContent } from "../lib/errors.js";
import { RATE_RULES } from "../lib/rate-limit.js";
import { enforceRateLimit } from "../school-route.js";

export const teamRoutes = new OpenAPIHono<AppEnv>();

const SESSION_HOURS = 12;
const VIEW_LOG_EVERY_MS = 3_600_000;
const ok = <T extends z.ZodTypeAny>(description: string, schema: T) => ({ description, content: { "application/json": { schema } } });
const json = <T extends z.ZodTypeAny>(schema: T) => ({ content: { "application/json": { schema } }, required: true });
const errors = {
  401: problemContent("Not signed in to the team console"),
  404: problemContent("Not on the main site, or no such school or request"),
} as const;

// ——— Team sessions ———

/** `__Host-bd_team` over https (hono adds the prefix), plain `bd_team` locally; never sent to a school's address. */
const TEAM_COOKIE = "bd_team";
const cookieName = (_c: Context<AppEnv>) => TEAM_COOKIE;
const tokenHash = (c: Context<AppEnv>, token: string) => c.get("deps").secret.hash("team-session", token);

/** The console lives on the main site only; on a school's address these paths don't exist. */
function requireMainSite(c: Context<AppEnv>): void {
  if (c.get("target").kind !== "apex") throw new ApiError("not_found", "The team console is on the main site.");
}

interface TeamMember {
  id: string;
  fullName: string;
  email: string;
}

async function currentTeam(c: Context<AppEnv>): Promise<{ member: TeamMember; sessionId: string } | null> {
  const token = getCookie(c, cookieName(c), c.get("deps").config.secureCookies ? "host" : undefined);
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const [row] = await c
    .get("deps")
    .db.select({ sessionId: teamSessions.id, id: teamMembers.id, fullName: teamMembers.fullName, email: teamMembers.email })
    .from(teamSessions)
    .innerJoin(teamMembers, eq(teamMembers.id, teamSessions.teamMemberId))
    .where(and(eq(teamSessions.tokenHash, tokenHash(c, token)), gt(teamSessions.expiresAt, new Date()), eq(teamMembers.status, "active")))
    .limit(1);
  return row ? { member: { id: row.id, fullName: row.fullName, email: row.email }, sessionId: row.sessionId } : null;
}

/** Main site, rate limit, and a live team session; otherwise 404 / 429 / 401. */
async function requireTeam(c: Context<AppEnv>): Promise<TeamMember> {
  requireMainSite(c);
  await enforceRateLimit(c, RATE_RULES.apiPerIp, c.get("clientIp") ?? "unknown");
  const team = await currentTeam(c);
  if (!team) throw new ApiError("unauthenticated", "Sign in to the team console.");
  c.header("Cache-Control", "no-store");
  return team.member;
}

const TeamMemberSchema = z.object({ id: z.string().uuid(), fullName: z.string(), email: z.string() }).openapi("TeamMember");

teamRoutes.openapi(
  createRoute({
    method: "post",
    path: "/v1/team/login",
    tags: ["team"],
    summary: "Sign in to the team console (main site only). School accounts can't sign in here",
    request: { body: json(z.object({ email: EmailSchema, password: z.string().min(1, "Enter your password").max(1024) }).openapi("TeamLogin")) },
    responses: { 200: ok("Signed in; sets the team cookie", TeamMemberSchema), 401: problemContent("Wrong email or password"), 404: errors[404], 429: problemContent("Too many tries") },
  }),
  async (c) => {
    requireMainSite(c);
    const { email, password } = c.req.valid("json");
    const { db, config } = c.get("deps");
    await enforceRateLimit(c, RATE_RULES.loginPerIp, c.get("clientIp") ?? "unknown");
    await enforceRateLimit(c, RATE_RULES.loginPerEmail, `team:${email}`);
    const [member] = await db.select().from(teamMembers).where(eq(teamMembers.email, email)).limit(1);
    // Same answer and the same work whether or not the account exists.
    const passwordOk = await verifyPassword(member?.passwordHash ?? null, password);
    if (!member || !passwordOk || member.status !== "active") throw new ApiError("invalid_credentials", "That email and password don’t match a team account.");

    const token = generateToken();
    const expiresAt = new Date(Date.now() + SESSION_HOURS * 3_600_000);
    await db.insert(teamSessions).values({ teamMemberId: member.id, tokenHash: tokenHash(c, token), expiresAt, ip: c.get("clientIp") ?? null, userAgent: c.get("userAgent") ?? null });
    await db.update(teamMembers).set({ lastLoginAt: new Date() }).where(eq(teamMembers.id, member.id));
    setCookie(c, cookieName(c), token, {
      httpOnly: true,
      secure: config.secureCookies,
      sameSite: "Strict",
      path: "/",
      expires: expiresAt,
      ...(config.secureCookies ? { prefix: "host" as const } : {}),
    });
    c.header("Cache-Control", "no-store");
    return c.json({ id: member.id, fullName: member.fullName, email: member.email }, 200);
  },
);

teamRoutes.openapi(
  createRoute({
    method: "post",
    path: "/v1/team/logout",
    tags: ["team"],
    summary: "Sign out of the team console (works even when the session is already gone)",
    responses: { 204: { description: "Signed out; clears the team cookie" }, 404: errors[404] },
  }),
  async (c) => {
    requireMainSite(c);
    const team = await currentTeam(c);
    if (team) await c.get("deps").db.delete(teamSessions).where(eq(teamSessions.id, team.sessionId));
    const secure = c.get("deps").config.secureCookies;
    deleteCookie(c, cookieName(c), { path: "/", secure, ...(secure ? { prefix: "host" as const } : {}) });
    return c.body(null, 204);
  },
);

teamRoutes.openapi(
  createRoute({ method: "get", path: "/v1/team/me", tags: ["team"], summary: "Who is signed in to the team console", responses: { 200: ok("Signed in", TeamMemberSchema), ...errors } }),
  async (c) => c.json(await requireTeam(c), 200),
);

// ——— Schools ———

const STATUS = z.enum(["active", "suspended", "archived"]);
const ConsoleSchoolSchema = z
  .object({
    subdomain: z.string(),
    name: z.string(),
    status: STATUS.openapi({ description: "suspended: paused by the team" }),
    createdAt: z.number().int().nullable().openapi({ description: "ms since epoch" }),
    owner: z.object({ fullName: z.string(), email: z.string() }).nullable(),
    students: z.number().int(),
    classes: z.number().int(),
    setupDone: z.number().int(),
    setupTotal: z.number().int(),
  })
  .openapi("ConsoleSchool");

const SETUP_LABELS: [keyof ConsoleSchoolRow["setup"], string][] = [
  ["calendar", "Calendar"],
  ["classes", "Classes"],
  ["arms", "Arms"],
  ["subjects", "Subjects"],
  ["students", "Students"],
  ["admins", "Admins"],
  ["branding", "Branding"],
];
const setupOf = (r: ConsoleSchoolRow) => SETUP_LABELS.map(([key, label]) => ({ label, done: r.setup[key] }));

function rowOf(r: ConsoleSchoolRow): z.infer<typeof ConsoleSchoolSchema> {
  const setup = setupOf(r);
  return {
    subdomain: r.subdomain,
    name: r.name,
    status: r.status,
    createdAt: r.createdAt.getTime(),
    owner: r.ownerName && r.ownerEmail ? { fullName: r.ownerName, email: r.ownerEmail } : null,
    students: r.students,
    classes: r.classes,
    setupDone: setup.filter((s) => s.done).length,
    setupTotal: setup.length,
  };
}

async function schoolBySubdomain(c: Context<AppEnv>, subdomain: string): Promise<ConsoleSchoolRow> {
  const row = (await consoleSchools(c.get("deps").db)).find((r) => r.subdomain === subdomain.toLowerCase());
  if (!row) throw new ApiError("not_found", "That school isn’t here any more.");
  return row;
}

const ConsoleOverviewSchema = z
  .object({
    schools: z.object({ active: z.number().int(), suspended: z.number().int(), newThisWeek: z.number().int() }),
    students: z.number().int(),
    trialsWaiting: z.number().int(),
    recentSchools: z.array(ConsoleSchoolSchema),
    activity: z.array(z.object({ at: z.number().int(), who: z.string(), what: z.string(), subdomain: z.string().optional() })),
  })
  .openapi("ConsoleOverview");

teamRoutes.openapi(
  createRoute({
    method: "get",
    path: "/v1/team/overview",
    tags: ["team"],
    summary: "Overview: schools active, paused and new this week; students; trial requests waiting; newest schools; recent activity",
    responses: { 200: ok("Overview", ConsoleOverviewSchema), ...errors },
  }),
  async (c) => {
    await requireTeam(c);
    const { db } = c.get("deps");
    const rows = await consoleSchools(db);
    const weekAgo = Date.now() - 7 * 86_400_000;
    const [waiting] = await db.select({ n: count() }).from(trialRequests).where(eq(trialRequests.status, "new"));
    const bySchoolId = new Map(rows.map((r) => [r.schoolId, r]));
    const log = await db
      .select({ at: teamLog.createdAt, who: teamLog.teamMemberName, what: teamLog.summary, schoolId: teamLog.aboutSchoolId })
      .from(teamLog)
      .orderBy(desc(teamLog.createdAt))
      .limit(12);
    const newest = [...rows].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    const signups = newest.slice(0, 12).map((r) => ({ at: r.createdAt.getTime(), who: r.ownerName ?? "Someone", what: `${r.name} signed up`, subdomain: r.subdomain }));
    const activity = [
      ...log.map((l) => {
        const school = l.schoolId ? bySchoolId.get(l.schoolId) : undefined;
        return { at: l.at.getTime(), who: l.who, what: l.what, ...(school ? { subdomain: school.subdomain } : {}) };
      }),
      ...signups,
    ]
      .sort((a, b) => b.at - a.at)
      .slice(0, 12);
    return c.json(
      {
        schools: {
          active: rows.filter((r) => r.status === "active").length,
          suspended: rows.filter((r) => r.status === "suspended").length,
          newThisWeek: rows.filter((r) => r.createdAt.getTime() > weekAgo).length,
        },
        students: rows.reduce((n, r) => n + r.students, 0),
        trialsWaiting: waiting?.n ?? 0,
        recentSchools: newest.slice(0, 5).map(rowOf),
        activity,
      },
      200,
    );
  },
);

teamRoutes.openapi(
  createRoute({
    method: "get",
    path: "/v1/team/schools",
    tags: ["team"],
    summary: "Every school: status, owner, students, classes, setup progress, joined (by name)",
    responses: { 200: ok("Schools", z.array(ConsoleSchoolSchema)), ...errors },
  }),
  async (c) => {
    await requireTeam(c);
    const rows = await consoleSchools(c.get("deps").db);
    return c.json(rows.map(rowOf).sort((a, b) => a.name.localeCompare(b.name)), 200);
  },
);

const ConsoleSchoolDetailSchema = ConsoleSchoolSchema.extend({
  state: z.string().nullable(),
  phone: z.string().nullable(),
  levelsOffered: z.array(z.string()),
  admins: z.number().int().openapi({ description: "The owner and admins" }),
  teachers: z.number().int(),
  parents: z.number().int(),
  subjects: z.number().int(),
  setup: z.array(z.object({ label: z.string(), done: z.boolean() })),
  statusNote: z
    .object({ status: z.enum(["active", "suspended"]), reason: z.string(), by: z.string(), at: z.number().int() })
    .nullable()
    .openapi({ description: "Why it was last paused or reactivated, by whom" }),
}).openapi("ConsoleSchoolDetail");

const actorName = (team: TeamMember) => `${team.fullName} (Brillianda)`;

teamRoutes.openapi(
  createRoute({
    method: "get",
    path: "/v1/team/schools/{subdomain}",
    tags: ["team"],
    summary: "One school's summary. Opening it writes a line to that school's change history (at most once an hour per team member)",
    request: { params: z.object({ subdomain: z.string().min(1).max(63) }) },
    responses: { 200: ok("Summary", ConsoleSchoolDetailSchema), ...errors },
  }),
  async (c) => {
    const team = await requireTeam(c);
    const { subdomain } = c.req.valid("param");
    const { db } = c.get("deps");
    const r = await schoolBySubdomain(c, subdomain);

    // Show the school that the team looked, once an hour per person.
    await withSchool(db, r.schoolId, async (tx) => {
      const [recent] = await tx
        .select({ id: auditLog.id })
        .from(auditLog)
        .where(
          and(
            eq(auditLog.action, "team.viewed"),
            sql`${auditLog.changes}->>'teamMemberId' = ${team.id}`,
            gte(auditLog.createdAt, new Date(Date.now() - VIEW_LOG_EVERY_MS)),
          ),
        )
        .limit(1);
      if (!recent) {
        await tx.insert(auditLog).values({
          schoolId: r.schoolId,
          actorName: actorName(team),
          action: "team.viewed",
          entity: "school",
          entityId: r.schoolId,
          changes: { teamMemberId: team.id },
          summary: "Viewed the school’s summary from the Brillianda team console",
          ip: c.get("clientIp"),
          userAgent: c.get("userAgent"),
        });
      }
    });

    const [note] = await db
      .select({ action: teamLog.action, reason: teamLog.reason, by: teamLog.teamMemberName, at: teamLog.createdAt })
      .from(teamLog)
      .where(and(eq(teamLog.aboutSchoolId, r.schoolId), inArray(teamLog.action, ["school.paused", "school.reactivated"]), isNotNull(teamLog.reason)))
      .orderBy(desc(teamLog.createdAt))
      .limit(1);
    return c.json(
      {
        ...rowOf(r),
        state: r.state,
        phone: r.phone,
        levelsOffered: r.levelsOffered,
        admins: r.admins,
        teachers: r.teachers,
        parents: r.parents,
        subjects: r.subjects,
        setup: setupOf(r),
        statusNote: note
          ? { status: note.action === "school.paused" ? ("suspended" as const) : ("active" as const), reason: note.reason!, by: note.by, at: note.at.getTime() }
          : null,
      },
      200,
    );
  },
);

const Reason = z.string().trim().min(3, "Give a reason of at least 3 characters").max(200, "Use at most 200 characters");

teamRoutes.openapi(
  createRoute({
    method: "put",
    path: "/v1/team/schools/{subdomain}/status",
    tags: ["team"],
    summary: "Pause a school (its people can't sign in; nothing is deleted) or reactivate it. The reason shows in its history",
    request: {
      params: z.object({ subdomain: z.string().min(1).max(63) }),
      body: json(z.object({ status: z.enum(["active", "suspended"], { message: "Choose active or suspended" }), reason: Reason }).openapi("SchoolStatusChange")),
    },
    responses: { 204: { description: "Changed" }, 409: problemContent("Already in that state, or archived"), 422: problemContent("Reason needed"), ...errors },
  }),
  async (c) => {
    const team = await requireTeam(c);
    const { subdomain } = c.req.valid("param");
    const { status, reason } = c.req.valid("json");
    const { db, schools: directory } = c.get("deps");
    const r = await schoolBySubdomain(c, subdomain);
    if (r.status === "archived") throw new ApiError("conflict", "That school is archived.");
    if (r.status === status) throw new ApiError("conflict", status === "suspended" ? "It’s already paused." : "It’s already active.");

    const paused = status === "suspended";
    await db.transaction(async (tx) => {
      await tx.update(schools).set({ status, updatedAt: new Date() }).where(eq(schools.id, r.schoolId));
      await tx.insert(teamLog).values({
        teamMemberId: team.id,
        teamMemberName: team.fullName,
        action: paused ? "school.paused" : "school.reactivated",
        summary: `${paused ? "Paused" : "Reactivated"} ${r.name}: ${reason}`,
        aboutSchoolId: r.schoolId,
        reason,
      });
    });
    await withSchool(db, r.schoolId, (tx) =>
      tx.insert(auditLog).values({
        schoolId: r.schoolId,
        actorName: actorName(team),
        action: paused ? "school.paused" : "school.reactivated",
        entity: "school",
        entityId: r.schoolId,
        changes: { teamMemberId: team.id, reason },
        summary: `${paused ? "Paused" : "Reactivated"} the school’s account: ${reason}`,
      }),
    );
    // This instance stops serving it at once; others within the directory's minute-long cache.
    directory.invalidate(r.subdomain);
    return c.body(null, 204);
  },
);

// ——— Trial requests ———

const TRIAL = z.enum(["new", "contacted", "converted", "declined"]);
const TrialRequestRowSchema = z
  .object({
    id: z.string().uuid(),
    at: z.number().int(),
    schoolName: z.string(),
    contactName: z.string(),
    role: z.string(),
    email: z.string(),
    phone: z.string(),
    studentCount: z.number().int(),
    state: z.string().nullable(),
    interests: z.array(z.string()),
    message: z.string().nullable(),
    status: TRIAL,
    note: z.string().nullable(),
  })
  .openapi("TrialRequestRow");

teamRoutes.openapi(
  createRoute({
    method: "get",
    path: "/v1/team/trial-requests",
    tags: ["team"],
    summary: "Trial requests from the website, newest first",
    responses: { 200: ok("Requests", z.array(TrialRequestRowSchema)), ...errors },
  }),
  async (c) => {
    await requireTeam(c);
    const rows = await c.get("deps").db.select().from(trialRequests).orderBy(desc(trialRequests.createdAt)).limit(1000);
    return c.json(
      rows.map((t) => ({
        id: t.id,
        at: t.createdAt.getTime(),
        schoolName: t.schoolName,
        contactName: t.contactName,
        role: t.role,
        email: t.email,
        phone: t.phone,
        studentCount: t.studentCount,
        state: t.state,
        interests: t.interests,
        message: t.message,
        status: t.status,
        note: t.teamNote,
      })),
      200,
    );
  },
);

teamRoutes.openapi(
  createRoute({
    method: "patch",
    path: "/v1/team/trial-requests/{id}",
    tags: ["team"],
    summary: "Set a trial request's status and the team's note (empty clears it)",
    request: {
      params: z.object({ id: z.string().uuid("Invalid id") }),
      body: json(z.object({ status: TRIAL, note: z.string().trim().max(500, "Use at most 500 characters").default("") }).openapi("TrialRequestUpdate")),
    },
    responses: { 204: { description: "Saved" }, ...errors },
  }),
  async (c) => {
    const team = await requireTeam(c);
    const { id } = c.req.valid("param");
    const { status, note } = c.req.valid("json");
    const { db } = c.get("deps");
    await db.transaction(async (tx) => {
      const [t] = await tx.update(trialRequests).set({ status, teamNote: note || null, updatedAt: new Date() }).where(eq(trialRequests.id, id)).returning({ schoolName: trialRequests.schoolName });
      if (!t) throw new ApiError("not_found", "That request isn’t here any more.");
      await tx.insert(teamLog).values({
        teamMemberId: team.id,
        teamMemberName: team.fullName,
        action: "trial.updated",
        summary: `Marked ${t.schoolName}’s trial request ${status}${note ? `: ${note}` : ""}`,
      });
    });
    return c.body(null, 204);
  },
);
