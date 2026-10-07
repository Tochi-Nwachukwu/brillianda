import { defineConfig } from "drizzle-kit";

// drizzle-kit only GENERATES migrations here. They are applied by scripts/migrate.ts,
// connected as the owner role. Roles are created by scripts/bootstrap.ts, not by drizzle-kit.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema/index.ts",
  out: "./migrations",
  casing: "snake_case",
  strict: true,
  verbose: true,
  dbCredentials: {
    url: process.env.DATABASE_OWNER_URL ?? "postgres://localhost/brillianda",
  },
});
