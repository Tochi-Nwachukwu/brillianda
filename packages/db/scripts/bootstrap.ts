/**
 * One-time (idempotent) cluster setup: roles + database.
 *   pnpm db:bootstrap
 * In production run it once with the provider's admin role, then rotate the passwords
 * it set and store them in the secret manager.
 */
import { bootstrapCluster } from "../src/admin.js";
import { requireEnv } from "./env.js";

await bootstrapCluster({
  adminUrl: requireEnv("DATABASE_ADMIN_URL"),
  dbName: process.env.DB_NAME ?? "brillianda",
  ownerPassword: requireEnv("DB_OWNER_PASSWORD"),
  appPassword: requireEnv("DB_APP_PASSWORD"),
});
console.log("Roles and database ready.");
