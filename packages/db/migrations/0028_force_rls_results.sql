ALTER TABLE results_settings FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE term_closures FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE scores FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE score_exclusions FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE sheet_completions FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE unlock_requests FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE TRUNCATE ON results_settings, term_closures, scores, score_exclusions, sheet_completions, unlock_requests FROM brillianda_app;--> statement-breakpoint
-- Closing a term and answering an unlock request are history: never removed.
REVOKE DELETE ON term_closures, unlock_requests FROM brillianda_app;
