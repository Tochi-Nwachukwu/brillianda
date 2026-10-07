import { uuidv7 } from "uuidv7";
import type { Database } from "../src/client.js";
import { auditLog, invitations, schoolMembers, schools, sessions, users } from "../src/schema/index.js";
import { withSchool } from "../src/with-school.js";

export interface SeededSchool {
  schoolId: string;
  ownerId: string;
  sessionId: string;
}

/** Creates a school with one row in EVERY school table, so isolation checks have something to leak. */
export async function seedSchool(db: Database, subdomain: string): Promise<SeededSchool> {
  const ownerId = uuidv7();
  const schoolId = uuidv7();
  const sessionId = uuidv7();
  const now = new Date();
  const later = new Date(now.getTime() + 86_400_000);

  await db.insert(users).values({ id: ownerId, email: `owner@${subdomain}.test`, fullName: `Owner ${subdomain}` });
  await db.insert(schools).values({ id: schoolId, name: `School ${subdomain}`, subdomain, ownerUserId: ownerId });

  await withSchool(db, schoolId, async (tx) => {
    await tx.insert(schoolMembers).values({ schoolId, userId: ownerId, role: "owner" });
    await tx.insert(sessions).values({
      id: sessionId,
      schoolId,
      userId: ownerId,
      tokenHash: `hash-${subdomain}-${sessionId}`,
      expiresAt: later,
      absoluteExpiresAt: later,
    });
    await tx.insert(auditLog).values({ schoolId, actorUserId: ownerId, action: "school.created", entity: "school", entityId: schoolId });
    await tx.insert(invitations).values({
      schoolId,
      email: `admin@${subdomain}.test`,
      role: "admin",
      tokenHash: `invite-${subdomain}-${sessionId}`,
      invitedBy: ownerId,
      expiresAt: later,
    });
  });

  return { schoolId, ownerId, sessionId };
}

/** Drizzle wraps driver errors ("Failed query: ..."); match against the Postgres message underneath. */
export async function pgError(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    const e = err as { message?: string; cause?: { message?: string; constraint?: string } };
    return [e.message, e.cause?.message, e.cause?.constraint].filter(Boolean).join(" | ");
  }
  throw new Error("Expected the query to fail, but it succeeded");
}
