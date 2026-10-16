-- Calendar tables are school tables: force RLS so even their owner is subject to the policies.
ALTER TABLE academic_sessions FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE terms FORCE ROW LEVEL SECURITY;--> statement-breakpoint
-- Rows are deleted one at a time (going from three terms to two); never wiped wholesale.
REVOKE TRUNCATE ON academic_sessions, terms FROM brillianda_app;
