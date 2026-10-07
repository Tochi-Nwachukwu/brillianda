import { runMigrations } from "../src/admin.js";
import { requireEnv } from "./env.js";

await runMigrations(requireEnv("DATABASE_OWNER_URL"));
console.log("Migrations applied.");
