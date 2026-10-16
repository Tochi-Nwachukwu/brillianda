/**
 * Creates a test school on whatever database DATABASE_URL points at (staging: Neon).
 *
 *   set -a; source .env.vercel; set +a
 *   pnpm --filter @brillianda/api seed:test-school -- fecheck owner@example.com admin@example.com
 *
 * Prints the two passwords once. Send them privately; they are not stored anywhere else.
 */
import { closeDatabase } from "@brillianda/db";
import { buildDeps } from "../src/deps.js";
import { loadEnv } from "../src/env.js";
import { createLogger } from "../src/lib/logger.js";
import { seedTestSchool } from "../src/seed-school.js";

const [subdomain = "fecheck", ownerEmail = `owner@${subdomain}.test`, adminEmail = `admin@${subdomain}.test`] = process.argv.slice(2).filter((a) => a !== "--");
const env = loadEnv({ ROOT_DOMAIN: "seed.invalid", ...process.env, MAIL_OUTBOX_KEY: "" });
if (env.APP_ENV === "production") {
  console.error("Refusing to create a test school on production.");
  process.exit(1);
}
const deps = buildDeps(env, createLogger("warn"));
try {
  const result = await seedTestSchool(deps, { subdomain, name: "FE Check School", ownerEmail: ownerEmail.toLowerCase(), adminEmail: adminEmail.toLowerCase() });
  console.log(`\nCreated "${subdomain}" with ${result.students} students.\n`);
  console.log(`  Owner  ${result.owner.email}   password: ${result.owner.password}`);
  console.log(`  Admin  ${result.admin.email}   password: ${result.admin.password}\n`);
  console.log("These passwords are shown only now. Send them privately, not in a group chat or a repo.\n");
} catch (err) {
  const cause = (err as { cause?: Error }).cause;
  console.error(`\n${(err as Error).message}${cause ? `\n${cause.message}` : ""}\n`);
  process.exitCode = 1;
} finally {
  await closeDatabase(deps.db);
}
