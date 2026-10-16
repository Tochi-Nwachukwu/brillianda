/** Bundled by tsup into dist/vercel.js; ../index.js hands it to Vercel. */
import { buildDeps } from "./deps.js";
import { createServer } from "./entry.js";
import { loadEnv } from "./env.js";

export default createServer(buildDeps(loadEnv()));
