/**
 * Adds two teachers to an existing test school (C1) on whatever database DATABASE_URL points at.
 *
 *   set -a; source .env.vercel; set +a
 *   pnpm --filter @brillianda/api seed:test-teachers -- fecheck form@example.com subject@example.com
 *
 * Prints the two passwords once. Send them privately; they are not stored anywhere else.
 */
import { closeDatabase } from "@brillianda/db";
import { buildDeps } from "../src/deps.js";
import { loadEnv } from "../src/env.js";
import { createLogger } from "../src/lib/logger.js";
import { seedTestTeachers } from "../src/seed-school.js";

const [subdomain = "fecheck", formEmail = `form@${subdomain}.test`, subjectEmail = `subject@${subdomain}.test`] = process.argv.slice(2).filter((a) => a !== "--");
const env = loadEnv({ ROOT_DOMAIN: "seed.invalid", ...process.env, MAIL_OUTBOX_KEY: "" });
if (env.APP_ENV === "production") {
  console.error("Refusing to add test teachers on production.");
  process.exit(1);
}
const deps = buildDeps(env, createLogger("warn"));
try {
  const r = await seedTestTeachers(deps, { subdomain, formTeacherEmail: formEmail.toLowerCase(), subjectTeacherEmail: subjectEmail.toLowerCase() });
  console.log(`\nAdded two teachers to "${subdomain}".\n`);
  console.log(`  Form teacher     ${r.formTeacher.email}   password: ${r.formTeacher.password}`);
  console.log(`                   form class ${r.formTeacher.formClass}; teaches ${r.formTeacher.subjects.join("; ")}`);
  console.log(`  Subject teacher  ${r.subjectTeacher.email}   password: ${r.subjectTeacher.password}`);
  console.log(`                   teaches ${r.subjectTeacher.subjects.join("; ")}\n`);
  console.log("These passwords are shown only now. Send them privately, not in a group chat or a repo.\n");
} catch (err) {
  const cause = (err as { cause?: Error }).cause;
  console.error(`\n${(err as Error).message}${cause ? `\n${cause.message}` : ""}\n`);
  process.exitCode = 1;
} finally {
  await closeDatabase(deps.db);
}
