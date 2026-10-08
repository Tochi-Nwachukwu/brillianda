// Vercel entry. Vercel's zero-config Hono detection needs a file that imports "hono" and
// default-exports the app. The app itself is the tsup bundle (dist/vercel.js), built by
// `pnpm build`, so Vercel never compiles our TypeScript; CI typechecks it instead.
import { Hono } from "hono";
import server from "./dist/vercel.js";

export default new Hono().route("/", server);
