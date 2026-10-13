CREATE TABLE "academic_sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"school_id" uuid NOT NULL,
	"start_year" integer NOT NULL,
	"name" text NOT NULL,
	"starts_on" date NOT NULL,
	"ends_on" date NOT NULL,
	"is_current" boolean DEFAULT false NOT NULL,
	"confirmed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	CONSTRAINT "academic_sessions_school_id_id_key" UNIQUE("school_id","id"),
	CONSTRAINT "academic_sessions_school_year_key" UNIQUE("school_id","start_year"),
	CONSTRAINT "academic_sessions_dates_check" CHECK ("academic_sessions"."ends_on" > "academic_sessions"."starts_on")
);
--> statement-breakpoint
ALTER TABLE "academic_sessions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "terms" (
	"id" uuid PRIMARY KEY NOT NULL,
	"school_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"name" text NOT NULL,
	"position" smallint NOT NULL,
	"starts_on" date NOT NULL,
	"ends_on" date NOT NULL,
	"is_current" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	CONSTRAINT "terms_school_id_id_key" UNIQUE("school_id","id"),
	CONSTRAINT "terms_session_position_key" UNIQUE("school_id","session_id","position"),
	CONSTRAINT "terms_position_check" CHECK ("terms"."position" between 1 and 3),
	CONSTRAINT "terms_dates_check" CHECK ("terms"."ends_on" > "terms"."starts_on")
);
--> statement-breakpoint
ALTER TABLE "terms" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "signup_drafts" ADD COLUMN "session_start_month" smallint;--> statement-breakpoint
ALTER TABLE "signup_drafts" ADD COLUMN "session_start_year" smallint;--> statement-breakpoint
ALTER TABLE "academic_sessions" ADD CONSTRAINT "academic_sessions_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "terms" ADD CONSTRAINT "terms_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "terms" ADD CONSTRAINT "terms_session_fk" FOREIGN KEY ("school_id","session_id") REFERENCES "public"."academic_sessions"("school_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "academic_sessions_one_current_idx" ON "academic_sessions" USING btree ("school_id") WHERE "academic_sessions"."is_current";--> statement-breakpoint
CREATE UNIQUE INDEX "terms_one_current_idx" ON "terms" USING btree ("school_id") WHERE "terms"."is_current";--> statement-breakpoint
CREATE POLICY "school_isolation" ON "academic_sessions" AS PERMISSIVE FOR ALL TO "brillianda_app" USING ("academic_sessions"."school_id" = app_current_school_id()) WITH CHECK ("academic_sessions"."school_id" = app_current_school_id());--> statement-breakpoint
CREATE POLICY "backup_read" ON "academic_sessions" AS PERMISSIVE FOR SELECT TO public USING (current_user = 'brillianda_backup');--> statement-breakpoint
CREATE POLICY "school_isolation" ON "terms" AS PERMISSIVE FOR ALL TO "brillianda_app" USING ("terms"."school_id" = app_current_school_id()) WITH CHECK ("terms"."school_id" = app_current_school_id());--> statement-breakpoint
CREATE POLICY "backup_read" ON "terms" AS PERMISSIVE FOR SELECT TO public USING (current_user = 'brillianda_backup');