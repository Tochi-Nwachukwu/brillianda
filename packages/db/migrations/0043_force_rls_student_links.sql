ALTER TABLE student_links FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE TRUNCATE ON student_links FROM brillianda_app;
