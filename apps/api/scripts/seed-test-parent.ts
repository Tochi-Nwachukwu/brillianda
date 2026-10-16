/**
 * Adds a parent account to an existing test school (C2): the guardian of the Okafor siblings.
 *
 *   set -a; source .env.vercel; set +a
 *   pnpm --filter @brillianda/api seed:test-parent -- fecheck parent@example.com
 *
 * Prints the password once. Send it privately; it is not stored anywhere else.
 */
import { closeDatabase } from "@brillianda/db";
import { buildDeps } from "../src/deps.js";
import { loadEnv } from "../src/env.js";
import { createLogger } from "../src/lib/logger.js";
import { seedTestParent } from "../src/seed-school.js";

const [subdomain = "fecheck", email = `parent@${subdomain}.test`] = process.argv.slice(2).filter((a) => a !== "--");
const env = loadEnv({ ROOT_DOMAIN: "seed.invalid", ...process.env, MAIL_OUTBOX_KEY: "" });
if (env.APP_ENV === "production") {
  console.error("Refusing to add a test parent on production.");
  process.exit(1);
}
const deps = buildDeps(env, createLogger("warn"));
try {
  const r = await seedTestParent(deps, { subdomain, email: email.toLowerCase() });
  console.log(`\nAdded a parent to "${subdomain}".\n`);
  console.log(`  Parent  ${r.email}   password: ${r.password}`);
  console.log(`          ${r.guardian}, guardian of ${r.children.join(" and ")}\n`);
  console.log("This password is shown only now. Send it privately, not in a group chat or a repo.\n");
} catch (err) {
  const cause = (err as { cause?: Error }).cause;
  console.error(`\n${(err as Error).message}${cause ? `\n${cause.message}` : ""}\n`);
  process.exitCode = 1;
} finally {
  await closeDatabase(deps.db);
}
