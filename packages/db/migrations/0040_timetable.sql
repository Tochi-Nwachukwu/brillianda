CREATE TABLE "timetable_lessons" (
	"id" uuid PRIMARY KEY NOT NULL,
	"school_id" uuid NOT NULL,
	"class_arm_id" uuid NOT NULL,
	"day" smallint NOT NULL,
	"period_id" text NOT NULL,
	"school_subject_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	CONSTRAINT "timetable_lessons_school_id_id_key" UNIQUE("school_id","id"),
	CONSTRAINT "timetable_lessons_slot_key" UNIQUE("school_id","class_arm_id","day","period_id"),
	CONSTRAINT "timetable_lessons_day" CHECK ("timetable_lessons"."day" BETWEEN 1 AND 5)
);
--> statement-breakpoint
ALTER TABLE "timetable_lessons" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "timetables" (
	"id" uuid PRIMARY KEY NOT NULL,
	"school_id" uuid NOT NULL,
	"periods" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"file_name" text,
	"file_bytes" "bytea",
	"file_sha256" text,
	"file_by" uuid,
	"file_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	CONSTRAINT "timetables_school_id_id_key" UNIQUE("school_id","id"),
	CONSTRAINT "timetables_one_per_school_key" UNIQUE("school_id"),
	CONSTRAINT "timetables_file_size" CHECK ("timetables"."file_bytes" IS NULL OR octet_length("timetables"."file_bytes") <= 2097152)
);
--> statement-breakpoint
ALTER TABLE "timetables" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "timetable_lessons" ADD CONSTRAINT "timetable_lessons_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timetable_lessons" ADD CONSTRAINT "timetable_lessons_arm_fk" FOREIGN KEY ("school_id","class_arm_id") REFERENCES "public"."class_arms"("school_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timetable_lessons" ADD CONSTRAINT "timetable_lessons_subject_fk" FOREIGN KEY ("school_id","school_subject_id") REFERENCES "public"."school_subjects"("school_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timetables" ADD CONSTRAINT "timetables_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timetables" ADD CONSTRAINT "timetables_file_by_users_id_fk" FOREIGN KEY ("file_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "timetable_lessons_school_subject_idx" ON "timetable_lessons" USING btree ("school_id","school_subject_id");--> statement-breakpoint
CREATE POLICY "school_isolation" ON "timetable_lessons" AS PERMISSIVE FOR ALL TO "brillianda_app" USING ("timetable_lessons"."school_id" = app_current_school_id()) WITH CHECK ("timetable_lessons"."school_id" = app_current_school_id());--> statement-breakpoint
CREATE POLICY "backup_read" ON "timetable_lessons" AS PERMISSIVE FOR SELECT TO public USING (current_user = 'brillianda_backup');--> statement-breakpoint
CREATE POLICY "school_isolation" ON "timetables" AS PERMISSIVE FOR ALL TO "brillianda_app" USING ("timetables"."school_id" = app_current_school_id()) WITH CHECK ("timetables"."school_id" = app_current_school_id());--> statement-breakpoint
CREATE POLICY "backup_read" ON "timetables" AS PERMISSIVE FOR SELECT TO public USING (current_user = 'brillianda_backup');