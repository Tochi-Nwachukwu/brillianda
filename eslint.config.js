// @ts-check
import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/node_modules/**", "**/.turbo/**", "packages/db/migrations/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node } },
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "@typescript-eslint/consistent-type-imports": "error",
    },
  },
  {
    // Tenancy rule: only packages/db talks to Postgres directly. Everything else
    // goes through withSchool() or the narrow helpers packages/db exports.
    files: ["apps/**/*.ts", "packages/core/**/*.ts", "packages/auth/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            { name: "pg", message: "Only packages/db may import the Postgres driver." },
            { name: "postgres", message: "Only packages/db may import a Postgres driver." },
          ],
          patterns: [
            {
              group: ["drizzle-orm/node-postgres", "drizzle-orm/node-postgres/*", "drizzle-orm/pg-core"],
              message: "Only packages/db may build clients or schema. Import from @brillianda/db instead.",
            },
            {
              group: ["@brillianda/db/src/*"],
              message: "Import from the @brillianda/db entry point.",
            },
          ],
        },
      ],
    },
  },
);
