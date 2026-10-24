CREATE TYPE "public"."promotion_decision" AS ENUM('promote', 'repeat', 'graduate');--> statement-breakpoint
CREATE TABLE "promotion_decisions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"school_id" uuid NOT NULL,
	"start_year" integer NOT NULL,
	"student_id" uuid NOT NULL,
	"decision" "promotion_decision" NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	CONSTRAINT "promotion_decisions_school_id_id_key" UNIQUE("school_id","id"),
	CONSTRAINT "promotion_decisions_student_key" UNIQUE("school_id","start_year","student_id"),
	CONSTRAINT "promotion_decisions_reason_length" CHECK (char_length("promotion_decisions"."reason") <= 200)
);
--> statement-breakpoint
ALTER TABLE "promotion_decisions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "results_settings" ADD COLUMN "pass_mark" numeric(5, 2);--> statement-breakpoint
ALTER TABLE "promotion_decisions" ADD CONSTRAINT "promotion_decisions_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promotion_decisions" ADD CONSTRAINT "promotion_decisions_student_fk" FOREIGN KEY ("school_id","student_id") REFERENCES "public"."students"("school_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "school_isolation" ON "promotion_decisions" AS PERMISSIVE FOR ALL TO "brillianda_app" USING ("promotion_decisions"."school_id" = app_current_school_id()) WITH CHECK ("promotion_decisions"."school_id" = app_current_school_id());--> statement-breakpoint
CREATE POLICY "backup_read" ON "promotion_decisions" AS PERMISSIVE FOR SELECT TO public USING (current_user = 'brillianda_backup');