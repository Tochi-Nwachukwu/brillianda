import { existsSync } from "node:fs";
import { defineConfig } from "vitest/config";

// Load the repo-root .env for local runs. Variables already set (CI) win; loadEnvFile never overrides.
const envFile = new URL("../../.env", import.meta.url);
if (existsSync(envFile)) process.loadEnvFile(envFile);

export default defineConfig({
  test: {
    // Each file gets its own throwaway database; run files in parallel, tests within a file serially.
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
