ALTER TABLE bank_questions FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ai_usage FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE TRUNCATE ON bank_questions, ai_usage FROM brillianda_app;--> statement-breakpoint
-- The usage log is the bill: rows are added, never changed or removed.
REVOKE UPDATE, DELETE ON ai_usage FROM brillianda_app;
