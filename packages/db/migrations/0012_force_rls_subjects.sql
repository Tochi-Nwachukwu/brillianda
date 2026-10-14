-- Subject tables are school tables: force RLS so even their owner is subject to the policies.
ALTER TABLE school_subjects FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE class_level_subjects FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE TRUNCATE ON school_subjects, class_level_subjects FROM brillianda_app;
