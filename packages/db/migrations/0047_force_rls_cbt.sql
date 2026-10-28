ALTER TABLE cbt_tests FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE cbt_test_classes FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE cbt_attempts FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE TRUNCATE ON cbt_tests, cbt_test_classes, cbt_attempts FROM brillianda_app;
