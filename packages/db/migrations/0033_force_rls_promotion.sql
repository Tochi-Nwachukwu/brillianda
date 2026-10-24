ALTER TABLE promotion_decisions FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE TRUNCATE ON promotion_decisions FROM brillianda_app;
