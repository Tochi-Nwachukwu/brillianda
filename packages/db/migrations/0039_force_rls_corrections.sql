ALTER TABLE correction_requests FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE TRUNCATE ON correction_requests FROM brillianda_app;
