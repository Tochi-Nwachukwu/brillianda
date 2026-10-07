# Safety net: migrations, backups, security

Six layers, each covering what the one before cannot. Code enforces the first four on every
change; the last two need a one-time setup (checklist at the end).

| Layer | Protects against | Recovery | Where |
|---|---|---|---|
| Migration guard | Shipping a DROP, TRUNCATE, rename, type change or RLS change by accident | Never reaches the database | `pnpm db:check`, CI, and again inside `db:migrate` |
| Append-only migrations | Editing history so environments silently drift | Never merges | CI (`BASE_REF` diff) |
| Pre-migration snapshot | A migration that runs and turns out wrong | Minutes: restore from the `pre-migrate-*` branch | `pnpm db:migrate` on any non-local database |
| Neon instant restore | A bad deploy, bad import or deleted rows, noticed within the history window | Minutes: restore to a timestamp | Neon Console → Backup & Restore |
| Nightly off-site backup | Neon outage, account loss, anything older than the history window | About an hour: restore the dump to any Postgres 17 | `.github/workflows/backup.yml` |
| Monthly restore drill | Backups that silently stopped or cannot be restored | Alerts before you need them | `.github/workflows/restore-drill.yml` |

## 1. Changing the schema safely (expand → migrate → contract)

The API keeps running during a deploy, so for a few minutes old code runs against the new
schema. Every change must work for both.

1. **Expand.** Add new things only: new tables, nullable columns or columns with defaults, new indexes.
   Ship it. Old code ignores them.
2. **Migrate data.** Backfill in small batches (`UPDATE ... WHERE id IN (... LIMIT 500)`), in its own
   reviewed migration or script. Ship the code that reads and writes the new shape.
3. **Contract.** Only after a release in which nothing uses the old shape, drop or rename it, with a
   `-- safety: allow <rule> because <reason>` line above the statement.

Rules of thumb:
- Renaming is "add new, copy, switch code, drop old" across releases, never `RENAME`.
- `SET NOT NULL` on a big table: add a `CHECK (col IS NOT NULL) NOT VALID`, `VALIDATE` it, then set NOT NULL.
- A new index on a big table: `CREATE INDEX CONCURRENTLY` in its own migration.
- A migration that has shipped is never edited. Fix forward with a new one.

What the guard flags: `drop-table`, `drop-column`, `drop-schema`, `drop-type`, `drop-function`,
`truncate`, `delete-rows`, `update-without-where`, `change-column-type`, `rename`, `set-not-null`,
`disable-rls`, `drop-policy`, `role-privilege`, `security-definer`. Each allow marker needs a
reason of at least ten characters, and reviewers should read it.

### Running migrations

```bash
pnpm db:plan                          # what would run; changes nothing
pnpm db:migrate                       # local: applies. remote: snapshots first, then applies
```

On a remote database `db:migrate` refuses to run unless `NEON_API_KEY` and `NEON_PROJECT_ID` are set
(it creates `pre-migrate-<time>-<name>`, kept 14 days), or you pass
`--no-snapshot="<reason>"` for a throwaway database. It also refuses while any pending migration
has unmarked unsafe SQL, takes a lock so two deploys never migrate at once, and gives up after 5
seconds waiting on a busy table instead of stalling every request.

## 2. Restoring

### A bad migration or deploy, noticed quickly

1. Neon Console → your project → **Branches** → open the `pre-migrate-...` branch from just before.
2. Or **Backup & Restore** → restore `production` to a timestamp before the problem.
3. Neon keeps a backup branch of the state it replaced, so a restore can itself be undone.
4. Redeploy the previous API version if the new code needs the new schema.

### Neon unavailable, or the data is older than the history window

1. Download the newest `brillianda/daily/.../*.dump.age` and its `.sha256`; check the checksum.
2. Decrypt with the private key from the password manager: `age -d -i key.txt -o brillianda.dump brillianda.dump.age`.
3. On the new server: `pnpm db:bootstrap` (creates roles and an empty database).
4. `pg_restore --exit-on-error --no-comments -d "<admin url>/brillianda" brillianda.dump`
5. `pnpm db:verify-restore "<admin url>/brillianda"` must pass.
6. `pnpm db:migrate` to bring it up to the current code, then point `DATABASE_URL` at it.

Anything written after the backup's timestamp is lost on this path; Neon's history window
is the better first choice whenever Neon is reachable.

## 3. Security checks

- **Secret scan** (gitleaks) on every push, over the full history. `.env` and `.env.*` are
  git-ignored; only `.env.example` is committed.
- **Dependency audit**: CI fails on high or critical advisories in production dependencies.
- **Dependabot** opens grouped update PRs every Monday.
- **Backup role** `brillianda_backup` can SELECT and nothing else, enforced by tests.
- **Backups are encrypted** with age before upload. CI holds only the public key; the private
  key lives in the password manager and the protected `restore-drill` environment.

## One-time setup checklist

### Neon (per environment; production gets its own project, never shared with test)
- [ ] Settings → **History window**: production at least 7 days (Launch plan) or 30 (Scale). Free is 6 hours.
- [ ] Branches → mark `production` **Protected** (paid plans) so it cannot be deleted or reset by mistake.
- [ ] Account settings → API keys → create one for CI. Note the project ID (Settings → General).
- [ ] Re-run bootstrap with `DB_BACKUP_PASSWORD` set, so `brillianda_backup` can log in.

### Backup storage (any S3-compatible bucket; Cloudflare R2 has no egress fees)
- [ ] Create a private bucket in a different provider from the database.
- [ ] Lifecycle rule: delete `brillianda/daily/` objects after 35 days.
- [ ] Create an access key limited to that bucket (write + list; no delete if the provider allows).
- [ ] `age-keygen -o brillianda-backup.key` on your laptop. The `# public key: age1...` line goes to
      GitHub; the file goes to the password manager. Without it, no backup can be read.

### GitHub (Tochi-Nwachukwu/brillianda → Settings)
- [ ] Environment `production-backup`, secrets: `BACKUP_DATABASE_URL` (brillianda_backup, direct host,
      `sslmode=verify-full`), `BACKUP_AGE_RECIPIENT`, `BACKUP_BUCKET`, `BACKUP_S3_ENDPOINT` (R2 only),
      `BACKUP_S3_REGION`, `BACKUP_S3_ACCESS_KEY_ID`, `BACKUP_S3_SECRET_ACCESS_KEY`.
- [ ] Environment `restore-drill` with **required reviewers**: the bucket secrets plus `BACKUP_AGE_SECRET_KEY`.
- [ ] Deploy secrets: `NEON_API_KEY`, `NEON_PROJECT_ID`, `DATABASE_OWNER_URL` for the migrate step.
- [ ] Branch protection on `main` and `staging`: pull request required, CI `check` and `security` must pass, no force pushes.
- [ ] Run **Nightly backup** once by hand (Actions → Run workflow), then **Restore drill**.
