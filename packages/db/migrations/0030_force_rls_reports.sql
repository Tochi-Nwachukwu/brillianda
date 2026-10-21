ALTER TABLE report_remarks FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE report_ratings FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE published_results FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE TRUNCATE ON report_remarks, report_ratings, published_results FROM brillianda_app;
