CREATE TYPE "public"."question_source" AS ENUM('teacher', 'ai');--> statement-breakpoint
CREATE TABLE "ai_usage" (
	"id" uuid PRIMARY KEY NOT NULL,
	"school_id" uuid NOT NULL,
	"user_id" uuid,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"purpose" text NOT NULL,
	"questions" integer NOT NULL,
	"input_tokens" integer,
	"output_tokens" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	CONSTRAINT "ai_usage_school_id_id_key" UNIQUE("school_id","id")
);
--> statement-breakpoint
ALTER TABLE "ai_usage" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "bank_questions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"school_id" uuid NOT NULL,
	"school_subject_id" uuid NOT NULL,
	"class_level_id" uuid NOT NULL,
	"question" jsonb NOT NULL,
	"source" "question_source" NOT NULL,
	"author_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	CONSTRAINT "bank_questions_school_id_id_key" UNIQUE("school_id","id")
);
--> statement-breakpoint
ALTER TABLE "bank_questions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "ai_usage" ADD CONSTRAINT "ai_usage_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_usage" ADD CONSTRAINT "ai_usage_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_questions" ADD CONSTRAINT "bank_questions_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_questions" ADD CONSTRAINT "bank_questions_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_questions" ADD CONSTRAINT "bank_questions_subject_fk" FOREIGN KEY ("school_id","school_subject_id") REFERENCES "public"."school_subjects"("school_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_questions" ADD CONSTRAINT "bank_questions_level_fk" FOREIGN KEY ("school_id","class_level_id") REFERENCES "public"."class_levels"("school_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_usage_school_created_idx" ON "ai_usage" USING btree ("school_id","created_at");--> statement-breakpoint
CREATE INDEX "bank_questions_school_pair_idx" ON "bank_questions" USING btree ("school_id","school_subject_id","class_level_id");--> statement-breakpoint
CREATE POLICY "school_isolation" ON "ai_usage" AS PERMISSIVE FOR ALL TO "brillianda_app" USING ("ai_usage"."school_id" = app_current_school_id()) WITH CHECK ("ai_usage"."school_id" = app_current_school_id());--> statement-breakpoint
CREATE POLICY "backup_read" ON "ai_usage" AS PERMISSIVE FOR SELECT TO public USING (current_user = 'brillianda_backup');--> statement-breakpoint
CREATE POLICY "school_isolation" ON "bank_questions" AS PERMISSIVE FOR ALL TO "brillianda_app" USING ("bank_questions"."school_id" = app_current_school_id()) WITH CHECK ("bank_questions"."school_id" = app_current_school_id());--> statement-breakpoint
CREATE POLICY "backup_read" ON "bank_questions" AS PERMISSIVE FOR SELECT TO public USING (current_user = 'brillianda_backup');