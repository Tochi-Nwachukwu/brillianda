/**
 * Team accounts for the console (C1). There is no sign-up: someone with database access adds
 * each member with `pnpm --filter @brillianda/api team:add -- email "Full Name"`.
 */
import { randomBytes } from "node:crypto";
import { hashPassword } from "@brillianda/auth";
import { eq, teamMembers, teamSessions, type Database } from "@brillianda/db";

export async function addTeamMember(db: Database, opts: { email: string; fullName: string }): Promise<{ email: string; password: string }> {
  const email = opts.email.trim().toLowerCase();
  const fullName = opts.fullName.trim().replace(/\s+/g, " ");
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error(`"${opts.email}" isn't an email address.`);
  if (fullName.length < 2) throw new Error("Give the team member's full name.");
  const [taken] = await db.select({ id: teamMembers.id }).from(teamMembers).where(eq(teamMembers.email, email)).limit(1);
  if (taken) throw new Error(`${email} already has a team account.`);
  const password = randomBytes(15).toString("base64url");
  await db.insert(teamMembers).values({ email, fullName, passwordHash: await hashPassword(password) });
  return { email, password };
}

/** Turns a team account off and signs it out everywhere. */
export async function disableTeamMember(db: Database, email: string): Promise<boolean> {
  const [m] = await db.update(teamMembers).set({ status: "disabled", updatedAt: new Date() }).where(eq(teamMembers.email, email.trim().toLowerCase())).returning({ id: teamMembers.id });
  if (!m) return false;
  await db.delete(teamSessions).where(eq(teamSessions.teamMemberId, m.id));
  return true;
}
