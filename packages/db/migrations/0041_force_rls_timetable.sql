ALTER TABLE timetables FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE timetable_lessons FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE TRUNCATE ON timetables, timetable_lessons FROM brillianda_app;
