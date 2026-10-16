/**
 * pnpm db:migrate            apply pending migrations (snapshot first on any remote database)
 * pnpm db:migrate -- --plan  show what would run, change nothing
 * pnpm db:migrate -- --no-snapshot="throwaway preview db"   remote without snapshot (logged)
 */
import { migrateSafely } from "../src/migrate-safely.js";
import { requireEnv } from "./env.js";

const args = process.argv.slice(2);
const planOnly = args.includes("--plan");
const skipArg = args.find((a) => a.startsWith("--no-snapshot"));
const skipSnapshotReason = skipArg ? skipArg.split("=").slice(1).join("=").trim() : undefined;
if (skipArg && !skipSnapshotReason) {
  console.error('--no-snapshot needs a reason: --no-snapshot="why this database does not need one"');
  process.exit(1);
}

const apiKey = process.env.NEON_API_KEY;
const projectId = process.env.NEON_PROJECT_ID;

try {
  await migrateSafely({
    ownerUrl: requireEnv("DATABASE_OWNER_URL"),
    planOnly,
    ...(skipSnapshotReason ? { skipSnapshotReason } : {}),
    ...(apiKey && projectId
      ? {
          snapshot: {
            apiKey,
            projectId,
            ...(process.env.NEON_BRANCH_ID ? { branchId: process.env.NEON_BRANCH_ID } : {}),
            keepDays: Number(process.env.SNAPSHOT_KEEP_DAYS ?? 14),
          },
        }
      : {}),
  });
} catch (err) {
  console.error(`\n✗ ${(err as Error).message}`);
  process.exit(1);
}
