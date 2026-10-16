CREATE TYPE "public"."subject_link_kind" AS ENUM('compulsory', 'elective');--> statement-breakpoint
CREATE TABLE "class_level_subjects" (
	"id" uuid PRIMARY KEY NOT NULL,
	"school_id" uuid NOT NULL,
	"class_level_id" uuid NOT NULL,
	"school_subject_id" uuid NOT NULL,
	"kind" "subject_link_kind" NOT NULL,
	"department" "department",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	CONSTRAINT "class_level_subjects_school_id_id_key" UNIQUE("school_id","id"),
	CONSTRAINT "class_level_subjects_pair_key" UNIQUE("school_id","class_level_id","school_subject_id")
);
--> statement-breakpoint
ALTER TABLE "class_level_subjects" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "school_subjects" (
	"id" uuid PRIMARY KEY NOT NULL,
	"school_id" uuid NOT NULL,
	"catalogue_id" text,
	"name" text NOT NULL,
	"code" text NOT NULL,
	"position" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	CONSTRAINT "school_subjects_school_id_id_key" UNIQUE("school_id","id"),
	CONSTRAINT "school_subjects_school_code_key" UNIQUE("school_id","code")
);
--> statement-breakpoint
ALTER TABLE "school_subjects" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "class_level_subjects" ADD CONSTRAINT "class_level_subjects_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "class_level_subjects" ADD CONSTRAINT "class_level_subjects_level_fk" FOREIGN KEY ("school_id","class_level_id") REFERENCES "public"."class_levels"("school_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "class_level_subjects" ADD CONSTRAINT "class_level_subjects_subject_fk" FOREIGN KEY ("school_id","school_subject_id") REFERENCES "public"."school_subjects"("school_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "school_subjects" ADD CONSTRAINT "school_subjects_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "class_level_subjects_subject_idx" ON "class_level_subjects" USING btree ("school_id","school_subject_id");--> statement-breakpoint
CREATE UNIQUE INDEX "school_subjects_school_name_idx" ON "school_subjects" USING btree ("school_id",lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX "school_subjects_school_catalogue_idx" ON "school_subjects" USING btree ("school_id","catalogue_id") WHERE "school_subjects"."catalogue_id" IS NOT NULL;--> statement-breakpoint
CREATE POLICY "school_isolation" ON "class_level_subjects" AS PERMISSIVE FOR ALL TO "brillianda_app" USING ("class_level_subjects"."school_id" = app_current_school_id()) WITH CHECK ("class_level_subjects"."school_id" = app_current_school_id());--> statement-breakpoint
CREATE POLICY "backup_read" ON "class_level_subjects" AS PERMISSIVE FOR SELECT TO public USING (current_user = 'brillianda_backup');--> statement-breakpoint
CREATE POLICY "school_isolation" ON "school_subjects" AS PERMISSIVE FOR ALL TO "brillianda_app" USING ("school_subjects"."school_id" = app_current_school_id()) WITH CHECK ("school_subjects"."school_id" = app_current_school_id());--> statement-breakpoint
CREATE POLICY "backup_read" ON "school_subjects" AS PERMISSIVE FOR SELECT TO public USING (current_user = 'brillianda_backup');