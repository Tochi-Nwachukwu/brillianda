/**
 * Writes the OpenAPI document to openapi.json at the repo root, for the frontend repo to
 * generate its typed client from (e.g. `npx openapi-typescript ../brillianda/openapi.json`).
 * CI fails if the committed file is out of date.
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { AuthSecret } from "@brillianda/auth";
import { createApp } from "../src/app.js";
import type { AppDeps } from "../src/context.js";
import { silentLogger } from "../src/lib/logger.js";
import { MemoryRateLimiter } from "../src/lib/rate-limit.js";

// The document does not touch the database; stub the deps it never calls.
const deps = {
  db: undefined as never,
  schools: undefined as never,
  secret: AuthSecret.fromBase64(Buffer.alloc(32, 1).toString("base64")),
  rateLimiter: new MemoryRateLimiter(),
  logger: silentLogger,
  mailer: { send: async () => {} },
  botCheck: { verify: async () => true },
  config: { rootDomain: "brillianda.com", protocol: "https", proxySecret: "x".repeat(16), allowSchoolQueryParam: false, secureCookies: true },
} satisfies AppDeps;

const res = await createApp(deps).request("/openapi.json");
const out = fileURLToPath(new URL("../../../openapi.json", import.meta.url));
writeFileSync(out, JSON.stringify(await res.json(), null, 2) + "\n");
console.log(`Wrote ${out}`);
