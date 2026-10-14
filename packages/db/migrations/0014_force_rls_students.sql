-- Student tables are school tables: force RLS so even their owner is subject to the policies.
ALTER TABLE import_batches FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE guardians FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE students FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE student_guardians FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE enrolments FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE counters FORCE ROW LEVEL SECURITY;--> statement-breakpoint
-- Students are soft-deleted and their history kept: the API never hard-deletes a student or an
-- enrolment, and nothing is ever wiped wholesale. (Undoing an import deletes that batch's own new
-- students, which is why DELETE stays on students: see the import route.)
REVOKE TRUNCATE ON import_batches, guardians, students, student_guardians, enrolments, counters FROM brillianda_app;--> statement-breakpoint
REVOKE DELETE ON import_batches, counters FROM brillianda_app;
