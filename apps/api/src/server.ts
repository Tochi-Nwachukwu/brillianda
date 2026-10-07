import { closeDatabase } from "@brillianda/db";
import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { buildDeps } from "./deps.js";
import { loadEnv } from "./env.js";

const env = loadEnv();
const deps = buildDeps(env);
const app = createApp(deps);

const server = serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  deps.logger.info("api listening", { port: info.port, rootDomain: env.ROOT_DOMAIN });
});

// Drain in-flight requests, then close the pool, so deploys never cut a transaction in half.
let shuttingDown = false;
const shutdown = (signal: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  deps.logger.info("shutting down", { signal });
  server.close(async () => {
    await closeDatabase(deps.db);
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
};
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
