CREATE TYPE "public"."remark_kind" AS ENUM('teacher', 'principal');--> statement-breakpoint
CREATE TABLE "published_results" (
	"id" uuid PRIMARY KEY NOT NULL,
	"school_id" uuid NOT NULL,
	"term_key" text NOT NULL,
	"class_arm_id" uuid NOT NULL,
	"published_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	CONSTRAINT "published_results_school_id_id_key" UNIQUE("school_id","id"),
	CONSTRAINT "published_results_class_key" UNIQUE("school_id","term_key","class_arm_id")
);
--> statement-breakpoint
ALTER TABLE "published_results" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "report_ratings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"school_id" uuid NOT NULL,
	"term_key" text NOT NULL,
	"student_id" uuid NOT NULL,
	"trait" text NOT NULL,
	"value" smallint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	CONSTRAINT "report_ratings_school_id_id_key" UNIQUE("school_id","id"),
	CONSTRAINT "report_ratings_one_key" UNIQUE("school_id","term_key","student_id","trait"),
	CONSTRAINT "report_ratings_value_check" CHECK ("report_ratings"."value" BETWEEN 1 AND 5)
);
--> statement-breakpoint
ALTER TABLE "report_ratings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "report_remarks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"school_id" uuid NOT NULL,
	"term_key" text NOT NULL,
	"student_id" uuid NOT NULL,
	"kind" "remark_kind" NOT NULL,
	"text" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	CONSTRAINT "report_remarks_school_id_id_key" UNIQUE("school_id","id"),
	CONSTRAINT "report_remarks_one_key" UNIQUE("school_id","term_key","student_id","kind"),
	CONSTRAINT "report_remarks_text_check" CHECK (char_length("report_remarks"."text") BETWEEN 1 AND 300)
);
--> statement-breakpoint
ALTER TABLE "report_remarks" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "results_settings" ADD COLUMN "ratings_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "results_settings" ADD COLUMN "rating_traits" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "published_results" ADD CONSTRAINT "published_results_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "published_results" ADD CONSTRAINT "published_results_published_by_users_id_fk" FOREIGN KEY ("published_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "published_results" ADD CONSTRAINT "published_results_arm_fk" FOREIGN KEY ("school_id","class_arm_id") REFERENCES "public"."class_arms"("school_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_ratings" ADD CONSTRAINT "report_ratings_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_ratings" ADD CONSTRAINT "report_ratings_student_fk" FOREIGN KEY ("school_id","student_id") REFERENCES "public"."students"("school_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_remarks" ADD CONSTRAINT "report_remarks_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_remarks" ADD CONSTRAINT "report_remarks_student_fk" FOREIGN KEY ("school_id","student_id") REFERENCES "public"."students"("school_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "school_isolation" ON "published_results" AS PERMISSIVE FOR ALL TO "brillianda_app" USING ("published_results"."school_id" = app_current_school_id()) WITH CHECK ("published_results"."school_id" = app_current_school_id());--> statement-breakpoint
CREATE POLICY "backup_read" ON "published_results" AS PERMISSIVE FOR SELECT TO public USING (current_user = 'brillianda_backup');--> statement-breakpoint
CREATE POLICY "school_isolation" ON "report_ratings" AS PERMISSIVE FOR ALL TO "brillianda_app" USING ("report_ratings"."school_id" = app_current_school_id()) WITH CHECK ("report_ratings"."school_id" = app_current_school_id());--> statement-breakpoint
CREATE POLICY "backup_read" ON "report_ratings" AS PERMISSIVE FOR SELECT TO public USING (current_user = 'brillianda_backup');--> statement-breakpoint
CREATE POLICY "school_isolation" ON "report_remarks" AS PERMISSIVE FOR ALL TO "brillianda_app" USING ("report_remarks"."school_id" = app_current_school_id()) WITH CHECK ("report_remarks"."school_id" = app_current_school_id());--> statement-breakpoint
CREATE POLICY "backup_read" ON "report_remarks" AS PERMISSIVE FOR SELECT TO public USING (current_user = 'brillianda_backup');