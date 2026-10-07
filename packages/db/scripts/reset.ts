/** Local only: drops and recreates the database, then migrates and seeds. */
import { bootstrapCluster, dropDatabase, runMigrations } from "../src/admin.js";
import { requireEnv } from "./env.js";

if (process.env.NODE_ENV === "production") {
  console.error("Refusing to reset a database with NODE_ENV=production.");
  process.exit(1);
}

const adminUrl = requireEnv("DATABASE_ADMIN_URL");
const dbName = process.env.DB_NAME ?? "brillianda";
await dropDatabase(adminUrl, dbName);
await bootstrapCluster({
  adminUrl,
  dbName,
  ownerPassword: requireEnv("DB_OWNER_PASSWORD"),
  appPassword: requireEnv("DB_APP_PASSWORD"),
});
await runMigrations(requireEnv("DATABASE_OWNER_URL"));
console.log("Database reset and migrated.");
