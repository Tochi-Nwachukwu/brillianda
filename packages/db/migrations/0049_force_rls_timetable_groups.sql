-- Timetable groups (A4): forced row-level security like every school table. Schools get their first
-- group lazily from the old timetables row (apps/api/src/routes/timetable.ts, groupsOf), because
-- the owner can't read FORCE RLS tables here.
ALTER TABLE timetable_groups FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE TRUNCATE ON timetable_groups FROM brillianda_app;
