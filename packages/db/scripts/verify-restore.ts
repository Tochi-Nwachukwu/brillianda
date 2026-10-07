/**
 * pnpm db:verify-restore <database-url>
 * Run against a freshly restored database (restore drill, or before switching to a restore).
 * Exits 1 if anything is missing or isolation did not survive.
 */
import { verifyRestoredDatabase } from "../src/verify-restore.js";

const url = process.argv[2] ?? process.env.RESTORE_DATABASE_URL;
if (!url) {
  console.error("Usage: pnpm db:verify-restore <admin url of the restored database>");
  process.exit(1);
}

const report = await verifyRestoredDatabase(url);
console.log(`Migrations: ${report.migrationsApplied} in backup, ${report.migrationsInCode} in code`);
console.log(`Schools: ${report.schools}`);
console.log("Rows:");
for (const [table, n] of Object.entries(report.rowCounts)) console.log(`  ${table.padEnd(24)} ${n}`);
if (!report.ok) {
  console.error(`\n✗ Restore verification failed (${report.problems.length}):`);
  for (const p of report.problems) console.error(`  - ${p}`);
  process.exit(1);
}
if (report.schools === 0) {
  console.warn("\n! The backup contains no schools. Expected only for a brand-new or test environment.");
}
console.log("\n✓ Restore verified: ledger present, isolation intact.");
