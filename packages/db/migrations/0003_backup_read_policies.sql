CREATE POLICY "backup_read" ON "audit_log" AS PERMISSIVE FOR SELECT TO public USING (current_user = 'brillianda_backup');--> statement-breakpoint
CREATE POLICY "backup_read" ON "school_members" AS PERMISSIVE FOR SELECT TO public USING (current_user = 'brillianda_backup');--> statement-breakpoint
CREATE POLICY "backup_read" ON "sessions" AS PERMISSIVE FOR SELECT TO public USING (current_user = 'brillianda_backup');--> statement-breakpoint
-- The nightly backup connects as brillianda_backup (created by scripts/bootstrap.ts) and runs
-- pg_dump --enable-row-security. It may READ everything, change nothing.
GRANT USAGE ON SCHEMA public TO brillianda_backup;--> statement-breakpoint
GRANT SELECT ON ALL TABLES IN SCHEMA public TO brillianda_backup;--> statement-breakpoint
GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO brillianda_backup;--> statement-breakpoint
ALTER DEFAULT PRIVILEGES FOR ROLE brillianda_owner IN SCHEMA public GRANT SELECT ON TABLES TO brillianda_backup;--> statement-breakpoint
ALTER DEFAULT PRIVILEGES FOR ROLE brillianda_owner IN SCHEMA public GRANT SELECT ON SEQUENCES TO brillianda_backup;--> statement-breakpoint
-- The migrations ledger, so a restore knows exactly which migrations it contains.
GRANT USAGE ON SCHEMA drizzle TO brillianda_backup;--> statement-breakpoint
GRANT SELECT ON ALL TABLES IN SCHEMA drizzle TO brillianda_backup;--> statement-breakpoint
GRANT SELECT ON ALL SEQUENCES IN SCHEMA drizzle TO brillianda_backup;
