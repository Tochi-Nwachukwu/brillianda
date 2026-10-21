CREATE TYPE "public"."unlock_status" AS ENUM('open', 'approved', 'declined');--> statement-breakpoint
CREATE TABLE "results_settings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"school_id" uuid NOT NULL,
	"components" jsonb NOT NULL,
	"scale" jsonb NOT NULL,
	"show_positions" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	CONSTRAINT "results_settings_school_id_id_key" UNIQUE("school_id","id"),
	CONSTRAINT "results_settings_one_per_school_key" UNIQUE("school_id")
);
--> statement-breakpoint
ALTER TABLE "results_settings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "score_exclusions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"school_id" uuid NOT NULL,
	"term_key" text NOT NULL,
	"class_arm_id" uuid NOT NULL,
	"school_subject_id" uuid NOT NULL,
	"student_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	CONSTRAINT "score_exclusions_school_id_id_key" UNIQUE("school_id","id"),
	CONSTRAINT "score_exclusions_row_key" UNIQUE("school_id","term_key","class_arm_id","school_subject_id","student_id")
);
--> statement-breakpoint
ALTER TABLE "score_exclusions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "scores" (
	"id" uuid PRIMARY KEY NOT NULL,
	"school_id" uuid NOT NULL,
	"term_key" text NOT NULL,
	"class_arm_id" uuid NOT NULL,
	"school_subject_id" uuid NOT NULL,
	"student_id" uuid NOT NULL,
	"component_id" text NOT NULL,
	"value" numeric(5, 2) NOT NULL,
	"is_absent" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	CONSTRAINT "scores_school_id_id_key" UNIQUE("school_id","id"),
	CONSTRAINT "scores_cell_key" UNIQUE("school_id","term_key","class_arm_id","school_subject_id","student_id","component_id"),
	CONSTRAINT "scores_value_check" CHECK ("scores"."value" >= 0 AND "scores"."value" <= 100 AND (NOT "scores"."is_absent" OR "scores"."value" = 0))
);
--> statement-breakpoint
ALTER TABLE "scores" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "sheet_completions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"school_id" uuid NOT NULL,
	"term_key" text NOT NULL,
	"class_arm_id" uuid NOT NULL,
	"school_subject_id" uuid NOT NULL,
	"completed_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	CONSTRAINT "sheet_completions_school_id_id_key" UNIQUE("school_id","id"),
	CONSTRAINT "sheet_completions_sheet_key" UNIQUE("school_id","term_key","class_arm_id","school_subject_id")
);
--> statement-breakpoint
ALTER TABLE "sheet_completions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "term_closures" (
	"id" uuid PRIMARY KEY NOT NULL,
	"school_id" uuid NOT NULL,
	"term_key" text NOT NULL,
	"closed_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	CONSTRAINT "term_closures_school_id_id_key" UNIQUE("school_id","id"),
	CONSTRAINT "term_closures_term_key" UNIQUE("school_id","term_key"),
	CONSTRAINT "term_closures_key_shape" CHECK ("term_closures"."term_key" ~ '^[0-9]{4}-[1-3]$')
);
--> statement-breakpoint
ALTER TABLE "term_closures" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "unlock_requests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"school_id" uuid NOT NULL,
	"term_key" text NOT NULL,
	"class_arm_id" uuid NOT NULL,
	"school_subject_id" uuid NOT NULL,
	"requested_by" uuid,
	"reason" text NOT NULL,
	"status" "unlock_status" DEFAULT 'open' NOT NULL,
	"resolved_by" uuid,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	CONSTRAINT "unlock_requests_school_id_id_key" UNIQUE("school_id","id"),
	CONSTRAINT "unlock_requests_reason_check" CHECK (char_length("unlock_requests"."reason") BETWEEN 5 AND 200)
);
--> statement-breakpoint
ALTER TABLE "unlock_requests" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "results_settings" ADD CONSTRAINT "results_settings_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "score_exclusions" ADD CONSTRAINT "score_exclusions_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "score_exclusions" ADD CONSTRAINT "score_exclusions_arm_fk" FOREIGN KEY ("school_id","class_arm_id") REFERENCES "public"."class_arms"("school_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "score_exclusions" ADD CONSTRAINT "score_exclusions_subject_fk" FOREIGN KEY ("school_id","school_subject_id") REFERENCES "public"."school_subjects"("school_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "score_exclusions" ADD CONSTRAINT "score_exclusions_student_fk" FOREIGN KEY ("school_id","student_id") REFERENCES "public"."students"("school_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scores" ADD CONSTRAINT "scores_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scores" ADD CONSTRAINT "scores_arm_fk" FOREIGN KEY ("school_id","class_arm_id") REFERENCES "public"."class_arms"("school_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scores" ADD CONSTRAINT "scores_subject_fk" FOREIGN KEY ("school_id","school_subject_id") REFERENCES "public"."school_subjects"("school_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scores" ADD CONSTRAINT "scores_student_fk" FOREIGN KEY ("school_id","student_id") REFERENCES "public"."students"("school_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sheet_completions" ADD CONSTRAINT "sheet_completions_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sheet_completions" ADD CONSTRAINT "sheet_completions_completed_by_users_id_fk" FOREIGN KEY ("completed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sheet_completions" ADD CONSTRAINT "sheet_completions_arm_fk" FOREIGN KEY ("school_id","class_arm_id") REFERENCES "public"."class_arms"("school_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sheet_completions" ADD CONSTRAINT "sheet_completions_subject_fk" FOREIGN KEY ("school_id","school_subject_id") REFERENCES "public"."school_subjects"("school_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "term_closures" ADD CONSTRAINT "term_closures_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "term_closures" ADD CONSTRAINT "term_closures_closed_by_users_id_fk" FOREIGN KEY ("closed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unlock_requests" ADD CONSTRAINT "unlock_requests_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unlock_requests" ADD CONSTRAINT "unlock_requests_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unlock_requests" ADD CONSTRAINT "unlock_requests_resolved_by_users_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unlock_requests" ADD CONSTRAINT "unlock_requests_arm_fk" FOREIGN KEY ("school_id","class_arm_id") REFERENCES "public"."class_arms"("school_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unlock_requests" ADD CONSTRAINT "unlock_requests_subject_fk" FOREIGN KEY ("school_id","school_subject_id") REFERENCES "public"."school_subjects"("school_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "scores_student_idx" ON "scores" USING btree ("school_id","student_id","term_key");--> statement-breakpoint
CREATE UNIQUE INDEX "unlock_requests_one_open_idx" ON "unlock_requests" USING btree ("school_id","term_key","class_arm_id","school_subject_id") WHERE "unlock_requests"."status" = 'open';--> statement-breakpoint
CREATE POLICY "school_isolation" ON "results_settings" AS PERMISSIVE FOR ALL TO "brillianda_app" USING ("results_settings"."school_id" = app_current_school_id()) WITH CHECK ("results_settings"."school_id" = app_current_school_id());--> statement-breakpoint
CREATE POLICY "backup_read" ON "results_settings" AS PERMISSIVE FOR SELECT TO public USING (current_user = 'brillianda_backup');--> statement-breakpoint
CREATE POLICY "school_isolation" ON "score_exclusions" AS PERMISSIVE FOR ALL TO "brillianda_app" USING ("score_exclusions"."school_id" = app_current_school_id()) WITH CHECK ("score_exclusions"."school_id" = app_current_school_id());--> statement-breakpoint
CREATE POLICY "backup_read" ON "score_exclusions" AS PERMISSIVE FOR SELECT TO public USING (current_user = 'brillianda_backup');--> statement-breakpoint
CREATE POLICY "school_isolation" ON "scores" AS PERMISSIVE FOR ALL TO "brillianda_app" USING ("scores"."school_id" = app_current_school_id()) WITH CHECK ("scores"."school_id" = app_current_school_id());--> statement-breakpoint
CREATE POLICY "backup_read" ON "scores" AS PERMISSIVE FOR SELECT TO public USING (current_user = 'brillianda_backup');--> statement-breakpoint
CREATE POLICY "school_isolation" ON "sheet_completions" AS PERMISSIVE FOR ALL TO "brillianda_app" USING ("sheet_completions"."school_id" = app_current_school_id()) WITH CHECK ("sheet_completions"."school_id" = app_current_school_id());--> statement-breakpoint
CREATE POLICY "backup_read" ON "sheet_completions" AS PERMISSIVE FOR SELECT TO public USING (current_user = 'brillianda_backup');--> statement-breakpoint
CREATE POLICY "school_isolation" ON "term_closures" AS PERMISSIVE FOR ALL TO "brillianda_app" USING ("term_closures"."school_id" = app_current_school_id()) WITH CHECK ("term_closures"."school_id" = app_current_school_id());--> statement-breakpoint
CREATE POLICY "backup_read" ON "term_closures" AS PERMISSIVE FOR SELECT TO public USING (current_user = 'brillianda_backup');--> statement-breakpoint
CREATE POLICY "school_isolation" ON "unlock_requests" AS PERMISSIVE FOR ALL TO "brillianda_app" USING ("unlock_requests"."school_id" = app_current_school_id()) WITH CHECK ("unlock_requests"."school_id" = app_current_school_id());--> statement-breakpoint
CREATE POLICY "backup_read" ON "unlock_requests" AS PERMISSIVE FOR SELECT TO public USING (current_user = 'brillianda_backup');