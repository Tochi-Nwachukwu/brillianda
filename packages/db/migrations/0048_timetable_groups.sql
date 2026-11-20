CREATE TABLE "timetable_groups" (
	"id" uuid PRIMARY KEY NOT NULL,
	"school_id" uuid NOT NULL,
	"name" text NOT NULL,
	"sections" "class_section"[] NOT NULL,
	"position" smallint DEFAULT 0 NOT NULL,
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
	CONSTRAINT "timetable_groups_school_id_id_key" UNIQUE("school_id","id"),
	CONSTRAINT "timetable_groups_name" CHECK (char_length("timetable_groups"."name") BETWEEN 1 AND 40),
	CONSTRAINT "timetable_groups_file_size" CHECK ("timetable_groups"."file_bytes" IS NULL OR octet_length("timetable_groups"."file_bytes") <= 2097152)
);
--> statement-breakpoint
ALTER TABLE "timetable_groups" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "timetable_groups" ADD CONSTRAINT "timetable_groups_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timetable_groups" ADD CONSTRAINT "timetable_groups_file_by_users_id_fk" FOREIGN KEY ("file_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "timetable_groups_school_position_idx" ON "timetable_groups" USING btree ("school_id","position");--> statement-breakpoint
CREATE POLICY "school_isolation" ON "timetable_groups" AS PERMISSIVE FOR ALL TO "brillianda_app" USING ("timetable_groups"."school_id" = app_current_school_id()) WITH CHECK ("timetable_groups"."school_id" = app_current_school_id());--> statement-breakpoint
CREATE POLICY "backup_read" ON "timetable_groups" AS PERMISSIVE FOR SELECT TO public USING (current_user = 'brillianda_backup');