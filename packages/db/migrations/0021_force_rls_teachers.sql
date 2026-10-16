ALTER TABLE arm_form_teachers FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE subject_teachers FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE registers FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE register_marks FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE TRUNCATE ON arm_form_teachers, subject_teachers, register_marks FROM brillianda_app;--> statement-breakpoint
-- A register, once taken, is history: it can be changed but never removed.
REVOKE DELETE, TRUNCATE ON registers FROM brillianda_app;
