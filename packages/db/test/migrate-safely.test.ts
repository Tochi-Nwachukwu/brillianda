import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MIGRATIONS_FOLDER } from "../src/admin.js";
import { isLocalDatabase, migrateSafely, readJournal } from "../src/migrate-safely.js";
import { createTestDatabase, type TestDatabase } from "../src/testing.js";

const open: TestDatabase[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  while (open.length) await open.pop()!.close();
});

async function freshDb() {
  const t = await createTestDatabase({ migrate: false });
  open.push(t);
  return t;
}

const quiet = () => {};
const total = readJournal().length;

async function appliedCount(ownerUrl: string): Promise<number> {
  const c = new pg.Client({ connectionString: ownerUrl });
  await c.connect();
  try {
    const t = await c.query(`select to_regclass('drizzle.__drizzle_migrations') as t`);
    if (!t.rows[0].t) return 0;
    return (await c.query(`select count(*)::int as n from drizzle.__drizzle_migrations`)).rows[0].n;
  } finally {
    await c.end();
  }
}

/** A copy of the real migrations plus one extra, written the way drizzle-kit would. */
function folderWithExtra(tag: string, sql: string): string {
  const dir = mkdtempSync(join(tmpdir(), "bd-migrations-"));
  cpSync(MIGRATIONS_FOLDER, dir, { recursive: true });
  const journalPath = join(dir, "meta/_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8"));
  const last = journal.entries.at(-1);
  journal.entries.push({ ...last, idx: last.idx + 1, when: last.when + 1000, tag });
  writeFileSync(journalPath, JSON.stringify(journal));
  writeFileSync(join(dir, `${tag}.sql`), sql);
  return dir;
}

describe("isLocalDatabase", () => {
  it("treats only loopback hosts as local", () => {
    expect(isLocalDatabase("postgres://u:p@localhost:5433/db")).toBe(true);
    expect(isLocalDatabase("postgres://u:p@127.0.0.1/db")).toBe(true);
    expect(isLocalDatabase("postgresql://u:p@ep-small-mud.eu-west-2.aws.neon.tech/db")).toBe(false);
  });
});

describe("migrateSafely", () => {
  it("--plan lists pending migrations and changes nothing", async () => {
    const t = await freshDb();
    const lines: string[] = [];
    await migrateSafely({ ownerUrl: t.ownerUrl, planOnly: true, log: (l) => lines.push(l) });
    expect(lines.join("\n")).toContain(`Pending (${total})`);
    expect(await appliedCount(t.ownerUrl)).toBe(0);
  });

  it("applies everything locally, then reports up to date", async () => {
    const t = await freshDb();
    const first = await migrateSafely({ ownerUrl: t.ownerUrl, log: quiet });
    expect(first.applied).toHaveLength(total);
    expect(await appliedCount(t.ownerUrl)).toBe(total);
    const second = await migrateSafely({ ownerUrl: t.ownerUrl, log: quiet });
    expect(second.applied).toEqual([]);
  });

  it("refuses a remote database without a snapshot, and applies nothing", async () => {
    const t = await freshDb();
    await expect(migrateSafely({ ownerUrl: t.ownerUrl, location: "remote", log: quiet })).rejects.toThrow(/without a snapshot/);
    expect(await appliedCount(t.ownerUrl)).toBe(0);
  });

  it("allows a remote database without a snapshot only with a stated reason", async () => {
    const t = await freshDb();
    const lines: string[] = [];
    await migrateSafely({ ownerUrl: t.ownerUrl, location: "remote", skipSnapshotReason: "throwaway preview", log: (l) => lines.push(l) });
    expect(lines.join("\n")).toContain("WITHOUT a snapshot. Reason given: throwaway preview");
    expect(await appliedCount(t.ownerUrl)).toBe(total);
  });

  it("takes the Neon snapshot BEFORE applying anything", async () => {
    const t = await freshDb();
    const calls: { method: string; url: string; body?: unknown; appliedAtCall: number }[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      calls.push({
        method: init?.method ?? "GET",
        url,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
        appliedAtCall: await appliedCount(t.ownerUrl),
      });
      if (!init?.method) return Response.json({ branches: [{ id: "br-main", default: true }, { id: "br-other" }] });
      if (init.method === "POST") return Response.json({ branch: { id: "br-snap" } });
      return Response.json({ branch: { id: "br-snap" } });
    });

    const result = await migrateSafely({
      ownerUrl: t.ownerUrl,
      location: "remote",
      snapshot: { apiKey: "k", projectId: "proj-1", keepDays: 14 },
      log: quiet,
    });

    expect(calls.map((c) => `${c.method} ${c.url.replace("https://console.neon.tech/api/v2", "")}`)).toEqual([
      "GET /projects/proj-1/branches",
      "POST /projects/proj-1/branches",
      "PATCH /projects/proj-1/branches/br-snap",
    ]);
    expect(calls[1]!.body).toMatchObject({ branch: { parent_id: "br-main", name: expect.stringMatching(/^pre-migrate-/) } });
    expect(calls.every((c) => c.appliedAtCall === 0)).toBe(true);
    expect(result.snapshot).toMatch(/^pre-migrate-/);
    expect(await appliedCount(t.ownerUrl)).toBe(total);
  });

  it("applies nothing when the snapshot fails", async () => {
    const t = await freshDb();
    vi.stubGlobal("fetch", async () => new Response("quota exceeded", { status: 402 }));
    await expect(
      migrateSafely({ ownerUrl: t.ownerUrl, location: "remote", snapshot: { apiKey: "k", projectId: "p", branchId: "br-x", keepDays: 1 }, log: quiet }),
    ).rejects.toThrow(/402/);
    expect(await appliedCount(t.ownerUrl)).toBe(0);
  });

  it("refuses a pending migration with unmarked destructive SQL, even locally", async () => {
    const t = await freshDb();
    const dir = folderWithExtra("0099_drop_things", `DROP TABLE "audit_log";`);
    await expect(migrateSafely({ ownerUrl: t.ownerUrl, migrationsFolder: dir, log: quiet })).rejects.toThrow(/drop-table/);
    expect(await appliedCount(t.ownerUrl)).toBe(0);
  });

  it("runs one migrator at a time", async () => {
    const t = await freshDb();
    const results = await Promise.all([
      migrateSafely({ ownerUrl: t.ownerUrl, log: quiet }),
      migrateSafely({ ownerUrl: t.ownerUrl, log: quiet }),
    ]);
    expect(results.map((r) => r.applied.length).sort()).toEqual([0, total]);
    expect(await appliedCount(t.ownerUrl)).toBe(total);
  });
});
