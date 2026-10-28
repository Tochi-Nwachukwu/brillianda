CREATE TYPE "public"."test_status" AS ENUM('draft', 'published');--> statement-breakpoint
CREATE TYPE "public"."test_where" AS ENUM('anywhere', 'school');--> statement-breakpoint
CREATE TABLE "cbt_attempts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"school_id" uuid NOT NULL,
	"test_id" uuid NOT NULL,
	"student_id" uuid NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"submitted_at" timestamp with time zone,
	"responses" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"theory_marks" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"left_page" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	CONSTRAINT "cbt_attempts_school_id_id_key" UNIQUE("school_id","id"),
	CONSTRAINT "cbt_attempts_once_key" UNIQUE("school_id","test_id","student_id")
);
--> statement-breakpoint
ALTER TABLE "cbt_attempts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "cbt_test_classes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"school_id" uuid NOT NULL,
	"test_id" uuid NOT NULL,
	"class_arm_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	CONSTRAINT "cbt_test_classes_school_id_id_key" UNIQUE("school_id","id"),
	CONSTRAINT "cbt_test_classes_pair_key" UNIQUE("school_id","test_id","class_arm_id")
);
--> statement-breakpoint
ALTER TABLE "cbt_test_classes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "cbt_tests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"school_id" uuid NOT NULL,
	"school_subject_id" uuid NOT NULL,
	"class_level_id" uuid NOT NULL,
	"title" text NOT NULL,
	"instructions" text DEFAULT '' NOT NULL,
	"questions" jsonb NOT NULL,
	"question_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"duration_minutes" integer NOT NULL,
	"opens_at" timestamp with time zone NOT NULL,
	"closes_at" timestamp with time zone NOT NULL,
	"where" "test_where" NOT NULL,
	"access_code" text NOT NULL,
	"shuffle" boolean NOT NULL,
	"show_score" boolean NOT NULL,
	"component_id" text NOT NULL,
	"status" "test_status" DEFAULT 'draft' NOT NULL,
	"author_id" uuid,
	"scores_sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	CONSTRAINT "cbt_tests_school_id_id_key" UNIQUE("school_id","id"),
	CONSTRAINT "cbt_tests_duration" CHECK ("cbt_tests"."duration_minutes" BETWEEN 5 AND 240),
	CONSTRAINT "cbt_tests_window" CHECK ("cbt_tests"."closes_at" > "cbt_tests"."opens_at")
);
--> statement-breakpoint
ALTER TABLE "cbt_tests" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "cbt_attempts" ADD CONSTRAINT "cbt_attempts_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cbt_attempts" ADD CONSTRAINT "cbt_attempts_test_fk" FOREIGN KEY ("school_id","test_id") REFERENCES "public"."cbt_tests"("school_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cbt_attempts" ADD CONSTRAINT "cbt_attempts_student_fk" FOREIGN KEY ("school_id","student_id") REFERENCES "public"."students"("school_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cbt_test_classes" ADD CONSTRAINT "cbt_test_classes_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cbt_test_classes" ADD CONSTRAINT "cbt_test_classes_test_fk" FOREIGN KEY ("school_id","test_id") REFERENCES "public"."cbt_tests"("school_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cbt_test_classes" ADD CONSTRAINT "cbt_test_classes_arm_fk" FOREIGN KEY ("school_id","class_arm_id") REFERENCES "public"."class_arms"("school_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cbt_tests" ADD CONSTRAINT "cbt_tests_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cbt_tests" ADD CONSTRAINT "cbt_tests_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cbt_tests" ADD CONSTRAINT "cbt_tests_subject_fk" FOREIGN KEY ("school_id","school_subject_id") REFERENCES "public"."school_subjects"("school_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cbt_tests" ADD CONSTRAINT "cbt_tests_level_fk" FOREIGN KEY ("school_id","class_level_id") REFERENCES "public"."class_levels"("school_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cbt_attempts_student_idx" ON "cbt_attempts" USING btree ("school_id","student_id");--> statement-breakpoint
CREATE INDEX "cbt_test_classes_arm_idx" ON "cbt_test_classes" USING btree ("school_id","class_arm_id");--> statement-breakpoint
CREATE INDEX "cbt_tests_school_opens_idx" ON "cbt_tests" USING btree ("school_id","opens_at");--> statement-breakpoint
CREATE POLICY "school_isolation" ON "cbt_attempts" AS PERMISSIVE FOR ALL TO "brillianda_app" USING ("cbt_attempts"."school_id" = app_current_school_id()) WITH CHECK ("cbt_attempts"."school_id" = app_current_school_id());--> statement-breakpoint
CREATE POLICY "backup_read" ON "cbt_attempts" AS PERMISSIVE FOR SELECT TO public USING (current_user = 'brillianda_backup');--> statement-breakpoint
CREATE POLICY "school_isolation" ON "cbt_test_classes" AS PERMISSIVE FOR ALL TO "brillianda_app" USING ("cbt_test_classes"."school_id" = app_current_school_id()) WITH CHECK ("cbt_test_classes"."school_id" = app_current_school_id());--> statement-breakpoint
CREATE POLICY "backup_read" ON "cbt_test_classes" AS PERMISSIVE FOR SELECT TO public USING (current_user = 'brillianda_backup');--> statement-breakpoint
CREATE POLICY "school_isolation" ON "cbt_tests" AS PERMISSIVE FOR ALL TO "brillianda_app" USING ("cbt_tests"."school_id" = app_current_school_id()) WITH CHECK ("cbt_tests"."school_id" = app_current_school_id());--> statement-breakpoint
CREATE POLICY "backup_read" ON "cbt_tests" AS PERMISSIVE FOR SELECT TO public USING (current_user = 'brillianda_backup');