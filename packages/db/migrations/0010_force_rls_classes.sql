-- Class tables are school tables: force RLS so even their owner is subject to the policies.
ALTER TABLE class_levels FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE arms FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE class_arms FORCE ROW LEVEL SECURITY;--> statement-breakpoint
-- Removed one at a time (only while no student sits in them); never wiped wholesale.
REVOKE TRUNCATE ON class_levels, arms, class_arms FROM brillianda_app;
