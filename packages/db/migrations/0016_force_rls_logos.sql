ALTER TABLE school_logos FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE TRUNCATE ON school_logos FROM brillianda_app;--> statement-breakpoint
-- Trial requests are only ever added from the site and updated by the team, never removed.
REVOKE DELETE, TRUNCATE ON trial_requests FROM brillianda_app;
