/**
 * Test harness: a throwaway database per test file, bootstrapped and migrated exactly the
 * way production is, so the tests exercise the real roles, grants and policies.
 */
import { randomBytes } from "node:crypto";
import { bootstrapCluster, deriveUrl, dropDatabase, runMigrations } from "./admin.js";
import { closeDatabase, createDatabase, type Database } from "./client.js";
import { ROLE_APP, ROLE_BACKUP, ROLE_OWNER } from "./schema/columns.js";

export interface TestDatabase {
  /** Read-only brillianda_backup connection URL, for backup tests. */
  backupUrl: string;
  /** Connected as brillianda_app: what the API uses. RLS applies. */
  db: Database;
  appUrl: string;
  ownerUrl: string;
  dbName: string;
  close(): Promise<void>;
}

export async function createTestDatabase(options: { migrate?: boolean } = {}): Promise<TestDatabase> {
  const adminUrl = process.env.TEST_DATABASE_ADMIN_URL;
  if (!adminUrl) {
    throw new Error("TEST_DATABASE_ADMIN_URL is not set. Start Postgres (docker compose up -d) and copy .env.example to .env.");
  }
  const ownerPassword = process.env.DB_OWNER_PASSWORD ?? "owner_dev_password";
  const appPassword = process.env.DB_APP_PASSWORD ?? "app_dev_password";
  const dbName = `brillianda_test_${randomBytes(6).toString("hex")}`;

  const backupPassword = process.env.DB_BACKUP_PASSWORD ?? "backup_dev_password";
  await bootstrapCluster({ adminUrl, dbName, ownerPassword, appPassword, backupPassword });
  const ownerUrl = deriveUrl(adminUrl, ROLE_OWNER, ownerPassword, dbName);
  const appUrl = deriveUrl(adminUrl, ROLE_APP, appPassword, dbName);
  const backupUrl = deriveUrl(adminUrl, ROLE_BACKUP, backupPassword, dbName);
  if (options.migrate !== false) await runMigrations(ownerUrl);

  const db = createDatabase(appUrl, { max: 5, applicationName: "brillianda-test" });
  return {
    db,
    appUrl,
    ownerUrl,
    backupUrl,
    dbName,
    async close() {
      await closeDatabase(db);
      await dropDatabase(adminUrl, dbName);
    },
  };
}
