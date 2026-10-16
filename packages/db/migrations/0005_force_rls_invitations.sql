-- invitations is a school table: force RLS so even its owner is subject to the policies.
ALTER TABLE invitations FORCE ROW LEVEL SECURITY;--> statement-breakpoint
-- Invitations are revoked, never deleted (the audit trail points at them).
REVOKE DELETE, TRUNCATE ON invitations FROM brillianda_app;--> statement-breakpoint
REVOKE TRUNCATE ON signup_drafts FROM brillianda_app;
