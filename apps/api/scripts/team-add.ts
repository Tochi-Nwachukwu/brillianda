/**
 * Adds a Brillianda team member (the console at /console) on whatever database DATABASE_URL
 * points at. Works on production too: this is how the real team gets its accounts.
 *
 *   set -a; source .env.vercel; set +a
 *   pnpm --filter @brillianda/api team:add -- ada@brillianda.com "Ada Okoro"
 *   pnpm --filter @brillianda/api team:add -- --disable ada@brillianda.com
 *
 * Prints the password once. Send it privately; it is not stored anywhere else.
 */
import { closeDatabase } from "@brillianda/db";
import { buildDeps } from "../src/deps.js";
import { loadEnv } from "../src/env.js";
import { createLogger } from "../src/lib/logger.js";
import { addTeamMember, disableTeamMember } from "../src/team-admin.js";

const args = process.argv.slice(2).filter((a) => a !== "--");
const env = loadEnv({ ROOT_DOMAIN: "seed.invalid", ...process.env, MAIL_OUTBOX_KEY: "" });
const deps = buildDeps(env, createLogger("warn"));
try {
  if (args[0] === "--disable") {
    const done = await disableTeamMember(deps.db, args[1] ?? "");
    console.log(done ? `\nDisabled ${args[1]} and signed them out.\n` : `\nNo team account for ${args[1]}.\n`);
  } else {
    const [email = "", ...name] = args;
    const r = await addTeamMember(deps.db, { email, fullName: name.join(" ") });
    console.log(`\nAdded ${r.email} to the team console.\n`);
    console.log(`  Password: ${r.password}\n`);
    console.log("This password is shown only now. Send it privately, not in a group chat or a repo.\n");
  }
} catch (err) {
  console.error(`\n${(err as Error).message}\n`);
  process.exitCode = 1;
} finally {
  await closeDatabase(deps.db);
}
