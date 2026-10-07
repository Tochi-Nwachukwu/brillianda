import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Each file gets its own throwaway database; run files in parallel, tests within a file serially.
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
