import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/server.ts"],
  format: ["esm"],
  platform: "node",
  target: "node22",
  outDir: "dist",
  clean: true,
  sourcemap: true,
  // Bundle the workspace packages (they ship TypeScript source); keep real npm deps external.
  noExternal: [/^@brillianda\//],
  external: ["@node-rs/argon2", "pg"],
});
