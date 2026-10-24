ALTER TABLE book_lists FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE TRUNCATE ON book_lists FROM brillianda_app;
