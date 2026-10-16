/**
 * pnpm --filter @brillianda/api bench
 * Server-side latency of the request pipeline against real Postgres (no network in the way):
 * middleware + school lookup + RLS transaction + session check + JSON. Uses a throwaway database.
 */
import { AuthSecret, createSession } from "@brillianda/auth";
import { schoolMembers, schools, users, withSchool } from "@brillianda/db";
import { createTestDatabase } from "@brillianda/db/testing";
import { randomBytes } from "node:crypto";
import { createApp } from "../src/app.js";
import { silentLogger } from "../src/lib/logger.js";
import { SchoolDirectory } from "../src/lib/school-directory.js";

const N = Number(process.env.BENCH_N ?? 3000);
const CONCURRENCY = Number(process.env.BENCH_CONCURRENCY ?? 10);

const t = await createTestDatabase();
try {
  const secret = AuthSecret.fromBase64(randomBytes(32).toString("base64"));
  const [user] = await t.db.insert(users).values({ email: "bench@surebloom.test", fullName: "Bench" }).returning();
  const [school] = await t.db.insert(schools).values({ name: "Surebloom", subdomain: "surebloom", ownerUserId: user!.id }).returning();
  await withSchool(t.db, school!.id, (tx) => tx.insert(schoolMembers).values({ schoolId: school!.id, userId: user!.id, role: "owner" }));
  const { token } = await withSchool(t.db, school!.id, (tx) => createSession(tx, secret, { schoolId: school!.id, userId: user!.id }));

  const app = createApp({
    db: t.db,
    secret,
    rateLimiter: { limit: async () => ({ success: true, remaining: 999, resetAt: Date.now() + 60_000 }) },
    schools: new SchoolDirectory(t.db),
    logger: silentLogger,
    mailer: { send: async () => {} },
    botCheck: { verify: async () => true },
    config: { rootDomain: "brillianda.test", protocol: "https", proxySecret: "x".repeat(16), allowSchoolQueryParam: false, secureCookies: false },
  });

  const host = "surebloom.brillianda.test";
  const cases: [string, string, Record<string, string>][] = [
    ["GET /health (no database)", "/health", {}],
    ["GET /v1/school (cached school lookup)", "/v1/school", { host }],
    ["GET /v1/me (RLS transaction + session)", "/v1/me", { host, cookie: `bd_session=${token}` }],
  ];

  console.log(`${N} requests each, ${CONCURRENCY} in flight\n`);
  console.log("endpoint".padEnd(42), "p50 ms".padStart(7), "p95 ms".padStart(7), "p99 ms".padStart(7), "req/s".padStart(8), " bytes");
  for (const [label, path, headers] of cases) {
    for (let i = 0; i < 200; i++) await app.request(path, { headers }); // warm up
    const times: number[] = [];
    let bytes = 0;
    let i = 0;
    const started = performance.now();
    await Promise.all(
      Array.from({ length: CONCURRENCY }, async () => {
        while (i++ < N) {
          const s = performance.now();
          const res = await app.request(path, { headers });
          const body = await res.arrayBuffer();
          times.push(performance.now() - s);
          bytes = body.byteLength;
          if (res.status !== 200) throw new Error(`${path} returned ${res.status}`);
        }
      }),
    );
    const elapsed = (performance.now() - started) / 1000;
    times.sort((a, b) => a - b);
    const pct = (p: number) => times[Math.min(times.length - 1, Math.floor((p / 100) * times.length))]!.toFixed(2);
    console.log(label.padEnd(42), pct(50).padStart(7), pct(95).padStart(7), pct(99).padStart(7), Math.round(N / elapsed).toString().padStart(8), ` ${bytes}`);
  }
} finally {
  await t.close();
}
